import { spawnSync } from "node:child_process";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, beforeEach, expect, it } from "vitest";
import { assertNoSensitiveData } from "../helpers/assert-no-sensitive-data.ts";

const command = fileURLToPath(
  new URL("../../dist/adapters/cli/bzt.js", import.meta.url),
);
const syntheticCredential = "bzt-integration-test-secret";
const credentialsEnv = {
  ZENTAO_BASE_URL: "https://fixture.test",
  ZENTAO_ACCOUNT: "acct_test",
  ZENTAO_PASSWORD: syntheticCredential,
};
let homeDir: string;
beforeEach(() => {
  homeDir = mkdtempSync(join(tmpdir(), "bzt-cli-"));
});
afterEach(() => {
  rmSync(homeDir, { recursive: true, force: true });
});

function run(args: string[], input?: string, env: NodeJS.ProcessEnv = {}) {
  const result = spawnSync(process.execPath, [command, ...args], {
    input,
    encoding: "utf8",
    timeout: 6000,
    windowsHide: true,
    env: {
      SystemRoot: process.env.SystemRoot,
      USERPROFILE: homeDir,
      HOME: homeDir,
      ...env,
    },
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
  const result = run(["doctor"], undefined, credentialsEnv);
  expect(result.status).toBe(0);
  expect(JSON.parse(result.stdout)).toMatchObject({ ok: true, missingEnv: [] });
});

it.each(["team", "user"])(
  "CFG-10 %s 错误路径隐藏短密码和机器人密钥",
  (source) => {
    const state = join(homeDir, ".better-zentao");
    mkdirSync(state);
    const path =
      source === "team"
        ? join(homeDir, "team.json")
        : join(state, "config.json");
    const password = "q7x9";
    const key = "g4k2";
    writeFileSync(
      path,
      JSON.stringify({ ["setting_" + password]: 1, ["setting_" + key]: 2 }),
    );
    const result = run(["doctor"], undefined, {
      ...credentialsEnv,
      ZENTAO_PASSWORD: password,
      BZT_WECOM_WEBHOOK: "https://fixture.test/cgi-bin/webhook/send?key=" + key,
      ...(source === "team" ? { BZT_CONFIG: path } : {}),
    });
    expect(result.status).toBe(1);
    assertNoSensitiveData([result.stdout, result.stderr], [password, key]);
    expect(JSON.parse(result.stdout).configError.details.fields).toEqual([
      "[已脱敏]",
    ]);
  },
);

it("WP-02 doctor 可加载有效的 BZT_CONFIG，日历未覆盖时告警但退出码为 0", () => {
  const path = join(homeDir, "team.json");
  writeFileSync(
    path,
    '{"version":1,"probe":{"productId":29},"calendar":{"holidays":[]}}',
  );
  const webhook =
    "https://fixture.test/cgi-bin/webhook/send?key=fixture-integration-key";
  const result = run(["doctor"], undefined, {
    ...credentialsEnv,
    BZT_CONFIG: path,
    BZT_WECOM_WEBHOOK: webhook,
  });
  expect(result.status).toBe(0);
  expect(JSON.parse(result.stdout)).toMatchObject({
    ok: true,
    warnings: [{ check: "CFG-07", severity: "warning" }],
  });
  assertNoSensitiveData(
    [result.stdout, result.stderr],
    [path, webhook, "fixture-integration-key"],
  );
});

it("CFG-10 / S01 doctor 拒绝包含凭据的团队文件，标准输出与错误输出均脱敏", () => {
  const path = join(homeDir, "team.json");
  const key = "bzt-file-key-fixture-only";
  writeFileSync(
    path,
    JSON.stringify({
      aliases: { 角色: "https://fixture.test/webhook?key=" + key },
    }),
  );
  const result = run(["doctor"], undefined, {
    ...credentialsEnv,
    BZT_CONFIG: path,
  });
  expect(result.status).toBe(1);
  expect(JSON.parse(result.stdout)).toMatchObject({
    ok: false,
    configError: {
      code: "INVALID_INPUT",
      message: expect.stringContaining("疑似凭据"),
      details: { fields: ["aliases.角色"] },
    },
  });
  assertNoSensitiveData([result.stdout, result.stderr], [path, key]);
});

it("CFG-12 doctor 检查个人配置并阻止越权覆盖", () => {
  const state = join(homeDir, ".better-zentao");
  mkdirSync(state);
  writeFileSync(join(state, "config.json"), '{"probe":{"productId":43}}');
  const result = run(["doctor"], undefined, credentialsEnv);
  expect(result.status).toBe(1);
  expect(JSON.parse(result.stdout)).toMatchObject({
    ok: false,
    configError: { code: "INVALID_INPUT", details: { fields: ["probe"] } },
  });
});

it("CFG-12 传入 CLI 覆盖时，--config 优先且 --product 不能改写探查产品", () => {
  const path = join(homeDir, "cli-team.json");
  writeFileSync(path, '{"probe":{"productId":29}}');
  const args = ["doctor", "--config", path, "--product", "43"];
  const env = { ...credentialsEnv, BZT_CONFIG: join(homeDir, "missing.json") };
  expect(run(args, undefined, env).status).toBe(0);
  writeFileSync(path, '{"probe":{"productId":43}}');
  const result = run(args, undefined, env);
  expect(result.status).toBe(1);
  expect(JSON.parse(result.stdout)).toMatchObject({
    ok: false,
    configError: {
      code: "INVALID_INPUT",
      details: { fields: ["probe.productId"] },
    },
  });
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
