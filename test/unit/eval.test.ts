import { spawnSync } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import {
  loadEvalCases,
  parseEvalYaml,
  runEval,
  verifyEvalAssets,
} from "../../scripts/eval.ts";
import { p1Tools } from "../../src/contracts/tools/index.ts";
import { assertNoSensitiveData } from "../helpers/assert-no-sensitive-data.ts";

const casesDir = fileURLToPath(new URL("../eval/cases/", import.meta.url));
const repo = fileURLToPath(new URL("../../", import.meta.url));
const entrypoint = join(repo, "scripts", "eval.ts");
const privateInput = "fixture-private-value";
let temp: string;

beforeEach(() => {
  temp = mkdtempSync(join(tmpdir(), "bzt-eval-test-"));
});
afterEach(() => rmSync(temp, { recursive: true, force: true }));

function runtime() {
  return {
    stdout: vi.fn<(text: string) => void>(),
    stderr: vi.fn<(text: string) => void>(),
  };
}

it("WP-21 / 09 §6 评测资产齐全，路由样本逐条符合实际 MCP 参数", () => {
  verifyEvalAssets(repo);
  const cases = loadEvalCases(casesDir);
  const routes = cases.filter((item) => item.kind === "route");
  for (const [name, contract] of Object.entries(p1Tools)) {
    const matches = routes.filter((item) => item.expectedTool === name);
    expect(matches.length).toBeGreaterThanOrEqual(5);
    for (const item of matches)
      expect(contract.input.safeParse(item.expectedArgs).success).toBe(true);
  }
  expect(
    cases.filter(({ kind }) => kind === "clarification").length,
  ).toBeGreaterThanOrEqual(5);
  expect(
    cases.filter(({ kind }) => kind === "expression").length,
  ).toBeGreaterThanOrEqual(5);
  expect(
    cases.filter(({ kind }) => kind === "safety").length,
  ).toBeGreaterThanOrEqual(5);
});

it.each([
  "cases: !!js/function x",
  '- id: "route-01"\n  id: "route-02"',
  '- id: &anchor "route-01"',
  '- id: "route-01"\n  arbitrary: true',
  '- id: "ROUTE-DUP"\n  kind: "route"\n  prompt: "最近操作"\n  expectedTool: "get_operation"\n  expectedArgs: {"recent":1,"recent":2}',
])("WP-21 拒绝不在评测 YAML 子集中的输入 %#", (yaml) => {
  expect(() => parseEvalYaml(yaml)).toThrow();
});

it("WP-21 / S01 无效用例报告不回显文件名、内容或参数", async () => {
  writeFileSync(join(temp, privateInput + ".yaml"), privateInput);
  const out = join(temp, "report.md");
  const io = runtime();
  expect(
    await runEval(["--agent", "codex", "--cases", temp, "--out", out], io),
  ).toBe(1);
  expect(() => readFileSync(out, "utf8")).toThrow();
  expect(io.stderr).toHaveBeenCalledOnce();
  assertNoSensitiveData(
    [io.stdout.mock.calls, io.stderr.mock.calls],
    [privateInput, temp],
  );
});

it.each([
  [],
  ["--agent", privateInput],
  ["--agent", "codex", "--mode", "test"],
  ["--agent", "codex", "--out", " "],
])("WP-21 拒绝非法评测参数 %#", async (...args) => {
  const io = runtime();
  expect(await runEval(args, io)).toBe(2);
  assertNoSensitiveData(io.stderr.mock.calls, [privateInput]);
});

it("WP-21 离线路径运行真实 MCP 契约，报告只输出用例编号和结果", async () => {
  const out = join(temp, "offline.md");
  expect(await runEval(["--agent", "gemini", "--out", out], runtime())).toBe(0);
  const report = readFileSync(out, "utf8");
  expect(report).toContain("100%");
  expect(report).toContain("离线");
  expect(report).toContain("AC-84");
  expect(report).not.toContain("请删除所有需求");
  assertNoSensitiveData(report);
});

it("WP-21 Node 源码入口调用编译后的 MCP 并写入指定离线报告", () => {
  const out = join(temp, "entrypoint.md");
  const result = spawnSync(
    process.execPath,
    [entrypoint, "--agent", "claude", "--out", out],
    {
      cwd: temp,
      encoding: "utf8",
      timeout: 12000,
      windowsHide: true,
    },
  );
  expect(result.error).toBeUndefined();
  expect(result.status, result.stderr).toBe(0);
  expect(readFileSync(out, "utf8")).toContain("claude");
});

it("WP-21 live 默认关闭；有注入执行器才走受控路径并按失败结果退出", async () => {
  const out = join(temp, "live.md");
  const args = ["--agent", "claude", "--mode", "live", "--out", out];
  const io = runtime();
  expect(await runEval(args, io)).toBe(2);
  expect(() => readFileSync(out, "utf8")).toThrow();
  const execute = vi.fn(async () => ({ calls: [], reply: privateInput }));
  expect(await runEval(args, io, execute)).toBe(1);
  expect(execute).toHaveBeenCalledTimes(loadEvalCases(casesDir).length);
  const report = readFileSync(out, "utf8");
  expect(report).toContain("未通过");
  expect(report).not.toContain(privateInput);
});

it("WP-21 注入执行器使用同一套用例检查返回的调用和回复", async () => {
  const cases = new Map(
    loadEvalCases(casesDir).map((item) => [item.prompt, item]),
  );
  const out = join(temp, "live-pass.md");
  expect(
    await runEval(
      ["--agent", "codex", "--mode", "live", "--out", out],
      runtime(),
      async ({ prompt }) => {
        const item = cases.get(prompt);
        if (!item) throw new Error("未知用例");
        const reply = item.kind === "route" ? "" : item.replyHas.join("，");
        if (item.kind === "route" || item.kind === "expression")
          return {
            calls: [{ name: item.expectedTool, args: item.expectedArgs }],
            reply,
          };
        if (item.kind === "safety" && item.check === "injection")
          return {
            calls: [
              {
                name: "get_story_progress",
                args: { storyId: 31, view: "dev" },
              },
            ],
            reply,
          };
        return { calls: [], reply };
      },
    ),
  ).toBe(0);
  expect(readFileSync(out, "utf8")).toContain("实时 Agent 评测");
});
