import {
  resolveCapabilitiesForVersion,
  type CapabilityId,
} from "../api/capabilities.ts";
import {
  createZentaoReadClient,
  type ZentaoReadClient,
  type ZentaoReadConfig,
} from "../api/client.ts";
import { getCurrentUser, getInstanceConfig, listUsers } from "../api/org.ts";
import { getProductModules, listProducts } from "../api/product.ts";
import type { Clock } from "../core/clock.ts";
import type { ConfigWarning } from "../core/config-checks.ts";
import {
  checkCalendarYear,
  checkZentaoVersion,
  findInvalidAccounts,
  findInvalidModuleKeys,
  findMissingEnv,
  findMissingProducts,
  loadFileConfig,
  readConfigEnvironment,
} from "../core/config.ts";
import type { ConfigEnv, ConfigOverrides, TeamConfig } from "../core/config.ts";
import { BztError } from "../core/errors.ts";
import { checkSqlite } from "../core/store/sqlite.ts";

interface DoctorOptions {
  readonly homeDir?: string;
  readonly clock?: Clock;
  readonly cli?: ConfigOverrides;
  readonly live?: boolean;
  readonly logSink?: (line: string) => void;
}

const redacted = "[已脱敏]";
const versionPattern = /^\d{1,4}(?:\.\d{1,4}){1,3}$/u;

// docs/08 §5 CFG-03–CFG-05：只核对本地配置引用的对象。
async function checkLiveConfiguration(
  client: ZentaoReadClient,
  config: TeamConfig,
  password: string,
) {
  const [products, users] = await Promise.all([
    Object.keys(config.products).length ? listProducts(client) : undefined,
    findInvalidAccounts(config, []).length ? listUsers(client) : undefined,
  ]);
  if (products?.truncated || users?.truncated) {
    throw new BztError(
      "ZENTAO_UNAVAILABLE",
      "禅道配置检查所需目录读取不完整。",
    );
  }
  const productIds = new Set(
    products?.items.filter(({ deleted }) => !deleted).map(({ id }) => id),
  );
  const moduleProducts = new Set(
    Object.keys(config.modules)
      .map((key) => Number(key.split(":", 1)[0]))
      .filter((id) => productIds.has(id)),
  );
  const moduleIds = new Map<number, ReadonlySet<number>>();
  for (const id of moduleProducts) {
    const modules = await getProductModules(client, id);
    moduleIds.set(id, new Set(modules.map((module) => module.id)));
  }
  return {
    missingProducts: findMissingProducts(config, productIds),
    invalidModules: findInvalidModuleKeys(config, moduleIds).map((key) =>
      key.includes(password) ? redacted : key,
    ),
    invalidAccountCount: findInvalidAccounts(config, users?.items ?? []).length,
  };
}

async function checkLiveDoctor(
  config: TeamConfig,
  connection: ZentaoReadConfig,
  localWarning?: ConfigWarning,
) {
  let endpoint = "instance-config";
  let live:
    | {
        version: string;
        URAndSR: boolean;
        account: string;
        writeCapabilities?: "unverified";
        capabilitiesNeedingReverification?: CapabilityId[];
      }
    | undefined;
  const warnings = localWarning ? [localWarning] : [];
  try {
    const client = createZentaoReadClient(connection);
    const instance = await getInstanceConfig(client);
    endpoint = "current-user";
    await getCurrentUser(client);

    const versionCheck = checkZentaoVersion(instance);
    const drifted = resolveCapabilitiesForVersion(instance.version)
      .filter(({ needsReverification }) => needsReverification)
      .map(({ id }) => id);
    if (!versionCheck.ok) warnings.push(versionCheck.warning);
    else if (drifted.length) {
      warnings.push({
        check: "CFG-02",
        severity: "warning",
        message: "实例版本与已验证版本不一致，写能力需要重新验证。",
      });
    }

    const safeVersion =
      versionPattern.exec(instance.version)?.[0] === instance.version &&
      !instance.version.includes(connection.password);
    live = {
      version: safeVersion ? instance.version : redacted,
      URAndSR: instance.URAndSR,
      account: redacted,
      ...(!versionCheck.ok || drifted.length
        ? { writeCapabilities: "unverified" }
        : {}),
      ...(drifted.length ? { capabilitiesNeedingReverification: drifted } : {}),
    };
    endpoint = "team-config";
    const findings = await checkLiveConfiguration(
      client,
      config,
      connection.password,
    );
    const ok =
      !findings.missingProducts.length &&
      !findings.invalidModules.length &&
      !findings.invalidAccountCount;
    return {
      ok,
      live: ok ? live : { ...live, configFindings: findings },
      ...(warnings.length ? { warnings } : {}),
    };
  } catch (error) {
    const code = error instanceof BztError ? error.code : "ZENTAO_UNAVAILABLE";
    return {
      ok: false,
      completeness: "partial",
      gaps: [{ endpoint, code }],
      liveError: { code, message: "禅道只读实连检查未完成。" },
      ...(live ? { live } : {}),
      ...(warnings.length ? { warnings } : {}),
    };
  }
}

export async function getDoctorStatus(
  env: ConfigEnv,
  nodeVersion: string,
  { homeDir, clock, cli, live, logSink }: DoctorOptions = {},
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
    const { zentao, logLevel } = readConfigEnvironment(env);
    const warning =
      configured && clock ? checkCalendarYear(config, clock) : undefined;
    if (live && status.ok) {
      const { account, baseUrl, timeoutMs } = zentao;
      const password = env.ZENTAO_PASSWORD;
      if (!clock || !account || !baseUrl || !password) {
        throw new BztError("INVALID_INPUT", "实连检查所需的环境或时钟未就绪。");
      }
      return {
        ...status,
        ...(await checkLiveDoctor(
          config,
          {
            account,
            baseUrl,
            password,
            clock,
            timezone: config.timezone,
            env: {
              ZENTAO_TIMEOUT_MS: String(timeoutMs),
              BZT_LOG_LEVEL: logLevel,
            },
            logSink,
          },
          warning,
        )),
      };
    }
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
