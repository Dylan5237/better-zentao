import { requiredEnv } from "../core/config.ts";
import { checkSqlite } from "../core/store/sqlite.ts";

export function getDoctorStatus(
  env: Readonly<Record<string, string | undefined>>,
) {
  const missingEnv = requiredEnv.filter((key) => !env[key]?.trim());
  return { ok: missingEnv.length === 0, sqlite: checkSqlite(), missingEnv };
}
