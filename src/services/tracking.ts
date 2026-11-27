import { z } from "zod";
import type { ZentaoReadClient } from "../api/client.ts";
import { listMyContributions, listMyWork } from "../api/my.ts";
import { createZentaoBusinessProvider } from "./providers/zentao-business-provider.ts";
import type { BusinessProvider } from "./ports/business-provider.ts";
import {
  getMyWorkInputSchema,
  myWorkGroupSchema,
  type GetMyWorkOutput,
} from "../contracts/tools/get_my_work.ts";
import {
  getTeamWorkInputSchema,
  type GetTeamWorkOutput,
  type TaskItem,
} from "../contracts/tools/get_team_work.ts";
import {
  getStoryProgressInputSchema,
  type GetStoryProgressOutput,
} from "../contracts/tools/get_story_progress.ts";
import {
  queryStoriesInputSchema,
  type QueryStoriesOutput,
  type StoryItem,
} from "../contracts/tools/query_stories.ts";
import type { ResolveContextOutput } from "../contracts/tools/resolve_context.ts";
import {
  addWorkdays,
  countWorkdaysBetween,
  createWorkCalendar,
  formatLocalDate,
  monthDateRange,
  overlapsDateRange,
  parseZentaoDateTime,
} from "../core/calendar.ts";
import type { Clock } from "../core/clock.ts";
import type { TeamConfig } from "../core/config.ts";
import type { Execution } from "../core/dto/execution.ts";
import type { RequirementDetail } from "../core/dto/story.ts";
import type { User } from "../core/dto/org.ts";
import { walkProductPlans, type ProductPlan } from "../core/dto/plan.ts";
import {
  storyDetailDtoFor,
  storyDtoFor,
  type Story,
  type StoryDetail,
} from "../core/dto/story.ts";
import type { Task, TaskDetail } from "../core/dto/task.ts";
import { BztError } from "../core/errors.ts";
import { readGapReason } from "./read-gap.ts";
import type { LocalStore } from "../core/store/index.ts";
import { htmlFragments } from "../domain/html-fragments.ts";
import { planOverlapDays } from "../domain/month.ts";
import { designProgress, featureProgress } from "../domain/progress.ts";
import { resolveStoryRoles } from "../domain/roles.ts";
import { detectStage, summarizeStages, type Stage } from "../domain/stage.ts";
import { parseStoryRoleTag } from "../domain/story-html-spec.ts";
import { summarizeLeafWork, taskTimeStatus } from "../domain/task.ts";
import {
  evaluateRules,
  rules,
  type RiskHit,
  type RuleContext,
  type RuleInput,
} from "../rules/index.ts";
import { DirectoryService } from "./directory.ts";
import {
  cachedWaiverEntries,
  foldRuleWaivers,
  foldStageRequirements,
  stageRequirementApprovers,
} from "./structured-notes.ts";

/** CR-009 §4.2：跟踪服务所需的最小读模型；LocalStore 与内存端口实现都满足。 */
export interface TrackingStore {
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
  readonly sourceLinks: {
    listTo(
      toType: string,
      toId: string,
    ): ReadonlyArray<{
      fromType: string;
      fromId: string;
      relation: string;
    }>;
    listFrom(
      fromType: string,
      fromId: string,
    ): ReadonlyArray<{
      toType: string;
      toId: string;
      relation: string;
    }>;
  };
  readonly intake: {
    list(): ReadonlyArray<{
      intakeId: string;
      feedbackByText: string | null;
      feedbackByAccount: string | null;
      channel: string | null;
      createdBy: string;
      createdAt: number;
      backfilled: boolean;
      actualStartedAt: number | null;
    }>;
    get(intakeId: string): {
      intakeId: string;
      feedbackByText: string | null;
      feedbackByAccount: string | null;
      channel: string | null;
      createdBy: string;
      createdAt: number;
      backfilled: boolean;
      actualStartedAt: number | null;
    };
  };
  readonly seenCursor: {
    get(scope: string): { lastSeenAt: number } | undefined;
    set(scope: string, lastSeenAt: number): void;
  };
  readonly cache?: {
    get(key: string): string | undefined;
    set(key: string, value: string, ttlMs: number): void;
    setPermanent(key: string, value: string): void;
    delete(key: string): boolean;
  };
  readonly stageRequirements?: {
    listByStory(storyId: number): ReadonlyArray<{
      stage: string;
      required: boolean;
      waiverReason: string | null;
      decidedAt: number;
    }>;
  };
  readonly waivers?: {
    listByObject(
      objectType: string,
      objectId: string,
    ): ReadonlyArray<{
      ruleId: string;
      reason: string;
      approvedBy: string;
      at: number;
    }>;
  };
}

interface TrackingOptions {
  readonly fresh?: boolean;
  /** CR-009 §4.1：优先注入业务底座；仅传 client 时自动包一层禅道适配器。 */
  readonly provider?: BusinessProvider;
  readonly client?: ZentaoReadClient;
  readonly config: TeamConfig;
  readonly clock: Clock;
  readonly baseUrl: string;
  readonly store: TrackingStore;
}

type WorkTask = Pick<Task, Extract<keyof Task, string>> & {
  readonly team?: TaskDetail["team"];
};
type StoryRow = Story | StoryDetail | RequirementDetail["story"];
type StageTask = Parameters<typeof summarizeStages>[0][number] & WorkTask;
type Inferences = GetStoryProgressOutput["inferences"];
type Gaps = GetStoryProgressOutput["gaps"];
type ParentRisk = NonNullable<GetTeamWorkOutput["data"]["parentRisks"]>[number];
type FullProgress = Extract<
  GetStoryProgressOutput["data"],
  { story: StoryItem }
>;

const dateFormat = new Intl.DateTimeFormat("en-GB", {
  timeZone: "UTC",
  year: "numeric",
  month: "2-digit",
  day: "2-digit",
  hour: "2-digit",
  minute: "2-digit",
  second: "2-digit",
  fractionalSecondDigits: 3,
  hourCycle: "h23",
});
const stageNames: Record<Stage, string> = {
  design: "方案设计",
  review: "方案评审",
  handoff: "传递设计方案",
  dev: "功能研发",
  interface: "接口联调",
  test: "功能测试",
  acceptance: "产品验收",
  delivery: "交付使用",
};
function isStage(value: string): value is Stage {
  return Object.hasOwn(stageNames, value);
}
const timeStates: Record<
  ReturnType<typeof taskTimeStatus>["status"],
  TaskItem["timeState"]
> = {
  completed: "done",
  unscheduled: "unscheduled",
  overdue: "overdue",
  due_today: "due_today",
  due_soon: "due_soon",
  normal: "on_track",
};
const idSchema = z.coerce.number().int().positive();

function isoTime(timestamp: number) {
  const fields = Object.fromEntries(
    dateFormat.formatToParts(timestamp).map(({ type, value }) => [type, value]),
  );
  return `${fields.year?.padStart(4, "0")}-${fields.month}-${fields.day}T${fields.hour}:${fields.minute}:${fields.second}.${fields.fractionalSecond}Z`;
}

function bounded(text: string, limit = 200) {
  const line = text.trim().replace(/[\r\n\u2028\u2029]+/gu, " ");
  return line.length > limit ? `${line.slice(0, limit - 1)}…` : line;
}

function cachedDate(value: number | null | undefined) {
  return value == null ? value : isoTime(value);
}

// SQLite 保存已投影的字段。回读仍经 DTO 校验并恢复日期与编号列表。
function encodeStory(story: Story | StoryDetail) {
  const { parentIds, ...fields } = story;
  return {
    ...fields,
    parent: parentIds ?? story.parent,
    openedDate: cachedDate(story.openedDate),
    assignedDate: cachedDate(story.assignedDate),
    closedDate: cachedDate(story.closedDate),
    lastEditedDate: cachedDate(story.lastEditedDate),
    reviewedDate: cachedDate(story.reviewedDate),
    plan: story.plan?.join(","),
    linkStories: story.linkStories?.join(","),
    linkRequirements: story.linkRequirements?.join(","),
    actions:
      "actions" in story
        ? story.actions?.map(({ date, ...action }) => ({
            ...action,
            date: cachedDate(date),
          }))
        : undefined,
  };
}
function indexById<T extends { id: number }>(rows: readonly T[]) {
  return new Map(rows.map((row) => [row.id, row]));
}

function groupBy<T, K>(items: Iterable<T>, keyFor: (item: T) => K) {
  const groups = new Map<K, T[]>();
  for (const item of items) {
    const key = keyFor(item);
    const group = groups.get(key);
    if (group) group.push(item);
    else groups.set(key, [item]);
  }
  return groups;
}

function parseInput<T>(schema: z.ZodType<T>, raw: unknown): T {
  const result = schema.safeParse(raw);
  if (!result.success)
    throw new BztError(
      "INVALID_INPUT",
      "跟踪查询参数不合法，请检查筛选条件和查询编号。",
    );
  return result.data;
}

function monthOf(input: string | undefined, today: string) {
  if (input !== "本月" && input !== "上月" && input !== "下月") return input;
  const offset = { 本月: 0, 上月: -1, 下月: 1 }[input];
  const position =
    Number(today.slice(0, 4)) * 12 + Number(today.slice(5, 7)) - 1 + offset;
  return `${Math.floor(position / 12)}-${String((position % 12) + 1).padStart(2, "0")}`;
}

function includesText(value: string | null | undefined, query: string) {
  return value?.toLowerCase().includes(query.toLowerCase()) === true;
}

function feedbackTokens(value: string | null | undefined) {
  return (
    value
      ?.split(/[、，,;；]/u)
      .map((token) => token.trim().toLowerCase())
      .filter(Boolean) ?? []
  );
}

function isWaiting(story: StoryRow) {
  return story.status === "reviewing" || story.status === "draft";
}

function evidenceText(html: string) {
  return [...html.matchAll(htmlFragments)]
    .map(([fragment, hidden]) => {
      if (
        hidden ||
        fragment.startsWith("<!--") ||
        /^<p[^>]*>\s*\[bzt:v1\s/iu.test(fragment)
      )
        return "";
      if (/^<h[1-6](?=[\s>])/iu.test(fragment)) return "\n## ";
      if (/^<\/?(?:h[1-6]|p|div|li|ul|ol|br)(?=[\s/>])/iu.test(fragment))
        return "\n";
      return fragment.startsWith("<") ? "" : fragment;
    })
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

// docs/07 §3.6、docs/05 §7 SEC-06：提取研发视图字段并截断不可信正文。
function developmentText(story: StoryDetail) {
  const sections: Record<"scope" | "design" | "acceptance", string[]> = {
    scope: [],
    design: [],
    acceptance: [],
  };
  let current: keyof typeof sections | undefined;
  for (const raw of evidenceText(story.spec ?? "").split(/\r?\n/u)) {
    const line = raw.trim().replace(/^#{1,6}\s+/u, "");
    if (!line || /^\[bzt:v1\s/u.test(line)) continue;
    const heading =
      /^(本次实现范围|设计文档|设计章节|验收标准|验收条件|背景与问题|来源)(?:\s*[:：]\s*(.*))?$/u.exec(
        line,
      );
    if (heading) {
      const [, label, content] = heading;
      if (label === "本次实现范围") current = "scope";
      else if (label === "设计文档" || label === "设计章节") current = "design";
      else if (label === "验收标准" || label === "验收条件")
        current = "acceptance";
      else current = undefined;
      if (current && content) sections[current].push(content);
    } else if (/^#{1,6}\s/u.test(raw.trim())) current = undefined;
    else if (current) sections[current].push(line);
  }
  const acceptance = story.verify ? evidenceText(story.verify).trim() : "";
  return {
    scope: bounded(sections.scope.join(" "), 2000) || undefined,
    designRef: bounded(sections.design.join(" "), 2000) || undefined,
    verify:
      bounded(acceptance || sections.acceptance.join(" "), 2000) || undefined,
  };
}

function numericIds(values: readonly (string | number)[]) {
  return [
    ...new Set(
      values.flatMap((value) => {
        const id = idSchema.safeParse(value).data;
        return id === undefined ? [] : [id];
      }),
    ),
  ];
}

// 每次查询独立记录取数缺口与快照时间，并复用同一次查询中的明细请求。
class TrackingRead {
  readonly now: number;
  readonly today: string;
  readonly time: RuleContext & { dueSoonWorkdays: number };
  readonly gaps: Gaps = [];
  readonly inferences: Inferences = [];
  readonly people = new Map<string, User>();
  readonly tasks = new Map<number, WorkTask>();
  readonly executions = new Map<number, Pick<Execution, "id" | "name">>();
  readonly executionDates = new Map<number, Execution>();
  readonly storyTitles = new Map<number, string>();
  private readonly executionTasks = new Map<
    number,
    Promise<{ readonly items: readonly Task[]; truncated: boolean } | undefined>
  >();
  private readonly storyDetails = new Map<
    number,
    Promise<StoryDetail | undefined>
  >();
  private readonly taskDetails = new Map<number, Promise<void | undefined>>();
  private readonly productBugs = new Map<
    number,
    ReturnType<TrackingRead["loadBugs"]>
  >();
  private readonly productPlans = new Map<
    number,
    ReturnType<TrackingRead["loadPlans"]>
  >();
  private readonly names = new Map<number, string>();
  private users?: Promise<void>;
  private executionList?: Promise<readonly Execution[]>;

  readonly provider: BusinessProvider;

  constructor(
    readonly options: TrackingOptions,
    horizon?: number,
  ) {
    if (options.provider) this.provider = options.provider;
    else if (options.client)
      this.provider = createZentaoBusinessProvider({
        client: options.client,
        baseUrl: "",
      });
    else throw new BztError("CONFIG_MISSING", "请为跟踪服务配置业务底座。");
    const { clock, config } = options;
    this.now = clock();
    this.today = formatLocalDate(this.now, config.timezone);
    this.time = {
      today: this.today,
      calendar: createWorkCalendar(config.calendar),
      timezone: config.timezone,
      dueSoonWorkdays: horizon ?? config.timeState.dueSoonWorkdays,
    };
  }

  finish<T>(
    data: T,
    filters: Record<string, unknown>,
    timeBasis: string,
  ): {
    ok: true;
    data: T;
    scope: {
      asOf: string;
      filters: Record<string, unknown>;
      timeBasis: string;
    };
    completeness: "complete" | "partial";
    gaps: Gaps;
    inferences: Inferences;
  } {
    return {
      ok: true,
      data,
      scope: { asOf: isoTime(this.now), filters, timeBasis },
      completeness: this.gaps.length ? "partial" : "complete",
      gaps: this.gaps,
      inferences: this.inferences,
    };
  }

  gap(source: string, reason: string) {
    if (
      !this.gaps.some((gap) => gap.source === source && gap.reason === reason)
    )
      this.gaps.push({ source, reason });
  }

  async read<T>(
    source: string,
    load: () => T | Promise<T>,
    missingIsEmpty = false,
  ) {
    try {
      return await load();
    } catch (error) {
      if (!(error instanceof BztError) || error.code === "AMBIGUOUS_ENTITY")
        throw error;
      if (!missingIsEmpty || error.code !== "NOT_FOUND")
        this.gap(source, readGapReason(source, error));
      return undefined;
    }
  }

  async page<T>(
    source: string,
    load: () => Promise<{ readonly items: readonly T[]; truncated: boolean }>,
  ) {
    const page = await this.read(source, load);
    if (page?.truncated) this.gap(source, "分页未读完整。");
    return page;
  }

  private async cached<T>(
    key: string,
    schema: z.ZodType<T>,
    load: () => Promise<T>,
    encode: (value: T) => unknown,
    cacheable: (value: T) => boolean,
    fresh = false,
  ): Promise<T> {
    const {
      config,
      store: { cache },
    } = this.options;
    // docs/05 §8 查询最多缓存一分钟，可通过任务缓存配置缩短或关闭。
    const ttl = Math.min(60_000, config.cache.taskMinutes * 60_000);
    if (!cache || ttl === 0) return load();
    try {
      const raw = cache.get(key);
      if (raw && !this.options.fresh) {
        const parsed = z
          .object({ observedAt: z.int(), value: schema })
          .safeParse(JSON.parse(raw));
        if (
          parsed.success &&
          parsed.data.observedAt <= this.now &&
          (!fresh || parsed.data.observedAt === this.now)
        )
          return parsed.data.value;
      }
    } catch {
      // 缓存损坏或不可用时直接请求禅道。
    }
    const value = await load();
    if (cacheable(value)) {
      try {
        cache.set(
          key,
          JSON.stringify({ observedAt: this.now, value: encode(value) }),
          ttl,
        );
      } catch {
        // 缓存写入失败不影响已取得的结果。
      }
    }
    return value;
  }

  me() {
    return this.read("me", () => this.provider.getCurrentUser());
  }

  directory() {
    this.users ??= this.page("users", () => this.provider.listUsers()).then(
      (page) => {
        for (const user of page?.items ?? [])
          if (!user.deleted) this.people.set(user.account, user);
      },
    );
    return this.users;
  }

  account(input: string) {
    if (this.people.has(input)) return input;
    const key = input.toLowerCase();
    const alias = this.options.config.aliases[input];
    if (alias) return alias;
    const matches = [...this.people.values()].filter(
      ({ account, realname, pinyin }) =>
        [account, realname, pinyin].some(
          (value) => value?.toLowerCase() === key,
        ),
    );
    if (matches.length > 1)
      throw new BztError(
        "AMBIGUOUS_ENTITY",
        "人员名称对应多个账号，请指定账号。",
        {
          candidates: matches.map(({ account }) => this.person(account)),
        },
      );
    return matches[0]?.account ?? input;
  }

  person(account: string | undefined | null): StoryItem["maintainer"] {
    return account
      ? {
          account: bounded(account),
          realname: bounded(this.people.get(account)?.realname ?? ""),
          untrusted: true,
        }
      : undefined;
  }

  url(type: string, id: number) {
    return new URL(
      `${type}-view-${id}.html`,
      `${this.options.baseUrl.replace(/\/+$/u, "")}/`,
    ).href;
  }

  async products(id?: number) {
    const page = await this.page("products", () =>
      this.provider.listProducts(),
    );
    const products = page?.items.filter((product) => !product.deleted) ?? [];
    for (const { id, name } of products) this.names.set(id, name);
    return products.filter((product) => id === undefined || product.id === id);
  }

  plans(product: number) {
    const pending = this.productPlans.get(product) ?? this.loadPlans(product);
    this.productPlans.set(product, pending);
    return pending;
  }

  private async loadPlans(product: number) {
    const rows = await this.page(`plans:${product}`, () =>
      this.provider.listProductPlans(product),
    );
    return [...walkProductPlans(rows?.items ?? [])].filter(
      ({ deleted }) => !deleted,
    );
  }

  bugs(product: number) {
    const pending = this.productBugs.get(product) ?? this.loadBugs(product);
    this.productBugs.set(product, pending);
    return pending;
  }

  private loadBugs(product: number) {
    return this.page(`bugs:${product}`, () =>
      this.provider.listProductBugs(product),
    );
  }

  async stories(
    product?: number,
    type: "story" | "requirement" = "story",
    fresh = false,
  ) {
    const products = await this.products(product);
    const { config } = this.options;
    const collection = type === "story" ? "stories" : "requirements";
    const pages = await Promise.all(
      products.map(({ id }) =>
        this.page(`${collection}:${id}`, () =>
          type === "requirement"
            ? this.provider.listProductRequirements(id)
            : this.cached(
                `stories:${id}`,
                z.object({
                  items: z
                    .array(storyDtoFor(config.timezone))
                    .refine((rows) =>
                      rows.every(
                        (row) => row.type === "story" && row.product === id,
                      ),
                    ),
                  truncated: z.boolean(),
                }),
                () => this.provider.listProductStories(id),
                ({ items, truncated }) => ({
                  items: items.map(encodeStory),
                  truncated,
                }),
                ({ truncated, items }) =>
                  !truncated && items.every((row) => row.product === id),
                fresh,
              ),
        ),
      ),
    );
    const stories = [
      ...indexById(
        pages
          .flatMap((page) => page?.items ?? [])
          .filter(
            (row) =>
              !row.deleted && products.some(({ id }) => id === row.product),
          ),
      ).values(),
    ];
    for (const { id, title } of stories)
      if (type === "story") this.storyTitles.set(id, title);
    return stories;
  }

  detail(id: number) {
    const pending =
      this.storyDetails.get(id) ??
      this.read(`story:${id}`, () => this.requiredDetail(id));
    this.storyDetails.set(id, pending);
    return pending;
  }

  async requiredDetail(id: number) {
    const { config } = this.options;
    const story = await this.cached(
      `story:${id}`,
      storyDetailDtoFor(config.timezone).refine(
        (row) => row.id === id && !row.deleted,
      ),
      async () => {
        const row = await this.provider.getStoryDetail(id);
        if (row.id !== id)
          throw new BztError(
            "ZENTAO_SCHEMA_MISMATCH",
            "需求详情与查询对象不一致。",
          );
        if (row.deleted) throw new BztError("NOT_FOUND", "需求已删除。");
        return row;
      },
      encodeStory,
      () => true,
    );
    this.storyTitles.set(id, story.title);
    const tag = parseStoryRoleTag(story.spec ?? "");
    if (tag?.maintainer || tag?.receiver) {
      const maintainer = tag.maintainer ?? null;
      const receiver = tag.receiver ?? null;
      try {
        let existing: ReturnType<LocalStore["storyRoles"]["get"]> | undefined;
        try {
          existing = this.options.store.storyRoles.get(story.id);
        } catch (error) {
          if (!(error instanceof BztError && error.code === "NOT_FOUND")) {
            throw error;
          }
        }
        if (
          existing?.maintainer !== maintainer ||
          existing?.receiver !== receiver
        ) {
          this.options.store.storyRoles.upsert({
            storyId: story.id,
            maintainer,
            receiver,
            updatedAt: this.now,
          });
        }
      } catch {
        // 角色缓存更新失败不影响只读查询。
      }
    }
    for (const execution of story.executions)
      if (!this.executions.has(execution.id))
        this.executions.set(execution.id, execution);
    return story;
  }

  allExecutions() {
    this.executionList ??= this.page("executions", () =>
      this.provider.listExecutions(),
    ).then((rows) => {
      const executions = rows?.items ?? [];
      for (const execution of executions) {
        this.executions.set(execution.id, execution);
        this.executionDates.set(execution.id, execution);
      }
      return executions;
    });
    return this.executionList;
  }

  async allTasks(range?: ReturnType<typeof monthDateRange>) {
    const executions = await this.allExecutions();
    return this.loadTasks(
      executions
        .filter(
          ({ begin, end }) => !range || overlapsDateRange(range, begin, end),
        )
        .map(({ id }) => id),
    );
  }

  private async loadTasks(executions: number[]) {
    return Promise.all(
      [...new Set(executions)].map((id) => {
        const pending =
          this.executionTasks.get(id) ??
          this.page(`tasks:${id}`, async () => {
            const result = await this.provider.listExecutionTasks(id);
            for (const task of result.items) {
              if (task.execution !== id)
                this.gap(`tasks:${id}`, "执行列表中有任务的归属不一致。");
              else if (!this.tasks.has(task.id)) this.tasks.set(task.id, task);
            }
            return result;
          });
        this.executionTasks.set(id, pending);
        return pending;
      }),
    );
  }

  private taskDetail(id: number) {
    const pending =
      this.taskDetails.get(id) ??
      this.read(`task:${id}`, async () => {
        const detail = await this.provider.getTaskDetail(id);
        const original = this.tasks.get(id);
        if (
          detail.id !== id ||
          (original && detail.execution !== original.execution)
        )
          throw new BztError(
            "ZENTAO_SCHEMA_MISMATCH",
            "任务详情与查询对象不一致。",
          );
        this.tasks.set(id, {
          ...detail,
          ...original,
          desc: original?.desc ?? detail.desc,
          team: detail.team,
        });
        for (const child of detail.children)
          if (!this.tasks.has(child.id) && child.execution === detail.execution)
            this.tasks.set(child.id, child);
      });
    this.taskDetails.set(id, pending);
    return pending;
  }

  async hydrateWorkTasks() {
    const checked = new Set<number>();
    for (;;) {
      const parents = new Set(
        [...this.tasks.values()]
          .filter(({ deleted }) => !deleted)
          .map(({ parent }) => parent),
      );
      const pending = [...this.tasks.values()].filter(
        (task) =>
          !task.deleted &&
          !checked.has(task.id) &&
          ((task.mode === "multi" &&
            !task.team?.length &&
            taskTimeStatus(task, this.time).status !== "completed") ||
            (task.isParent && !parents.has(task.id))),
      );
      if (!pending.length) return;
      for (const { id } of pending) checked.add(id);
      await Promise.all(pending.map(({ id }) => this.taskDetail(id)));
    }
  }

  async storyTasks(story: StoryDetail) {
    const pages = await this.loadTasks(story.executions.map(({ id }) => id));
    await Promise.all(
      (story.tasks ?? [])
        .filter(({ id }) => !this.tasks.has(id))
        .map(({ id }) => this.taskDetail(id)),
    );
    const known = [...this.tasks.values()].filter(
      (task) => !task.deleted && this.storyId(task) === story.id,
    );
    const parentsWithChildren = new Set(known.map(({ parent }) => parent));
    await Promise.all(
      known
        .filter(({ id, isParent }) => isParent && !parentsWithChildren.has(id))
        .map(({ id }) => this.taskDetail(id)),
    );
    const rows = [...this.tasks.values()]
      .filter((task) => !task.deleted && this.storyId(task) === story.id)
      .sort((a, b) => a.id - b.id);
    const ids = new Set(rows.map(({ id }) => id));
    const missing = story.tasks?.some(({ id }) => !ids.has(id));
    const parents = new Set(rows.map(({ parent }) => parent));
    const incompleteTree = rows.some(
      ({ id, parent, isParent }) =>
        (isParent && !parents.has(id)) || (parent != null && !ids.has(parent)),
    );
    if (missing || incompleteTree)
      this.gap(`story:${story.id}:tasks`, "需求关联任务或父子关系读取不完整。");
    return {
      rows,
      complete:
        !missing &&
        !incompleteTree &&
        pages.every((page) => page?.truncated === false),
    };
  }

  storyId(task: WorkTask) {
    return (
      task.story ??
      this.ancestors(task).find(({ story }) => story != null)?.story
    );
  }

  private ancestors(task: WorkTask) {
    const ancestors: WorkTask[] = [];
    const visited = new Set([task.id]);
    let id = task.parent;
    while (id != null && !visited.has(id)) {
      visited.add(id);
      const parent = this.tasks.get(id);
      if (!parent) break;
      ancestors.push(parent);
      id = parent.parent;
    }
    return ancestors;
  }

  stageInputs(rows: readonly WorkTask[]): StageTask[] {
    const children = groupBy(rows, ({ parent }) => parent);
    const { naming, teams } = this.options.config;
    return rows.map((task) => {
      const account = task.assignedTo;
      const inTeam = (id: string) =>
        account != null &&
        (teams[id]?.lead === account || teams[id]?.members.includes(account));
      const role = account ? this.people.get(account)?.role : undefined;
      const assigneeGroup =
        role === "qa" || role === "test" || inTeam("qa")
          ? "test"
          : role === "design" || inTeam("design")
            ? "design"
            : undefined;
      const executionKind = this.executions
        .get(task.execution)
        ?.name.includes(`【${naming.execution.kinds.design}】`)
        ? "design"
        : undefined;
      return {
        ...task,
        isParent: task.isParent || children.has(task.id),
        evidence: {
          assigneeGroup,
          executionKind,
          prefixes: naming.taskPrefix,
          childTitles: children.get(task.id)?.map(({ name }) => name),
        },
      };
    });
  }

  taskItem(
    task: WorkTask,
    account = task.assignedTo,
    stages?: ReadonlyMap<number, StageTask>,
  ): TaskItem {
    const { status } = taskTimeStatus(task, this.time);
    let detection = detectStage(task, stages?.get(task.id)?.evidence);
    for (const ancestor of this.ancestors(task)) {
      const inherited = detectStage(
        ancestor,
        stages?.get(ancestor.id)?.evidence,
      );
      if (inherited.stage === "unknown") continue;
      detection = inherited;
      break;
    }
    if (detection.confidence === "inferred")
      this.inferred(
        `task:${task.id}:stage`,
        "按任务标题、类型、所属团队或迭代推测阶段。",
      );
    const story = this.storyId(task);
    return {
      id: task.id,
      name: bounded(task.name),
      url: this.url("task", task.id),
      untrusted: true,
      stage: detection.stage === "unknown" ? undefined : detection.stage,
      stageLevel:
        detection.confidence === "unknown" ? undefined : detection.confidence,
      status: task.status,
      assignedTo: this.person(account),
      estStarted: task.estStarted ?? undefined,
      deadline: task.deadline ?? undefined,
      left: task.left ?? undefined,
      timeState: timeStates[status],
      overdueDays:
        status === "overdue" && task.deadline
          ? countWorkdaysBetween(task.deadline, this.today, this.time.calendar)
          : undefined,
      story: story
        ? {
            id: story,
            title: bounded(
              this.storyTitles.get(story) ?? task.storyTitle ?? "",
            ),
            untrusted: true,
          }
        : undefined,
      execution: {
        id: task.execution,
        name: bounded(this.executions.get(task.execution)?.name ?? ""),
        untrusted: true,
      },
      isParent: stages?.get(task.id)?.isParent ?? task.isParent,
    };
  }

  inferred(field: string, basis: string) {
    if (!this.inferences.some((item) => item.field === field))
      this.inferences.push({ field, level: "inferred", basis });
  }

  async roles(story: StoryRow) {
    const { config, store } = this.options;
    const spec = "spec" in story ? story.spec : undefined;
    const configured = config.modules[`${story.product}:${story.module}`];
    const fallback = config.moduleDefaults[story.product];
    const [stored, links] = await Promise.all([
      this.read(
        `storyRoles:${story.id}`,
        () => store.storyRoles.get(story.id),
        true,
      ),
      this.read(`sourceLinks:story:${story.id}`, () =>
        store.sourceLinks.listTo("story", String(story.id)),
      ),
    ]);
    const sources = new Set(
      links
        ?.filter(
          ({ fromType, relation }) =>
            fromType === "intake" && relation === "source",
        )
        .map(({ fromId }) => fromId),
    );
    const taggedIntake = parseStoryRoleTag(spec ?? "")?.intake;
    if (taggedIntake) sources.add(taggedIntake);
    const intakes = (
      await Promise.all(
        [...sources].map((id) =>
          this.read(`intake:${id}`, () => store.intake.get(id), true),
        ),
      )
    ).filter((row) => row !== undefined);
    const intake =
      intakes.find(({ feedbackByAccount }) => feedbackByAccount) ?? intakes[0];
    const roleInput: NonNullable<RuleInput["roles"]> = {
      directory: [...this.people.values()],
      stored,
      intake,
      module: {
        maintainer: configured?.designLead ?? fallback?.designLead,
        devLead: configured?.devLead ?? fallback?.devLead,
      },
    };
    const roles = resolveStoryRoles({
      ...roleInput,
      story: { ...story, spec },
    });
    return { roles, roleInput, intakes, links: links ?? [] };
  }

  async maintainedCandidates(stories: Story[], account: string) {
    const { config, store } = this.options;
    const matches = await Promise.all(
      stories
        .filter(({ status }) => status !== "closed")
        .map(async (story) => {
          const module = config.modules[`${story.product}:${story.module}`];
          if (
            story.openedBy === account ||
            story.assignedTo === account ||
            (module?.designLead ??
              config.moduleDefaults[story.product]?.designLead) === account
          )
            return story.id;
          const stored = await this.read(
            `storyRoles:${story.id}`,
            () => store.storyRoles.get(story.id),
            true,
          );
          return stored?.maintainer === account ? story.id : undefined;
        }),
    );
    return new Set(matches.filter((id) => id !== undefined));
  }

  async feedbackStoryIds(account: string, realname: string) {
    const { intake, sourceLinks } = this.options.store;
    const records = await this.read("intake", () => intake.list());
    const matched =
      records?.filter(
        ({ feedbackByAccount, feedbackByText }) =>
          feedbackByAccount === account ||
          feedbackTokens(feedbackByText).some(
            (token) =>
              token === account.toLowerCase() ||
              token === realname.toLowerCase(),
          ),
      ) ?? [];
    const links = await Promise.all(
      matched.map(({ intakeId }) =>
        this.read("sourceLinks:intake", () =>
          sourceLinks.listFrom("intake", intakeId),
        ),
      ),
    );
    return new Set(
      numericIds(
        links.flatMap(
          (page) =>
            page
              ?.filter(
                ({ toType, relation }) =>
                  toType === "story" && relation === "source",
              )
              .map(({ toId }) => toId) ?? [],
        ),
      ),
    );
  }

  storyItem(
    story: StoryRow,
    people: Awaited<ReturnType<TrackingRead["roles"]>>,
    progress: StoryItem["progress"],
    riskCodes: string[],
    plan?: ProductPlan,
    next?: TaskItem,
  ): StoryItem {
    const { roles, intakes } = people;
    const version = this.version(story, plan);
    return {
      id: story.id,
      title: bounded(story.title),
      url: this.url(story.type, story.id),
      untrusted: true,
      product: {
        id: story.product,
        name: bounded(
          this.names.get(story.product) ??
            this.options.config.products[story.product]?.name ??
            "",
        ),
        untrusted: true,
      },
      module:
        story.module && story.moduleTitle
          ? {
              id: story.module,
              path: bounded(story.moduleTitle),
              untrusted: true,
            }
          : undefined,
      category:
        story.category === "feature" || story.category === "design"
          ? story.category
          : "other",
      status: bounded(story.status),
      progress: { value: progress.value, level: progress.level },
      plan: plan
        ? {
            id: plan.id,
            title: bounded(plan.title),
            month: plan.begin?.slice(0, 7),
            untrusted: true,
          }
        : undefined,
      version: version ? bounded(version) : undefined,
      maintainer: this.person(roles.maintainer),
      currentOwner: this.person(roles.currentHandler),
      receiver: this.person(roles.receiver),
      feedbackBy: displayFeedback(
        intakes[0]?.feedbackByText ??
          story.feedbackBy ??
          roles.feedback.original,
      ),
      nextStage: next?.stage,
      nextDeadline: next?.deadline,
      riskCodes,
    };
  }

  version(story: StoryRow, plan?: ProductPlan) {
    const { keywordPrefix, pattern } = this.options.config.versionTag;
    const expression = new RegExp(pattern, "iu");
    const token = story.keywords
      ?.split(/[\s,，、;；]+/u)
      .find(
        (value) =>
          value.startsWith(keywordPrefix) &&
          expression.test(value.slice(keywordPrefix.length)),
      );
    if (token) return token.slice(keywordPrefix.length);
    return plan && expression.test(plan.title) ? plan.title : undefined;
  }
}

function displayFeedback(value: string | undefined | null) {
  return value ? bounded(value) : undefined;
}

function selectedPlan(
  plans: readonly ProductPlan[],
  story: StoryRow,
  planId?: number,
  month?: string,
) {
  const linked = plans.filter(({ id }) => story.plan?.includes(id));
  if (planId !== undefined) return linked.find(({ id }) => id === planId);
  return linked.find((plan) => month && overlapsPlan(plan, month)) ?? linked[0];
}

// docs/04 §4.6 只按 L3 的起止日期判断计划月份。
function overlapsPlan(plan: ProductPlan, month: string) {
  return (
    planOverlapDays(
      { ...plan, kind: plan.parent && plan.parent > 0 ? "l3" : "other" },
      month,
    ) > 0
  );
}

function overlapsExecution(
  execution: Pick<Execution, "begin" | "end">,
  month: string,
) {
  return (
    execution.begin != null &&
    execution.end != null &&
    execution.begin.slice(0, 7) <= month &&
    month <= execution.end.slice(0, 7)
  );
}

function activeStoryMonth(
  story: Pick<
    Story,
    "openedDate" | "assignedDate" | "lastEditedDate" | "closedDate"
  >,
  month: string,
  timezone: string,
) {
  return [
    story.openedDate,
    story.assignedDate,
    story.lastEditedDate,
    story.closedDate,
  ].some(
    (date) => date != null && formatLocalDate(date, timezone).startsWith(month),
  );
}

function scheduledInMonth(
  task: WorkTask,
  range?: ReturnType<typeof monthDateRange>,
) {
  if (!range || (!task.estStarted && !task.deadline)) return true;
  return overlapsDateRange(
    range,
    task.estStarted ?? task.deadline,
    task.deadline ?? task.estStarted,
  );
}

function threshold(
  workdays: number,
  standard: number,
): { workdays: number; source: "default" | "configured" } {
  return { workdays, source: workdays === standard ? "default" : "configured" };
}

async function evidenceConfig(
  state: TrackingRead,
  story: StoryDetail,
  {
    receiver,
    maintainer,
  }: Pick<ReturnType<typeof resolveStoryRoles>, "receiver" | "maintainer">,
) {
  const { config, store } = state.options;
  const defaults =
    story.category === "design"
      ? config.stageDefaults.design
      : config.stageDefaults.feature;
  const [cachedRequirements, cachedWaivers] = await Promise.all([
    state.read(
      "stageRequirements:" + story.id,
      () => store.stageRequirements?.listByStory(story.id) ?? [],
    ),
    state.read(
      "waivers:story:" + story.id,
      () => store.waivers?.listByObject("story", String(story.id)) ?? [],
    ),
  ]);
  const handoffs = (story.actions ?? []).flatMap(({ action, date }) =>
    action.toLowerCase() === "activated" && date != null ? [date] : [],
  );
  if (story.assignedTo === receiver && story.assignedDate != null)
    handoffs.push(story.assignedDate);
  return {
    required: foldStageRequirements(
      defaults,
      cachedRequirements,
      story.actions,
      stageRequirementApprovers(config.roles, maintainer),
    ),
    waivers: foldRuleWaivers(
      "story",
      story.id,
      cachedWaiverEntries(cachedWaivers ?? []),
      {
        actions: story.actions,
        approvers: [...(config.roles.PM ?? []), maintainer],
      },
    ),
    handoffAt: handoffs.length ? Math.max(...handoffs) : null,
  };
}

async function relatedStories(
  state: TrackingRead,
  story: StoryDetail,
  inbound: Awaited<ReturnType<TrackingRead["roles"]>>["links"],
) {
  const outbound = await state.read(`sourceLinks:story:${story.id}`, () =>
    state.options.store.sourceLinks.listFrom("story", String(story.id)),
  );
  const requirements = numericIds([
    ...(story.linkRequirements ?? []),
    ...(story.requirements ?? []).map(({ id }) => id),
    ...inbound
      .filter(
        ({ fromType, relation }) =>
          fromType === "requirement" && relation === "links",
      )
      .map(({ fromId }) => fromId),
  ]);
  const pairs = numericIds([
    ...inbound
      .filter(
        ({ fromType, relation }) =>
          fromType === "story" && relation === "pairs",
      )
      .map(({ fromId }) => fromId),
    ...(outbound ?? [])
      .filter(
        ({ toType, relation }) => toType === "story" && relation === "pairs",
      )
      .map(({ toId }) => toId),
  ]).filter((id) => id !== story.id);
  const derivesFrom = numericIds([
    ...(outbound ?? [])
      .filter(
        ({ toType, relation }) => toType === "story" && relation === "derives",
      )
      .map(({ toId }) => toId),
    ...(story.fromStory ? [story.fromStory] : []),
  ]).find((id) => id !== story.id);
  const derived = numericIds(
    inbound
      .filter(
        ({ fromType, relation }) =>
          fromType === "story" && relation === "derives",
      )
      .map(({ fromId }) => fromId),
  );
  return {
    requirements,
    requirement: requirements[0],
    pairs,
    pair: pairs[0],
    derivesFrom,
    derived,
  };
}

// docs/07 §3.10 风险输出与巡检工具共用契约，领域证据保留在原因中。
function projectRisk(
  state: TrackingRead,
  story: StoryDetail,
  risk: RiskHit & { waived?: { by: string; reason: string } },
): FullProgress["risks"][number] {
  const task =
    risk.objectType === "task" ? state.tasks.get(risk.objectId) : undefined;
  const owner = state.person(task ? task.assignedTo : story.assignedTo);
  const level = risk.confidence === "recorded" ? "recorded" : "inferred";
  if (level === "inferred")
    state.inferred(
      `${risk.objectType}:${risk.objectId}:risk:${risk.ruleId}`,
      "规则命中使用了推测的阶段或流程证据。",
    );
  const limit = risk.threshold
    ? `（${risk.threshold.source === "default" ? "默认" : "已确认配置"}阈值：${risk.threshold.workdays} 个工作日）`
    : "";
  return {
    rule: risk.ruleId,
    severity: risk.severity,
    level,
    object: {
      type: risk.objectType,
      id: risk.objectId,
      title: bounded(task?.name ?? story.title),
      url: state.url(risk.objectType, risk.objectId),
      untrusted: true,
    },
    owner: owner
      ? { account: owner.account, realname: owner.realname }
      : undefined,
    since: risk.since ?? undefined,
    reason: `${risk.state === "stalled" ? "滞留" : "缺口"}：${risk.evidence.join("，")}${limit}`,
    suggestion: risk.suggestion,
    waived: risk.waived
      ? {
          by: bounded(risk.waived.by),
          reason: bounded(risk.waived.reason),
          untrusted: true,
        }
      : undefined,
  };
}

async function storyEvidence(
  state: TrackingRead,
  story: StoryDetail,
  people: Awaited<ReturnType<TrackingRead["roles"]>>,
  plan?: ProductPlan,
) {
  const [tasks, relations, bugPage] = await Promise.all([
    state.storyTasks(story),
    relatedStories(state, story, people.links),
    state.bugs(story.product),
  ]);
  const { config } = state.options;
  const linkedFeatures =
    story.category === "design"
      ? await Promise.all(
          numericIds([
            ...relations.pairs,
            ...relations.derived,
            ...(relations.derivesFrom ? [relations.derivesFrom] : []),
          ]).map((id) => state.detail(id)),
        )
      : [];
  const bugs = [
    ...indexById(
      (bugPage?.items ?? []).filter(
        (bug) =>
          !bug.deleted &&
          bug.product === story.product &&
          bug.story === story.id,
      ),
    ).values(),
  ];
  const stageInputs = state.stageInputs(tasks.rows);
  const stageIndex = indexById(stageInputs);
  const taskItems = tasks.rows.map((task) =>
    state.taskItem(task, task.assignedTo, stageIndex),
  );
  const stageSummary = summarizeStages(stageInputs);
  const metadata = await evidenceConfig(state, story, people.roles);
  const releaseDate = config.releaseCalendar.find(
    ({ product, version }) =>
      product === story.product && version === state.version(story, plan),
  )?.date;
  const business =
    story.category === "design"
      ? designProgress({
          ...story,
          ...stageSummary,
          tasksComplete: tasks.complete && linkedFeatures.every(Boolean),
          hasRelatedFeature: linkedFeatures.some(
            (row) => row?.category === "feature",
          ),
        })
      : featureProgress({
          ...story,
          ...stageSummary,
          required: metadata.required,
          bugs,
          tasksComplete: tasks.complete,
          today: state.today,
          releaseDate,
        });
  const developmentAccounts = new Set([
    ...(config.roles.RM ?? []),
    ...[...state.people.values()]
      .filter(({ role }) => role === "dev")
      .map(({ account }) => account),
    ...[
      ...Object.values(config.modules),
      ...Object.values(config.moduleDefaults),
    ].flatMap(({ devLead }) => (devLead ? [devLead] : [])),
  ]);
  const evaluation = evaluateRules(
    {
      story,
      tasks: stageInputs,
      roles: people.roleInput,
      tasksComplete: tasks.complete,
      ...metadata,
    },
    {
      ...state.time,
      developmentAccounts,
      thresholds: {
        R02: {
          missingAfter: threshold(config.rules.R02.missingAfter, 1),
          waitAfter: threshold(config.rules.R02.waitAfter, 2),
        },
        R03: { after: threshold(config.rules.R03.after, 3) },
      },
      disabledRules: new Set(
        rules
          .filter(({ id }) => id > "R05" || !config.rules[id].enabled)
          .map(({ id }) => id),
      ),
    },
  );
  const risks = [...evaluation.hits, ...evaluation.waived].map((risk) =>
    projectRisk(state, story, risk),
  );
  const lacksQualityEvidence =
    story.category !== "design" &&
    bugPage?.truncated !== false &&
    ["待验收", "待交付", "可关闭"].includes(business.progress);
  const inferred =
    taskItems.some(({ stageLevel }) => stageLevel === "inferred") ||
    business.progress === "无法判断" ||
    lacksQualityEvidence;
  const progress: FullProgress["progress"] = {
    value: lacksQualityEvidence ? "无法判断" : business.progress,
    level: inferred ? "inferred" : "recorded",
    basis: inferred
      ? "按可获得的阶段与质量证据推测。"
      : "按需求状态、关联阶段及问题记录判断。",
  };
  if (inferred) state.inferred(`story:${story.id}:progress`, progress.basis);
  const stages: FullProgress["stages"] = Object.entries(
    metadata.required,
  ).flatMap(([key, required]) => {
    if (!isStage(key)) return [];
    const status = stageSummary.stages[key]?.status;
    const items = taskItems.filter(({ stage }) => stage === key);
    const leaves = items.filter(({ isParent }) => !isParent);
    const state =
      status === "completed"
        ? "done"
        : status === "cancelled"
          ? "cancelled"
          : status !== "in_progress"
            ? required
              ? "missing"
              : "waived"
            : leaves.every(({ status }) => status === "wait")
              ? "not_started"
              : "doing";
    return [
      {
        stage: key,
        required,
        state,
        tasks: items,
        evidence: leaves.map(({ id }) => `关联工作 #${id}`),
      },
    ];
  });
  const nextStage = stages.find(
    ({ state, required }) =>
      required &&
      state !== "done" &&
      state !== "waived" &&
      state !== "cancelled",
  );
  const next = nextStage?.tasks
    .filter(({ timeState }) => timeState !== "done")
    .sort((a, b) =>
      (a.deadline ?? "9999-12-31").localeCompare(b.deadline ?? "9999-12-31"),
    )[0];
  const riskCodes = [
    ...new Set([
      ...evaluation.hits.map(({ ruleId }) => ruleId),
      ...business.flags.filter(
        (flag) => /^R\d+$/u.test(flag) && !rules.some(({ id }) => id === flag),
      ),
    ]),
  ];
  return {
    item: state.storyItem(story, people, progress, riskCodes, plan, next),
    progress,
    risks,
    stages,
    taskItems,
    stageSummary,
    tasksComplete: tasks.complete,
    required: metadata.required,
    nextStage,
    related: {
      requirement: relations.requirement,
      requirements: relations.requirements,
      pair: relations.pair,
      pairs: relations.pairs,
      derivesFrom: relations.derivesFrom,
      bugs: bugs.map(
        ({ id, title, severity, status }) =>
          ({
            id,
            title: bounded(title),
            severity,
            status: bounded(status),
            story: story.id,
            url: state.url("bug", id),
            untrusted: true,
          }) satisfies FullProgress["related"]["bugs"][number],
      ),
    },
  };
}

function feedbackMatches(
  story: StoryRow,
  people: Awaited<ReturnType<TrackingRead["roles"]>>,
  account: string,
  query: string,
) {
  const { intakes, roles } = people;
  if (
    intakes.some(
      ({ feedbackByAccount, feedbackByText }) =>
        feedbackByAccount === account ||
        feedbackTokens(feedbackByText).includes(query.toLowerCase()),
    )
  )
    return true;
  return (
    roles.feedback.matches.some(
      (match) => "account" in match && match.account === account,
    ) ||
    feedbackTokens(story.feedbackBy).some(
      (token) =>
        token === account.toLowerCase() || token === query.toLowerCase(),
    )
  );
}

// docs/04 §4.2–4.3 先在完整任务树判叶子，再按有效责任人过滤。
function workItems(
  state: TrackingRead,
  members: Set<string>,
  tasksComplete: boolean,
  rows: WorkTask[],
  range?: ReturnType<typeof monthDateRange>,
) {
  const work = summarizeLeafWork(rows, { ...state.time, tasksComplete });
  const index = indexById(rows);
  const stageIndex = indexById(state.stageInputs(rows));
  for (const gap of work.gaps) {
    if (gap.kind === "task_list") continue;
    const task = index.get(gap.taskId);
    if (task && !scheduledInMonth(task, range)) continue;
    if (
      gap.kind === "team" &&
      task &&
      !task.team?.some(({ account }) => members.has(account)) &&
      task.team?.length &&
      !(task.assignedTo && members.has(task.assignedTo))
    )
      continue;
    state.gap(
      `task:${gap.taskId}`,
      gap.kind === "children"
        ? "父任务的子任务读取不完整。"
        : "缺少多人任务成员状态。",
    );
  }
  const leaves = work.leaves.flatMap(({ taskId, participants }) => {
    const task = index.get(taskId);
    return task && scheduledInMonth(task, range)
      ? participants
          .filter(
            ({ account, active }) => active === true && members.has(account),
          )
          .map(({ account }) => ({
            task,
            account,
            item: state.taskItem(task, account, stageIndex),
          }))
      : [];
  });
  const parents: ParentRisk[] = work.parentRisks.flatMap(
    ({ taskId, allChildrenFinished }) => {
      const task = index.get(taskId);
      if (
        !task?.assignedTo ||
        !members.has(task.assignedTo) ||
        !scheduledInMonth(task, range)
      )
        return [];
      return [
        {
          task: state.taskItem(task, task.assignedTo, stageIndex),
          allChildrenFinished,
          reason: allChildrenFinished
            ? "子任务已完成，父任务仍未关闭。"
            : "父任务自身已超过截止日期。",
        },
      ];
    },
  );
  return { leaves, parents };
}

const partialDetails = z.object({
  completeness: z.literal("partial"),
  gaps: z.array(z.object({ source: z.string(), reason: z.string() })),
});

export class TrackingService {
  private readonly directory: DirectoryService;

  constructor(private readonly options: TrackingOptions) {
    this.directory = new DirectoryService(options);
  }

  private async resolveScope(
    state: TrackingRead,
    input: { product?: string; module?: string; plan?: string; month?: string },
  ): Promise<Partial<ResolveContextOutput["data"]>> {
    if (!input.product && !input.module && !input.plan) return {};
    try {
      const result = await this.directory.resolveContext(input);
      for (const { source, reason } of result.gaps) state.gap(source, reason);
      return result.data;
    } catch (error) {
      if (!(error instanceof BztError) || error.code === "AMBIGUOUS_ENTITY")
        throw error;
      const partial = partialDetails.safeParse(error.details).data;
      if (!partial) throw error;
      for (const { source, reason } of partial.gaps) state.gap(source, reason);
      return {};
    }
  }

  async getTeamWork(raw: unknown, month?: string): Promise<GetTeamWorkOutput> {
    const {
      team,
      members,
      product,
      view = "overdue",
      groupBy: group = "member",
    } = parseInput(getTeamWorkInputSchema, raw);
    const state = new TrackingRead(this.options);
    const range = month && monthDateRange(month);
    const data: GetTeamWorkOutput["data"] = {
      groups: [],
      totals: { overdue: 0, dueSoon: 0, open: 0 },
      parentRisks: [],
    };
    const filters: Record<string, unknown> = {
      team,
      members,
      product,
      view,
      groupBy: group,
      ...(month && { month }),
    };
    const finish = () =>
      state.finish(
        data,
        filters,
        "按叶子任务截止日期和工作日日历统计；缺口下汇总仅覆盖已读到的任务。",
      );
    const [scope, me] = await Promise.all([
      this.resolveScope(state, { product }),
      !team && !members ? state.me() : undefined,
      state.directory(),
    ]);
    if ((product && !scope.product) || (!team && !members && !me))
      return finish();
    const explicitTeam = team ? this.directory.resolveTeam(team) : undefined;
    const teams = explicitTeam
      ? [explicitTeam]
      : members
        ? []
        : Object.entries(this.options.config.teams)
            .filter(([, config]) => config.lead === me?.account)
            .map(([id, config]) => ({ ...config, id }));
    if (!members && !teams.length)
      throw new BztError(
        "NOT_FOUND",
        "当前用户没有配置主管团队，请指定团队或成员。",
      );
    if (team && !explicitTeam)
      throw new BztError("NOT_FOUND", "未找到指定团队。");
    const accounts = new Set(
      members?.map((member) => state.account(member)) ??
        teams.flatMap(({ lead, members }) => [lead, ...members]),
    );
    if (team && members)
      for (const account of accounts)
        if (
          !teams.some(
            ({ lead, members }) =>
              lead === account || members.includes(account),
          )
        )
          accounts.delete(account);
    filters.members = [...accounts];
    filters.teams = teams.map(({ id }) => id);
    filters.product = scope.product?.id ?? product;
    const productId = scope.product?.id;
    const pages = await state.allTasks(range || undefined);
    await state.hydrateWorkTasks();
    const rows = [...state.tasks.values()].sort((a, b) => a.id - b.id);
    for (const task of rows) {
      const id = state.storyId(task);
      if (id && task.storyTitle?.trim() && !state.storyTitles.has(id))
        state.storyTitles.set(id, task.storyTitle);
    }
    const work = workItems(
      state,
      accounts,
      pages.every((page) => page?.truncated === false),
      rows,
      range || undefined,
    );
    const detailIds = new Set<number>();
    for (const { task, item } of work.leaves) {
      if (
        item.story &&
        ((productId && !task.product) ||
          (group === "story" &&
            !item.story.title &&
            (view === "all_open" || item.timeState === view)))
      )
        detailIds.add(item.story.id);
    }
    if (productId)
      for (const { task } of work.parents)
        if (task.story && !state.tasks.get(task.id)?.product)
          detailIds.add(task.story.id);
    const storyProducts = new Map<number, number>();
    await Promise.all(
      [...detailIds].map(async (id) => {
        const detail = await state.detail(id);
        if (detail) storyProducts.set(id, detail.product);
      }),
    );
    const inProduct = (task: WorkTask) => {
      if (!productId) return true;
      const storyId = state.storyId(task);
      const actual =
        task.product ?? (storyId ? storyProducts.get(storyId) : undefined);
      if (!actual)
        state.gap(`task:${task.id}:product`, "任务缺少可确认的产品归属。");
      return actual === productId;
    };
    const leaves = work.leaves.filter(({ task }) => inProduct(task));
    const counted = [...indexById(leaves.map(({ item }) => item)).values()];
    data.totals = {
      overdue: counted.filter(({ timeState }) => timeState === "overdue")
        .length,
      dueSoon: counted.filter(({ timeState }) => timeState === "due_soon")
        .length,
      open: counted.length,
    };
    data.parentRisks = work.parents.filter(({ task }) => {
      const row = state.tasks.get(task.id);
      return row !== undefined && inProduct(row);
    });
    const visible = leaves.filter(
      ({ item }) => view === "all_open" || item.timeState === view,
    );
    if (group === "story")
      for (const { item } of visible)
        if (item.story && !item.story.title)
          item.story.title = bounded(
            state.storyTitles.get(item.story.id) ?? "",
          );
    const grouped = groupBy(visible, ({ item, account }) =>
      group === "member"
        ? account
        : group === "story"
          ? String(item.story?.id ?? "unlinked")
          : String(item.execution.id),
    );
    for (const [key, rows] of grouped) {
      const items = [...indexById(rows.map(({ item }) => item)).values()];
      const first = items[0];
      const label =
        group === "member"
          ? state.person(key)?.realname || key
          : group === "story"
            ? first?.story?.title ||
              (first?.story ? `需求 #${key}` : "未关联需求")
            : first?.execution.name || `迭代 #${key}`;
      data.groups.push({
        key: bounded(key),
        label: bounded(label),
        count: items.length,
        items,
        untrusted: true,
      });
    }
    return finish();
  }

  async getMyWork(raw: unknown, month?: string): Promise<GetMyWorkOutput> {
    const {
      groups = myWorkGroupSchema.options,
      horizonDays,
      since = "last_seen",
      markSeen = true,
    } = parseInput(getMyWorkInputSchema, raw);
    const state = new TrackingRead(this.options, horizonDays);
    const range = month ? monthDateRange(month) : undefined;
    const { store, client: myClient } = this.options;
    const selected = new Set(groups);
    const data: GetMyWorkOutput["data"] = {
      new: [],
      action: {
        overdue: [],
        dueToday: [],
        dueSoon: [],
        unscheduled: [],
        toReceive: [],
        toReview: [],
      },
      waiting_ready: [],
      maintained: [],
      raised: [],
      can_start: { tests: [], upcomingTests: [], acceptDeliver: [] },
      parentRisks: [],
    };
    const filters: Record<string, unknown> = {
      groups: [...selected],
      horizonDays: state.time.dueSoonWorkdays,
      since,
      markSeen,
      ...(month && { month }),
    };
    const hints: string[] = [];
    const finish = (): GetMyWorkOutput => ({
      ...state.finish(
        data,
        filters,
        "按叶子任务截止日期和工作日日历；新增按指派时间与本地已读时间。",
      ),
      ...(hints.length ? { hints } : {}),
    });
    const me = await state.me();
    if (!me?.account || !selected.size) return finish();
    filters.account = bounded(me.account);
    const needsTasks =
      selected.has("action") ||
      selected.has("new") ||
      selected.has("can_start");
    const initialCursor =
      selected.has("new") && since === "last_seen"
        ? await state.read("seenCursor:my_work", () =>
            store.seenCursor.get("my_work"),
          )
        : undefined;
    const sinceMs =
      since === "last_seen"
        ? (initialCursor?.lastSeenAt ?? 0)
        : since.length === 10
          ? parseZentaoDateTime(
              `${since} 00:00:00`,
              this.options.config.timezone,
            )
          : z.coerce.date().safeParse(since).data?.getTime();
    if (sinceMs == null || !Number.isFinite(sinceMs))
      throw new BztError("INVALID_INPUT", "新增查询的起始时间无效。");
    if (selected.has("new")) filters.since = isoTime(sinceMs);
    const isNew = (assignedAt?: number | null) =>
      selected.has("new") &&
      assignedAt != null &&
      assignedAt > sinceMs &&
      assignedAt <= state.now;

    const [pages, allStories, review, contributions] = await Promise.all([
      needsTasks ? state.allTasks(range) : [],
      // 游标不能越过来源列表的观察时间。
      state.stories(undefined, "story", selected.has("new") && markSeen),
      selected.has("action") && myClient
        ? state.page("myWork:reviewBy", () =>
            listMyWork(myClient, { mode: "story", browseType: "reviewBy" }),
          )
        : undefined,
      selected.has("raised") && myClient
        ? state.page("my_contribute", () =>
            listMyContributions(myClient, {
              mode: "story",
              browseType: "openedBy",
            }),
          )
        : undefined,
      state.directory(),
    ]);
    const storyIds = (page: typeof review) =>
      new Set(
        page?.items
          .filter(
            (item) => "type" in item && item.type === "story" && !item.deleted,
          )
          .map(({ id }) => id),
      );
    const reviewIds = storyIds(review);
    const contributionIds = storyIds(contributions);
    if (needsTasks) await state.hydrateWorkTasks();
    const candidateTasks = [...state.tasks.values()].sort(
      (a, b) => a.id - b.id,
    );
    const work = workItems(
      state,
      new Set([me.account]),
      pages.every((page) => page?.truncated === false),
      candidateTasks,
      range,
    );
    // docs/07 §3.2 新增用分配列表判定。此后补取的详情、角色或 Bug 均是辅助证据。
    const newInputsComplete = !state.gaps.some(({ source }) =>
      /^(?:me$|products$|executions$|stories:|tasks:|task:|my_contribute$|seenCursor:)/u.test(
        source,
      ),
    );
    if (selected.has("action")) data.parentRisks = work.parents;
    for (const { task, item } of work.leaves) {
      if (isNew(task.assignedDate)) data.new.push(item);
      if (!selected.has("action")) continue;
      if (item.timeState === "overdue") data.action.overdue.push(item);
      if (item.timeState === "due_today") data.action.dueToday.push(item);
      if (item.timeState === "due_soon") data.action.dueSoon.push(item);
      if (item.timeState === "unscheduled") data.action.unscheduled.push(item);
    }
    const ownStoryIds = new Set(
      work.leaves.flatMap(({ item }) => (item.story ? [item.story.id] : [])),
    );
    const stories = month
      ? (
          await Promise.all(
            allStories.map(async (story) => {
              if (
                ownStoryIds.has(story.id) ||
                activeStoryMonth(story, month, this.options.config.timezone)
              )
                return story;
              if (!story.plan?.length) return undefined;
              const plans = await state.plans(story.product);
              return plans.some(
                (plan) =>
                  story.plan?.includes(plan.id) && overlapsPlan(plan, month),
              )
                ? story
                : undefined;
            }),
          )
        ).filter((story) => story !== undefined)
      : allStories;
    const storyIdsInMonth = month
      ? new Set(stories.map(({ id }) => id))
      : undefined;
    const [maintainedIds, feedbackIds] = await Promise.all([
      selected.has("maintained")
        ? state.maintainedCandidates(stories, me.account)
        : new Set<number>(),
      selected.has("raised")
        ? state.feedbackStoryIds(me.account, me.realname)
        : new Set<number>(),
    ]);
    const freshStories = indexById(
      stories.filter(
        (story) => story.assignedTo === me.account && isNew(story.assignedDate),
      ),
    );
    const candidates = new Set<number>();
    for (const story of stories) {
      const raised =
        selected.has("raised") &&
        (story.openedBy === me.account ||
          feedbackIds.has(story.id) ||
          feedbackTokens(story.feedbackBy).some(
            (token) =>
              token === me.account.toLowerCase() ||
              me.realname.toLowerCase().includes(token),
          ));
      const open =
        story.status !== "closed" &&
        (maintainedIds.has(story.id) ||
          (selected.has("action") &&
            (story.assignedTo === me.account ||
              story.reviewedBy === me.account)) ||
          (selected.has("waiting_ready") &&
            story.assignedTo === me.account &&
            isWaiting(story)));
      if (raised || open || freshStories.has(story.id))
        candidates.add(story.id);
    }
    if (selected.has("can_start"))
      for (const id of ownStoryIds) candidates.add(id);
    if (selected.has("action"))
      for (const id of reviewIds)
        if (!storyIdsInMonth || storyIdsInMonth.has(id)) candidates.add(id);
    for (const id of contributionIds)
      if (!storyIdsInMonth || storyIdsInMonth.has(id)) candidates.add(id);
    const uninspectedMaintained = selected.has("maintained")
      ? stories.filter(
          ({ id, status }) => status !== "closed" && !candidates.has(id),
        ).length
      : 0;
    if (uninspectedMaintained > 0) {
      state.inferred(
        "maintained",
        `需求列表不含正文角色标签；本次已按提出人、当前处理人、模块设计主管与本地角色缓存筛选，另有 ${uninspectedMaintained} 条未关闭需求未读取正文标签，仅由正文标签指定维护人且尚未入本地缓存的需求可能漏列。`,
      );
      hints.push(
        month
          ? `所选月有 ${uninspectedMaintained} 条未关闭需求尚未核对正文角色标签。可在「需求查询」选择「维护人」，并按产品筛选核对。`
          : `另有 ${uninspectedMaintained} 条未关闭需求未读取正文角色标签；如需全量核对仅由正文标签指定维护人的需求，请调用 query_stories(role="maintainer") 刷新本地角色缓存。`,
      );
    }

    const details = await Promise.all(
      [...candidates].map(async (id) => ({
        id,
        story: await state.detail(id),
      })),
    );
    for (const { id, story } of details) {
      const fresh = freshStories.get(id);
      if (!story) {
        if (fresh) {
          const people = await state.roles(fresh);
          state.inferred(
            `story:${id}:progress`,
            "仅已确认指派，需求进展待确认。",
          );
          data.new.push(
            state.storyItem(
              fresh,
              people,
              { value: "无法判断", level: "inferred" },
              [],
            ),
          );
        }
        continue;
      }
      const people = await state.roles(story);
      const { roles } = people;
      const assigned = roles.currentHandler === me.account;
      const waiting =
        assigned && isWaiting(story) && roles.maintainer !== me.account;
      const maintained =
        selected.has("maintained") &&
        story.status !== "closed" &&
        roles.maintainer === me.account;
      const raised =
        selected.has("raised") &&
        (contributionIds.has(id) ||
          roles.proposer === me.account ||
          feedbackMatches(story, people, me.account, me.realname));
      const action =
        selected.has("action") &&
        story.status !== "closed" &&
        (assigned || reviewIds.has(story.id));
      const canStart =
        selected.has("can_start") &&
        ownStoryIds.has(story.id) &&
        story.category === "feature" &&
        story.status === "active";
      if (!(
        maintained ||
        raised ||
        action ||
        canStart ||
        fresh ||
        (waiting && selected.has("waiting_ready"))
      ))
        continue;
      const evidence = await storyEvidence(state, story, people);
      const { item } = evidence;
      if (fresh)
        data.new.push({
          ...item,
          currentOwner: state.person(fresh.assignedTo),
        });
      if (waiting && selected.has("waiting_ready"))
        data.waiting_ready.push({ ...item, waitingFor: item.maintainer });
      if (maintained) data.maintained.push(item);
      if (raised) data.raised.push(item);
      if (action && !waiting) {
        if (
          assigned &&
          (roles.receiver === me.account ||
            this.options.config.roles.RM?.includes(me.account)) &&
          story.category === "feature" &&
          story.status === "active" &&
          evidence.progress.value === "待接收"
        )
          data.action.toReceive.push(item);
        if (reviewIds.has(story.id) && story.status === "reviewing")
          data.action.toReview.push(item);
      }
      if (canStart)
        this.addReadyTasks(
          state,
          data.can_start,
          evidence,
          work.leaves
            .filter(({ item }) => item.story?.id === story.id)
            .map(({ item }) => item.id),
          me.account,
        );
    }
    if (markSeen && selected.has("new") && newInputsComplete) {
      await state.read("seenCursor:my_work", () => {
        const previous = store.seenCursor.get("my_work")?.lastSeenAt;
        store.seenCursor.set("my_work", Math.max(state.now, previous ?? 0));
      });
    }
    return finish();
  }

  // docs/04 §3.2、§4.4，docs/07 §3.2：按上游阶段完成度与严重 Bug 门禁计算可开始任务。
  private addReadyTasks(
    state: TrackingRead,
    output: GetMyWorkOutput["data"]["can_start"],
    evidence: Awaited<ReturnType<typeof storyEvidence>>,
    own: number[],
    account: string,
  ) {
    if (!evidence.tasksComplete || evidence.stageSummary.hasUnknownTasks)
      return;
    const { dev, interface: integration, test } = evidence.stageSummary.stages;
    const integrationReady =
      integration?.status === "completed" ||
      (!evidence.required.interface &&
        (!integration || integration.status === "cancelled"));
    const devReady =
      (dev?.status === "completed" || (!dev && !evidence.required.dev)) &&
      integrationReady;
    const upstream = evidence.taskItems.filter(
      ({ stage, isParent, timeState }) =>
        !isParent &&
        timeState !== "done" &&
        (stage === "dev" || stage === "interface"),
    );
    const horizon = addWorkdays(
      state.today,
      state.time.dueSoonWorkdays,
      state.time.calendar,
    );
    const upcoming =
      upstream.length > 0 &&
      upstream.every(
        ({ deadline }) =>
          deadline && deadline >= state.today && deadline <= horizon,
      ) &&
      (dev != null || !evidence.required.dev) &&
      (integration != null || !evidence.required.interface);
    for (const item of evidence.taskItems) {
      if (!own.includes(item.id) || item.isParent || item.status !== "wait")
        continue;
      const owned = { ...item, assignedTo: state.person(account) };
      if (item.stage === "test") {
        if (devReady) output.tests.push(owned);
        else if (upcoming) output.upcomingTests.push(owned);
      }
      if (
        (item.stage === "acceptance" || item.stage === "delivery") &&
        test?.status === "completed" &&
        ["待验收", "待交付", "可关闭"].includes(evidence.progress.value)
      )
        output.acceptDeliver.push(owned);
    }
  }

  async queryStories(
    raw: unknown,
    portalMonth?: string,
  ): Promise<QueryStoriesOutput> {
    const input = parseInput(queryStoriesInputSchema, raw);
    const { store } = this.options;
    const state = new TrackingRead(this.options);
    const {
      product,
      module,
      plan,
      category,
      version,
      role,
      who,
      feedbackBy,
      openedFrom,
      openedTo,
      keyword,
      progress,
      type = "story",
      status = ["unclosed"],
      unlinked,
    } = input;
    const month = portalMonth ?? monthOf(input.month, state.today);
    const limit = Math.min(100, input.limit ?? 20);
    const filters: Record<string, unknown> = {
      ...input,
      type,
      status,
      month,
      limit,
    };
    const finish = (items: StoryItem[]): QueryStoriesOutput => {
      const counts = new Map<string, number>();
      for (const { progress } of items)
        counts.set(progress.value, (counts.get(progress.value) ?? 0) + 1);
      const output = state.finish(
        {
          items: items.slice(0, limit),
          countsByProgress: Object.fromEntries(counts),
        },
        filters,
        "阶段依据关联工作记录；月份按计划与执行日期，反馈查询也纳入诉求登记日期；登记日期范围按业务时区。",
      );
      return {
        ...output,
        ...(items.length > limit ? { truncated: true } : {}),
      };
    };
    const [scope, me] = await Promise.all([
      this.resolveScope(state, { product, module, plan, month }),
      role && !who ? state.me() : undefined,
      state.directory(),
    ]);
    if (
      (product && !scope.product) ||
      (module && !scope.module) ||
      (plan && !scope.plan) ||
      (role && !who && !me?.account)
    )
      return finish([]);
    const account = who ? state.account(who) : me?.account;
    const feedbackAccount = feedbackBy ? state.account(feedbackBy) : undefined;
    if (account) filters.who = bounded(account);
    if (scope.product) filters.product = scope.product.id;
    if (scope.module) filters.module = scope.module.id;
    if (scope.plan) filters.plan = scope.plan.id;
    const rows = await state.stories(scope.product?.id, type);
    const candidates = rows.filter(
      (row) =>
        (!portalMonth ||
          type !== "requirement" ||
          row.openedDate == null ||
          activeStoryMonth(row, portalMonth, this.options.config.timezone)) &&
        (!category || row.category === category) &&
        (!scope.module ||
          row.module == null ||
          row.module === scope.module.id) &&
        (!scope.plan || row.plan == null || row.plan.includes(scope.plan.id)) &&
        (status.includes("all") ||
          status.includes(row.status) ||
          (status.includes("unclosed") && row.status !== "closed")),
    );
    const matched = await Promise.all(
      candidates.map(async (row): Promise<StoryItem | undefined> => {
        let story: StoryRow;
        let storyDetail: StoryDetail | undefined;
        if (type === "requirement") {
          const links =
            unlinked !== undefined
              ? await state.read(`sourceLinks:requirement:${row.id}`, () =>
                  store.sourceLinks.listFrom("requirement", String(row.id)),
                )
              : undefined;
          const knownLinked = Boolean(
            row.linkStories?.length ||
            links?.some(
              ({ toType, relation }) =>
                toType === "story" && relation === "links",
            ),
          );
          if (unlinked === true && knownLinked) return undefined;
          const detail =
            (unlinked !== undefined && !knownLinked) || role || who || keyword
              ? await state.read(`requirement:${row.id}`, () =>
                  state.provider.getRequirementDetail(row.id),
                )
              : undefined;
          if (
            detail &&
            (detail.story.id !== row.id ||
              detail.story.product !== row.product ||
              detail.story.deleted)
          ) {
            state.gap(`requirement:${row.id}`, "用户需求详情与列表不一致。");
            return undefined;
          }
          if (unlinked !== undefined && !knownLinked && (!detail || !links))
            return undefined;
          const linked = Boolean(
            knownLinked ||
            detail?.story.linkStories?.length ||
            detail?.relations.some(({ type }) => type === "story"),
          );
          if (unlinked !== undefined && unlinked === linked) return undefined;
          story = detail?.story ?? row;
        } else {
          storyDetail = await state.detail(row.id);
          if (storyDetail && storyDetail.product !== row.product) {
            state.gap(`story:${row.id}`, "需求详情与列表产品不一致。");
            return undefined;
          }
          story = storyDetail ?? row;
        }
        if (scope.module && story.module !== scope.module.id) return undefined;
        if (
          keyword &&
          ![
            story.title,
            story.keywords,
            "spec" in story ? story.spec : undefined,
          ].some((value) => includesText(value, keyword))
        )
          return undefined;
        const people = await state.roles(story);
        const { roles, intakes } = people;
        const openedDates = [
          story.openedDate,
          ...intakes.map(({ createdAt }) => createdAt),
        ].flatMap((date) =>
          date == null
            ? []
            : [formatLocalDate(date, this.options.config.timezone)],
        );
        if (
          (openedFrom || openedTo) &&
          !openedDates.some(
            (date) =>
              (!openedFrom || date >= openedFrom) &&
              (!openedTo || date <= openedTo),
          )
        )
          return undefined;
        if (
          account &&
          ((role === "maintainer" && roles.maintainer !== account) ||
            (role === "receiver" && roles.receiver !== account) ||
            (role === "assigned" && roles.currentHandler !== account) ||
            (role === "raised" &&
              roles.proposer !== account &&
              !feedbackMatches(story, people, account, who ?? account)) ||
            (!role &&
              ![
                roles.maintainer,
                roles.receiver,
                roles.currentHandler,
                roles.proposer,
              ].includes(account) &&
              !feedbackMatches(story, people, account, who ?? account)))
        )
          return undefined;
        if (
          feedbackBy &&
          feedbackAccount &&
          !feedbackMatches(story, people, feedbackAccount, feedbackBy)
        )
          return undefined;
        const plans = story.plan?.length
          ? await state.plans(story.product)
          : [];
        const selected = selectedPlan(plans, story, scope.plan?.id, month);
        if (scope.plan && !story.plan?.includes(scope.plan.id))
          return undefined;
        if (
          version &&
          state.version(story, selected)?.toLowerCase() !==
            version.toLowerCase() &&
          !plans.some(
            (plan) =>
              story.plan?.includes(plan.id) &&
              state.version(story, plan)?.toLowerCase() ===
                version.toLowerCase(),
          )
        )
          return undefined;
        if (month) {
          const activeInMonth =
            portalMonth &&
            activeStoryMonth(story, portalMonth, this.options.config.timezone);
          const raisedInMonth =
            (feedbackBy || story.type === "requirement") &&
            openedDates.some((date) => date.startsWith(month));
          const references = "executions" in story ? story.executions : [];
          const plannedInMonth = plans.some(
            (plan) =>
              story.plan?.includes(plan.id) && overlapsPlan(plan, month),
          );
          if (!activeInMonth && !raisedInMonth && !plannedInMonth) {
            if (references.length) await state.allExecutions();
            const overlaps = references.map(({ id }) => {
              const execution = state.executionDates.get(id);
              if (!execution?.begin || !execution.end)
                state.gap(`execution:${id}`, "无法确认关联迭代的起止日期。");
              return (
                execution !== undefined && overlapsExecution(execution, month)
              );
            });
            if (!overlaps.includes(true)) return undefined;
          }
        }
        if (type === "story" && !storyDetail)
          state.inferred(
            `story:${story.id}:progress`,
            "需求详情未读到，进展待确认。",
          );
        const item = storyDetail
          ? (await storyEvidence(state, storyDetail, people, selected)).item
          : state.storyItem(
              story,
              people,
              {
                value: story.type === "requirement" ? "用户诉求" : "无法判断",
                level: story.type === "requirement" ? "recorded" : "inferred",
              },
              [],
              selected,
            );
        return !progress?.length || progress.includes(item.progress.value)
          ? item
          : undefined;
      }),
    );
    return finish(matched.filter((item) => item !== undefined));
  }

  async getStoryProgress(
    raw: unknown,
    { raisedByMe = false } = {},
  ): Promise<GetStoryProgressOutput> {
    const input = parseInput(getStoryProgressInputSchema, raw);
    const { store } = this.options;
    const {
      storyId,
      intakeId,
      requirementId,
      view = "full",
      format = "data",
    } = input;
    const state = new TrackingRead(this.options);
    const filters = { ...input, view, format };
    const finish = (data: GetStoryProgressOutput["data"]) =>
      state.finish(
        data,
        filters,
        "按需求状态、关联阶段和质量记录判断；预计日期来自任务排期。",
      );
    let ids = storyId === undefined ? [] : [storyId];
    if (intakeId) {
      const links = await state.read("sourceLinks:intake", () =>
        store.sourceLinks.listFrom("intake", intakeId),
      );
      ids = numericIds(
        links
          ?.filter(
            ({ toType, relation }) =>
              toType === "story" && relation === "source",
          )
          .map(({ toId }) => toId) ?? [],
      );
    }
    if (requirementId) {
      const [detail, links] = await Promise.all([
        state.read(`requirement:${requirementId}`, async () => {
          const row = await state.provider.getRequirementDetail(requirementId);
          if (row.story.id !== requirementId || row.story.deleted)
            throw new BztError(
              "ZENTAO_SCHEMA_MISMATCH",
              "用户需求详情与查询对象不一致。",
            );
          return row;
        }),
        state.read(`sourceLinks:requirement:${requirementId}`, () =>
          store.sourceLinks.listFrom("requirement", String(requirementId)),
        ),
      ]);
      ids = numericIds([
        ...(detail?.story.linkStories ?? []),
        ...(detail?.relations ?? [])
          .filter(({ type }) => type === "story")
          .map(({ id }) => id),
        ...(links ?? [])
          .filter(
            ({ toType, relation }) =>
              toType === "story" && relation === "links",
          )
          .map(({ toId }) => toId),
      ]);
    }
    if (!ids.length && !state.gaps.length)
      throw new BztError("NOT_FOUND", "没有找到相关的研发需求。");
    let details =
      storyId === undefined
        ? await Promise.all(ids.map((id) => state.detail(id)))
        : [await state.requiredDetail(storyId)];
    // CR-002：反馈者按编号或受理回执打开详情时，也沿用「我提出或反馈」的范围。
    if (raisedByMe) {
      const me = await state.me();
      details = await Promise.all(
        details.map(async (row) => {
          if (!row || !me) return undefined;
          if (row.openedBy === me.account) return row;
          const people = await state.roles(row);
          return feedbackMatches(row, people, me.account, me.realname)
            ? row
            : undefined;
        }),
      );
      if (!details.some(Boolean) && !state.gaps.length)
        throw new BztError("NOT_FOUND", "没有找到本人提出或反馈的相关需求。");
    }
    const story = details[0];
    if (!story || ids.length !== 1)
      return finish({
        candidates: details.flatMap((row) =>
          row
            ? [
                {
                  id: row.id,
                  title: bounded(row.title),
                  url: state.url("story", row.id),
                  untrusted: true,
                },
              ]
            : [],
        ),
      });
    await state.directory();
    if (view === "dev") {
      const { rows } = await state.storyTasks(story);
      const stages = indexById(state.stageInputs(rows));
      const content = developmentText(story);
      const result = finish({
        ...content,
        tasks: rows.map((task) =>
          state.taskItem(task, task.assignedTo, stages),
        ),
        untrusted: true,
      });
      return !content.scope && story.category === "feature"
        ? { ...result, hints: ["R05 缺少本次实现范围，请与状态维护人确认。"] }
        : result;
    }
    const [people, plans] = await Promise.all([
      state.roles(story),
      story.plan?.length ? state.plans(story.product) : [],
      this.options.config.products[story.product]
        ? undefined
        : state.products(story.product),
    ]);
    const evidence = await storyEvidence(
      state,
      story,
      people,
      selectedPlan(plans, story),
    );
    const { item, progress, related, risks, stages, nextStage } = evidence;
    const { roles } = people;
    let card: string | undefined;
    if (format === "card") {
      const businessProgress =
        {
          待接收: "等待安排研发",
          待传递: "等待交接设计方案",
          可关闭: "工作已达到完成条件",
          "已关闭·证据缺失": "已结束，完成情况待核实",
          未就绪: "准备中",
          无法判断: "进展待确认",
        }[progress.value] ?? progress.value;
      const owner =
        item.currentOwner?.realname || item.currentOwner?.account || "待确认";
      const maintainer =
        item.maintainer?.realname || item.maintainer?.account || "待确认";
      const followUp =
        nextStage && isStage(nextStage.stage)
          ? stageNames[nextStage.stage]
          : "待确认";
      const nextDate =
        item.nextDeadline && item.nextDeadline >= state.today
          ? item.nextDeadline
          : undefined;
      card = [
        `【需求进度】${item.title}`,
        `当前：${businessProgress}（${progress.level === "inferred" ? "推测" : "记录"}）`,
        `负责人：${owner}`,
        `进度联系人：${maintainer}`,
        `下一步：${followUp}${nextDate ? `（预计 ${nextDate}）` : ""}`,
        `数据时间：${isoTime(state.now)}`,
        `查看详情：${item.url}`,
      ].join("\n");
      if (nextDate)
        state.inferred("card.nextDate", "预计按下一阶段已登记的截止日期展示。");
    }
    return finish({
      story: item,
      progress,
      stages,
      related,
      risks,
      card,
      untrusted: true,
      people: {
        feedbackBy: item.feedbackBy,
        raisedBy: bounded(roles.proposer ?? ""),
        maintainer: item.maintainer?.account,
        currentOwner: item.currentOwner?.account,
        receiver: item.receiver?.account,
        untrusted: true,
      },
    });
  }
}
