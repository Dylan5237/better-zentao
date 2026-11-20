import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { expect, it } from "vitest";
import { assertNoSensitiveData } from "../helpers/assert-no-sensitive-data.ts";

const command = fileURLToPath(
  new URL("../../dist/adapters/cli/bzt.js", import.meta.url),
);
const syntheticCredential = "bzt-integration-test-secret";

function run(args: string[], input?: string, env: NodeJS.ProcessEnv = {}) {
  const result = spawnSync(process.execPath, [command, ...args], {
    input,
    encoding: "utf8",
    timeout: 6000,
    windowsHide: true,
    env: { SystemRoot: process.env.SystemRoot, ...env },
  });
  expect(result.error).toBeUndefined();
  assertNoSensitiveData(result.stderr, [syntheticCredential]);
  assertNoSensitiveData(result.stdout, [syntheticCredential]);
  return result;
}

it("WP-00 编译后的 bzt --help 可用", () => {
  const result = run(["--help"]);
  expect(result.status).toBe(0);
  expect(result.stdout).toContain("bzt doctor");
  expect(result.stdout).toContain("bzt mcp");
});

it("WP-00 错误命令只写 stderr 且不复述参数", () => {
  const result = run(["--" + syntheticCredential]);
  expect(result.status).toBe(2);
  expect(result.stdout).toBe("");
  expect(result.stderr).toContain("参数不合法");
});

it("CFG-01 编译后的 doctor 离线检查配置", () => {
  const result = run(["doctor"], undefined, {
    ZENTAO_BASE_URL: "https://fixture.test",
    ZENTAO_ACCOUNT: "acct_test",
    ZENTAO_PASSWORD: syntheticCredential,
  });
  expect(result.status).toBe(0);
  expect(JSON.parse(result.stdout)).toMatchObject({ ok: true, missingEnv: [] });
});

it("CFG-01 缺少必填环境变量时返回非零状态和变量名", () => {
  const result = run(["doctor"]);
  expect(result.status).toBe(1);
  expect(JSON.parse(result.stdout)).toMatchObject({
    ok: false,
    missingEnv: ["ZENTAO_BASE_URL", "ZENTAO_ACCOUNT", "ZENTAO_PASSWORD"],
  });
});

it("WP-00 离线 MCP initialize 的 stdout 只有一条 JSON-RPC 响应", () => {
  const init = {
    jsonrpc: "2.0",
    id: 17,
    method: "initialize",
    params: {
      protocolVersion: "2024-11-05",
      capabilities: {},
      clientInfo: { name: "offline-test", version: "1.0.0" },
    },
  };
  const result = run(["mcp"], JSON.stringify(init) + "\n");
  expect(result.status).toBe(0);
  const frames = result.stdout.trimEnd().split("\n");
  expect(frames).toHaveLength(1);
  expect(JSON.parse(frames[0] ?? "")).toMatchObject({
    jsonrpc: "2.0",
    id: 17,
    result: {
      protocolVersion: init.params.protocolVersion,
      serverInfo: { name: "better-zentao" },
    },
  });
});
