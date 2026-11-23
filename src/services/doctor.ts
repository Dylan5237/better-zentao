import type { Clock } from "../core/clock.ts";
import {
  checkCalendarYear,
  findMissingEnv,
  loadFileConfig,
  readConfigEnvironment,
} from "../core/config.ts";
import type { ConfigEnv, ConfigOverrides } from "../core/config.ts";
import { BztError } from "../core/errors.ts";
import { checkSqlite } from "../core/store/sqlite.ts";

interface DoctorOptions {
  readonly homeDir?: string;
  readonly clock?: Clock;
  readonly cli?: ConfigOverrides;
}

export async function getDoctorStatus(
  env: ConfigEnv,
  nodeVersion: string,
  { homeDir, clock, cli }: DoctorOptions = {},
) {
  const missingEnv = findMissingEnv(env);
  // CFG-13 须先于 Node 24 专用的配置和 SQLite 检查。
  const minor = /^24\.(\d+)\.\d+$/u.exec(nodeVersion)?.[1];
  const nodeSupported = minor !== undefined && Number(minor) >= 11;
  const status = {
    ok: nodeSupported && missingEnv.length === 0,
    requiredNode: ">=24.11.0 <25",
    sqlite: nodeSupported ? await checkSqlite() : null,
    missingEnv,
  };
  if (!nodeSupported) return status;
  try {
    const { config, configured } = await loadFileConfig({ env, homeDir, cli });
    readConfigEnvironment(env);
    const warning =
      configured && clock ? checkCalendarYear(config, clock) : undefined;
    return warning ? { ...status, warnings: [warning] } : status;
  } catch (error) {
    if (!(error instanceof BztError)) throw error;
    return {
      ...status,
      ok: false,
      configError: {
        code: error.code,
        message: error.message,
        details: error.details,
      },
    };
  }
}
