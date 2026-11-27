import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { runCli } from "../../src/adapters/cli/run-cli.ts";
import { assertNoSensitiveData } from "../helpers/assert-no-sensitive-data.ts";

const runtime = () => ({
  stdout: vi.fn<(line: string) => void>(),
  stderr: vi.fn<(line: string) => void>(),
  nodeVersion: "24.11.0",
  clock: () => 0,
  env: {},
  homeDir: root,
});
const blockedFetch = vi.fn<typeof fetch>(async () => {
  throw new Error("离线测试禁止出站。");
});
let root: string;

beforeEach(async () => {
  blockedFetch.mockClear();
  vi.stubGlobal("fetch", blockedFetch);
  root = await mkdtemp(join(tmpdir(), "bzt-server-cli-"));
});

afterEach(async () => {
  vi.unstubAllGlobals();
  await rm(root, { recursive: true, force: true });
  expect(blockedFetch).not.toHaveBeenCalled();
});

it.each([["--help"], ["serve", "--help"]])(
  "SRV-REG-01/02 帮助列出集中入口和 --server-config（%s）",
  async (...args) => {
    const output = runtime();
    expect(await runCli(args, output)).toBe(0);
    expect(output.stdout.mock.calls.flat().join("")).toMatch(
      /\bbzt serve\b[^\n]*--server-config\b/u,
    );
    expect(output.stderr).not.toHaveBeenCalled();
  },
);

it("SRV-REG-01/02 新命令保留本机 Web 和 stdio MCP 入口", async () => {
  const output = runtime();
  expect(await runCli(["--help"], output)).toBe(0);
  const help = output.stdout.mock.calls.flat().join("");
  expect(help).toContain("bzt web");
  expect(help).toContain("bzt mcp");

  const web = runtime();
  expect(await runCli(["web", "--host", "0.0.0.0"], web)).toBe(2);
  const doctor = runtime();
  expect(await runCli(["doctor"], doctor)).toBe(1);
  expect(JSON.parse(doctor.stdout.mock.calls.flat().join(""))).toMatchObject({
    node: "24.11.0",
    ok: false,
  });
});

it.each([
  ["--unsupported-flag"],
  ["--server-config"],
  ["--server-config", " "],
  ["--server-config", "first.json", "--server-config", "second.json"],
])("serve 非法参数退出码为 2（%s）", async (...args) => {
  const output = runtime();
  expect(await runCli(["serve", ...args], output)).toBe(2);
  expect(output.stderr).toHaveBeenCalled();
  expect(output.stdout).not.toHaveBeenCalled();
});

it("serve 缺少 --server-config 时退出并给出诊断", async () => {
  const output = runtime();
  expect(await runCli(["serve"], output)).not.toBe(0);
  expect(output.stderr).toHaveBeenCalled();
  expect(output.stdout).not.toHaveBeenCalled();
});

it.each(["不存在", "JSON 损坏", "不符合 schema"])(
  "serve 的配置文件%s时安全退出",
  async (kind) => {
    const output = runtime();
    const file = join(root, "server.json");
    const marker = "synthetic-serve-config-private-value";
    if (kind !== "不存在")
      await writeFile(
        file,
        kind === "JSON 损坏"
          ? `{"value":"${marker}"`
          : JSON.stringify({ version: 1, password: marker }),
        "utf8",
      );
    expect(await runCli(["serve", "--server-config", file], output)).not.toBe(
      0,
    );
    expect(output.stderr).toHaveBeenCalled();
    expect(output.stdout).not.toHaveBeenCalled();
    assertNoSensitiveData(
      [output.stderr.mock.calls, output.stdout.mock.calls],
      [marker],
    );
  },
);
