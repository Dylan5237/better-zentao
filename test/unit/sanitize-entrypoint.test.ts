import { spawnSync } from "node:child_process";
import {
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { runSanitizeFixture } from "../../scripts/sanitize-fixture.ts";
import * as fixtureFile from "../../src/api/internal/fixture-file.ts";
import * as engine from "../../src/api/internal/fixture-sanitizer.ts";
import { assertNoSensitiveData } from "../helpers/assert-no-sensitive-data.ts";

const entrypoint = fileURLToPath(
  new URL("../../scripts/sanitize-fixture.ts", import.meta.url),
);
const tempPrefix = fileURLToPath(
  new URL("../../.bzt-sanitize-test-", import.meta.url),
);
const hash = "a1eabec4c16b37021d87a0944618abcd";
const localInput = "synthetic-local-private-input";
const failureMessage = "夹具脱敏失败。请检查参数、JSON 输入和输出路径。\n";
let tempDir: string;

function run(args: string[], input?: string) {
  const result = spawnSync(process.execPath, [entrypoint, ...args], {
    input,
    encoding: "utf8",
    timeout: 4000,
    windowsHide: true,
  });
  expect(result.error).toBeUndefined();
  assertNoSensitiveData([result.stdout, result.stderr], [hash, localInput]);
  return result;
}

function runLocal(args: string[], sanitize = runSanitizeFixture) {
  const stdout = vi.fn<(text: string) => void>();
  const stderr = vi.fn<(text: string) => void>();
  const status = sanitize(args, { stdout, stderr });
  assertNoSensitiveData(
    [stdout.mock.calls, stderr.mock.calls],
    [hash, localInput],
  );
  return { status, stdout, stderr };
}

beforeEach(() => {
  tempDir = mkdtempSync(tempPrefix);
});

afterEach(() => {
  rmSync(tempDir, { recursive: true, force: true });
  vi.restoreAllMocks();
});

it.each([201, 404])(
  "WP-03 脱敏脚本文件输入与 --out 保留响应状态 %i 和字符串 ID",
  (status) => {
    const source = join(tempDir, "input.json");
    const output = join(tempDir, "output.json");
    writeFileSync(
      source,
      JSON.stringify({
        status,
        body: { id: "11", password: hash, title: localInput },
      }),
    );
    const result = runLocal([source, "--out", output]);
    expect(result.status).toBe(0);
    expect(result.stdout).not.toHaveBeenCalled();
    const sanitized: unknown = JSON.parse(readFileSync(output, "utf8"));
    expect(sanitized).toMatchObject({ status, body: { id: "11" } });
    assertNoSensitiveData(sanitized, [hash, localInput]);
  },
);

it("WP-03 脱敏脚本读取 --stdin，只把脱敏 JSON 写到 stdout", () => {
  const result = run(["--stdin"], JSON.stringify({ id: "11", token: hash }));
  expect(result.status).toBe(0);
  expect(result.stderr).toBe("");
  expect(JSON.parse(result.stdout)).toEqual({ id: "11" });
});

it("WP-03 脱敏脚本拒绝标准输入中的损坏 JSON", () => {
  const result = run(["--stdin"], "{" + localInput);
  expect(result.status).toBe(1);
  expect(result.stdout).toBe("");
  expect(result.stderr).toBe(failureMessage);
});

it("WP-03 脱敏脚本读取本地文件并输出脱敏 JSON", () => {
  const source = join(tempDir, "input.json");
  writeFileSync(source, JSON.stringify({ id: "11", token: hash }));

  const { status, stdout, stderr } = runLocal([source]);

  expect(status).toBe(0);
  expect(stderr).not.toHaveBeenCalled();
  expect(stdout).toHaveBeenCalledTimes(1);
  expect(JSON.parse(stdout.mock.lastCall?.[0] ?? "")).toEqual({ id: "11" });
});

it.each(["损坏 JSON", "缺失文件", "互斥输入", "未知选项"])(
  "WP-03 脱敏脚本安全拒绝%s且保留已有文件",
  (kind) => {
    const source = join(tempDir, localInput + ".json");
    const output = join(tempDir, "output.json");
    writeFileSync(output, "existing");
    if (kind === "损坏 JSON") writeFileSync(source, "{" + localInput);
    const args = [source, "--out", output];
    if (kind === "互斥输入") args.push("--stdin");
    if (kind === "未知选项") args.push("--" + localInput);
    const { status, stdout, stderr } = runLocal(args);
    expect(status).toBe(1);
    expect(stderr).toHaveBeenCalledExactlyOnceWith(failureMessage);
    expect(stdout).not.toHaveBeenCalled();
    expect(readFileSync(output, "utf8")).toBe("existing");
  },
);

it.each(["输入", "输出"])("WP-03 脱敏脚本拒绝空白%s路径", (kind) => {
  const source = join(tempDir, "missing.json");
  const args = kind === "输入" ? [" "] : [source, "--out", " "];
  const readInput = vi.spyOn(fixtureFile, "sanitizeFixtureInput");

  const { status, stdout, stderr } = runLocal(args);

  expect(status).toBe(1);
  expect(readInput).not.toHaveBeenCalled();
  expect(stdout).not.toHaveBeenCalled();
  expect(stderr).toHaveBeenCalledExactlyOnceWith(failureMessage);
});

it("WP-03 脱敏脚本重命名失败时清除暂存目录并保留目标内容", () => {
  const source = join(tempDir, "input.json");
  const target = join(tempDir, "out.json");
  const existing = join(target, "existing.json");
  writeFileSync(source, "{}");
  mkdirSync(target);
  writeFileSync(existing, "existing");

  const { status, stdout, stderr } = runLocal([source, "--out", target]);

  expect(status).toBe(1);
  expect(stdout).not.toHaveBeenCalled();
  expect(stderr).toHaveBeenCalledExactlyOnceWith(failureMessage);
  expect(readdirSync(tempDir).sort()).toEqual(["input.json", "out.json"]);
  expect(readFileSync(existing, "utf8")).toBe("existing");
});

it.each([false, true])(
  "WP-03 二次复扫拒绝输出时不创建或覆盖目标文件（已有文件 %s）",
  (existing) => {
    const source = join(tempDir, "input.json");
    const target = join(tempDir, "out.json");
    writeFileSync(source, "{}");
    if (existing) writeFileSync(target, "existing");
    const sanitize = () => {
      engine.assertSanitizedJson({ title: "Bearer " + localInput });
      return null;
    };
    vi.spyOn(engine, "createFixtureSanitizer").mockReturnValue({
      sanitize,
      sanitizeBatch: () => [sanitize()],
    });

    const { status, stdout, stderr } = runLocal([source, "--out", target]);
    expect(status).toBe(1);
    expect(stdout).not.toHaveBeenCalled();
    expect(stderr).toHaveBeenCalledWith(
      expect.stringContaining("夹具脱敏失败"),
    );
    if (existing) expect(readFileSync(target, "utf8")).toBe("existing");
    else expect(() => readFileSync(target, "utf8")).toThrow();
  },
);

it("WP-03 脱敏脚本在进程内从标准输入读取 JSON", async () => {
  const readStdin = vi.fn(() => JSON.stringify({ id: "11", token: hash }));
  vi.resetModules();
  vi.doMock("node:fs", async (importOriginal) => ({
    ...(await importOriginal<typeof import("node:fs")>()),
    readFileSync: readStdin,
  }));
  try {
    const { runSanitizeFixture: sanitizeFromStdin } =
      await import("../../scripts/sanitize-fixture.ts");
    const { status, stdout, stderr } = runLocal(["--stdin"], sanitizeFromStdin);

    expect(readStdin).toHaveBeenCalledExactlyOnceWith(0, "utf8");
    expect(status).toBe(0);
    expect(stderr).not.toHaveBeenCalled();
    expect(stdout).toHaveBeenCalledTimes(1);
    expect(JSON.parse(stdout.mock.lastCall?.[0] ?? "")).toEqual({ id: "11" });
  } finally {
    vi.doUnmock("node:fs");
    vi.resetModules();
  }
});
