import { readFileSync } from "node:fs";
import type { SanitizedJson } from "../../core/dto/fixture.ts";
import { BztError } from "../../core/errors.ts";
import { createFixtureSanitizer } from "./fixture-sanitizer.ts";

export function sanitizeFixtureInput(path?: string): SanitizedJson {
  let input: unknown;
  try {
    input = JSON.parse(readFileSync(path ?? 0, "utf8"));
  } catch {
    throw new BztError("INVALID_INPUT", "夹具输入不可读或不是合法 JSON。");
  }
  return createFixtureSanitizer().sanitize(input);
}
