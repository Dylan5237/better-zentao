import { mkdtempSync, renameSync, rmSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { parseArgs } from "node:util";
import { sanitizeFixtureInput } from "../src/api/internal/fixture-file.ts";
import { BztError } from "../src/core/errors.ts";

interface FixtureScriptOutput {
  stdout(text: string): void;
  stderr(text: string): void;
}

function writeFixture(path: string, json: string): void {
  const staging = mkdtempSync(join(dirname(path), ".bzt-fixture-"));
  const pending = join(staging, "fixture.json");
  try {
    writeFileSync(pending, json, { encoding: "utf8", mode: 0o600 });
    renameSync(pending, path);
  } finally {
    rmSync(staging, { recursive: true, force: true });
  }
}

export function runSanitizeFixture(
  args: string[],
  output: FixtureScriptOutput,
): number {
  try {
    const { values, positionals } = parseArgs({
      args,
      allowPositionals: true,
      options: { stdin: { type: "boolean" }, out: { type: "string" } },
    });
    if (
      positionals.length !== (values.stdin ? 0 : 1) ||
      positionals.some((path) => !path.trim()) ||
      values.out?.trim() === ""
    ) {
      throw new BztError("INVALID_INPUT", "请提供一个夹具路径或 --stdin。");
    }

    const safe = sanitizeFixtureInput(positionals[0]);
    const json = JSON.stringify(safe, null, 2) + "\n";
    if (values.out === undefined) output.stdout(json);
    else writeFixture(values.out, json);
    return 0;
  } catch {
    // 解析、脱敏与 I/O 异常都可能引用路径或输入，错误出口只用固定文字。
    output.stderr("夹具脱敏失败。请检查参数、JSON 输入和输出路径。\n");
    return 1;
  }
}

if (import.meta.main) {
  process.exitCode = runSanitizeFixture(process.argv.slice(2), {
    stdout: (text) => process.stdout.write(text),
    stderr: (text) => process.stderr.write(text),
  });
}
