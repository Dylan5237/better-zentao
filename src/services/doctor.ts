import { requiredEnv } from "../core/config.ts";
import { checkSqlite } from "../core/store/sqlite.ts";

export async function getDoctorStatus(
  env: Readonly<Record<string, string | undefined>>,
  nodeVersion: string,
) {
  const missingEnv = requiredEnv.filter((key) => !env[key]?.trim());
  // 与 package.json engines 对齐。版本由 CLI 从 process.versions.node 注入。
  const minor = /^24\.(\d+)\.\d+$/u.exec(nodeVersion)?.[1];
  const nodeSupported = minor !== undefined && Number(minor) >= 11;
  return {
    ok: nodeSupported && missingEnv.length === 0,
    requiredNode: ">=24.11.0 <25",
    sqlite: nodeSupported ? await checkSqlite() : null,
    missingEnv,
  };
}
