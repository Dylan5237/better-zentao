import { join, resolve } from "node:path";
import { z } from "zod";
import { createZentaoReadClient } from "../api/client.ts";
import { sampleMyActivity } from "../api/my.ts";
import { getStoryDetail } from "../api/story.ts";
import {
  operationPlanSchema,
  type OperationResult,
} from "../contracts/operation.ts";
import {
  getCurrentUser,
  getInstanceConfig,
  getInstanceWebRoute,
} from "../api/org.ts";
import { toolErrorMessages, toolErrorSchema } from "../contracts/error.ts";
import type { ToolError } from "../contracts/error.ts";
import type { ConfirmOperation, GetOperation } from "../contracts/operation.ts";
import {
  checkZentaoVersion,
  findMissingEnv,
  loadConfig,
} from "../core/config.ts";
import { normalizeZentaoBaseUrl } from "../core/base-url.ts";
import { formatLocalDate } from "../core/calendar.ts";
import type { ConfigEnv, TeamConfig } from "../core/config.ts";
import { BztError } from "../core/errors.ts";
import {
  instanceHashOf,
  openLocalStore,
  sanitizeAccount,
} from "../core/store/index.ts";
import { DecomposeService } from "./decompose.ts";
import { ManagementService } from "./management.ts";
import { NotifyService } from "./notify.ts";
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

async function assemble(
  runtime: WorkbenchRuntime | undefined,
  verifyIdentity = false,
  optionalTeamConfig = false,
) {
  const missing = findMissingEnv(runtime?.env ?? {});
  const password = runtime?.env.ZENTAO_PASSWORD;
  if (!runtime || !password || missing.length)
    throw new BztError("CONFIG_MISSING", "缺少必填禅道环境变量。", {
      fields: missing,
    });
  const config = await loadConfig({ ...runtime, optionalTeamConfig });
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
  // Web 登录必须回读本人身份，不能用已有目录缓存接受新提交的密码。
  const viewer = verifyIdentity ? await getCurrentUser(client) : undefined;
  if (viewer && viewer.account !== account.trim())
    throw new BztError("AUTH_FAILED", "登录账号与禅道返回的身份不一致。");
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
  const freshTracking = new TrackingService({ ...common, fresh: true });
  const risk = new RiskService(common);
  const schedule = new ScheduleService(common);
  const management = new ManagementService({ ...common, directory });
  const notify = new NotifyService({ config, env, clock, store, logSink });
  const createExecutor = (instanceVersion?: string) =>
    new OperationExecutor({
      ...common,
      gateway: createZentaoGateway({
        client,
        account: store.location.account,
        instanceVersion,
        storyRoles: store.storyRoles,
        readStepId: (opId, seq) => store.operationSteps.get(opId, seq).zentaoId,
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

  const flow = async () =>
    new FlowService({
      ...(await forWrite()),
      storyRoles: store.storyRoles,
    });

  async function notifyConfirmed(result: OperationResult) {
    const { kind, planJson } = store.operations.get(result.opId);
    const event = new Map([
      ["assign_story", "assign_other"],
      ["decompose_stories", "decompose"],
      ["handoff_story", "handoff"],
    ]).get(kind);
    if (!event || !["confirmed", "partial"].includes(result.status)) return;
    const { plan } = z
      .object({ plan: operationPlanSchema })
      .parse(JSON.parse(planJson));
    const isDesignHandoff =
      event === "handoff" &&
      plan.steps.some(({ action }) => action === "story.create");
    if (isDesignHandoff && result.status === "confirmed") {
      result.nextActions = [
        ...(result.nextActions ?? []),
        ...(plan.warnings ?? [])
          .filter(({ code }) => code === "MANUAL_DESIGN_CLOSE")
          .map(({ message }) => message),
      ];
    }

    const receipts: NonNullable<OperationResult["notified"]> = [];
    for (const row of result.steps) {
      const step = plan.steps[row.seq - 1];
      if (
        !step ||
        row.state !== "done" ||
        row.zentaoId === undefined ||
        step.fields.notify?.value !== true
      )
        continue;
      const account = step.fields.assignedTo?.value;
      const type = step.type;
      if (
        typeof account !== "string" ||
        (type !== "story" && type !== "task") ||
        (event === "assign_other" && account === store.location.account)
      )
        continue;
      if (
        !env.BZT_WECOM_WEBHOOK?.trim() ||
        !config.notify.events.some((kind) => kind === event)
      )
        continue;
      try {
        const name =
          plan.affects
            ?.find((person) => person.startsWith(account + " "))
            ?.slice(account.length + 1) ?? account;
        const title =
          type === "task"
            ? step.fields.name?.value
            : (await getStoryDetail(client, row.zentaoId)).title;
        const outcome = await notify.notifyEvent({
          event,
          type,
          id: row.zentaoId,
          title,
          status: type === "task" ? "已拆解" : "已指派",
          deadline: step.fields.deadline?.value,
          targets: [{ account, realname: name }],
        });
        receipts.push(...outcome.notified);
      } catch {
        receipts.push({ target: account, channel: "wecom", state: "failed" });
      }
    }
    result.notified = receipts;
  }

  return {
    viewer,
    portalReadSources: {
      cache: store.cache,
      currentMonth: () => formatLocalDate(clock(), config.timezone).slice(0, 7),
      sampleActivity: () => sampleMyActivity(client),
      instance: () => getInstanceWebRoute(client),
      baseUrl,
      freshTracking,
    },
    get releaseCalendar() {
      return config.releaseCalendar.map(({ product, version, date }) => ({
        product,
        version,
        date,
      }));
    },
    portalTeams() {
      const designers = config.teams.design;
      const developmentTeams = Object.entries(config.teams)
        .filter(
          ([key, team]) =>
            ["fe", "be"].includes(key) ||
            team.executionKinds?.some(
              (kind) => kind === "dev" || kind === "ui",
            ),
        )
        .map(([id, team]) => ({
          id,
          name: team.name,
          members: [...new Set([team.lead, ...team.members])],
        }));
      return {
        developmentTeams,
        designMaintainers: designers
          ? [...new Set([designers.lead, ...designers.members])].map(
              (account) => ({
                account,
                lead: account === designers.lead,
                ...(viewer?.account === account && viewer.realname
                  ? { realname: viewer.realname }
                  : {}),
              }),
            )
          : undefined,
      };
    },
    get roles() {
      return config.roles;
    },
    updateRoles(roles: TeamConfig["roles"]) {
      config.roles = roles;
    },
    intakeCatalog() {
      const products = Object.entries(config.products)
        .filter(
          ([, product]) => product.enabled !== false && !product.probeOnly,
        )
        .map(([id, product]) => ({
          id: Number(id),
          name: product.name,
          modules: Object.entries(config.modules)
            .filter(([key]) => key.startsWith(id + ":"))
            .map(([key, module]) => ({
              id: Number(key.split(":")[1]),
              path: module.name,
              designLead:
                module.designLead ?? config.moduleDefaults[id]?.designLead,
              devLead: module.devLead ?? config.moduleDefaults[id]?.devLead,
            })),
        }));
      return { products };
    },
    directory,
    management,
    async decomposeStories(input: unknown) {
      return new DecomposeService({
        ...(await forWrite()),
        stageRequirements: store.stageRequirements,
        storyRoles: store.storyRoles,
      }).decomposeStories(input);
    },
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
      return (await flow()).assignStory(input);
    },
    async handoffStory(input: unknown) {
      return (await flow()).handoffStory(input);
    },
    async rescheduleStory(input: unknown) {
      return (await flow()).rescheduleStory(input);
    },
    async closeStories(input: unknown) {
      return (await flow()).closeStories(input);
    },
    async setStoryMeta(input: unknown) {
      return (await flow()).setStoryMeta(input);
    },
    async confirmOperation(input: ConfirmOperation) {
      const options = await forWrite();
      const result = await options.executor.confirm(input);
      new IntakeService(options).recordConfirmed(result.opId, result);
      new FlowService({
        ...options,
        storyRoles: store.storyRoles,
      }).recordConfirmed(result.opId, result);
      await notifyConfirmed(result);
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

export function openAuthenticatedWorkbench(
  runtime: WorkbenchRuntime,
  optionalTeamConfig = false,
) {
  return assemble(runtime, true, optionalTeamConfig);
}

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
  manual: z
    .object({
      kind: z.enum(["subtasks", "story_spec"]),
      id: z.int().positive(),
    })
    .optional(),
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
  const manual = parsed?.manual;
  const root = normalizeZentaoBaseUrl(env.ZENTAO_BASE_URL ?? "");
  let guidance: string | undefined;
  if (
    manual &&
    root &&
    (code === "CAPABILITY_UNVERIFIED" || code === "CAPABILITY_DISABLED")
  ) {
    const isTask = manual.kind === "subtasks";
    const label = isTask ? "在禅道打开父任务" : "在禅道编辑需求正文";
    const url = new URL(
      isTask ? "index.php" : "story-edit-" + manual.id + ".html",
      root,
    );
    if (isTask) {
      url.searchParams.set("m", "task");
      url.searchParams.set("f", "view");
      url.searchParams.set("taskID", String(manual.id));
    }
    if (!secrets.some((secret) => secret && url.href.includes(secret))) {
      details.links = [{ label, url: url.href }];
      guidance = isTask
        ? "L4 子任务创建尚未验证，请在禅道父任务中手工创建。"
        : "禅道 22.6 正文编辑尚未验证，请在禅道手工编辑。";
    }
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
    message: guidance ?? diagnostic ?? toolErrorMessages[code],
    ...(Object.keys(details).length ? { details } : {}),
    retryable: code === "ZENTAO_UNAVAILABLE" || code === "ZENTAO_TIMEOUT",
  });
}
