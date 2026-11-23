import { formatLocalDate } from "./calendar.ts";
import type { Clock } from "./clock.ts";
import type { TeamConfig } from "./config.ts";
import { BztError } from "./errors.ts";

export const PROBE_PRODUCT_ID = 29;

export interface ConfigWarning {
  readonly check: "CFG-02" | "CFG-07";
  readonly severity: "warning";
  readonly message: string;
}

// docs/08 §5 CFG-02。调用方只传入已投影的实例设置。
export function checkZentaoVersion(
  instance: Readonly<{ version: string; URAndSR: boolean }>,
) {
  if (instance.version === "22.6" && instance.URAndSR === true)
    return { ok: true } as const;
  const warning: ConfigWarning = {
    check: "CFG-02",
    severity: "warning",
    message: "禅道需为 22.6 且启用三级需求。写能力需要重新验证。",
  };
  return { ok: false, warning, writeCapabilities: "unverified" } as const;
}

// CFG-03
export function findMissingProducts(
  config: Pick<TeamConfig, "products">,
  remoteProductIds: ReadonlySet<number>,
): number[] {
  return Object.keys(config.products)
    .map(Number)
    .filter((id) => !remoteProductIds.has(id));
}

type ModulesByProduct = ReadonlyMap<number, ReadonlySet<number>>;

// CFG-04
export function findInvalidModuleKeys(
  config: Pick<TeamConfig, "modules">,
  remoteModules: ModulesByProduct,
): string[] {
  return Object.keys(config.modules).filter((key) => {
    const separator = key.indexOf(":");
    const productId = Number(key.slice(0, separator));
    const moduleId = Number(key.slice(separator + 1));
    return !remoteModules.get(productId)?.has(moduleId);
  });
}

interface DirectoryAccount {
  readonly account: string;
  readonly deleted: boolean;
}

// CFG-05
export function findInvalidAccounts(
  config: Pick<
    TeamConfig,
    | "modules"
    | "moduleDefaults"
    | "teams"
    | "roles"
    | "aliases"
    | "notify"
    | "snapshot"
  >,
  directory: readonly DirectoryAccount[],
): string[] {
  const active = new Set(
    directory
      .filter((entry) => entry.deleted === false)
      .map((entry) => entry.account),
  );
  const leads = [
    ...Object.values(config.modules),
    ...Object.values(config.moduleDefaults),
  ];
  const accounts = new Set([
    ...leads.flatMap(({ designLead, devLead, testLead }) => [
      designLead,
      devLead,
      testLead,
    ]),
    ...Object.values(config.teams).flatMap(({ lead, members }) => [
      lead,
      ...members,
    ]),
    ...Object.values(config.roles).flat(),
    ...Object.values(config.aliases),
    config.notify.digest.collector,
    config.snapshot.collector,
  ]);
  return [...accounts]
    .filter(
      (account): account is string =>
        account !== undefined && !active.has(account),
    )
    .sort();
}

// CFG-06
export function checkModuleDevLeads(
  config: Pick<TeamConfig, "products" | "modules" | "moduleDefaults">,
  firstLevelModules: ModulesByProduct,
): void {
  const missing: string[] = [];
  const missingLists: number[] = [];
  for (const [productId, product] of Object.entries(config.products)) {
    const id = Number(productId);
    if (
      product.enabled === false ||
      (id === PROBE_PRODUCT_ID && product.probeOnly)
    )
      continue;
    const modules = firstLevelModules.get(id);
    if (modules === undefined) {
      missingLists.push(id);
      continue;
    }
    for (const moduleId of modules) {
      const key = productId + ":" + moduleId;
      const devLead =
        config.modules[key]?.devLead ??
        config.moduleDefaults[productId]?.devLead;
      if (!devLead) missing.push(key);
    }
  }
  if (missing.length || missingLists.length) {
    throw new BztError("CONFIG_MISSING", "请检查一级模块清单及研发主管配置。", {
      ...(missingLists.length ? { products: missingLists } : {}),
      modules: missing,
    });
  }
}

// CFG-07
export function checkCalendarYear(
  config: Pick<TeamConfig, "timezone" | "calendar">,
  clock: Clock,
): ConfigWarning | undefined {
  const year = formatLocalDate(clock(), config.timezone).slice(0, 4);
  if (config.calendar.holidays.some((date) => date.startsWith(year + "-")))
    return undefined;
  return {
    check: "CFG-07",
    severity: "warning",
    message: "工作日历缺少 " + year + " 年的节假日记录。",
  };
}

// CFG-11
export function checkCollector(
  config: Pick<TeamConfig, "notify" | "snapshot">,
  job: "digest" | "snapshot",
  account: string | undefined,
): void {
  const digest = job === "digest";
  const collector = digest
    ? config.notify.digest.collector
    : config.snapshot.collector;
  const name = digest ? "摘要" : "快照";
  if (!collector) {
    throw new BztError("CONFIG_MISSING", "请配置唯一的" + name + "采集账号。", {
      fields: [digest ? "notify.digest.collector" : "snapshot.collector"],
    });
  }
  if (account !== collector) {
    throw new BztError(
      "PERMISSION_DENIED",
      "请使用配置中的唯一" + name + "采集账号。",
      { collector },
    );
  }
}
