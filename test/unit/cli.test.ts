import { expect, it, vi } from "vitest";
import { runCli } from "../../src/adapters/cli/run-cli.ts";

function localRuntime() {
  return {
    stdout: vi.fn<(text: string) => void>(),
    stderr: vi.fn<(text: string) => void>(),
    nodeVersion: "24.11.0",
    env: {},
  };
}

it("WP-00 空命令显示本地使用帮助", async () => {
  const runtime = localRuntime();
  await expect(runCli([], runtime)).resolves.toBe(0);
  expect(runtime.stdout).toHaveBeenCalledExactlyOnceWith(
    expect.stringContaining("bzt mcp"),
  );
  expect(runtime.stderr).not.toHaveBeenCalled();
});

it.each([
  ["多余参数", ["mcp", "extra"]],
  ["未实现命令", ["probe"]],
  ["未知选项", ["--unknown"]],
])("WP-00 拦截%s", async (_name, args) => {
  const runtime = localRuntime();
  await expect(runCli(args, runtime)).resolves.toBe(2);
  expect(runtime.stdout).not.toHaveBeenCalled();
  expect(runtime.stderr).toHaveBeenCalledExactlyOnceWith(
    expect.stringContaining("参数不合法"),
  );
});

it("CFG-01 doctor 退出状态由本地配置检查决定", async () => {
  const runtime = localRuntime();
  await expect(runCli(["doctor"], runtime)).resolves.toBe(1);
  const [line] = runtime.stdout.mock.calls[0] ?? [];
  expect(JSON.parse(line ?? "")).toMatchObject({ node: "24.11.0", ok: false });
  expect(runtime.stderr).not.toHaveBeenCalled();
});
