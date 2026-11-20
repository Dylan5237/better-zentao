import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { expect, it } from "vitest";
import { createBetterZentaoMcpServer } from "../../src/adapters/mcp-factory.ts";
import { createBetterZentao, ZentaoApiError } from "../../src/index.ts";
import { assertNoSecrets, toolNames, verifyCliParity, verifyMcpLifecycle, verifyMcpTools } from "../fixtures/local-scenarios.mjs";
import { draftInput, envFor, newFixture, PASSWORD, startMock, TOKEN } from "../fixtures/zentao.mjs";
import { mcpProcess, runCli, toolData } from "../fixtures/process.mjs";

async function withMock(check, options = {}) {
  const mock = await startMock(options);
  try {
    await check(mock);
  } finally {
    await mock.close();
  }
}

async function withMcp(mock, check, env = mock.env) {
  const rpc = mcpProcess(env);
  try {
    await check(rpc);
  } finally {
    await rpc.close();
  }
}

it("TC-ADP-01 真实 stdio 握手发现九个工具，stdout 每行 JSON-RPC，启动诊断仅 stderr", async () => {
  await withMock(mock => withMcp(mock, rpc => verifyMcpLifecycle(mock, rpc)));
});

it("TC-ADP-02 缺 ZENTAO_PASSWORD 时发现正常，调用才安全返回 ConfigError", async () => {
  await withMock(async mock => {
    const { ZENTAO_PASSWORD, ...env } = mock.env;
    await withMcp(mock, async rpc => {
      expect((await rpc.initialize()).serverInfo.name).toBe("better-zentao-mcp");
      expect((await rpc.list()).tools.map(tool => tool.name)).toEqual(toolNames);
      const output = toolData(await rpc.call("get_my_dashboard"));
      expect(output.isError).toBe(true);
      expect(output.data.error).toMatchObject({ name: "ConfigError", code: "CONFIG_ERROR", missingVars: ["ZENTAO_PASSWORD"] });
      expect(mock.requests).toEqual([]);
      assertNoSecrets(JSON.stringify(output));
    }, env);
  });
});

it("TC-ADP-03 真实 stdio 调用九个工具，走完 Mock 创建、指派与删除守卫，安全返回异常", async () => {
  await withMock(mock => withMcp(mock, async rpc => {
    await rpc.initialize();
    await verifyMcpTools(mock, rpc);
    const failure = await rpc.call("get_story_progress", { storyId: 9999 });
    expect(toolData(failure)).toMatchObject({ isError: true, data: { error: { code: "ZENTAO_API_ERROR", status: 404 } } });
    assertNoSecrets(JSON.stringify(failure));
    expect(rpc.stdout.every(line => JSON.parse(line).jsonrpc === "2.0")).toBe(true);
  }), { leaks: true });
});

it("TC-ADP-04 remote 隐藏上游错误细节并替换返回值中偶然出现的 Token", async () => {
  const remoteSecret = "synthetic-remote-token-435";
  const fixture = newFixture();
  fixture.stories.get(101).title += " " + remoteSecret + " " + TOKEN;
  const client = createBetterZentao({ env: envFor(), fetchImpl: fixture.fetchImpl });
  client.tracking.getMyDashboard = async () => { throw new ZentaoApiError("内部错误正文 " + remoteSecret + " " + PASSWORD, 503); };
  const server = createBetterZentaoMcpServer(client, { remote: true, redactSecrets: [remoteSecret] });
  const wire = new Client({ name: "remote-mode-test", version: "1" });
  const [transport, serverTransport] = InMemoryTransport.createLinkedPair();
  try {
    await server.connect(serverTransport);
    await wire.connect(transport);
    const success = toolData(await wire.callTool({ name: "query_stories", arguments: { product: 42 } }));
    expect(success.data.stories[0].title).toContain("[redacted] [redacted]");
    expect(JSON.stringify(success)).not.toContain(remoteSecret);
    assertNoSecrets(JSON.stringify(success));
    const failed = toolData(await wire.callTool({ name: "get_my_dashboard" }));
    expect(failed).toMatchObject({ isError: true, data: { error: { status: 503, message: "禅道 API 请求失败" } } });
    expect(JSON.stringify(failed)).not.toMatch(/内部错误正文|synthetic-remote-token/);
    assertNoSecrets(JSON.stringify(failed));
  } finally {
    await wire.close();
    await server.close();
  }
});

it("TC-ADP-05 九个真实 CLI 子命令的 JSON 与对应 MCP 工具一致", async () => {
  await withMock(mock => withMcp(mock, async rpc => {
    await rpc.initialize();
    await verifyCliParity(mock, rpc);
  }));
});

it("TC-ADP-06 CLI 退出码 0/1/2 区分成功、API/部分失败、缺确认与参数错误", async () => {
  await withMock(async mock => {
    const success = await runCli(["stories", "--json"], mock.env);
    expect(success.code).toBe(0);
    expect(JSON.parse(success.stdout).matchedCount).toBeGreaterThan(0);
    const help = await runCli(["--help"], {});
    expect(help.code).toBe(0);
    expect(help.stdout).toContain("用法 bzt");
    const missingInput = await runCli(["progress", "--json"], {});
    expect(missingInput.code).toBe(2);
    expect(JSON.parse(missingInput.stdout).error.message).toContain("提供且只提供一项");
    const apiError = await runCli(["progress", "9999", "--json"], mock.env);
    expect(apiError.code).toBe(1);
    expect(JSON.parse(apiError.stdout).error).toMatchObject({ code: "ZENTAO_API_ERROR", status: 404 });
    assertNoSecrets(apiError.stdout + apiError.stderr);

    for (const args of [["delete", "101"], ["delete", "101", "--confirm=false"], ["import", "--stdin", "--dry-run=1"],
      ["import", "--stdin", "--dry-run=false", "--dry-run"], ["stories", "--limit", "201"]]) {
      const result = await runCli([...args, "--json"], mock.env);
      expect(result.code).toBe(2);
      expect(JSON.parse(result.stdout).error.code).toBe("INVALID_PARAM");
    }
    expect(mock.businessWrites()).toEqual([]);
    const input = JSON.stringify([{ ...draftInput, title: "成功条目" }, { ...draftInput, title: "失败条目" }]);
    const partial = await runCli(["import", "--stdin", "--dry-run=false", "--json"], mock.env, input);
    expect(partial.code).toBe(1);
    expect(JSON.parse(partial.stdout)).toMatchObject({ created: 1, failed: 1, readbackUnconfirmed: 0, results: [
      { index: 1, receipts: [{ id: 9001, readbackConfirmed: true }] }, { index: 2, receipts: [{ error: { code: "CREATE_UNCONFIRMED" } }] },
    ] });
    assertNoSecrets(partial.stdout + partial.stderr);
    expect(mock.businessWrites()).toHaveLength(2);
  }, { override: request => {
    if (request.method === "POST" && request.body?.title === "失败条目") {
      return new Response(JSON.stringify({ error: "上游错误 " + TOKEN + PASSWORD }), { status: 503 });
    }
  } });
});

it("TC-ADP-06 CLI 单遍解析 JSON 选项并区分 -- 后的位置参数", async () => {
  await withMock(async mock => {
    const positional = await runCli(["resolve", "--kinds", "user", "--", "--json"], mock.env);
    expect(positional.code).toBe(0);
    expect(JSON.parse(positional.stdout).query).toBe("--json");
    expect(positional.stdout).toContain('\n  "query"');
    expect(positional.stderr).toBe("");

    const misplaced = await runCli(["delete", "101", "--", "--json"], mock.env);
    expect(misplaced.code).toBe(2);
    expect(misplaced.stdout).toBe("");
    expect(JSON.parse(misplaced.stderr).error.code).toBe("INVALID_PARAM");

    const trailingFlag = await runCli(["import", "--stdin", "--dry-run=1", "--json"], mock.env);
    expect(trailingFlag.code).toBe(2);
    expect(JSON.parse(trailingFlag.stdout).error.message).toContain("--dry-run");
    expect(trailingFlag.stderr).toBe("");
    expect(mock.businessWrites()).toEqual([]);
  });
});

it("TC-ADP-07 单遍解析 dry-run、文件/管道二选一，坏参数早于文件访问", async () => {
  const directory = await mkdtemp(join(tmpdir(), "bzt-import-"));
  try {
    const validFile = join(directory, "样例需求.json");
    const nonexistent = join(directory, "缺失.json");
    const input = JSON.stringify({ stories: [draftInput] });
    await writeFile(validFile, "\uFEFF" + input, "utf8");
    await withMock(async mock => {
      for (const [options, stdin] of [
        [["--file", validFile], ""],
        [["--stdin", "--dry-run"], input],
        [["--stdin", "--dry-run=true"], input],
      ]) {
        const result = await runCli(["import", ...options, "--json"], mock.env, stdin);
        expect(result.code).toBe(0);
        expect(JSON.parse(result.stdout)).toMatchObject({ dryRun: true, allOk: true, issueCount: 0 });
      }
      const baseline = mock.requests.length;
      for (const options of [
        ["--file", nonexistent, "--dry-run=1"], ["--file", nonexistent, "--dry-run", "--dry-run=false"],
        ["--file", nonexistent, "--stdin", "--dry-run=false"], ["--file", "--json", validFile, "--dry-run=false"],
        ["--dry-run", "false", "--file", validFile], [],
      ]) {
        const result = await runCli(["import", ...options, ...(options.includes("--json") ? [] : ["--json"])], mock.env);
        expect(result.code).toBe(2);
        expect(JSON.parse(result.stdout).error.code).toBe("INVALID_PARAM");
      }
      const failedFile = await runCli(["import", "--file", nonexistent, "--json"], mock.env);
      expect(failedFile.code).toBe(1);
      expect(mock.requests).toHaveLength(baseline);
      expect(mock.businessWrites()).toEqual([]);
      const confirmed = await runCli(["import", "--file", validFile, "--dry-run=false", "--json"], mock.env);
      expect(confirmed.code).toBe(0);
      expect(JSON.parse(confirmed.stdout).created).toBe(1);
      expect(mock.businessWrites()).toHaveLength(1);
      expect(mock.businessWrites()[0].body.title).toBe(draftInput.title);
    });
  } finally {
    await rm(directory, { force: true, recursive: true });
  }
});

it("TC-ADP-08 项目 Skill 与三端模板完整，密码只走进程环境", async () => {
  const [skill, onboarding, example] = await Promise.all([
    readFile(new URL("../../skills/better-zentao/SKILL.md", import.meta.url), "utf8"),
    readFile(new URL("../../docs/onboarding/local-agent-setup.md", import.meta.url), "utf8"),
    readFile(new URL("../../.env.example", import.meta.url), "utf8"),
  ]);
  expect(skill).toMatch(/^---\r?\nname: better-zentao\r?\n/);
  for (const name of toolNames) expect(skill).toContain(name);
  expect(skill).toMatch(/dryRun: true/);
  expect(skill).toMatch(/禁止重试创建/);
  for (const host of ["Antigravity", "Codex", "Claude Code"]) expect(onboarding).toContain(host);
  expect(onboarding).toContain('env_vars = ["ZENTAO_PASSWORD"]');
  expect(onboarding).toContain(".mcp.json");
  expect(onboarding).toContain("claude mcp add");
  expect(onboarding).toContain("$" + "{ZENTAO_PASSWORD}");
  expect(onboarding).not.toMatch(/["']?ZENTAO_PASSWORD["']?\s*[:=]\s*["'](?!\$\{ZENTAO_PASSWORD\})[^"'\r\n]{1,}["']/);
  expect(example).toMatch(/^ZENTAO_PASSWORD=\r?$/m);
  assertNoSecrets(skill + onboarding + example);
});
