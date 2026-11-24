import { join, resolve } from "node:path";
import { z } from "zod";
import { createZentaoReadClient } from "../api/client.ts";
import { getInstanceConfig } from "../api/org.ts";
import { toolErrorMessages, toolErrorSchema } from "../contracts/error.ts";
import type { ToolError } from "../contracts/error.ts";
import type { ConfirmOperation, GetOperation } from "../contracts/operation.ts";
import {
  checkZentaoVersion,
  findMissingEnv,
  loadConfig,
} from "../core/config.ts";
import type { ConfigEnv } from "../core/config.ts";
import { BztError } from "../core/errors.ts";
import {
  instanceHashOf,
  openLocalStore,
  sanitizeAccount,
} from "../core/store/index.ts";
import { DirectoryService } from "./directory.ts";
import { FlowService } from "./flow.ts";
import { IntakeService } from "./intake.ts";
import { OperationExecutor } from "./operation.ts";
import { RiskService } from "./risk.ts";
import { ScheduleService } from "./schedule.ts";
import { TrackingService } from "./tracking.ts";
import { createZentaoGateway } from "./zentao-gateway.ts";

export interface WorkbenchRuntime {
  readonly env: ConfigEnv;
  readonly homeDir?: string;
  readonly clock: () => number;
  readonly logSink?: (line: string) => void;
}

const utcTimestamp = new Intl.DateTimeFormat("sv-SE", {
  timeZone: "UTC",
  year: "numeric",
  month: "2-digit",
  day: "2-digit",
  hour: "2-digit",
  minute: "2-digit",
  second: "2-digit",
});

async function assemble(runtime: WorkbenchRuntime | undefined) {
  const missing = findMissingEnv(runtime?.env ?? {});
  const password = runtime?.env.ZENTAO_PASSWORD;
  if (!runtime || !password || missing.length)
    throw new BztError("CONFIG_MISSING", "缺少必填禅道环境变量。", {
      fields: missing,
    });
  const config = await loadConfig(runtime);
  const { baseUrl, account } = config.zentao;
  const { clock, logSink, env } = runtime;
  const client = createZentaoReadClient({
    baseUrl,
    account: account.trim(),
    password,
    clock,
    logSink,
    env,
    timezone: config.timezone,
  });
  const store = openLocalStore({
    baseUrl,
    account,
    clock,
    dbPath: join(
      config.stateDir,
      instanceHashOf(baseUrl),
      sanitizeAccount(account),
      "state.db",
    ),
  });
  const common = { client, config, clock, baseUrl, store };
  const directory = new DirectoryService({
    ...common,
    cache: {
      get(key): unknown {
        const value = store.cache.get(key);
        return value === undefined ? undefined : JSON.parse(value);
      },
      set: (key, value, ttlMs) =>
        store.cache.set(key, JSON.stringify(value), ttlMs),
    },
  });
  const tracking = new TrackingService(common);
  const risk = new RiskService(common);
  const schedule = new ScheduleService(common);
  const createExecutor = (instanceVersion?: string) =>
    new OperationExecutor({
      ...common,
      gateway: createZentaoGateway({
        client,
        account: store.location.account,
        instanceVersion,
        storyRoles: store.storyRoles,
      }),
      channel: "mcp",
      instanceVersion,
    });
  const history = createExecutor();

  async function forWrite() {
    // 每次生成或确认计划都刷新版本，防止运行中的实例升级后沿用旧配方。
    const instance = await getInstanceConfig(client);
    const instanceVersion = checkZentaoVersion(instance).ok
      ? instance.version
      : "unverified";
    const executor = createExecutor(instanceVersion);
    return { ...common, directory, executor, instanceVersion };
  }

  return {
    directory,
    tracking,
    risk,
    schedule,
    reportDir: resolve(config.stateDir, "reports"),
    close: () => store.close(),
    async createStory(input: unknown) {
      return new IntakeService(await forWrite()).createStory(input);
    },
    async importStories(input: unknown) {
      return new IntakeService(await forWrite()).importStories(input);
    },
    async assignStory(input: unknown) {
      return new FlowService({
        ...(await forWrite()),
        storyRoles: store.storyRoles,
      }).assignStory(input);
    },
    async confirmOperation(input: ConfirmOperation) {
      const options = await forWrite();
      const result = await options.executor.confirm(input);
      new IntakeService(options).recordConfirmed(result.opId, result);
      return result;
    },
    getOperation(input: GetOperation) {
      return {
        ok: true,
        data: history.getOperation(input),
        scope: {
          asOf: utcTimestamp.format(clock()).replace(" ", "T") + "Z",
          filters: input,
        },
        completeness: "complete",
        gaps: [],
        inferences: [],
      };
    },
  };
}

export type Workbench = Awaited<ReturnType<typeof assemble>>;

export function createWorkbench(runtime?: WorkbenchRuntime) {
  let pending: Promise<Workbench> | undefined;
  return {
    get() {
      pending ??= assemble(runtime).catch((error: unknown) => {
        pending = undefined;
        throw error;
      });
      return pending;
    },
    close() {
      const current = pending;
      pending = undefined;
      void current
        ?.then((workbench) => workbench.close())
        .catch(() => undefined);
    },
  };
}

const safeField = /^[\p{L}\d_.-]{1,80}$/u;
const credentialText =
  /[\r\n]|(?:password|passwd|pwd|token|authorization|bearer|credential|cookie|secret|apikey|privatekey|webhook)\s*["']?\s*[:=\s]|[a-f\d]{32}|\$(?:2[aby]|argon2(?:id|i|d))\$|\beyJ[\w-]+\.[\w-]+\.[\w-]+\b|https?:\/\//iu;
const candidateSchema = z.union([
  z.string(),
  z.object({
    id: z.union([z.int().positive(), z.string()]).optional(),
    account: z.string().optional(),
    realname: z.string().optional(),
    name: z.string().optional(),
    title: z.string().optional(),
  }),
]);
const detailSchema = z.object({
  fields: z.array(z.string()).optional(),
  missing: z.array(z.string()).optional(),
  candidates: z.array(candidateSchema).optional(),
  capability: z.string().optional(),
});
const publicBusinessSentence =
  /^(?:(?:需求)?标题(?:已存在|不能为空|过长)|(?:该)?需求不存在|缺少必填(?:字段|项)|参数不合法|没有(?:创建|查看)需求的权限)$/u;

export function projectToolError(
  error: unknown,
  env: ConfigEnv = {},
): ToolError {
  const code =
    error instanceof BztError ? error.code : "ZENTAO_SCHEMA_MISMATCH";
  const webhook = URL.parse(env.BZT_WECOM_WEBHOOK ?? "");
  const base = URL.parse(env.ZENTAO_BASE_URL ?? "");
  const secrets = [
    env.ZENTAO_PASSWORD,
    webhook?.searchParams.get("key"),
    webhook?.username,
    webhook?.password,
    base?.username,
    base?.password,
  ];
  const clean = (text: string) =>
    text.length <= 120 &&
    !credentialText.test(text) &&
    !secrets.some((secret) => secret && text.includes(secret))
      ? text
      : "[已脱敏]";
  const parsed =
    error instanceof BztError
      ? detailSchema.safeParse(error.details).data
      : undefined;
  const details: NonNullable<ToolError["details"]> = {};
  for (const key of ["fields", "missing"] satisfies Array<
    "fields" | "missing"
  >) {
    const fields = parsed?.[key];
    if (fields)
      details[key] = fields
        .slice(0, 100)
        .map((field) => (safeField.test(field) ? clean(field) : "[已脱敏]"));
  }
  if (parsed?.capability && safeField.test(parsed.capability))
    details.capability = clean(parsed.capability);
  if (code === "AMBIGUOUS_ENTITY" && parsed?.candidates) {
    details.candidates = parsed.candidates
      .slice(0, 100)
      .map((candidate) =>
        typeof candidate === "string"
          ? clean(candidate)
          : Object.fromEntries(
              Object.entries(candidate).map(([key, value]) => [
                key,
                typeof value === "string" ? clean(value) : value,
              ]),
            ),
      );
  }
  const diagnostic =
    code === "ZENTAO_BUSINESS_ERROR" &&
    error instanceof BztError &&
    error.message.split("。").every((part) => publicBusinessSentence.test(part))
      ? clean(error.message)
      : undefined;
  return toolErrorSchema.parse({
    ok: false,
    code,
    message: diagnostic ?? toolErrorMessages[code],
    ...(Object.keys(details).length ? { details } : {}),
    retryable: code === "ZENTAO_UNAVAILABLE" || code === "ZENTAO_TIMEOUT",
  });
}
