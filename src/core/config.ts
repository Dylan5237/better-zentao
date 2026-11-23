import { readFile } from "node:fs/promises";
import { join } from "node:path";
import { z } from "zod";
import { normalizeZentaoBaseUrl } from "./base-url.ts";
import {
  calendarConfig,
  civilDate,
  createWorkCalendar,
  isIanaTimezone,
} from "./calendar.ts";
import { BztError } from "./errors.ts";
import { PROBE_PRODUCT_ID } from "./config-checks.ts";

export {
  checkCalendarYear,
  checkCollector,
  checkModuleDevLeads,
  checkZentaoVersion,
  findInvalidAccounts,
  findInvalidModuleKeys,
  findMissingProducts,
} from "./config-checks.ts";

export { PROBE_PRODUCT_ID };
export const PROBE_APPROVAL_MAX_TTL_MS = 60_000;
const DEFAULT_ZENTAO_TIMEOUT_MS = 15_000;
const timeoutSetting = z
  .string()
  .regex(/^\d+$/u)
  .transform(Number)
  .pipe(z.int().min(1).max(2_147_483_647));

export function resolveZentaoTimeout(
  env?: Readonly<{ ZENTAO_TIMEOUT_MS?: string }>,
): number {
  const value = env?.ZENTAO_TIMEOUT_MS?.trim();
  if (!value) return DEFAULT_ZENTAO_TIMEOUT_MS;

  const timeout = timeoutSetting.safeParse(value);
  if (!timeout.success) {
    throw new BztError(
      "INVALID_INPUT",
      "ZENTAO_TIMEOUT_MS 必须是有效的毫秒数。",
      { fields: ["ZENTAO_TIMEOUT_MS"] },
    );
  }
  return timeout.data;
}

export const probeSettings = z
  .strictObject({
    productId: z.literal(PROBE_PRODUCT_ID).default(PROBE_PRODUCT_ID),
  })
  .default({ productId: PROBE_PRODUCT_ID });

export const requiredEnv = [
  "ZENTAO_BASE_URL",
  "ZENTAO_ACCOUNT",
  "ZENTAO_PASSWORD",
] as const;

const text = z.string().regex(/\S/u);
const positiveInt = z.int().positive();
const nonnegativeInt = z.int().nonnegative();
const idPattern = /^[1-9]\d*$/u;
const idKey = z
  .string()
  .regex(idPattern)
  .refine((key) => Number.isSafeInteger(Number(key)));
const moduleKey = z
  .string()
  .regex(/^[1-9]\d*:[1-9]\d*$/u)
  .refine((key) =>
    key.split(":").every((id) => Number.isSafeInteger(Number(id))),
  );
const timeOfDay = z.string().regex(/^(?:[01]\d|2[0-3]):[0-5]\d$/u);
const quietHours = z.tuple([timeOfDay, timeOfDay]);
const mode = z.enum(["personal", "strict-ai"]);
const executionKind = z.enum(["design", "dev", "ui"]);
const stageName = z.enum([
  "design",
  "review",
  "handoff",
  "dev",
  "interface",
  "test",
  "acceptance",
  "delivery",
]);
const pattern = text.refine((value) => {
  try {
    new RegExp(value, "u");
    return true;
  } catch {
    return false;
  }
});

const leadFields = {
  designLead: text.optional(),
  devLead: text.optional(),
  testLead: text.optional(),
};

const naming = z
  .strictObject({
    l3Plan: z
      .strictObject({
        pattern: text.default("【{owner}】{module}-{yyyy}年{mm}月"),
        matchBy: z.literal("dateOverlap").default("dateOverlap"),
      })
      .prefault({}),
    execution: z
      .strictObject({
        pattern: text.default("【{product}】【{kind}】{yyyy}年{mm}月迭代"),
        kinds: z
          .strictObject({
            design: text.default("设计"),
            dev: text.default("研发"),
            ui: text.default("UI"),
          })
          .prefault({}),
        legacyPatterns: z
          .array(text)
          .default([
            "{mm}月UI设计迭代计划",
            "【{product}】【{kind}】{mm}月迭代",
          ]),
      })
      .prefault({}),
    taskPrefix: z
      .strictObject({
        design: text.default("【设计】"),
        review: text.default("【评审】"),
        handoff: text.default("【传递】"),
        dev: text.default("【研发】"),
        interface: text.default("【接口】"),
        test: text.default("【测试】"),
        acceptance: text.default("【验收】"),
        delivery: text.default("【交付】"),
      })
      .prefault({}),
    legacyTaskPrefixes: z
      .strictObject({
        design: z.array(text).optional(),
        review: z.array(text).optional(),
        handoff: z.array(text).optional(),
        dev: z.array(text).default(["【前端研发】", "【后端开发】"]),
        interface: z.array(text).optional(),
        test: z.array(text).default(["【前端测试】"]),
        acceptance: z.array(text).optional(),
        delivery: z.array(text).optional(),
      })
      .prefault({}),
  })
  .prefault({});

function stage(
  durationDays: number,
  options: {
    after?: z.infer<typeof stageName>;
    startOffset?: number;
    required?: boolean;
  } = {},
) {
  return z
    .strictObject({
      after:
        options.after === undefined
          ? stageName.optional()
          : stageName.default(options.after),
      startOffset: z.int().default(options.startOffset ?? 0),
      durationDays: positiveInt.default(durationDays),
      required: z.boolean().default(options.required ?? true),
    })
    .prefault({});
}

const stageDefaults = z
  .strictObject({
    feature: z
      .strictObject({
        dev: stage(5),
        interface: stage(2, { after: "dev", startOffset: -2, required: false }),
        test: stage(2, { after: "dev" }),
        acceptance: stage(1, { after: "test" }),
        delivery: stage(1, { after: "acceptance", required: false }),
      })
      .prefault({}),
    design: z
      .strictObject({
        design: stage(5),
        review: stage(1, { after: "design" }),
        handoff: stage(1, { after: "review" }),
      })
      .prefault({}),
    assignees: z
      .strictObject({
        test: text.default("team:qa.lead"),
        acceptance: text.default("story.maintainer"),
        delivery: text.default("story.maintainer"),
        review: text.default("module.designLead"),
        handoff: text.default("story.maintainer"),
      })
      .prefault({}),
  })
  .prefault({});

const on = z.boolean().default(true);
const off = z.boolean().default(false);

// docs/04 §5 与 docs/08 §3 定义了各规则阈值与启用阶段。
const rules = z
  .strictObject({
    R01: z.strictObject({ enabled: on }).prefault({}),
    R02: z
      .strictObject({
        enabled: on,
        missingAfter: nonnegativeInt.default(1),
        waitAfter: nonnegativeInt.default(2),
      })
      .prefault({}),
    R03: z
      .strictObject({ enabled: on, after: nonnegativeInt.default(3) })
      .prefault({}),
    R04: z.strictObject({ enabled: on }).prefault({}),
    R05: z.strictObject({ enabled: on }).prefault({}),
    R06: z
      .strictObject({ enabled: off, systemStartDate: civilDate.optional() })
      .prefault({}),
    R07: z
      .strictObject({ enabled: off, after: nonnegativeInt.default(2) })
      .prefault({}),
    R08: z
      .strictObject({ enabled: off, after: nonnegativeInt.default(5) })
      .prefault({}),
    R09: z
      .strictObject({ enabled: off, after: nonnegativeInt.default(5) })
      .prefault({}),
    R10: z
      .strictObject({ enabled: off, fromWorkday: positiveInt.default(5) })
      .prefault({}),
    R11: z
      .strictObject({ enabled: off, after: nonnegativeInt.default(1) })
      .prefault({}),
    R12: z.strictObject({ enabled: off }).prefault({}),
    R13: z
      .strictObject({ enabled: off, beforeRelease: nonnegativeInt.default(3) })
      .prefault({}),
    R14: z
      .strictObject({ enabled: off, olderThanDays: nonnegativeInt.default(30) })
      .prefault({}),
    R15: z
      .strictObject({ enabled: off, after: nonnegativeInt.default(10) })
      .prefault({}),
    R16: z.strictObject({ enabled: off }).prefault({}),
  })
  .prefault({});

const notify = z
  .strictObject({
    channel: z.literal("wecom-robot").default("wecom-robot"),
    digest: z
      .strictObject({
        time: timeOfDay.default("09:00"),
        workdaysOnly: z.boolean().default(true),
        collector: text.optional(),
      })
      .prefault({}),
    events: z
      .array(z.enum(["handoff", "decompose", "assign_other", "release_gate"]))
      .default(["handoff", "decompose", "assign_other", "release_gate"]),
    dedupe: z.literal("per-item-per-day").default("per-item-per-day"),
    quietHours: quietHours.default(["20:00", "08:30"]),
  })
  .prefault({});

export const teamConfigSchema = z
  .strictObject({
    $schema: text.optional(),
    version: z.literal(1).default(1),
    mode: mode.default("personal"),
    timezone: z.string().refine(isIanaTimezone).default("Asia/Shanghai"),
    products: z
      .record(
        idKey,
        z.strictObject({
          name: text,
          state: z.enum(["design", "runtime", "delivery", "other"]),
          projects: z.array(positiveInt).default([]),
          enabled: z.boolean().optional(),
          probeOnly: z.boolean().optional(),
        }),
      )
      .default({}),
    pairs: z
      .array(z.strictObject({ design: positiveInt, runtime: positiveInt }))
      .default([]),
    modules: z
      .record(
        moduleKey,
        z.strictObject({
          name: text,
          ...leadFields,
          team: text.optional(),
        }),
      )
      .default({}),
    moduleDefaults: z.record(idKey, z.strictObject(leadFields)).default({}),
    teams: z
      .record(
        text,
        z.strictObject({
          name: text,
          lead: text,
          members: z.array(text),
          executionKinds: z.array(executionKind).optional(),
        }),
      )
      .default({}),
    roles: z
      .partialRecord(z.enum(["PM", "PJ", "DM", "RM", "QA_LEAD"]), z.array(text))
      .default({}),
    aliases: z.record(text, text).default({}),
    naming,
    versionTag: z
      .strictObject({
        keywordPrefix: text.default("版本:"),
        pattern: pattern.default("^V\\d+\\.\\d+\\.\\d+$"),
      })
      .prefault({}),
    releaseCalendar: z
      .array(
        z.strictObject({
          product: positiveInt,
          version: text,
          date: civilDate,
          owner: text,
        }),
      )
      .default([]),
    legacyReleasePlans: z
      .strictObject({
        until: civilDate,
        titlePattern: pattern.default("^V\\d+\\.\\d+"),
      })
      .optional(),
    stageDefaults,
    rules,
    timeState: z
      .strictObject({ dueSoonWorkdays: nonnegativeInt.default(3) })
      .prefault({}),
    schedule: z
      .strictObject({
        dailyHours: z.number().positive().default(6),
        weeks: positiveInt.default(4),
        suggestTop: positiveInt.default(3),
      })
      .prefault({}),
    calendar: calendarConfig.prefault({}),
    notify,
    wecomMap: z.record(text, text).default({}),
    write: z
      .strictObject({
        planExpiresMinutes: positiveInt.default(10),
        minConfirmDelaySeconds: positiveInt.default(3),
        importMaxRows: positiveInt.default(50),
        disableCapabilities: z.array(text).default([]),
      })
      .prefault({}),
    probe: probeSettings,
    snapshot: z
      .strictObject({
        collector: text.optional(),
        day: positiveInt.max(31).default(1),
        exportDir: text.optional(),
      })
      .prefault({}),
    cache: z
      .strictObject({
        directoryMinutes: nonnegativeInt.default(30),
        metaMinutes: nonnegativeInt.default(30),
        executionMinutes: nonnegativeInt.default(5),
        taskMinutes: nonnegativeInt.default(2),
      })
      .prefault({}),
    http: z.strictObject({ concurrency: positiveInt.default(8) }).prefault({}),
  })
  .superRefine((config, ctx) => {
    const invalidReference = (path: PropertyKey[]) =>
      ctx.addIssue({
        code: "custom",
        path,
        message: "产品未在 products 中声明。",
      });
    if (Object.keys(config.products).length > 0) {
      for (const [index, pair] of config.pairs.entries()) {
        for (const side of ["design", "runtime"] as const) {
          if (!Object.hasOwn(config.products, pair[side]))
            invalidReference(["pairs", index, side]);
        }
      }
    }
    for (const key of Object.keys(config.modules)) {
      const productId = key.split(":", 1)[0] ?? "";
      if (!Object.hasOwn(config.products, productId))
        invalidReference(["modules", key]);
    }
    for (const key of Object.keys(config.moduleDefaults)) {
      if (!Object.hasOwn(config.products, key))
        invalidReference(["moduleDefaults", key]);
    }
    try {
      createWorkCalendar(config.calendar);
    } catch (error) {
      if (!(error instanceof BztError)) throw error;
      ctx.addIssue({
        code: "custom",
        path: ["calendar", "extraWorkdays"],
        message: error.message,
      });
    }
  });

export type TeamConfig = z.output<typeof teamConfigSchema>;

const userConfigSchema = z.strictObject({
  $schema: text.optional(),
  mode: mode.optional(),
  notify: z.strictObject({ quietHours: quietHours.optional() }).optional(),
});

export type ConfigEnv = Readonly<Record<string, string | undefined>>;

export interface ConfigOverrides {
  readonly config?: string;
  readonly product?: string | number;
}

interface ConfigSources {
  readonly env: ConfigEnv;
  readonly homeDir?: string;
  readonly cli?: ConfigOverrides;
}

const credentialField =
  /password|passwd|pwd|token|authorization|bearer|credential|cookie|secret|apikey|privatekey|phpsessid|zentaosid|sessionid|webhook/iu;
const credentialValues = [
  /\bbearer\s+\S+/iu,
  /\b(?:token|authorization|password|x-api-key|zentaosid|phpsessid)["']?\s*[:=]\s*\S+/iu,
  /\beyJ[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+\b/u,
  /\$(?:2[aby]|argon2(?:id|i|d))\$\S+/u,
  /[a-f\d]{32}/iu,
  /-----BEGIN [A-Z ]*PRIVATE KEY-----/u,
];

function hasCredentialField(key: string): boolean {
  return credentialField.test(key.replace(/[^a-z]/giu, ""));
}

function knownCredentials(env: ConfigEnv): string[] {
  const webhook = env.BZT_WECOM_WEBHOOK?.trim() || "";
  const keys: string[] = [];
  const url = URL.parse(webhook);
  if (url) {
    for (const [name, value] of url.searchParams) {
      if (name.toLowerCase() === "key") keys.push(value);
    }
  }
  return [env.ZENTAO_PASSWORD, webhook, ...keys].filter(
    (value): value is string => Boolean(value?.trim()),
  );
}

function hasCredentialValue(value: string, known: readonly string[]): boolean {
  if (
    known.some(
      (secret) =>
        value === secret || (secret.length >= 8 && value.includes(secret)),
    )
  )
    return true;
  if (credentialValues.some((matcher) => matcher.test(value))) return true;
  for (const match of value.matchAll(/https?:\/\/[^\s"'<>]+/giu)) {
    const url = URL.parse(match[0]);
    if (!url) continue;
    if (url.username || url.password) return true;
    for (const name of url.searchParams.keys()) {
      if (name.toLowerCase() === "key" || hasCredentialField(name)) return true;
    }
  }
  return false;
}

function unsafeKey(key: string, known: readonly string[]): boolean {
  return (
    key === "__proto__" ||
    hasCredentialField(key) ||
    hasCredentialValue(key, known)
  );
}

function safeSegment(key: string, known: readonly string[]): string {
  return /^[\p{L}\d_$:-]{1,64}$/u.test(key) &&
    !unsafeKey(key, known) &&
    !known.some((secret) => key.includes(secret))
    ? key
    : "[已脱敏]";
}

function invalidConfig(message: string, fields: readonly string[]): BztError {
  return new BztError("INVALID_INPUT", message, {
    fields: [...new Set(fields)].sort(),
  });
}

function scanConfigCredentials(input: unknown, known: readonly string[]): void {
  const fields: string[] = [];
  const pending = [{ input, path: "" }];
  for (let entry = pending.pop(); entry; entry = pending.pop()) {
    const { input: value, path } = entry;
    if (typeof value === "string" && hasCredentialValue(value, known))
      fields.push(path || "$");
    if (value === null || typeof value !== "object") continue;
    const children: [string, unknown][] = Object.entries(value);
    for (const [key, child] of children) {
      const segment = safeSegment(key, known);
      const childPath = path ? path + "." + segment : segment;
      if (unsafeKey(key, known)) fields.push(childPath);
      else pending.push({ input: child, path: childPath });
    }
  }
  if (fields.length)
    throw invalidConfig("配置中含疑似凭据或不安全字段。", fields);
}

function parseConfig<T>(
  schema: z.ZodType<T>,
  input: unknown,
  known: readonly string[],
): T {
  const result = schema.safeParse(input);
  if (result.success) return result.data;
  const fields = result.error.issues.flatMap((issue) => {
    const paths =
      issue.code === "unrecognized_keys"
        ? issue.keys.map((key) => [...issue.path, key])
        : [issue.path];
    return paths.map(
      (path) =>
        path.map((key) => safeSegment(String(key), known)).join(".") || "$",
    );
  });
  throw invalidConfig("配置字段不合法。", fields);
}

// JSON.parse 已验证语法，但会覆盖重复键。按原文的对象边界核对解码后的键名。
function rejectDuplicateKeys(contents: string, source: string): void {
  const objects: Set<string>[] = [];
  const tokens = /[{}]|("(?:\\.|[^"\\])*")\s*(:)?/gu;
  for (const [token, quoted, colon] of contents.matchAll(tokens)) {
    if (token === "{") objects.push(new Set());
    else if (token === "}") objects.pop();
    else if (quoted && colon) {
      const keys = objects.at(-1);
      const key: string = JSON.parse(quoted);
      if (keys?.has(key))
        throw invalidConfig("配置对象中有重复字段。", [source]);
      keys?.add(key);
    }
  }
}

async function readConfigFile(
  path: string,
  source: string,
  known: readonly string[],
  optional = false,
): Promise<unknown> {
  let contents: string;
  try {
    contents = await readFile(path, "utf8");
  } catch (error) {
    if (
      optional &&
      error instanceof Error &&
      "code" in error &&
      error.code === "ENOENT"
    )
      return undefined;
    throw invalidConfig("无法读取配置文件。", [source]);
  }
  let input: unknown;
  try {
    input = JSON.parse(contents);
  } catch {
    throw invalidConfig("配置文件不是合法 JSON。", [source]);
  }
  rejectDuplicateKeys(contents, source);
  // 必须先扫描原始 JSON，避免敏感字段在投影时消失。
  scanConfigCredentials(input, known);
  return input;
}

function productOverride(
  product: ConfigOverrides["product"],
): number | undefined {
  if (product === undefined) return undefined;
  const value =
    typeof product === "string" && idPattern.test(product)
      ? Number(product)
      : product;
  const result = positiveInt.safeParse(value);
  if (!result.success)
    throw invalidConfig("临时产品范围必须是正整数。", ["--product"]);
  return result.data;
}

export async function loadFileConfig({ env, homeDir, cli }: ConfigSources) {
  const known = knownCredentials(env);
  const teamPath = (cli?.config ?? env.BZT_CONFIG)?.trim();
  if (cli?.config !== undefined && !teamPath) {
    throw invalidConfig("团队配置路径不能为空。", ["--config"]);
  }
  const stateDir =
    env.BZT_HOME?.trim() ||
    (homeDir === undefined ? undefined : join(homeDir, ".better-zentao"));
  const source = cli?.config === undefined ? "BZT_CONFIG" : "--config";
  const teamRaw = teamPath
    ? await readConfigFile(teamPath, source, known)
    : undefined;
  const userRaw = stateDir
    ? await readConfigFile(
        join(stateDir, "config.json"),
        "用户配置",
        known,
        true,
      )
    : undefined;
  const team = parseConfig(
    teamConfigSchema,
    teamRaw === undefined ? {} : teamRaw,
    known,
  );
  const user = parseConfig(
    userConfigSchema,
    userRaw === undefined ? {} : userRaw,
    known,
  );
  if (team.mode === "strict-ai" && user.mode === "personal") {
    throw invalidConfig("个人配置只能收紧团队的写入确认要求。", ["mode"]);
  }
  const config: TeamConfig = {
    ...team,
    mode: user.mode ?? team.mode,
    notify: {
      ...team.notify,
      quietHours: user.notify?.quietHours ?? team.notify.quietHours,
    },
  };
  return {
    config,
    stateDir,
    productId: productOverride(cli?.product),
    configured: teamRaw !== undefined || userRaw !== undefined,
  };
}

export function findMissingEnv(env: ConfigEnv) {
  return requiredEnv.filter((key) => !env[key]?.trim());
}

function hasAbsoluteHttpSyntax(value: string): boolean {
  return /^https?:\/\/[^/\\]/iu.test(value) && !/[\s\\]/u.test(value);
}

function checkBaseUrl(input: string): string {
  const url = hasAbsoluteHttpSyntax(input)
    ? normalizeZentaoBaseUrl(input)
    : null;
  if (url) {
    try {
      if (!/\/api\.php(?:\/|$)/iu.test(decodeURIComponent(url.pathname)))
        return url.href;
    } catch {
      // 非法百分号编码使用同一条脱敏提示。
    }
  }
  throw invalidConfig("禅道基础地址不合法。", ["ZENTAO_BASE_URL"]);
}

const logLevel = z.enum(["debug", "info", "warn", "error"]);

export function resolveLogLevel(env?: Readonly<{ BZT_LOG_LEVEL?: string }>) {
  const parsed = logLevel.safeParse(env?.BZT_LOG_LEVEL?.trim().toLowerCase());
  return parsed.success ? parsed.data : "info";
}

export function readConfigEnvironment(env: ConfigEnv) {
  const baseUrl = env.ZENTAO_BASE_URL?.trim();
  const normalizedBaseUrl = baseUrl ? checkBaseUrl(baseUrl) : undefined;
  const webhook = env.BZT_WECOM_WEBHOOK?.trim();
  if (webhook) {
    const url = hasAbsoluteHttpSyntax(webhook) ? URL.parse(webhook) : null;
    const keys = url?.searchParams.getAll("key") ?? [];
    if (
      url?.pathname !== "/cgi-bin/webhook/send" ||
      keys.length !== 1 ||
      !keys[0]?.trim()
    )
      throw invalidConfig("企微机器人地址不合法。", ["BZT_WECOM_WEBHOOK"]);
  }
  return {
    zentao: {
      baseUrl: normalizedBaseUrl,
      account: env.ZENTAO_ACCOUNT,
      timeoutMs: resolveZentaoTimeout(env),
    },
    logLevel: resolveLogLevel(env),
  };
}

/** docs/08 §1。密码与企微机器人地址由调用方按需从环境取用。 */
export async function loadConfig(
  options: ConfigSources & { readonly homeDir: string },
) {
  const { config, stateDir, productId } = await loadFileConfig(options);
  const {
    logLevel,
    zentao: { baseUrl, account, timeoutMs },
  } = readConfigEnvironment(options.env);
  const missingEnv = findMissingEnv(options.env);
  if (!baseUrl || !account || missingEnv.length) {
    throw new BztError("CONFIG_MISSING", "缺少必填禅道环境变量。", {
      fields: missingEnv,
    });
  }
  return {
    ...config,
    zentao: { baseUrl, account, timeoutMs },
    logLevel,
    stateDir,
    productId,
  };
}
