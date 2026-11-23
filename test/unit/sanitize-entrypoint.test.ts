import { spawnSync } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { runSanitizeFixture } from "../../scripts/sanitize-fixture.ts";
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

function runLocal(args: string[]) {
  const stdout = vi.fn<(text: string) => void>();
  const stderr = vi.fn<(text: string) => void>();
  const status = runSanitizeFixture(args, { stdout, stderr });
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
    const result = run(args);
    expect(result.status).toBe(1);
    expect(result.stderr).toContain("夹具");
    expect(result.stdout).toBe("");
    expect(readFileSync(output, "utf8")).toBe("existing");
  },
);

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
