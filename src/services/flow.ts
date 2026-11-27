import { z } from "zod";
import { getCapability } from "../api/capabilities.ts";
import type { ZentaoReadClient } from "../api/client.ts";
import { createZentaoBusinessProvider } from "./providers/zentao-business-provider.ts";
import type { BusinessProvider } from "./ports/business-provider.ts";
import {
  operationPlanSchema,
  type OperationResult,
  type OperationStep,
  type PreparedOperation,
} from "../contracts/operation.ts";
import { assignStoryInputSchema } from "../contracts/tools/assign_story.ts";
import { closeStoriesInputSchema } from "../contracts/tools/close_stories.ts";
import { handoffStoryInputSchema } from "../contracts/tools/handoff_story.ts";
import {
  normalizedMonthSchema,
  rescheduleStoryInputSchema,
} from "../contracts/tools/reschedule_story.ts";
import {
  metaRolesSchema,
  setStoryMetaInputSchema,
  stageRequirementsSchema,
  waiverSchema,
} from "../contracts/tools/set_story_meta.ts";
import type { ResolveContextInput } from "../contracts/tools/resolve_context.ts";
import { normalizeZentaoBaseUrl } from "../core/base-url.ts";
import { createWorkCalendar, formatLocalDate } from "../core/calendar.ts";
import type { Clock } from "../core/clock.ts";
import type { TeamConfig } from "../core/config.ts";
import { walkProductPlans } from "../core/dto/plan.ts";
import type { StoryDetail } from "../core/dto/story.ts";
import type { ProductPlan } from "../core/dto/plan.ts";
import type { Task } from "../core/dto/task.ts";
import type { Bug } from "../core/dto/bug.ts";
import { BztError } from "../core/errors.ts";
import { instanceHashOf } from "../core/store/index.ts";
import { htmlFragments } from "../domain/html-fragments.ts";
import { resolveStoryRoles } from "../domain/roles.ts";
import { detectStage } from "../domain/stage.ts";
import {
  buildStoryHtmlSpec,
  parseStoryRoleTag,
} from "../domain/story-html-spec.ts";
import {
  isCancelledTask,
  isTaskFinished,
  selectLeafTasks,
} from "../domain/task.ts";
import { formatVersionTag } from "../domain/templates.ts";
import type { RuleInput } from "../rules/types.ts";
import * as r04 from "../rules/r04-premature-assignment.ts";
import * as r14 from "../rules/r14-stale-tasks.ts";
import type { DirectoryService } from "./directory.ts";
import type { OperationExecutor } from "./operation.ts";
import {
  foldStageRequirements,
  resolveStoryStageApprovers,
} from "./structured-notes.ts";

type StoryRoles = NonNullable<RuleInput["roles"]>;
type FlowTask = Omit<Task, symbol>;
type Warnings = PreparedOperation["warnings"];
type Cleanup = Extract<
  z.output<typeof closeStoriesInputSchema>,
  { mode: "cleanup" }
>["cleanup"];

/** FlowService 实际使用的存储子集（prepare/recordConfirmed 路径）。 */
export interface FlowStore {
  readonly location: {
    readonly instanceHash: string;
    readonly account: string;
  };
  readonly operations: {
    get(opId: string): {
      actor: string;
      kind: string;
      planJson: string;
      executedAt: number | null;
    };
  };
  readonly operationSteps: {
    list(opId: string): Array<{
      seq: number;
      action: string;
      zentaoId: number | null;
      state: string;
    }>;
  };
  readonly storyRoles: {
    get(storyId: number): {
      storyId: number;
      maintainer: string | null;
      receiver: string | null;
      updatedAt: number;
    };
    upsert(role: {
      storyId: number;
      maintainer: string | null;
      receiver: string | null;
      updatedAt: number;
    }): void;
  };
  readonly reschedules?: {
    listByStory(storyId: number): ReadonlyArray<{
      at: number;
      by: string;
      toMonth: string;
      fromMonth: string | null;
      reason: string;
    }>;
    append(input: {
      storyId: number;
      fromMonth: string | null;
      toMonth: string;
      reason: string;
      by: string;
      at: number;
    }): void;
  };
  readonly stageRequirements?: {
    get(storyId: number, stage: string): { decidedAt: number } | undefined;
    listByStory(storyId: number): ReadonlyArray<{
      stage: string;
      required: boolean;
    }>;
    upsert(input: {
      storyId: number;
      stage: string;
      required: boolean;
      waiverReason: string | null;
      decidedBy: string;
      decidedAt: number;
    }): void;
  };
  readonly waivers?: {
    get(key: {
      ruleId: string;
      objectType: string;
      objectId: string;
    }): { at: number } | undefined;
    upsert(input: {
      ruleId: string;
      objectType: string;
      objectId: string;
      reason: string;
      approvedBy: string;
      at: number;
    }): void;
  };
  readonly cache?: {
    get?(key: string, now?: number): string | undefined;
    set?(key: string, value: string, ttlMs: number): void;
  };
  readonly sourceLinks?: {
    listTo?(
      toType: string,
      toId: string,
    ): ReadonlyArray<{
      fromType: string;
      fromId: string;
      relation: string;
    }>;
    listFrom?(
      fromType: string,
      fromId: string,
    ): ReadonlyArray<{
      toType: string;
      toId: string;
      relation: string;
    }>;
    find(key: {
      fromType: string;
      fromId: string;
      toType: string;
      toId: string;
      relation: string;
    }): { origin: string } | undefined;
    upsert(input: {
      fromType: string;
      fromId: string;
      toType: string;
      toId: string;
      relation: string;
      origin: string;
      verifiedAt: number | null;
    }): void;
  };
}

interface FlowOptions {
  /** CR-009 §4.1：优先注入业务底座；仅传 client 时自动包一层禅道适配器。 */
  readonly provider?: BusinessProvider;
  readonly client?: ZentaoReadClient;
  readonly directory: Pick<DirectoryService, "resolveContext">;
  readonly executor: Pick<OperationExecutor, "prepare">;
  readonly storyRoles?: { readonly get: (id: number) => StoryRoles["stored"] };
  /** CR-009 §4.2：流程服务存储；SQLite LocalStore 或端口内存实现。 */
  readonly store?: FlowStore;
  readonly clock?: Clock;
  readonly baseUrl?: string;
  readonly instanceVersion?: string;
  readonly config: Pick<
    TeamConfig,
    "roles" | "teams" | "modules" | "moduleDefaults" | "rules"
  > &
    Partial<
      Pick<
        TeamConfig,
        "write" | "timezone" | "calendar" | "naming" | "stageDefaults"
      >
    >;
}

const metadata = z.strictObject({
  stageRequirements: stageRequirementsSchema.optional(),
  roles: metaRolesSchema.optional(),
  comment: z.string().optional(),
});
const rescheduleNote = z.strictObject({
  fromMonth: normalizedMonthSchema.nullable(),
  toMonth: normalizedMonthSchema,
  reason: z.string().trim().min(1),
});
const storedPlan = z.object({
  instanceHash: z.string(),
  plan: operationPlanSchema,
});

function parseInput<T>(schema: z.ZodType<T>, raw: unknown, message: string): T {
  const result = schema.safeParse(raw);
  if (!result.success) throw new BztError("INVALID_INPUT", message);
  return result.data;
}

function field(
  value: OperationStep["fields"][string]["value"],
  origin: "user" | "default" | "derived" = "derived",
) {
  return { value, origin };
}

function storyStep(
  story: Pick<StoryDetail, "id" | "product">,
  action: string,
  fields: OperationStep["fields"],
): OperationStep {
  const { id, product } = story;
  return {
    action,
    type: "story",
    id,
    product,
    fields,
    cacheKeys: [`story:${id}`, `stories:${product}`],
  };
}

function taskClose(
  task: FlowTask,
  product: number,
  reason?: string,
): OperationStep {
  return {
    action: "task.close",
    type: "task",
    product,
    id: task.id,
    fields: reason ? { comment: field(reason, "user") } : {},
    cacheKeys: [
      `task:${task.id}`,
      `tasks:${task.execution}`,
      ...(task.story == null ? [] : [`story:${task.story}`]),
    ],
  };
}

function emptyPreview(
  kind: string,
  summary: string,
  warnings: Warnings,
): PreparedOperation {
  return {
    ok: true,
    opId: "",
    kind,
    level: "W0",
    expiresAt: "",
    preview: { summary, steps: [], affects: [] },
    warnings,
    requiresPreviewAck: false,
  };
}

function note(kind: string, value: object): string {
  const json = JSON.stringify(value).replace(
    /[<>&]/gu,
    (char) => `\\u${char.charCodeAt(0).toString(16).padStart(4, "0")}`,
  );
  return `[bzt:${kind} v1 ${json}]`;
}

function readNote<T>(kind: string, value: unknown, schema: z.ZodType<T>) {
  const prefix = `[bzt:${kind} v1 `;
  if (
    typeof value !== "string" ||
    !value.startsWith(prefix) ||
    !value.endsWith("]")
  )
    return undefined;
  try {
    return schema.parse(JSON.parse(value.slice(prefix.length, -1)));
  } catch {
    throw new BztError("INVALID_INPUT", "本地操作的结构化备注格式不合法。");
  }
}

function specText(html: string): string {
  return [...html.matchAll(htmlFragments)]
    .map(([fragment]) =>
      /^<\/?(?:h[1-6]|li|div|p|br)\b/iu.test(fragment)
        ? "\n"
        : fragment.startsWith("<")
          ? ""
          : fragment,
    )
    .join("")
    .replace(/&nbsp;|&#160;/giu, " ")
    .replace(
      /&(?:amp|lt|gt|quot|#39|#91);/gu,
      (entity) =>
        ({
          "&amp;": "&",
          "&lt;": "<",
          "&gt;": ">",
          "&quot;": '"',
          "&#39;": "'",
          "&#91;": "[",
        })[entity] ?? entity,
    );
}

function specSections(spec: string) {
  const sections: Record<"scope" | "design", string[]> = {
    scope: [],
    design: [],
  };
  let current: keyof typeof sections | undefined;
  for (const raw of specText(spec).split(/\r?\n/u)) {
    const line = raw.trim().replace(/^#{1,6}\s+/u, "");
    if (!line || /^\[bzt:/iu.test(line)) continue;
    const heading =
      /^(本次实现范围|设计文档|设计章节|验收标准|验收条件|背景与问题|来源)(?:\s*[:：]\s*(.*))?$/u.exec(
        line,
      );
    if (heading) {
      const [, label, content] = heading;
      current =
        label === "本次实现范围"
          ? "scope"
          : label === "设计文档" || label === "设计章节"
            ? "design"
            : undefined;
      if (current && content) sections[current].push(content);
    } else if (current) {
      sections[current].push(line);
    }
  }
  return sections;
}

function developmentAccounts(config: FlowOptions["config"]): Set<string> {
  const accounts = new Set(config.roles.RM);
  for (const { devLead } of [
    ...Object.values(config.modules),
    ...Object.values(config.moduleDefaults),
  ]) {
    if (devLead) accounts.add(devLead);
  }
  for (const { lead, members, executionKinds } of Object.values(config.teams)) {
    if (!executionKinds?.includes("dev")) continue;
    accounts.add(lead);
    for (const member of members) accounts.add(member);
  }
  return accounts;
}

export class FlowService {
  private readonly provider: BusinessProvider;
  private readonly authorizedStageOps = new Map<string, Set<string>>();

  constructor(private readonly options: FlowOptions) {
    if (options.provider) this.provider = options.provider;
    else if (options.client)
      this.provider = createZentaoBusinessProvider({
        client: options.client,
        baseUrl: "",
      });
    else throw new BztError("CONFIG_MISSING", "请为流程服务配置业务底座。");
  }

  async assignStory(raw: unknown): Promise<PreparedOperation> {
    const parsed = assignStoryInputSchema.safeParse(raw);
    if (!parsed.success)
      throw new BztError(
        "INVALID_INPUT",
        "请提供有效的需求编号和指派对象，并检查指派参数。",
      );
    const { executor, config } = this.options;
    const { storyIds, to, comment, notify } = parsed.data;
    const person = await this.readPerson(to);
    if (!person) throw new BztError("NOT_FOUND", "未找到指派对象。");

    const ids = [...new Set(storyIds)];
    const stories = await Promise.all(ids.map((id) => this.readStory(id)));
    const accounts = developmentAccounts(config);
    if (person.roles.includes("dev")) accounts.add(person.account);
    const steps: OperationStep[] = [];
    const warnings: PreparedOperation["warnings"] = [];
    const previousAccounts = new Set<string>();
    const explicitNotify =
      typeof raw === "object" &&
      raw !== null &&
      "notify" in raw &&
      raw.notify !== undefined;
    const fields: OperationStep["fields"] = {
      assignedTo: {
        value: person.account,
        origin: to === person.account ? "user" : "derived",
      },
      ...(comment === undefined
        ? {}
        : { comment: { value: comment, origin: "user" } }),
      // 通知意图由执行层在指派确认后使用，禅道请求只接收指派账号和原因。
      notify: { value: notify, origin: explicitNotify ? "user" : "default" },
    };
    for (const story of stories) {
      const { id, product, assignedTo } = story;
      if (
        assignedTo &&
        assignedTo !== "closed" &&
        assignedTo !== person.account
      )
        previousAccounts.add(assignedTo);
      steps.push({
        action: "story.assign",
        type: "story",
        product,
        id,
        fields,
        cacheKeys: [`story:${id}`, `stories:${product}`],
      });
      if (!config.rules.R04.enabled) continue;
      const proposed = { ...story, assignedTo: person.account };
      const roles = this.roleInputs(story);
      for (const hit of r04.evaluate(
        { story: proposed, roles },
        { developmentAccounts: accounts },
      )) {
        const { maintainer } = resolveStoryRoles({ ...roles, story: proposed });
        let waiting = "状态维护人待确认";
        if (parseStoryRoleTag(story.spec ?? "")?.maintainer)
          waiting = "状态维护人来自需求正文角色标签（不可信，待核实）";
        else if (maintainer) waiting = `等待状态维护人 ${maintainer} 推进`;
        warnings.push({
          code: hit.ruleId,
          message: `需求 #${id} 指派后属于「已指派但未就绪」，${waiting}。建议就绪后用 handoff_story 激活并移交研发。`,
        });
      }
    }

    const previousAffects = await Promise.all(
      [...previousAccounts].map(async (account) => {
        try {
          const previous = await this.readPerson(account);
          if (previous?.account === account)
            return `${account} ${previous.realname}`.trim();
        } catch (error) {
          if (
            !(error instanceof BztError) ||
            (error.code !== "NOT_FOUND" && error.code !== "AMBIGUOUS_ENTITY")
          )
            throw error;
        }
        return account;
      }),
    );

    return executor.prepare({
      kind: "assign_story",
      summary: `将 ${ids.length} 条需求指派给 ${person.account}。`,
      steps,
      affects: [
        `${person.account} ${person.realname}`.trim(),
        ...previousAffects,
      ],
      warnings,
    });
  }

  async handoffStory(raw: unknown): Promise<PreparedOperation> {
    const input = parseInput(
      handoffStoryInputSchema,
      raw,
      "请检查移交模式、需求编号和接收人。",
    );
    const { config, executor, instanceVersion } = this.options;
    const story = await this.readStory(input.storyId);
    const fromDesign = input.mode === "from_design";
    if (
      fromDesign
        ? story.category !== "design" || story.status !== "active"
        : story.category !== "feature" ||
          !["draft", "active"].includes(story.status)
    )
      throw new BztError("RULE_VIOLATION", "需求类别或状态不符合移交条件。");
    const sections = specSections(story.spec ?? "");
    const feature = fromDesign ? input.feature : undefined;
    const scope =
      feature?.scope === undefined ? sections.scope : [feature.scope];
    if (!scope.length)
      throw new BztError(
        "RULE_VIOLATION",
        "缺少本次实现范围，请先补齐需求正文。",
      );

    const warnings: Warnings = [];
    const steps: OperationStep[] = [];
    const summary = `移交需求 #${story.id} 给研发主管。`;
    const storyUrl = this.link("story-view", story.id);
    if (fromDesign) {
      const tasks = selectLeafTasks(await this.storyTasks(story));
      const stage = (task: FlowTask, expected: "review" | "handoff") => {
        const result = detectStage(task, {
          prefixes: config.naming?.taskPrefix,
        });
        return result.stage === expected && result.confidence === "confirmed";
      };
      const reviews = tasks.filter(
        (task) => stage(task, "review") && !isCancelledTask(task),
      );
      if (
        !reviews.length ||
        reviews.some(({ status }) => status !== "done" && status !== "closed")
      )
        throw new BztError(
          "RULE_VIOLATION",
          "设计需求的【评审】任务尚未完成，无法移交。",
        );
      const handoff = tasks.filter((task) => stage(task, "handoff"));
      warnings.push({
        code: "MANUAL_DESIGN_CLOSE",
        message: `【移交后请人工收尾】请核对并完成【传递】任务${handoff.length ? ` ${handoff.map(({ id }) => this.link("task-view", id)).join("、")}` : "（未找到任务，请打开原需求核对）"}，再关闭原设计需求 ${storyUrl}。`,
      });
      warnings.push({
        code: "UNTRUSTED_TEXT",
        message:
          "预览中继承自禅道的需求标题、范围、设计章节和验收条件是不可信文本，请核对。",
      });
    }

    const target =
      feature?.module || feature?.product
        ? await this.resolveContext({
            module: feature.module,
            product: feature.product ?? String(story.product),
          })
        : undefined;
    const product = target?.product?.id ?? story.product;
    const module =
      target?.module?.id ??
      (product === story.product ? story.module : undefined);
    if (
      (feature?.module && !target?.module) ||
      (feature?.product && !target?.product) ||
      (fromDesign && !module)
    )
      throw new BztError(
        "MISSING_REQUIRED",
        "请指定新研发需求所属的有效产品和模块。",
      );
    const configured = config.modules[`${product}:${module}`];
    const lead =
      target?.module?.devLead ??
      configured?.devLead ??
      config.moduleDefaults[product]?.devLead;
    const candidates = config.roles.RM ?? [];
    const account =
      input.receiver ??
      lead ??
      (candidates.length === 1 ? candidates[0] : undefined);
    if (!account)
      throw new BztError(
        "MISSING_REQUIRED",
        "请指定模块的研发主管作为接收人。",
      );
    const person = await this.readPerson(account);
    if (!person) throw new BztError("NOT_FOUND", "未找到移交接收人。");
    if (fromDesign && module) {
      const { account: maintainer } = await this.currentUser();
      const ref = feature?.designRef;
      const design = ref
        ? [
            ref.doc,
            `章节：${ref.section}`,
            ...(ref.version ? [`版本：${ref.version}`] : []),
          ]
        : sections.design;
      const spec = buildStoryHtmlSpec(
        { background: [], scope, design, source: [`衍生自 #${story.id}`] },
        { maintainer, receiver: person.account },
        "visible",
      );
      steps.push({
        action: "story.create",
        type: "story",
        product,
        fields: {
          product: field(product, feature?.product ? "user" : "derived"),
          module: field(module, feature?.module ? "user" : "derived"),
          modules: field([module]),
          title: field(
            feature?.title ?? story.title,
            feature?.title ? "user" : "derived",
          ),
          category: field("feature"),
          status: field("draft", "default"),
          reviewer: field([], "default"),
          assignedTo: field(maintainer),
          spec: field(spec),
          verify: field(
            specText(story.verify ?? "")
              .trim()
              .replaceAll("<", "&lt;")
              .replaceAll(">", "&gt;") ||
              `按原设计需求 #${story.id} 的评审范围核对。`,
          ),
        },
        cacheKeys: [`stories:${product}`],
      });
      steps.push({
        action: "story.linkStory",
        type: "story",
        product,
        fromStep: 1,
        fields: { stories: field([story.id]) },
        cacheKeys: [`story:${story.id}`, `stories:${story.product}`],
      });
    }
    const follow = (
      action: string,
      fields: OperationStep["fields"],
    ): OperationStep =>
      fromDesign
        ? {
            action,
            type: "story",
            product,
            fromStep: 1,
            fields,
            cacheKeys: [`stories:${product}`],
          }
        : storyStep(story, action, fields);
    const activationAllowed =
      getCapability("story.activate", instanceVersion).state === "verified" &&
      !config.write?.disableCapabilities.includes("story.activate");
    if (activationAllowed && (fromDesign || story.status !== "active"))
      steps.push(follow("story.activate", { status: field("active") }));
    if (!activationAllowed && (fromDesign || story.status !== "active"))
      warnings.push({
        code: "MANUAL_ACTIVATION",
        message: fromDesign
          ? `请在禅道手动激活新建的研发需求，可从原设计需求 ${storyUrl} 查看关联。`
          : `请在禅道手动激活需求 ${storyUrl}。`,
      });
    if (
      [
        "story.assign",
        "story.comment",
        ...(fromDesign ? ["story.create", "story.linkStory"] : []),
      ].some(
        (action) =>
          getCapability(action, instanceVersion).state !== "verified" ||
          config.write?.disableCapabilities.includes(action),
      )
    ) {
      warnings.push({
        code: "CAPABILITY_UNAVAILABLE",
        message: `当前实例或配置下无法确认指派和备注可执行，请在禅道手动完成移交 ${storyUrl}。`,
      });
      return emptyPreview("handoff_story", summary, warnings);
    }
    steps.push(
      follow("story.assign", {
        assignedTo: field(
          person.account,
          input.receiver === person.account ? "user" : "derived",
        ),
        notify: field(
          input.notify ?? true,
          input.notify === undefined ? "default" : "user",
        ),
      }),
    );
    if (!fromDesign)
      warnings.push({
        code: "MANUAL_ROLE_TAG",
        message:
          "禅道 22.6 的需求编辑不能改写正文角色标签。接收人将记录在结构化备注与本地状态中。",
      });
    const comment =
      input.comment ??
      (fromDesign
        ? `从设计需求 #${story.id} 移交研发。`
        : "移交研发主管接收与排期。");
    steps.push(
      follow("story.comment", {
        comment: field(
          fromDesign
            ? comment
            : note("meta", { roles: { receiver: person.account }, comment }),
          input.comment === undefined ? "default" : "user",
        ),
      }),
    );
    return executor.prepare({
      kind: "handoff_story",
      summary,
      steps,
      warnings,
      affects: [`${person.account} ${person.realname}`.trim()],
    });
  }

  async rescheduleStory(raw: unknown): Promise<PreparedOperation> {
    const { storyIds, toMonth, reason, moveTasks } = parseInput(
      rescheduleStoryInputSchema,
      raw,
      "请提供需求编号、目标月份和挪月原因。",
    );
    const { executor } = this.options;
    const normalized = this.month(toMonth);
    const stories = await Promise.all(
      [...new Set(storyIds)].map((id) => this.readStory(id)),
    );
    const plansByProduct = new Map(
      await Promise.all(
        [...new Set(stories.map(({ product }) => product))].map(
          async (id): Promise<[number, readonly ProductPlan[]]> => [
            id,
            await this.completeList(`plans:${id}`, () =>
              this.provider.listProductPlans(id),
            ),
          ],
        ),
      ),
    );
    const steps: OperationStep[] = [];
    const warnings: Warnings = [];
    for (const story of stories) {
      const { product, module, plan } = await this.resolveContext({
        product: String(story.product),
        module: story.module ? String(story.module) : undefined,
        plan: `L3 ${normalized}`,
        month: normalized,
      }).catch((error: unknown) => {
        if (
          !(error instanceof BztError) ||
          error.code !== "NOT_FOUND" ||
          error.details?.completeness === "partial"
        )
          throw error;
        throw new BztError(
          "NOT_FOUND",
          `需求 #${story.id} 对应产品和模块下找不到 ${normalized} 的 L3 计划。`,
        );
      });
      if (
        product?.id !== story.product ||
        plan?.level !== "L3" ||
        (story.module && module?.id !== story.module)
      )
        throw new BztError(
          "NOT_FOUND",
          `需求 #${story.id} 对应产品和模块下找不到 ${normalized} 的 L3 计划。`,
        );
      const plans = [
        ...walkProductPlans(plansByProduct.get(story.product) ?? []),
      ];
      const fromMonths = new Set(
        plans
          .filter(({ id, deleted }) => !deleted && story.plan?.includes(id))
          .map(({ begin }) => begin?.slice(0, 7))
          .filter((month) => month !== undefined),
      );
      const fromMonth =
        fromMonths.size === 1 ? ([...fromMonths][0] ?? null) : null;
      if (story.plan?.length && fromMonth === null)
        warnings.push({
          code: "SOURCE_MONTH_UNKNOWN",
          message: `需求 #${story.id} 未能确定唯一来源月份。`,
        });
      steps.push(
        storyStep(story, "story.edit", { plan: field(plan.id) }),
        storyStep(story, "story.comment", {
          comment: field(
            note("reschedule", { fromMonth, toMonth: normalized, reason }),
          ),
        }),
      );
      if (moveTasks)
        warnings.push({
          code: "MANUAL_TASK_RESCHEDULE",
          message: `需求 #${story.id} 的任务所属迭代与截止日期需人工调整：${this.link("story-view", story.id)}。`,
        });
    }
    return executor.prepare({
      kind: "reschedule_story",
      summary: `将 ${stories.length} 条需求挪到 ${normalized} 的 L3 计划并保留原因。`,
      steps,
      warnings,
    });
  }

  async closeStories(raw: unknown): Promise<PreparedOperation> {
    const input = parseInput(
      closeStoriesInputSchema,
      raw,
      "请检查关闭模式、需求编号和清理范围。",
    );
    const { executor } = this.options;
    if (input.mode === "cleanup") return this.cleanup(input.cleanup);
    const stories = await Promise.all(
      [...new Set(input.storyIds)].map((id) => this.readStory(id)),
    );
    const steps: OperationStep[] = [];
    const warnings: Warnings = [];
    for (const story of stories) {
      if (story.status !== "closed")
        steps.push(
          storyStep(story, "story.close", {
            closedReason: field(
              input.closedReason ?? "done",
              input.closedReason === undefined ? "default" : "user",
            ),
          }),
        );
      for (const task of selectLeafTasks(await this.storyTasks(story))) {
        if (task.status === "done") steps.push(taskClose(task, story.product));
        else if (!isTaskFinished(task.status))
          warnings.push({
            code: "UNFINISHED_TASK",
            message: `需求 #${story.id} 的未完成任务将保留，请决定是否继续处理：${this.link("task-view", task.id)}。`,
          });
      }
    }
    const summary = `收尾 ${stories.length} 条需求及其已完成的叶子任务。`;
    return steps.length
      ? executor.prepare({ kind: "close_stories", summary, steps, warnings })
      : emptyPreview("close_stories", summary, warnings);
  }

  async setStoryMeta(raw: unknown): Promise<PreparedOperation> {
    const { storyId, version, scope, stageRequirements, roles, waiver } =
      parseInput(
        setStoryMetaInputSchema,
        raw,
        "请提供有效的需求编号和待修改的元数据。",
      );
    const { config, executor } = this.options;
    const rule = waiver?.rule.toUpperCase();
    const releaseGate = rule === "R13" || rule === "RELEASE_GATE";
    if (
      releaseGate &&
      !config.roles.PM?.includes((await this.currentUser()).account)
    )
      throw new BztError(
        "PERMISSION_DENIED",
        "只有产品管理角色可以登记发布门禁例外。",
      );
    if (scope)
      throw new BztError(
        "CAPABILITY_UNVERIFIED",
        `正文变更能力尚未验证，请在禅道编辑需求 ${this.link("story-edit", storyId)}。`,
        { manual: { kind: "story_spec", id: storyId } },
      );
    const story = await this.readStory(storyId);
    let stageApprovers: readonly string[] | undefined;
    if (stageRequirements && Object.keys(stageRequirements).length > 0) {
      let storedRoles:
        | {
            storyId: number;
            maintainer: string | null;
            receiver: string | null;
            updatedAt: number;
          }
        | undefined;
      try {
        storedRoles = this.options.store?.storyRoles.get(storyId);
      } catch (error) {
        if (!(error instanceof BztError && error.code === "NOT_FOUND"))
          throw error;
      }
      stageApprovers = resolveStoryStageApprovers(config, story, storedRoles);
      if (
        stageApprovers.length > 0 &&
        !stageApprovers.includes((await this.currentUser()).account)
      ) {
        throw new BztError(
          "PERMISSION_DENIED",
          "只有产品管理、设计管理、研发管理或当前需求维护人可以调整阶段要求。",
        );
      }
    }
    const warnings: Warnings = [];
    const steps: OperationStep[] = [];
    if (version)
      steps.push(
        storyStep(story, "story.edit", {
          keywords: field(formatVersionTag(version), "user"),
        }),
      );
    if (roles || stageRequirements)
      steps.push(
        storyStep(story, "story.comment", {
          comment: field(note("meta", { roles, stageRequirements })),
        }),
      );
    if (waiver)
      steps.push(
        storyStep(story, "story.comment", {
          comment: field(
            note("waiver", {
              rule: releaseGate ? "R13" : waiver.rule,
              reason: waiver.reason,
            }),
          ),
        }),
      );
    if (roles)
      warnings.push({
        code: "ROLE_TAG_UNCHANGED",
        message:
          "禅道需求正文微标签保持原样，确认后通过结构化评论留痕，并更新本地角色缓存。",
      });
    const prepared = await executor.prepare({
      kind: "set_story_meta",
      summary: `更新需求 #${storyId} 的元数据。`,
      steps,
      warnings,
    });
    if (stageApprovers && prepared.opId) {
      this.authorizedStageOps.set(prepared.opId, new Set(stageApprovers));
      this.options.store?.cache?.set?.(
        `stage-meta-approvers-v1:${prepared.opId}`,
        JSON.stringify({ storyId, approvers: [...stageApprovers] }),
        30 * 24 * 60 * 60_000,
      );
    }
    return prepared;
  }

  private readPersistedStageApprovers(
    opId: string,
    storyId: number,
  ): readonly string[] | undefined {
    try {
      const cachedGrant = this.options.store?.cache?.get?.(
        `stage-meta-approvers-v1:${opId}`,
        0,
      );
      if (!cachedGrant) return undefined;
      const parsedGrant = z
        .strictObject({
          storyId: z.number().int().positive(),
          approvers: z.array(z.string()),
        })
        .safeParse(JSON.parse(cachedGrant));
      return parsedGrant.success && parsedGrant.data.storyId === storyId
        ? parsedGrant.data.approvers
        : undefined;
    } catch {
      return undefined;
    }
  }

  /**
   * 异步确认回写入口（供 Workbench 使用）：
   * 优先复用持久化审批人（零额外上游回读）；仅当无持久化记录时补读目标需求。
   */
  async recordConfirmedWithStory(
    opId: string,
    result: OperationResult,
  ): Promise<void> {
    const resolvedStories = new Map<number, StoryDetail>();
    const store = this.options.store;
    if (store) {
      try {
        const record = store.operations.get(opId);
        if (record.kind === "set_story_meta") {
          const done = store.operationSteps
            .list(opId)
            .filter(
              ({ state, action, zentaoId }) =>
                state === "done" &&
                action === "story.comment" &&
                zentaoId !== null,
            );
          for (const row of done) {
            if (
              row.zentaoId !== null &&
              !resolvedStories.has(row.zentaoId) &&
              this.readPersistedStageApprovers(opId, row.zentaoId) === undefined
            ) {
              try {
                resolvedStories.set(
                  row.zentaoId,
                  await this.readStory(row.zentaoId),
                );
              } catch {
                // 回读失败时回退到 recordConfirmed 既有角色与模块校验。
              }
            }
          }
        }
      } catch {
        // 交由 recordConfirmed 统一处理异常。
      }
    }
    this.recordConfirmed(opId, result, resolvedStories);
  }

  recordConfirmed(
    opId: string,
    result: OperationResult,
    resolvedStories?: ReadonlyMap<number, StoryDetail>,
  ): void {
    /* CR-009 §4.2: recordConfirmed 只在具备完整补充存储时生效。 */
    if (result.opId !== opId)
      throw new BztError("INVALID_INPUT", "操作回执编号不一致。");
    const { store, baseUrl } = this.options;
    if (!store)
      throw new BztError("CONFIG_MISSING", "请为流程服务配置本地操作存储。");
    const record = store.operations.get(opId);
    if (
      record.actor !== store.location.account ||
      (baseUrl && instanceHashOf(baseUrl) !== store.location.instanceHash)
    )
      throw new BztError("NOT_FOUND", "未找到操作回执。", { opId });
    if (
      !["handoff_story", "reschedule_story", "set_story_meta"].includes(
        record.kind,
      )
    )
      return;
    let stored: z.output<typeof storedPlan>;
    try {
      stored = storedPlan.parse(JSON.parse(record.planJson));
    } catch {
      throw new BztError("INVALID_INPUT", "本地操作记录格式不合法。");
    }
    if (stored.instanceHash !== store.location.instanceHash)
      throw new BztError("NOT_FOUND", "未找到操作回执。", { opId });
    const at = record.executedAt;
    if (at === null) return;
    const { steps } = stored.plan;
    const done = store.operationSteps
      .list(opId)
      .filter(({ state }) => state === "done");
    for (const row of done) {
      const step = steps[row.seq - 1];
      const storyId = row.zentaoId;
      if (!step || step.action !== row.action || storyId === null) continue;
      const reschedules = store.reschedules;
      if (
        reschedules &&
        record.kind === "reschedule_story" &&
        step.action === "story.edit"
      ) {
        const comment = steps[row.seq];
        if (comment?.action !== "story.comment" || comment.id !== storyId)
          continue;
        const change = readNote(
          "reschedule",
          comment.fields.comment?.value,
          rescheduleNote,
        );
        if (!change) continue;
        const prior = reschedules
          .listByStory(storyId)
          .some(
            (entry) =>
              entry.at === at &&
              entry.by === record.actor &&
              entry.toMonth === change.toMonth &&
              entry.fromMonth === change.fromMonth &&
              entry.reason === change.reason,
          );
        if (!prior)
          reschedules.append({
            storyId,
            ...change,
            by: record.actor,
            at,
          });
      }
      const stageRequirements = store.stageRequirements;
      if (
        stageRequirements &&
        record.kind === "set_story_meta" &&
        step.action === "story.comment"
      ) {
        const comment = step.fields.comment?.value;
        const meta = readNote("meta", comment, metadata);
        const roleApprovers = [
          ...(this.options.config.roles.PM ?? []),
          ...(this.options.config.roles.DM ?? []),
          ...(this.options.config.roles.RM ?? []),
        ];
        const moduleMaintainers = [
          ...Object.values(this.options.config.modules).map(
            (m) => m.designLead,
          ),
          ...Object.values(this.options.config.moduleDefaults).map(
            (m) => m.designLead,
          ),
        ].filter((lead): lead is string => Boolean(lead));
        const preparedApprovers = this.authorizedStageOps.get(opId);
        const persistedApprovers = this.readPersistedStageApprovers(
          opId,
          storyId,
        );
        let storedRoleRecord:
          | {
              storyId: number;
              maintainer: string | null;
              receiver: string | null;
              updatedAt: number;
            }
          | undefined;
        try {
          storedRoleRecord = store.storyRoles.get(storyId);
        } catch (error) {
          if (!(error instanceof BztError && error.code === "NOT_FOUND"))
            throw error;
        }
        const liveStory = resolvedStories?.get(storyId);
        const liveApprovers = liveStory
          ? resolveStoryStageApprovers(
              this.options.config,
              liveStory,
              storedRoleRecord,
            )
          : undefined;
        const actorAuthorized =
          liveApprovers !== undefined
            ? liveApprovers.length === 0 || liveApprovers.includes(record.actor)
            : persistedApprovers !== undefined
              ? persistedApprovers.length === 0 ||
                persistedApprovers.includes(record.actor)
              : preparedApprovers !== undefined
                ? preparedApprovers.size === 0 ||
                  preparedApprovers.has(record.actor)
                : roleApprovers.length === 0 ||
                  roleApprovers.includes(record.actor) ||
                  moduleMaintainers.includes(record.actor) ||
                  storedRoleRecord?.maintainer === record.actor;
        this.authorizedStageOps.delete(opId);
        for (const [stage, requirement] of Object.entries(
          meta?.stageRequirements ?? {},
        )) {
          if (
            !actorAuthorized ||
            !requirement ||
            (stageRequirements.get(storyId, stage)?.decidedAt ?? -Infinity) >=
              at
          )
            continue;
          stageRequirements.upsert({
            storyId,
            stage,
            required: requirement.required,
            waiverReason: requirement.reason ?? null,
            decidedBy: record.actor,
            decidedAt: at,
          });
        }
        if (meta?.roles) this.saveRoles(store, storyId, meta.roles, at);
        const waiver = readNote("waiver", comment, waiverSchema);
        const waivers = store.waivers;
        if (waiver && waivers) {
          const key = {
            ruleId: waiver.rule,
            objectType: "story",
            objectId: String(storyId),
          };
          if ((waivers.get(key)?.at ?? -Infinity) < at)
            waivers.upsert({
              ...key,
              reason: waiver.reason,
              approvedBy: record.actor,
              at,
            });
        }
      }
      if (record.kind === "handoff_story" && step.action === "story.create") {
        const spec = step.fields.spec?.value;
        const tag =
          typeof spec === "string" ? parseStoryRoleTag(spec) : undefined;
        if (tag) this.saveRoles(store, storyId, tag, at);
        const index = steps.findIndex(
          ({ action, fromStep }) =>
            action === "story.linkStory" && fromStep === row.seq,
        );
        const targets = steps[index]?.fields.stories?.value;
        const target = z.tuple([z.int().positive()]).safeParse(targets)
          .data?.[0];
        if (target === undefined) continue;
        const key = {
          fromType: "story",
          fromId: String(storyId),
          toType: "story",
          toId: String(target),
        };
        const sourceLinks = store.sourceLinks;
        if (!sourceLinks) continue;
        const derives = { ...key, relation: "derives" };
        if (!sourceLinks.find(derives))
          sourceLinks.upsert({
            ...derives,
            origin: "local",
            verifiedAt: null,
          });
        if (
          done.some(
            ({ seq, zentaoId }) => seq === index + 1 && zentaoId === storyId,
          )
        ) {
          const links = { ...key, relation: "links" };
          if (sourceLinks.find(links)?.origin !== "native")
            sourceLinks.upsert({
              ...links,
              origin: "native",
              verifiedAt: at,
            });
        }
      }
      if (
        record.kind === "handoff_story" &&
        step.action === "story.assign" &&
        step.fromStep === undefined &&
        typeof step.fields.assignedTo?.value === "string"
      ) {
        this.saveRoles(
          store,
          storyId,
          { receiver: step.fields.assignedTo.value },
          at,
        );
      }
    }
  }

  private saveRoles(
    store: FlowStore,
    storyId: number,
    roles: z.output<typeof metaRolesSchema>,
    at: number,
  ) {
    let previous;
    try {
      previous = store.storyRoles.get(storyId);
    } catch (error) {
      if (!(error instanceof BztError) || error.code !== "NOT_FOUND")
        throw error;
    }
    if (previous && previous.updatedAt >= at) return;
    store.storyRoles.upsert({
      storyId,
      maintainer: roles.maintainer ?? previous?.maintainer ?? null,
      receiver: roles.receiver ?? previous?.receiver ?? null,
      updatedAt: at,
    });
  }

  private async cleanup({
    scope,
    classes = ["A"],
    reason,
  }: Cleanup): Promise<PreparedOperation> {
    if (classes.includes("B") && !reason)
      throw new BztError("MISSING_REQUIRED", "关闭 B 类任务必须填写清理原因。");
    const { config, executor, store } = this.options;
    const team =
      scope.team &&
      Object.entries(config.teams).filter(
        ([id, team]) => id === scope.team || team.name === scope.team,
      );
    if (team && team.length !== 1)
      throw new BztError(
        team.length ? "AMBIGUOUS_ENTITY" : "NOT_FOUND",
        "无法唯一定位清理范围内的团队。",
      );
    const selectedTeam = team ? team[0]?.[1] : undefined;
    const teamAccounts = selectedTeam
      ? new Set([selectedTeam.lead, ...selectedTeam.members])
      : undefined;
    const before = scope.beforeMonth
      ? `${this.month(scope.beforeMonth)}-01`
      : undefined;
    let executionIds: number[];
    if (scope.execution) {
      const { execution } = await this.resolveContext({
        execution: scope.execution,
      });
      if (!execution)
        throw new BztError("NOT_FOUND", "未找到清理范围内的执行。");
      executionIds = [execution.id];
    } else {
      executionIds = (
        await this.completeList("executions", () =>
          this.provider.listExecutions(),
        )
      ).map(({ id }) => id);
    }
    const executionSet = new Set(executionIds);
    const tasks = selectLeafTasks(await this.loadTasks(executionIds)).filter(
      ({ assignedTo, execution }) =>
        executionSet.has(execution) &&
        (!teamAccounts || (assignedTo != null && teamAccounts.has(assignedTo))),
    );
    const timezone = config.timezone ?? "Asia/Shanghai";
    const today = this.today();
    const context = {
      today,
      timezone,
      calendar: createWorkCalendar(config.calendar),
      thresholds: {
        R14: {
          olderThanDays: {
            days: config.rules.R14.olderThanDays,
            unit: "calendarDays",
            source: "configured",
          },
        },
      },
    } satisfies Parameters<typeof r14.evaluate>[1];
    const candidates = new Map(tasks.map((task) => [task.id, task]));
    const groups = Map.groupBy(tasks, ({ story }) => story);
    const warnings: Warnings = [];
    const steps: OperationStep[] = [];
    const bugsByProduct = new Map<
      number,
      Promise<{ readonly items: readonly Bug[]; truncated: boolean }>
    >();
    for (const [id, scopedTasks] of groups) {
      const story = id === null ? undefined : await this.readStory(id);
      const tasksComplete =
        story?.status === "active" &&
        story.category === "feature" &&
        scopedTasks.some(({ status }) => status === "done");
      let bugs: Bug[] | undefined;
      if (story && tasksComplete) {
        let pending = bugsByProduct.get(story.product);
        if (!pending) {
          pending = this.provider.listProductBugs(story.product);
          bugsByProduct.set(story.product, pending);
        }
        bugs = await this.completeList(`bugs:${story.product}`, () => pending);
      }
      const fullTasks =
        story && tasksComplete
          ? selectLeafTasks(await this.storyTasks(story))
          : scopedTasks;
      const stageTasks = fullTasks.map((task) => ({
        ...task,
        evidence: { prefixes: config.naming?.taskPrefix },
      }));
      let storedRoles:
        | {
            storyId: number;
            maintainer: string | null;
            receiver: string | null;
            updatedAt: number;
          }
        | undefined;
      if (story) {
        try {
          storedRoles = store?.storyRoles.get(story.id);
        } catch (error) {
          if (!(error instanceof BztError && error.code === "NOT_FOUND"))
            throw error;
        }
      }
      const requirements = story
        ? store?.stageRequirements?.listByStory(story.id)
        : undefined;
      const defaultStageMap: Readonly<Record<string, { required: boolean }>> =
        story?.category === "design"
          ? (config.stageDefaults?.design ?? {
              design: { required: true },
              review: { required: true },
              handoff: { required: true },
            })
          : (config.stageDefaults?.feature ?? {
              dev: { required: true },
              interface: { required: false },
              test: { required: true },
              acceptance: { required: true },
              delivery: { required: true },
            });
      const required = story
        ? foldStageRequirements(
            defaultStageMap,
            requirements ?? [],
            story.actions,
            resolveStoryStageApprovers(config, story, storedRoles),
          )
        : undefined;
      const hits = r14.evaluate(
        { story, tasks: stageTasks, tasksComplete, bugs, required },
        context,
      );
      for (const hit of hits) {
        const task = candidates.get(hit.objectId);
        const category = hit.cleanupClass;
        if (!task || !category) continue;
        if (before && hit.since !== null && hit.since >= before) continue;
        if (
          category === "C" ||
          hit.since === null ||
          !classes.includes(category)
        ) {
          warnings.push({
            code: "R14",
            message: `R14 ${category} 类任务供人工核对${hit.since === null ? "（起点未知）" : ""}：${this.link("task-view", task.id)}。`,
          });
          continue;
        }
        if (story)
          steps.push(
            taskClose(
              task,
              story.product,
              category === "B" ? reason : undefined,
            ),
          );
      }
    }
    const summary = `按 R14 核对历史任务，拟关闭 ${steps.length} 个叶子任务。`;
    return steps.length
      ? executor.prepare({ kind: "close_stories", summary, steps, warnings })
      : emptyPreview("close_stories", summary, warnings);
  }

  private async storyTasks(story: StoryDetail): Promise<FlowTask[]> {
    const linkedIds = (story.tasks ?? []).map(({ id }) => id);
    const tasks = await this.loadTasks(
      story.executions.map(({ id }) => id),
      linkedIds,
    );
    const rows = tasks.filter(
      (task) => !task.deleted && task.story === story.id,
    );
    const found = new Set(rows.map(({ id }) => id));
    if (linkedIds.some((id) => !found.has(id)))
      throw this.readGap(`story:${story.id}:tasks`, "需求关联任务读取不完整");
    return rows;
  }

  private async loadTasks(
    executionIds: number[],
    taskIds: number[] = [],
  ): Promise<FlowTask[]> {
    const pages = await Promise.all(
      [...new Set(executionIds)].map(async (id) => {
        const source = `execution:${id}:tasks`;
        const items = await this.completeList(source, () =>
          this.provider.listExecutionTasks(id),
        );
        if (items.some(({ execution }) => execution !== id))
          throw this.readGap(source, "返回的任务与执行归属不一致");
        return items;
      }),
    );
    const tasks = new Map<number, FlowTask>(
      pages.flat().map((task) => [task.id, task]),
    );
    const read = async (id: number) => {
      try {
        const task = await this.provider.getTaskDetail(id);
        if (task.id !== id)
          throw new BztError(
            "ZENTAO_SCHEMA_MISMATCH",
            "返回的任务编号与请求不一致。",
          );
        tasks.set(id, task);
        for (const child of task.children)
          if (!tasks.has(child.id)) tasks.set(child.id, child);
      } catch (error) {
        if (!(error instanceof BztError)) throw error;
        throw this.readGap(`task:${id}`, error.code);
      }
    };
    await Promise.all(taskIds.filter((id) => !tasks.has(id)).map(read));
    const inspected = new Set<number>();
    for (;;) {
      const parents = new Set([...tasks.values()].map(({ parent }) => parent));
      const missing = new Set(
        [...tasks.values()].flatMap(({ id, isParent, parent, deleted }) => {
          if (deleted) return [];
          return [
            ...(parent != null && !tasks.has(parent) ? [parent] : []),
            ...(isParent && !parents.has(id) ? [id] : []),
          ];
        }),
      );
      const pending = [...missing].filter((id) => !inspected.has(id));
      if (!pending.length) {
        if (missing.size) throw this.readGap("tasks", "父子任务关系不完整");
        break;
      }
      for (const id of pending) inspected.add(id);
      await Promise.all(pending.map(read));
    }
    return [...tasks.values()].map((task) => {
      if (task.story !== null) return task;
      const visited = new Set([task.id]);
      let id = task.parent;
      while (id !== null) {
        if (visited.has(id))
          throw this.readGap(`task:${task.id}`, "父子任务关系存在循环");
        visited.add(id);
        const parent = tasks.get(id);
        if (!parent || parent.deleted) break;
        if (parent.story !== null) return { ...task, story: parent.story };
        id = parent.parent;
      }
      return task;
    });
  }

  private async completeList<T>(
    source: string,
    read: () => Promise<{ readonly items: readonly T[]; truncated: boolean }>,
  ): Promise<T[]> {
    let result;
    try {
      result = await read();
    } catch (error) {
      if (!(error instanceof BztError)) throw error;
      throw this.readGap(source, error.code);
    }
    if (result.truncated) throw this.readGap(source, "分页结果已截断");
    return [...result.items];
  }

  private readGap(source: string, reason: string) {
    return new BztError(
      "ZENTAO_UNAVAILABLE",
      "禅道数据读取不完整，无法准备操作。",
      { completeness: "partial", gaps: [{ source, reason }] },
    );
  }

  private async currentUser() {
    const { store } = this.options;
    const user = await this.provider.getCurrentUser();
    if (store && store.location.account !== user.account)
      throw new BztError(
        "PERMISSION_DENIED",
        "当前禅道账号与本地操作存储不一致。",
      );
    return user;
  }

  private link(
    page: "story-view" | "story-edit" | "task-view",
    id: number,
  ): string {
    const { baseUrl } = this.options;
    const base = baseUrl && normalizeZentaoBaseUrl(baseUrl);
    if (!base)
      throw new BztError("CONFIG_MISSING", "请为流程服务配置禅道基础地址。");
    return new URL(`${page}-${id}.html`, base).href;
  }

  private today() {
    const { clock, config } = this.options;
    if (!clock)
      throw new BztError("CONFIG_MISSING", "请为流程服务配置业务时钟。");
    return formatLocalDate(clock(), config.timezone ?? "Asia/Shanghai");
  }

  private month(input: string): string {
    if (input !== "上月" && input !== "本月" && input !== "下月") return input;
    const today = this.today();
    const offset = { 上月: -1, 本月: 0, 下月: 1 }[input];
    const index =
      Number(today.slice(0, 4)) * 12 + Number(today.slice(5, 7)) - 1 + offset;
    return `${String(Math.floor(index / 12)).padStart(4, "0")}-${String((index % 12) + 1).padStart(2, "0")}`;
  }

  private async readPerson(input: string) {
    return (await this.resolveContext({ people: [input] })).people[0];
  }

  private async resolveContext(input: ResolveContextInput) {
    const context = await this.options.directory.resolveContext(input);
    // 目录截断时，未读取的记录仍可能影响姓名或拼音匹配的唯一性。
    if (context.completeness === "partial" || context.truncated)
      throw new BztError(
        "ZENTAO_UNAVAILABLE",
        "禅道目录读取不完整，无法准备操作。",
        {
          completeness: "partial",
          gaps: context.gaps,
        },
      );
    return context.data;
  }

  private roleInputs({ id, product, module }: StoryDetail): StoryRoles {
    const { config, storyRoles = this.options.store?.storyRoles } =
      this.options;
    const configured = config.modules[`${product}:${module}`];
    const defaults = config.moduleDefaults[product];
    let stored: StoryRoles["stored"];
    try {
      stored = storyRoles?.get(id);
    } catch (error) {
      if (!(error instanceof BztError) || error.code !== "NOT_FOUND")
        throw error;
    }
    return {
      stored,
      module: {
        maintainer: configured?.designLead ?? defaults?.designLead,
        devLead: configured?.devLead ?? defaults?.devLead,
      },
    };
  }

  private async readStory(id: number): Promise<StoryDetail> {
    try {
      const story = await this.provider.getStoryDetail(id);
      if (story.type !== "story" || story.id !== id)
        throw new BztError(
          "ZENTAO_SCHEMA_MISMATCH",
          "禅道返回的需求类型或编号与请求不一致。",
        );
      if (story.deleted)
        throw new BztError("NOT_FOUND", "需求已删除，无法指派。");
      return story;
    } catch (error) {
      if (!(error instanceof BztError)) throw error;
      throw new BztError(
        error.code,
        `无法确认需求 #${id}，请检查需求及查看权限。`,
        {
          completeness: "partial",
          gaps: [
            {
              source: `story:${id}`,
              reason: `需求预检失败（${error.code}）。`,
            },
          ],
        },
      );
    }
  }
}
