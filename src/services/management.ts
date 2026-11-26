import { z } from "zod";
import { listProductBugs } from "../api/bug.ts";
import { getCapability } from "../api/capabilities.ts";
import type { ZentaoReadClient } from "../api/client.ts";
import { listExecutionsIncludingClosed } from "../api/execution.ts";
import { getCurrentUser } from "../api/org.ts";
import { getPlanDetail, listProductPlans } from "../api/plan.ts";
import { listProducts } from "../api/product.ts";
import { listReleases } from "../api/release.ts";
import { getStoryDetail, listProductStories } from "../api/story.ts";
import { getTaskDetail, listExecutionTasks } from "../api/task.ts";
import {
  getMonthlyDevQueueInputSchema,
  type GetMonthlyDevQueueOutput,
} from "../contracts/tools/get_monthly_dev_queue.ts";
import {
  getPlanProgressInputSchema,
  type GetPlanProgressInput,
  type GetPlanProgressOutput,
} from "../contracts/tools/get_plan_progress.ts";
import type { StoryItem } from "../contracts/tools/query_stories.ts";
import {
  civilDate,
  countWorkdaysBetween,
  createWorkCalendar,
  formatLocalDate,
  type WorkCalendar,
} from "../core/calendar.ts";
import type { Clock } from "../core/clock.ts";
import type { TeamConfig } from "../core/config.ts";
import type { Bug } from "../core/dto/bug.ts";
import type { Execution } from "../core/dto/execution.ts";
import { walkProductPlans, type ProductPlan } from "../core/dto/plan.ts";
import type { Story, StoryDetail } from "../core/dto/story.ts";
import type { Task } from "../core/dto/task.ts";
import { BztError } from "../core/errors.ts";
import { readGapReason } from "./read-gap.ts";
import type { LocalStore, SnapshotWithItems } from "../core/store/index.ts";
import {
  isDevExecutionInMonth,
  isInLastWorkdaysOfMonth,
  planOverlapDays,
} from "../domain/month.ts";
import {
  classifyMonthlyDevQueue,
  compareCommitmentSnapshot,
  summarizePlan,
  type PlanStory,
} from "../domain/plan-summary.ts";
import {
  completionRate,
  designProgress,
  featureProgress,
} from "../domain/progress.ts";
import { summarizeRelease } from "../domain/release.ts";
import { resolveStoryRoles } from "../domain/roles.ts";
import { detectStage, summarizeStages } from "../domain/stage.ts";
import {
  isCancelledTask,
  isTaskFinished,
  selectLeafTasks,
  taskTimeStatus,
} from "../domain/task.ts";
import { evaluateRules, type RuleInput } from "../rules/index.ts";
import { DirectoryService } from "./directory.ts";
import {
  cachedWaiverEntries,
  foldRuleWaivers,
  foldStageRequirements,
  readJsonNote,
  resolveReleaseWaiver,
} from "./structured-notes.ts";

interface ManagementOptions {
  client: ZentaoReadClient;
  config: TeamConfig;
  clock: Clock;
  baseUrl: string;
  store?: Partial<
    Pick<
      LocalStore,
      | "snapshots"
      | "reschedules"
      | "waivers"
      | "stageRequirements"
      | "sourceLinks"
      | "storyRoles"
    >
  >;
  calendar?: WorkCalendar;
  directory?: Pick<DirectoryService, "resolveTeam"> &
    Partial<Pick<DirectoryService, "listAccountNames">>;
}

type PlanData = GetPlanProgressOutput["data"];
type ReleaseData = Extract<PlanData, { view: "release" }>;
type CommitmentData = Extract<PlanData, { view: "commitment" }>;
type IterationData = Extract<PlanData, { view: "iteration" }>;
type ProductScope = { id: number; name: string; projects: readonly number[] };
type StoryRow = Story | StoryDetail;
type WorkTask = Pick<Task, Extract<keyof Task, string>>;
type StageTask = Parameters<typeof summarizeStages>[0][number] & WorkTask;

const utc = new Intl.DateTimeFormat("en-GB", {
  timeZone: "UTC",
  hour: "2-digit",
  minute: "2-digit",
  second: "2-digit",
  fractionalSecondDigits: 3,
  hourCycle: "h23",
});
const executionMonth = "按计划起止日期与月份重叠、迭代名称和日期归属";
const featureStages: readonly (keyof TeamConfig["stageDefaults"]["feature"])[] =
  ["dev", "interface", "test", "acceptance", "delivery"];
const monthText = z.string().regex(/^\d{4}-(?:0[1-9]|1[0-2])$/u);
const rescheduleNote = z.strictObject({
  fromMonth: monthText.nullable(),
  toMonth: monthText,
  reason: z.string().trim().min(1),
});
function historyReasons(
  details: readonly StoryDetail[],
  from: string,
  to?: string,
) {
  const reasons = new Map<number, string>();
  for (const row of details) {
    const ordered = [...(row.actions ?? [])].sort(
      (a, b) => (a.date ?? 0) - (b.date ?? 0) || a.id - b.id,
    );
    for (const { actor, action, comment } of ordered) {
      if (!actor || action.toLowerCase() !== "commented") continue;
      const note = readJsonNote(
        "reschedule",
        comment?.trim() ?? "",
        rescheduleNote,
      );
      if (
        note?.fromMonth === from &&
        (to ? note.toMonth === to : note.toMonth > from)
      )
        reasons.set(row.id, note.reason);
    }
  }
  return reasons;
}

function parseInput<T>(schema: z.ZodType<T>, raw: unknown): T {
  const result = schema.safeParse(raw);
  if (!result.success)
    throw new BztError("INVALID_INPUT", "管理视图查询参数不合法。", {
      fields: result.error.issues.map(({ path }) => path.join(".")),
    });
  return result.data;
}

function monthOf(value: string | undefined, today: string) {
  const month = today.slice(0, 7);
  if (!value || value === "本月") return month;
  if (value !== "上月" && value !== "下月") return value;
  const offset = value === "上月" ? -1 : 1;
  const position =
    Number(month.slice(0, 4)) * 12 + Number(month.slice(5)) - 1 + offset;
  return `${String(Math.floor(position / 12)).padStart(4, "0")}-${String((position % 12) + 1).padStart(2, "0")}`;
}

function indexById<T extends { id: number }>(rows: Iterable<T>) {
  return new Map(Array.from(rows, (row) => [row.id, row]));
}

function key(value: string) {
  return value.trim().normalize("NFKC").toLowerCase();
}

function matches(ref: string, id: number, name: string) {
  return /^#?\d+$/u.test(ref)
    ? Number(ref.replace(/^#/u, "")) === id
    : key(ref) === key(name);
}

function isFeature(row: StoryRow) {
  return !row.deleted && row.type === "story" && row.category !== "design";
}

function bounded(value: string, size = 200) {
  return value
    .trim()
    .replace(/[\r\n\u2028\u2029]+/gu, " ")
    .replace(
      /\b(?:token|authorization|password|x-api-key|zentaosid|phpsessid)\s*[:=]\s*\S+|\bbearer\s+\S+|\bhttps?:\/\/[^\s?#]*\/webhook\S*|\beyJ[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+\b|\$(?:2[aby]|argon2(?:id|i|d))\$\S+|[a-f\d]{32,}/giu,
      "[已隐藏]",
    )
    .slice(0, size);
}

function median(values: number[]) {
  const ordered = values.sort((a, b) => a - b);
  const lower = ordered[Math.floor((ordered.length - 1) / 2)];
  const upper = ordered[Math.floor(ordered.length / 2)];
  return lower === undefined || upper === undefined
    ? null
    : (lower + upper) / 2;
}

class ManagementRead {
  readonly now: number;
  readonly today: string;
  readonly asOf: string;
  readonly calendar: WorkCalendar;
  readonly gaps: GetPlanProgressOutput["gaps"] = [];
  readonly inferences: GetPlanProgressOutput["inferences"] = [];
  readonly hints: string[] = [];
  private truncated = false;
  private executions?: Promise<Execution[]>;
  private readonly taskPages = new Map<
    number,
    Promise<{ items: Task[]; truncated: boolean } | undefined>
  >();
  private readonly details = new Map<
    number,
    Promise<StoryDetail | undefined>
  >();
  private readonly taskDetails = new Map<
    number,
    Promise<Awaited<ReturnType<typeof getTaskDetail>> | undefined>
  >();
  private readonly productPlans = new Map<number, Promise<ProductPlan[]>>();
  private readonly planRows = new Map<number, Promise<Story[]>>();
  private readonly productStories = new Map<number, Promise<Story[]>>();
  private readonly productBugs = new Map<
    number,
    Promise<{ items: Bug[]; truncated: boolean } | undefined>
  >();
  private people = new Map<string, string>();
  private peopleLoad?: Promise<void>;
  private readonly productsById = new Map<number, ProductScope>();

  constructor(readonly options: ManagementOptions) {
    const now = options.clock();
    this.now = now;
    this.today = formatLocalDate(now, options.config.timezone);
    this.asOf = `${formatLocalDate(now, "UTC")}T${utc.format(now)}Z`;
    this.calendar =
      options.calendar ?? createWorkCalendar(options.config.calendar);
  }

  finish<T>(
    data: T,
    filters: Record<string, unknown>,
    timeBasis: string,
  ): Omit<GetPlanProgressOutput, "data"> & { data: T } {
    const completeness: GetPlanProgressOutput["completeness"] = this.gaps.length
      ? "partial"
      : "complete";
    return {
      ok: true,
      data,
      scope: { asOf: this.asOf, filters, timeBasis },
      completeness,
      gaps: [...this.gaps].sort(
        (a, b) =>
          a.source.localeCompare(b.source) || a.reason.localeCompare(b.reason),
      ),
      inferences: this.inferences,
      ...(this.truncated ? { truncated: true } : {}),
      ...(this.hints.length ? { hints: this.hints } : {}),
    };
  }

  gap(source: string, reason: string) {
    if (
      !this.gaps.some((gap) => gap.source === source && gap.reason === reason)
    )
      this.gaps.push({ source, reason });
  }

  async read<T>(source: string, load: () => T | Promise<T>) {
    try {
      return await load();
    } catch (error) {
      this.gap(
        source,
        error instanceof BztError ? readGapReason(source, error) : "读取失败。",
      );
      return undefined;
    }
  }

  async page<T>(
    source: string,
    load: () => Promise<{ items: T[]; truncated: boolean }>,
  ) {
    const page = await this.read(source, load);
    if (page?.truncated) {
      this.truncated = true;
      this.gap(source, "分页未读完整。");
    }
    return page;
  }

  async products(ref?: string) {
    const { config, client } = this.options;
    const configured = Object.entries(config.products).map(([id, product]) => ({
      id: Number(id),
      ...product,
    }));
    let rows: ProductScope[] = configured.filter(
      ({ enabled, probeOnly }) => enabled !== false && !probeOnly,
    );
    if (
      !configured.length ||
      (ref && !configured.some(({ id, name }) => matches(ref, id, name)))
    ) {
      const page = await this.page("products", () => listProducts(client));
      rows = [
        ...rows,
        ...(page?.items ?? [])
          .filter(({ id, deleted }) => !deleted && !config.products[id])
          .map(({ id, name }) => ({ id, name, projects: [] })),
      ];
    }
    for (const row of rows) this.productsById.set(row.id, row);
    if (!ref) return rows;
    return this.select(
      rows.filter(({ id, name }) => matches(ref, id, name)),
      "产品",
    );
  }

  select<T>(rows: T[], label: string) {
    if (rows.length > 1)
      throw new BztError(
        "AMBIGUOUS_ENTITY",
        `匹配到多个${label}，请使用编号。`,
      );
    if (!rows.length && !this.gaps.length)
      throw new BztError("NOT_FOUND", `没有找到匹配的${label}。`);
    return rows;
  }

  private executionList() {
    return (this.executions ??= this.page("executions", () =>
      listExecutionsIncludingClosed(this.options.client),
    ).then((page) => [...indexById(page?.items ?? []).values()]));
  }

  async executionsFor(products: readonly ProductScope[]) {
    if (!products.length) return [];
    const projects = new Set(products.flatMap(({ projects }) => [...projects]));
    return (await this.executionList()).filter(
      ({ project }) =>
        products.some((product) => !product.projects.length) ||
        projects.has(project),
    );
  }

  planKind(plan: ProductPlan): NonNullable<PlanStory["planKind"]> {
    const legacy = this.options.config.legacyReleasePlans;
    if (legacy && new RegExp(legacy.titlePattern, "iu").test(plan.title))
      return "legacyRelease";
    return plan.parent !== null && plan.parent > 0 ? "l3" : "other";
  }

  plans(productId: number) {
    const prior = this.productPlans.get(productId);
    if (prior) return prior;
    const next = this.page(`plans:${productId}`, () =>
      listProductPlans(this.options.client, productId),
    ).then((page) =>
      [...indexById(walkProductPlans(page?.items ?? [])).values()].filter(
        ({ deleted }) => !deleted,
      ),
    );
    this.productPlans.set(productId, next);
    return next;
  }

  async selectPlans(
    products: readonly ProductScope[],
    month: string | undefined,
    ref?: string,
  ) {
    const plans = (
      await Promise.all(products.map(({ id }) => this.plans(id)))
    ).flat();
    const selected = plans.filter(
      (plan) =>
        this.planKind(plan) === "l3" &&
        (ref
          ? matches(ref, plan.id, plan.title)
          : month !== undefined &&
            planOverlapDays({ ...plan, kind: "l3" }, month) > 0),
    );
    return ref ? this.select(selected, "L3 计划") : selected;
  }

  planStories(plan: ProductPlan) {
    const prior = this.planRows.get(plan.id);
    if (prior) return prior;
    const next = this.read(`plan:${plan.id}`, async () => {
      const detail = await getPlanDetail(this.options.client, plan.id);
      if (detail.plan.product !== plan.product)
        throw new BztError("ZENTAO_SCHEMA_MISMATCH", "计划所属产品不一致。");
      return detail.planStories.filter(
        (row) => isFeature(row) && row.product === plan.product,
      );
    }).then((rows) => rows ?? []);
    this.planRows.set(plan.id, next);
    return next;
  }

  stories(productId: number) {
    const prior = this.productStories.get(productId);
    if (prior) return prior;
    const next = this.page(`stories:${productId}`, () =>
      listProductStories(this.options.client, productId),
    ).then((page) =>
      (page?.items ?? []).filter(
        (row) => !row.deleted && row.product === productId,
      ),
    );
    this.productStories.set(productId, next);
    return next;
  }

  bugs(productId: number) {
    const prior = this.productBugs.get(productId);
    if (prior) return prior;
    const next = this.page(`bugs:${productId}`, () =>
      listProductBugs(this.options.client, productId),
    );
    this.productBugs.set(productId, next);
    return next;
  }

  detail(id: number) {
    const prior = this.details.get(id);
    if (prior) return prior;
    const next = this.read(`story:${id}`, async () => {
      const row = await getStoryDetail(this.options.client, id);
      if (row.id !== id || row.deleted)
        throw new BztError(
          "ZENTAO_SCHEMA_MISMATCH",
          "需求详情与查询对象不一致。",
        );
      return row;
    });
    this.details.set(id, next);
    return next;
  }

  cachedDetail(id: number) {
    return this.details.get(id);
  }

  taskDetail(id: number) {
    const prior = this.taskDetails.get(id);
    if (prior) return prior;
    const next = this.read(`task:${id}`, async () => {
      const task = await getTaskDetail(this.options.client, id);
      if (task.id !== id)
        throw new BztError(
          "ZENTAO_SCHEMA_MISMATCH",
          "任务详情与查询对象不一致。",
        );
      return task;
    });
    this.taskDetails.set(id, next);
    return next;
  }

  private taskPage(id: number) {
    const prior = this.taskPages.get(id);
    if (prior) return prior;
    const next = this.page(`tasks:${id}`, async () => {
      const page = await listExecutionTasks(this.options.client, id, "all");
      if (page.items.some(({ execution }) => execution !== id)) {
        this.gap(`tasks:${id}`, "任务列表含有其他执行的任务。");
        return {
          ...page,
          items: page.items.filter(({ execution }) => execution === id),
          truncated: true,
        };
      }
      return page;
    });
    this.taskPages.set(id, next);
    return next;
  }

  async tasks(ids: readonly number[]) {
    const pages = await Promise.all(
      [...new Set(ids)].map((id) => this.taskPage(id)),
    );
    return {
      rows: [
        ...indexById(pages.flatMap((page) => page?.items ?? [])).values(),
      ].filter((task) => !task.deleted),
      complete: pages.every((page) => page?.truncated === false),
    };
  }

  devExecutions(executions: readonly Execution[], month: string) {
    const devLabel = this.options.config.naming.execution.kinds.dev;
    return executions.filter((row) =>
      isDevExecutionInMonth(row, month, { devLabel }),
    );
  }

  snapshot(productId: number, month: string) {
    return this.read(`snapshot:${productId}:${month}`, () => {
      const repo = this.options.store?.snapshots;
      const latest = repo?.listSnapshotsByMonthAndProduct(month, productId)[0];
      if (!latest || !repo) return undefined;
      const full = repo.getSnapshot(latest.snapId);
      if (!full || full.productId !== productId || full.month !== month)
        throw new BztError("NOT_FOUND", "月度快照明细不可用。");
      return full;
    });
  }

  reschedules(month: string) {
    return this.read(
      `reschedules:${month}`,
      () =>
        this.options.store?.reschedules?.listByMonthRange(month, "9999-12") ??
        [],
    );
  }

  url(kind: "story" | "bug", id: number) {
    const url = new URL(this.options.baseUrl);
    url.username = "";
    url.password = "";
    url.search = "";
    url.hash = "";
    url.pathname = `${url.pathname.replace(/\/+$/u, "")}/${kind}-view-${id}.html`;
    return url.href;
  }

  async loadPeople(evidence: readonly StoryEvidence[]) {
    const directory = this.options.directory;
    if (
      !directory?.listAccountNames ||
      !evidence.some(
        ({ owner, roles }) => owner || roles.maintainer || roles.receiver,
      )
    )
      return;
    this.peopleLoad ??= this.read("users", () =>
      directory.listAccountNames?.(),
    ).then((result) => {
      if (!result) return;
      this.people = result.people;
      for (const { source, reason } of result.gaps) this.gap(source, reason);
    });
    await this.peopleLoad;
  }

  storyItem(evidence: StoryEvidence, plan?: ProductPlan): StoryItem {
    const { row, owner, progress, roles } = evidence;
    const person = (account: string | null): StoryItem["currentOwner"] =>
      account
        ? {
            account,
            realname: bounded(this.people.get(account) ?? ""),
            untrusted: true,
          }
        : undefined;
    return {
      id: row.id,
      title: bounded(row.title),
      url: this.url("story", row.id),
      untrusted: true,
      product: {
        id: row.product,
        name: bounded(
          this.productsById.get(row.product)?.name ??
            this.options.config.products[row.product]?.name ??
            `产品 #${row.product}`,
        ),
        untrusted: true,
      },
      module:
        row.module && row.moduleTitle
          ? { id: row.module, path: bounded(row.moduleTitle), untrusted: true }
          : undefined,
      category:
        row.category === "design"
          ? "design"
          : row.category === "feature"
            ? "feature"
            : "other",
      status: bounded(row.status),
      progress: { value: progress, level: "inferred" },
      plan: plan
        ? {
            id: plan.id,
            title: bounded(plan.title),
            month: plan.begin?.slice(0, 7),
            untrusted: true,
          }
        : undefined,
      maintainer: person(roles.maintainer),
      currentOwner: person(owner),
      receiver: person(roles.receiver),
      riskCodes: [],
    };
  }

  bugItem(bug: Bug): ReleaseData["openBugs"][number] {
    return {
      id: bug.id,
      title: bounded(bug.title),
      severity: bug.severity,
      status: bounded(bug.status),
      story: bug.story ?? undefined,
      url: this.url("bug", bug.id),
      untrusted: true,
    };
  }
}

type TaskRows = Awaited<ReturnType<ManagementRead["tasks"]>>;

function groupTasks(rows: readonly Task[]) {
  const indexed = indexById(rows);
  const groups = new Map<number, Task[]>();
  for (const task of indexed.values()) {
    const visited = new Set<number>();
    let current: Task | undefined = task;
    while (current && current.story == null && !visited.has(current.id)) {
      visited.add(current.id);
      current =
        current.parent == null ? undefined : indexed.get(current.parent);
    }
    const id = current?.story;
    if (id != null) {
      const group = groups.get(id) ?? [];
      group.push(task);
      groups.set(id, group);
    }
  }
  return groups;
}

function stageInputs(
  rows: readonly WorkTask[],
  config: TeamConfig,
): StageTask[] {
  const children = new Map<number, string[]>();
  for (const row of rows) {
    if (row.parent == null) continue;
    const titles = children.get(row.parent) ?? [];
    titles.push(row.name);
    children.set(row.parent, titles);
  }
  return rows.map((task) => {
    const prefixes = { ...config.naming.taskPrefix };
    for (const stage of featureStages) {
      const legacy = config.naming.legacyTaskPrefixes[stage]?.find((prefix) =>
        task.name.startsWith(prefix),
      );
      if (legacy) prefixes[stage] = legacy;
    }
    const qa = config.teams.qa;
    const assigneeGroup =
      task.assignedTo &&
      (qa?.lead === task.assignedTo || qa?.members.includes(task.assignedTo))
        ? "test"
        : undefined;
    return {
      ...task,
      isParent: task.isParent || children.has(task.id),
      evidence: { prefixes, childTitles: children.get(task.id), assigneeGroup },
    };
  });
}

type StoryEvidence = Awaited<ReturnType<typeof storyEvidence>>;

async function storyEvidence(
  state: ManagementRead,
  row: StoryRow,
  known: readonly WorkTask[],
  complete: boolean,
  options: { detail?: boolean; bugs?: readonly Bug[] } = {},
) {
  const { config, store } = state.options;
  const cached = await state.read(
    "stageRequirements:" + row.id,
    () => store?.stageRequirements?.listByStory(row.id) ?? [],
  );
  const initialRequirements = foldStageRequirements(
    config.stageDefaults.feature,
    cached,
  );
  const knownStages = summarizeStages(stageInputs(known, config)).stages;
  const needsWaiver = featureStages.some(
    (stage) =>
      initialRequirements[stage] && knownStages[stage]?.status === "cancelled",
  );
  const shouldRead =
    options.detail ||
    row.status === "active" ||
    !known.length ||
    needsWaiver ||
    Boolean(cached?.length) ||
    (row.status === "closed" &&
      featureStages.some(
        (stage) =>
          initialRequirements[stage] &&
          knownStages[stage]?.status !== "completed",
      ));
  const detail = await (shouldRead
    ? state.detail(row.id)
    : state.cachedDetail(row.id));
  const candidate = detail ?? row;
  const loaded = detail
    ? await state.tasks(detail.executions.map(({ id }) => id))
    : undefined;
  const grouped = groupTasks(loaded?.rows ?? []).get(row.id) ?? [];
  const taskMap = indexById([...known, ...grouped]);
  const parentIds = new Set([...taskMap.values()].map(({ parent }) => parent));
  const inspect = [
    ...new Set([
      ...(detail?.tasks ?? [])
        .map(({ id }) => id)
        .filter((id) => !taskMap.has(id)),
      ...[...taskMap.values()]
        .filter(({ id, isParent }) => isParent && !parentIds.has(id))
        .map(({ id }) => id),
    ]),
  ];
  const loadedDetails = await Promise.all(
    inspect.map((id) => state.taskDetail(id)),
  );
  for (const task of loadedDetails) {
    if (!task || task.deleted || (task.story != null && task.story !== row.id))
      continue;
    taskMap.set(task.id, task);
    for (const child of task.children)
      if (!child.deleted && (child.story == null || child.story === row.id))
        taskMap.set(child.id, child);
  }
  const tasksComplete =
    complete &&
    (!shouldRead || detail !== undefined) &&
    loaded?.complete !== false &&
    inspect.every((id) => taskMap.has(id));
  const rows = [...taskMap.values()];
  const foundParents = new Set(rows.map(({ parent }) => parent));
  const incompleteTree = rows.some(
    (task) =>
      (task.isParent && !foundParents.has(task.id)) ||
      (task.parent != null && !taskMap.has(task.parent)),
  );
  if (incompleteTree || inspect.some((id) => !taskMap.has(id)))
    state.gap(`story:${row.id}:tasks`, "需求关联任务或父子关系读取不完整。");
  const actions = [...(detail?.actions ?? [])].sort(
    (a, b) => (a.date ?? 0) - (b.date ?? 0) || a.id - b.id,
  );
  const required = foldStageRequirements(
    config.stageDefaults.feature,
    cached,
    actions,
  );
  const stageTasks = stageInputs(rows, config);
  const stages = summarizeStages(stageTasks);
  const summary = {
    ...stages,
    tasksComplete: tasksComplete && !incompleteTree,
  };
  const module = config.modules[candidate.product + ":" + candidate.module];
  const fallback = config.moduleDefaults[candidate.product];
  const stored = store?.storyRoles
    ? await state.read(`storyRoles:${row.id}`, () => {
        try {
          return store.storyRoles?.get(row.id);
        } catch (error) {
          if (error instanceof BztError && error.code === "NOT_FOUND")
            return undefined;
          throw error;
        }
      })
    : undefined;
  const roles = resolveStoryRoles({
    story: candidate,
    module: {
      maintainer: module?.designLead ?? fallback?.designLead,
      devLead: module?.devLead ?? fallback?.devLead,
    },
    ...(stored ? { stored } : {}),
  });
  // docs/04 §4.4。测试任务完成后，严重 Bug 仍可阻止需求退出测试阶段。
  const bugs =
    options.bugs ??
    (candidate.status === "active" && stages.stages.test?.status === "completed"
      ? (await state.bugs(row.product))?.items.filter(
          (bug) => bug.product === row.product && bug.story === row.id,
        )
      : undefined);
  const progress = featureProgress({
    ...candidate,
    ...summary,
    required,
    bugs,
  }).progress;
  return {
    row: candidate,
    detail,
    actions,
    tasks: rows,
    stageTasks,
    required,
    roles,
    owner: roles.currentHandler,
    progress,
    ...summary,
  };
}

function snapshotSummary(
  products: readonly ProductScope[],
  snapshots: readonly SnapshotWithItems[],
) {
  const seen = new Set(snapshots.map(({ productId }) => productId));
  return {
    snapshotAvailable: snapshots.length > 0,
    snapshots: snapshots.map(({ snapId, productId, source, takenAt }) => ({
      snapId,
      productId,
      source,
      takenAt,
    })),
    missingSnapshotProductIds: products
      .map(({ id }) => id)
      .filter((id) => !seen.has(id)),
  };
}

async function mapDetails(state: ManagementRead, ids: readonly number[]) {
  const rows: StoryDetail[] = [];
  const unique = [...new Set(ids)];
  // 公开接口没有迭代需求列表，限制补读并发，避免将整产品请求同时打到禅道。
  for (let i = 0; i < unique.length; i += 16) {
    const batch = await Promise.all(
      unique.slice(i, i + 16).map((id) => state.detail(id)),
    );
    rows.push(...batch.filter((row) => row !== undefined));
  }
  return rows;
}

async function iterationStories(
  state: ManagementRead,
  products: readonly ProductScope[],
  executions: readonly Execution[],
  tasks: TaskRows,
) {
  if (!executions.length) return [];
  const executionIds = new Set(executions.map(({ id }) => id));
  const productIds = new Set(products.map(({ id }) => id));
  const taskStoryIds = [...groupTasks(tasks.rows).keys()];
  const stories = (
    await Promise.all(products.map(({ id }) => state.stories(id)))
  ).flat();
  const ids = [
    ...stories.filter(isFeature).map(({ id }) => id),
    ...taskStoryIds,
  ];
  const details = await mapDetails(state, ids);
  const linked = new Set(taskStoryIds);
  for (const row of details)
    if (row.executions.some(({ id }) => executionIds.has(id)))
      linked.add(row.id);
  return [...indexById([...stories, ...details]).values()].filter(
    (row) =>
      isFeature(row) && productIds.has(row.product) && linked.has(row.id),
  );
}

async function monthlyPool(
  state: ManagementRead,
  products: readonly ProductScope[],
  month: string,
) {
  const [plans, executions] = await Promise.all([
    state.selectPlans(products, month),
    state.executionsFor(products),
  ]);
  const selected = state.devExecutions(executions, month);
  const [planned, taskRows] = await Promise.all([
    Promise.all(
      plans.map(async (plan) => ({
        plan,
        rows: await state.planStories(plan),
      })),
    ),
    state.tasks(selected.map(({ id }) => id)),
  ]);
  const iteration = await iterationStories(state, products, selected, taskRows);
  const planByStory = new Map<number, ProductPlan>();
  for (const { plan, rows } of planned)
    for (const { id } of rows) planByStory.set(id, plan);
  return {
    planned: planned.flatMap(({ rows }) => rows),
    iteration,
    planByStory,
    executions,
  };
}

function leafStories(evidence: readonly StoryEvidence[]) {
  const parents = new Set(
    evidence.flatMap(({ row, detail }) => [row.parent, detail?.parent]),
  );
  return evidence.filter(
    ({ row, detail }) =>
      !parents.has(row.id) &&
      !row.isParent &&
      !detail?.isParent &&
      !detail?.children?.length,
  );
}

function normalizePlanStory(
  evidence: StoryEvidence,
  planKind?: PlanStory["planKind"],
): PlanStory {
  const { row, tasks, owner, progress, detail } = evidence;
  return {
    id: row.id,
    children: detail?.children ?? [],
    tasks,
    owner,
    module: row.module ?? null,
    progress,
    ...(planKind ? { planKind } : {}),
  };
}

async function releaseWaivers(
  state: ManagementRead,
  story: StoryEvidence,
  version: string,
) {
  const { config, store } = state.options;
  const waivers = await state.read(
    `waivers:${story.row.id}`,
    () => store?.waivers?.listByObject("story", String(story.row.id)) ?? [],
  );
  return resolveReleaseWaiver(
    config,
    story.row,
    story.actions,
    waivers ?? [],
    version,
  );
}

export class ManagementService {
  constructor(private readonly options: ManagementOptions) {}

  async getPlanProgress(raw: unknown): Promise<GetPlanProgressOutput> {
    const input = parseInput(getPlanProgressInputSchema, raw);
    const state = new ManagementRead(this.options);
    const month = monthOf(input.month, state.today);
    const products = await state.products(input.product);
    const filters = {
      ...input,
      month,
      productIds: products.map(({ id }) => id),
    };
    switch (input.view) {
      case "plan": {
        const groupBy = input.groupBy ?? "owner";
        const data = await this.plan(state, products, month, input, groupBy);
        return state.finish(
          data,
          { ...filters, groupBy, planIds: data.planIds },
          "L3 叶子需求按进展去重，任务只计未取消叶子；两个比率分别计算。",
        );
      }
      case "release": {
        const data = await this.release(state, products, input.version);
        return state.finish(
          data,
          {
            ...filters,
            productId: data.productId,
            dateSource: data.dateSource,
          },
          "测试阶段和产品 Bug 门禁，发布日距离按工作日历计算。",
        );
      }
      case "commitment":
        return state.finish(
          await this.commitment(state, products, month),
          filters,
          `${executionMonth}，以月初快照比对已登记的挪月与当前进展。`,
        );
      case "iteration":
        return state.finish(
          await this.iteration(state, products, month, input),
          filters,
          "仅反映禅道可见投入。拆解和测试周期按工作日，逾期按排期与实际完成记录。",
        );
    }
  }

  private async plan(
    state: ManagementRead,
    products: ProductScope[],
    month: string,
    input: GetPlanProgressInput,
    groupBy: NonNullable<GetPlanProgressInput["groupBy"]>,
  ): Promise<Extract<PlanData, { view: "plan" }>> {
    const plans = await state.selectPlans(products, month, input.plan);
    const rows = [
      ...indexById(
        (
          await Promise.all(plans.map((plan) => state.planStories(plan)))
        ).flat(),
      ).values(),
    ];
    const executions = rows.length
      ? await state.executionsFor(
          products.filter(({ id }) =>
            plans.some(({ product }) => product === id),
          ),
        )
      : [];
    const tasks = await state.tasks(executions.map(({ id }) => id));
    const grouped = groupTasks(tasks.rows);
    const complete =
      tasks.complete &&
      !state.gaps.some(({ source }) => source === "executions");
    const evidence = await Promise.all(
      rows.map((row) =>
        storyEvidence(state, row, grouped.get(row.id) ?? [], complete),
      ),
    );
    if (evidence.some(({ detail }) => !detail))
      state.inferences.push({
        field: "storyDeliveryRate",
        level: "inferred",
        basis: "需求详情读取不完整，按计划列表中的父子标记排除父需求。",
      });
    return {
      view: "plan",
      ...summarizePlan(
        leafStories(evidence).map((item) => normalizePlanStory(item, "l3")),
        state.asOf,
        groupBy,
      ),
      planIds: plans.map(({ id }) => id),
    };
  }

  private async release(
    state: ManagementRead,
    products: ProductScope[],
    version: string | undefined,
  ): Promise<ReleaseData> {
    const { config, client } = this.options;
    if (!version || !new RegExp(config.versionTag.pattern, "iu").test(version))
      throw new BztError("INVALID_INPUT", "请指定符合版本标签配置的发布版本。");
    const calendarProducts = products.filter(({ id }) =>
      config.releaseCalendar.some(
        (entry) => entry.product === id && entry.version === version,
      ),
    );
    const scope =
      products.length > 1 && calendarProducts.length === 1
        ? calendarProducts
        : products;
    const [product] = state.select(scope, "发布产品");
    const capability = getCapability("release.read");
    const [rows, plans, bugs, releases, executions] = product
      ? await Promise.all([
          state.stories(product.id),
          config.legacyReleasePlans &&
          state.today <= config.legacyReleasePlans.until
            ? state.plans(product.id)
            : [],
          state.bugs(product.id),
          capability.state === "verified"
            ? state.page(`releases:${product.id}`, () =>
                listReleases(client, product.id),
              )
            : undefined,
          state.executionsFor([product]),
        ])
      : [[], [], undefined, undefined, []];
    const prefix = config.versionTag.keywordPrefix;
    const legacyPlans = plans.filter((plan) => {
      if (state.planKind(plan) !== "legacyRelease") return false;
      const normalized = key(plan.title);
      const target = key(version);
      return (
        normalized === target ||
        (normalized.startsWith(target) &&
          /^[\s_\-:：【(（]/u.test(normalized.slice(target.length)))
      );
    });
    const legacyRows = (
      await Promise.all(
        legacyPlans.map(async (plan) =>
          (await state.planStories(plan)).map((row) => ({
            ...row,
            plan: [...new Set([...(row.plan ?? []), plan.id])],
          })),
        ),
      )
    ).flat();
    const selected = [
      ...indexById([
        ...rows.filter(
          (row) =>
            isFeature(row) &&
            (row.keywords
              ?.split(/[\s,，、;；]+/u)
              .includes(`${prefix}${version}`) ||
              row.plan?.some((id) =>
                legacyPlans.some((plan) => plan.id === id),
              )),
        ),
        ...legacyRows,
      ]).values(),
    ];
    const productBugs = [...indexById(bugs?.items ?? []).values()].filter(
      (bug) =>
        !bug.deleted && bug.status !== "closed" && bug.product === product?.id,
    );
    const related = new Map<number, Bug[]>();
    for (const bug of productBugs) {
      if (bug.story == null) continue;
      const group = related.get(bug.story) ?? [];
      group.push(bug);
      related.set(bug.story, group);
    }
    const tasks = await state.tasks(
      selected.length ? executions.map(({ id }) => id) : [],
    );
    const grouped = groupTasks(tasks.rows);
    const complete =
      tasks.complete &&
      !state.gaps.some(({ source }) => source === "executions");
    const evidence = await Promise.all(
      selected.map(async (row) => {
        const storyBugs = related.get(row.id) ?? [];
        const known = grouped.get(row.id) ?? [];
        const test = summarizeStages(stageInputs(known, config)).stages.test;
        return storyEvidence(state, row, known, complete, {
          detail:
            row.isParent !== false ||
            test?.status !== "completed" ||
            storyBugs.some(isSerious),
          bugs: storyBugs,
        });
      }),
    );
    const releaseLeaves = leafStories(evidence);
    state.hints.push("发布门禁按叶子需求计算，父需求及其直属任务不计入。");
    const waivers = (
      await Promise.all(
        releaseLeaves
          .filter(({ progress }) => progress !== "已取消")
          .map((item) => releaseWaivers(state, item, version)),
      )
    ).flat();
    const releaseInput: RuleInput["release"] = {
      product: product?.id ?? 0,
      version,
      keywordPrefix: prefix,
      stories: releaseLeaves.map((item) => {
        const original = selected.find(({ id }) => id === item.row.id);
        return {
          ...item.row,
          plan: original?.plan,
          keywords: original?.keywords,
          tasks: item.progress === "已取消" ? [] : item.tasks,
          progress: item.progress,
          tasksComplete: item.tasksComplete,
          stages: item.stages,
          bugs: related.get(item.row.id) ?? [],
        };
      }),
      legacyPlans: legacyPlans.map(({ id, end, product }) => ({
        id,
        end,
        product,
        version,
      })),
      releaseCalendar: config.releaseCalendar,
      releases: releases?.items,
      waivers,
    };
    const time = { today: state.today, calendar: state.calendar };
    const summary = summarizeRelease({ ...releaseInput, ...time });
    const incomplete =
      !bugs ||
      bugs.truncated ||
      state.gaps.some(({ source }) =>
        /^(?:stories:|plans:|plan:|executions$|tasks:|story:|task:|waivers:)/u.test(
          source,
        ),
      );
    const confirmedBlocked = releaseInput.stories.some(
      (story) =>
        story.progress !== "已取消" &&
        !waivers.some(({ storyId }) => storyId === story.id) &&
        (story.bugs.some(isSerious) ||
          (story.tasksComplete !== false &&
            story.stages.test?.status !== "completed")),
    );
    const gate =
      (incomplete && !confirmedBlocked) ||
      summary.testCompletionRate.denominator === 0
        ? "unknown"
        : summary.gate;
    if (summary.dateSource || capability.state !== "verified")
      state.inferences.push({
        field: "releaseDate",
        level: summary.dateSource === "release" ? "recorded" : "inferred",
        basis: `${capability.state === "verified" ? "" : "发布接口未验证，"}${summary.dateSource === "release" ? "使用禅道发布记录" : summary.dateSource === "calendar" ? "使用配置发布日历" : summary.dateSource === "legacyPlan" ? "使用历史版本计划结束日" : "没有可用的发布日记录"}。`,
      });
    if (!summary.releaseDate)
      state.hints.push("缺少发布日，无法计算距发布日工作日与超期排期。");
    const beforeRelease = config.rules.R13.beforeRelease;
    const warnings =
      config.rules.R13.enabled && gate === "blocked"
        ? evaluateRules(
            { release: releaseInput },
            {
              ...time,
              thresholds: {
                R13: {
                  beforeRelease: {
                    workdays: beforeRelease,
                    source: beforeRelease === 3 ? "default" : "configured",
                  },
                },
              },
            },
          )
            .hits.filter(({ ruleId }) => ruleId === "R13")
            .map(({ objectId }) => objectId)
        : [];
    const openIds = new Set(summary.openBugs.map(({ id }) => id));
    const open = productBugs
      .filter(({ id }) => openIds.has(id))
      .sort((a, b) => a.severity - b.severity || a.id - b.id);
    return {
      view: "release",
      version,
      productId: product?.id ?? null,
      ...summary,
      flags: [...summary.flags],
      gate,
      openBugs: open.map((bug) => state.bugItem(bug)),
      openSeriousBugs: open.filter(isSerious).map((bug) => state.bugItem(bug)),
      unlinkedSeriousBugs: productBugs
        .filter((bug) => bug.story == null && isSerious(bug))
        .map((bug) => state.bugItem(bug)),
      unlinkedBugIds: productBugs
        .filter(({ story }) => story == null)
        .map(({ id }) => id),
      waivers: summary.waivers.map((entry) => ({ ...entry, untrusted: true })),
      releaseWarningStoryIds: warnings,
    };
  }

  private async commitment(
    state: ManagementRead,
    products: ProductScope[],
    month: string,
  ): Promise<CommitmentData> {
    const snapshots = (
      await Promise.all(products.map(({ id }) => state.snapshot(id, month)))
    ).filter((row) => row !== undefined);
    const summary = snapshotSummary(products, snapshots);
    const result: CommitmentData = {
      view: "commitment",
      ...summary,
      fulfilled: [],
      carriedOver: [],
      inserted: [],
      pendingStoryIds: [],
      cancelledStoryIds: [],
      unknownStoryIds: [],
    };
    if (summary.missingSnapshotProductIds.length)
      state.hints.push(
        "部分或全部产品缺少月初快照，兑现与新增仅统计有快照的产品。",
      );
    if (!snapshots.length) return result;
    const covered = products.filter(({ id }) =>
      snapshots.some(({ productId }) => productId === id),
    );
    const [pool, reschedules] = await Promise.all([
      monthlyPool(state, covered, month),
      state.reschedules(month),
    ]);
    const current = indexById([...pool.planned, ...pool.iteration]);
    const snapshotIds = snapshots.flatMap(({ items }) =>
      items.map(({ storyId }) => storyId),
    );
    const reasons = new Map(
      (reschedules ?? [])
        .filter(
          ({ fromMonth, toMonth }) => fromMonth === month && toMonth > month,
        )
        .map(({ storyId, reason }) => [storyId, reason]),
    );
    const missing = await mapDetails(
      state,
      snapshotIds.filter((id) => !current.has(id) && !reasons.has(id)),
    );
    const currentDetails = await mapDetails(
      state,
      snapshotIds.filter((id) => current.has(id) && !reasons.has(id)),
    );
    for (const [id, reason] of historyReasons(
      [...missing, ...currentDetails],
      month,
    ))
      reasons.set(id, reason);
    const tasks = await state.tasks(pool.executions.map(({ id }) => id));
    const grouped = groupTasks(tasks.rows);
    const scopeComplete = !state.gaps.some(({ source }) =>
      /^(?:stories:|plans:|plan:|executions$|tasks:|story:)/u.test(source),
    );
    const evidence = await Promise.all(
      [...indexById([...current.values(), ...missing]).values()]
        .filter(isFeature)
        .map((row) =>
          storyEvidence(state, row, grouped.get(row.id) ?? [], tasks.complete),
        ),
    );
    const compare = compareCommitmentSnapshot(
      snapshotIds,
      evidence
        .filter(
          ({ detail, row }) =>
            !detail?.children?.length && (current.has(row.id) || scopeComplete),
        )
        .map(({ row, progress }) => ({
          id: row.id,
          progress,
          inCurrentMonth: current.has(row.id),
        })),
      reasons,
    );
    if (!compare.snapshotAvailable) return result;
    return {
      ...result,
      ...compare,
      carriedOver: compare.carriedOver.map(({ id, reason }) => ({
        id,
        reason: reason ? bounded(reason, 500) : null,
        untrusted: true,
      })),
    };
  }

  private async iteration(
    state: ManagementRead,
    products: ProductScope[],
    month: string,
    input: GetPlanProgressInput,
  ): Promise<IterationData> {
    const { config } = this.options;
    const [available, plans, snapshotRows] = await Promise.all([
      state.executionsFor(products),
      Promise.all(products.map(({ id }) => state.plans(id))),
      Promise.all(products.map(({ id }) => state.snapshot(id, month))),
    ]);
    const executions = input.execution
      ? state.select(
          available.filter(({ id, name }) =>
            matches(input.execution ?? "", id, name),
          ),
          "执行",
        )
      : available.filter(
          ({ begin, end }) =>
            begin &&
            end &&
            begin.slice(0, 7) <= month &&
            month <= end.slice(0, 7),
        );
    const snapshot = snapshotSummary(
      products,
      snapshotRows.filter((row) => row !== undefined),
    );
    if (snapshot.missingSnapshotProductIds.length)
      state.hints.push(
        "部分或全部产品缺少月度快照，可以查看当前迭代指标，月初承诺请按快照另查。",
      );
    const tasks = await state.tasks(executions.map(({ id }) => id));
    const stories = await iterationStories(state, products, executions, tasks);
    const storyIds = new Set(stories.map(({ id }) => id));
    const grouped = groupTasks(tasks.rows);
    const plansById = indexById(plans.flat());
    const evidence = await Promise.all(
      stories.map((row) =>
        storyEvidence(state, row, grouped.get(row.id) ?? [], tasks.complete, {
          detail: true,
        }),
      ),
    );
    const scopedTaskIds = new Set(
      tasks.rows
        .filter((task) =>
          task.product != null
            ? products.some(({ id }) => id === task.product)
            : !task.story || storyIds.has(task.story),
        )
        .map(({ id }) => id),
    );
    for (const row of stories)
      for (const task of grouped.get(row.id) ?? []) scopedTaskIds.add(task.id);
    const leaves = selectLeafTasks(tasks.rows).filter(
      (task) => scopedTaskIds.has(task.id) && !isCancelledTask(task),
    );
    const time = {
      today: state.today,
      calendar: state.calendar,
      timezone: config.timezone,
    };
    const dated = leaves.filter(
      ({ deadline, status, finishedDate }) =>
        civilDate.safeParse(deadline).success &&
        (!isTaskFinished(status) || finishedDate != null),
    );
    const late = dated.filter((task) => {
      const result = taskTimeStatus(task, time);
      return result.status === "overdue" || result.historicallyLate;
    });
    const visibleHours = {
      estimate: 0,
      consumed: 0,
      left: 0,
      leafTaskCount: leaves.length,
      missingHoursTaskCount: 0,
    };
    for (const task of leaves) {
      visibleHours.estimate += task.estimate ?? 0;
      visibleHours.consumed += task.consumed ?? 0;
      visibleHours.left += task.left ?? 0;
      if (task.estimate == null || task.consumed == null || task.left == null)
        visibleHours.missingHoursTaskCount++;
    }
    const calendarDays = (from: number, to: number) =>
      countWorkdaysBetween(
        formatLocalDate(from, config.timezone),
        formatLocalDate(to, config.timezone),
        state.calendar,
      );
    const leafIds = new Set(leaves.map(({ id }) => id));
    const threshold = config.rules.R03.after;
    const decomposition: number[] = [];
    const testCycles: number[] = [];
    const compliance = new Map<
      string | null,
      IterationData["complianceByOwner"][number]["counts"]
    >();
    for (const item of leafStories(evidence)) {
      const { row, actions, tasksComplete, progress } = item;
      const linked = (grouped.get(row.id) ?? []).filter((task) =>
        leafIds.has(task.id),
      );
      const activation = actions
        .filter(
          ({ action, date }) =>
            action.toLowerCase() === "activated" && date != null,
        )
        .map(({ date }) => date)
        .at(-1);
      const handoff =
        activation ??
        (item.roles.receiver === null || item.roles.receiver === row.assignedTo
          ? row.assignedDate
          : null);
      const opened = linked.flatMap(({ openedDate }) =>
        openedDate == null ? [] : [openedDate],
      );
      if (
        progress !== "已取消" &&
        progress !== "未就绪" &&
        tasksComplete &&
        handoff != null
      ) {
        const first = opened.length ? Math.min(...opened) : undefined;
        if (first !== undefined && first >= handoff)
          decomposition.push(calendarDays(handoff, first));
        else if (!linked.length && calendarDays(handoff, state.now) > threshold)
          decomposition.push(threshold + 1);
      }
      const stageTasks = stageInputs(grouped.get(row.id) ?? [], config);
      const test = summarizeStages(stageTasks).stages.test;
      const starts = stageTasks.flatMap((task) =>
        leafIds.has(task.id) &&
        detectStage(task, task.evidence).stage === "test" &&
        task.realStarted != null
          ? [task.realStarted]
          : [],
      );
      if (
        tasksComplete &&
        progress !== "已取消" &&
        starts.length &&
        test?.status === "completed" &&
        test.finishedDate != null &&
        test.finishedDate >= Math.min(...starts)
      )
        testCycles.push(calendarDays(Math.min(...starts), test.finishedDate));
      const hasPlan =
        row.plan?.some((id) => {
          const plan = plansById.get(id);
          return plan && state.planKind(plan) === "l3";
        }) ?? false;
      const planComplete = !state.gaps.some(
        ({ source }) => source === `plans:${row.product}`,
      );
      const waivers = await state.read(
        "waivers:" + row.id,
        () =>
          this.options.store?.waivers?.listByObject("story", String(row.id)) ??
          [],
      );
      const ruleInput: RuleInput = {
        waivers: foldRuleWaivers(
          "story",
          row.id,
          cachedWaiverEntries(waivers ?? []),
          {
            actions: item.actions,
            approvers: [...(config.roles.PM ?? []), item.roles.maintainer],
          },
        ),
        story: item.detail,
        tasksComplete,
        required: item.required,
        tasks: item.stageTasks,
        ...(planComplete ? { hasL3Plan: hasPlan } : {}),
      };
      const { hits } = evaluateRules(ruleInput, {
        ...time,
        ...(config.rules.R06.systemStartDate
          ? { systemStartDate: config.rules.R06.systemStartDate }
          : {}),
      });
      for (const { ruleId } of hits) {
        if (
          (ruleId !== "R05" && ruleId !== "R06") ||
          !config.rules[ruleId].enabled
        )
          continue;
        const counts = compliance.get(item.owner) ?? {};
        counts[ruleId] = (counts[ruleId] ?? 0) + 1;
        compliance.set(item.owner, counts);
      }
    }
    state.inferences.push(
      {
        field: "visibleHours",
        level: "recorded",
        basis: "仅反映禅道可见投入，按未取消叶子任务汇总，缺工时单独计数。",
      },
      {
        field: "decompositionTimeliness",
        level: "inferred",
        basis: `以已记录的激活移交或接收人指派为起点，观察首个叶子任务创建或超出 ${threshold} 个工作日仍无任务。`,
      },
      {
        field: "overdueRate",
        level: "inferred",
        basis: "分母为排期可判定的叶子任务，终态任务需有实际完成时间。",
      },
      {
        field: "testCycleMedianWorkdays",
        level: "inferred",
        basis:
          "按测试实际开始至测试阶段完成的工作日差取中位数，仅纳入有实际记录的样本。",
      },
    );
    return {
      view: "iteration",
      executionIds: executions.map(({ id }) => id),
      storyIds: [...storyIds],
      decompositionTimeliness: completionRate(
        decomposition.filter((days) => days <= threshold).length,
        decomposition.length,
      ),
      overdueRate: completionRate(late.length, dated.length),
      testCycleMedianWorkdays: median(testCycles),
      testCycleSampleSize: testCycles.length,
      visibleHours,
      ...snapshot,
      complianceByOwner: [...compliance].map(([owner, counts]) => ({
        owner,
        counts,
      })),
      crossProduct: await this.crossProduct(state, evidence),
    };
  }

  private async crossProduct(
    state: ManagementRead,
    evidence: readonly StoryEvidence[],
  ) {
    const { store, config } = this.options;
    const byStory = new Map(evidence.map((item) => [item.row.id, item]));
    const groups: IterationData["crossProduct"] = [];
    const seen = new Set<string>();
    await state.loadPeople(evidence);
    const project = (item: StoryEvidence) => ({
      ...state.storyItem(item),
      stages: Object.entries(item.stages).map(([stage, { status }]) => ({
        stage,
        status,
      })),
    });
    for (const item of evidence) {
      const { row } = item;
      const related = new Set(row.linkStories ?? []);
      if (row.fromStory) related.add(row.fromStory);
      const here = String(row.id);
      const links = await state.read(`sourceLinks:story:${here}`, () => ({
        incoming: store?.sourceLinks?.listTo("story", here) ?? [],
        outgoing: store?.sourceLinks?.listFrom("story", here) ?? [],
      }));
      for (const link of links?.outgoing ?? [])
        if (
          link.toType === "story" &&
          (link.relation === "pairs" || link.relation === "derives")
        )
          related.add(Number(link.toId));
      for (const link of links?.incoming ?? []) {
        if (
          link.fromType === "story" &&
          (link.relation === "pairs" || link.relation === "derives")
        )
          related.add(Number(link.fromId));
        if (link.fromType !== "intake" || link.relation !== "source") continue;
        const peers = await state.read(
          `sourceLinks:intake:${link.fromId}`,
          () => store?.sourceLinks?.listFrom("intake", link.fromId) ?? [],
        );
        for (const peer of peers ?? [])
          if (peer.toType === "story" && peer.relation === "source")
            related.add(Number(peer.toId));
      }
      const ids = [...related].filter(
        (id) => Number.isSafeInteger(id) && id > 0 && id !== row.id,
      );
      const comparison = [project(item)];
      for (const id of ids) {
        let peer = byStory.get(id);
        if (!peer) {
          const detail = await state.detail(id);
          if (detail) {
            peer = await storyEvidence(state, detail, [], true, {
              detail: true,
            });
            byStory.set(id, peer);
            await state.loadPeople([peer]);
          }
        }
        if (!peer || peer.row.product === row.product) continue;
        const projected = project(peer);
        if (peer.row.category === "design") {
          const { progress } = designProgress({
            ...peer.row,
            ...peer,
            hasRelatedFeature: isFeature(row),
          });
          projected.progress.value = progress;
        }
        comparison.push(projected);
      }
      if (comparison.length < 2) continue;
      const groupKey = comparison
        .map(({ id }) => id)
        .sort((a, b) => a - b)
        .join(",");
      if (seen.has(groupKey)) continue;
      seen.add(groupKey);
      groups.push({ stories: comparison });
      if (
        config.rules.R15.enabled &&
        comparison.some(
          ({ progress }) =>
            progress.value === "未就绪" || progress.value === "待接收",
        )
      ) {
        for (const compared of comparison) {
          const closed = byStory.get(compared.id)?.row.closedDate;
          if (compared.progress.value !== "已完成" || closed == null) continue;
          if (
            countWorkdaysBetween(
              formatLocalDate(closed, config.timezone),
              state.today,
              state.calendar,
            ) < config.rules.R15.after
          )
            continue;
          for (const candidate of comparison)
            if (
              candidate.progress.value === "未就绪" ||
              candidate.progress.value === "待接收"
            )
              candidate.riskCodes.push("R15");
          break;
        }
      }
    }
    return groups;
  }

  async getMonthlyDevQueue(raw: unknown): Promise<GetMonthlyDevQueueOutput> {
    const input = parseInput(getMonthlyDevQueueInputSchema, raw);
    const state = new ManagementRead(this.options);
    const { config, client, directory } = this.options;
    const month = monthOf(input.month, state.today);
    const previousMonth = monthOf("上月", `${month}-01`);
    const allTeams = Object.keys(config.teams);
    let teamIds: string[];
    if (input.team) {
      const team = (
        directory ?? new DirectoryService(this.options)
      ).resolveTeam(input.team);
      if (!team) throw new BztError("NOT_FOUND", "没有找到匹配的团队。");
      teamIds = [team.id];
    } else {
      const account = allTeams.length
        ? (await state.read("me", () => getCurrentUser(client)))?.account
        : undefined;
      const led = allTeams.filter(
        (id) => account && config.teams[id]?.lead === account,
      );
      teamIds = led.length ? led : allTeams;
    }
    const products = await state.products();
    const [pool, snapshotRows] = await Promise.all([
      monthlyPool(state, products, month),
      Promise.all(products.map(({ id }) => state.snapshot(id, previousMonth))),
    ]);
    const snapshots = snapshotRows.filter((row) => row !== undefined);
    const fallbackProducts = products.filter(
      ({ id }) => !snapshots.some(({ productId }) => productId === id),
    );
    const snapshotIds = snapshots.flatMap(({ items }) =>
      items
        .filter(
          ({ progressAtSnap }) =>
            progressAtSnap !== "已完成" && progressAtSnap !== "已取消",
        )
        .map(({ storyId }) => storyId),
    );
    const rows = indexById([...pool.planned, ...pool.iteration]);
    let historyIds: number[] | undefined;
    if (fallbackProducts.length) {
      const history = await state.reschedules(previousMonth);
      const fallbackProductIds = new Set(fallbackProducts.map(({ id }) => id));
      const candidates = (history ?? [])
        .filter(
          ({ fromMonth, toMonth }) =>
            fromMonth === previousMonth && toMonth === month,
        )
        .map(({ storyId }) => storyId);
      const currentIds = [...rows.values()]
        .filter(({ product }) => fallbackProductIds.has(product))
        .map(({ id }) => id);
      const historyRows = await mapDetails(state, [
        ...currentIds,
        ...candidates,
      ]);
      for (const row of historyRows)
        if (isFeature(row) && fallbackProductIds.has(row.product))
          rows.set(row.id, row);
      const comments = historyReasons(historyRows, previousMonth, month);
      historyIds = [...new Set([...candidates, ...comments.keys()])].filter(
        (id) => {
          const row = rows.get(id);
          return row !== undefined && fallbackProductIds.has(row.product);
        },
      );
      state.inferences.push({
        field: "carryOverSource",
        level: "inferred",
        basis: "缺少上月快照的产品通过已登记挪月记录还原遗留。",
      });
      state.hints.push("缺少上月快照的产品仅能还原已有记录的挪月需求。");
    }
    const previous = await mapDetails(
      state,
      snapshotIds.filter((id) => !rows.has(id)),
    );
    for (const row of previous.filter(isFeature)) rows.set(row.id, row);
    const tasks = await state.tasks(pool.executions.map(({ id }) => id));
    const grouped = groupTasks(tasks.rows);
    const complete =
      tasks.complete &&
      !state.gaps.some(({ source }) => source === "executions");
    const plans = indexById(
      (await Promise.all(products.map(({ id }) => state.plans(id)))).flat(),
    );
    const scoped = await Promise.all(
      [...rows.values()].map((row) =>
        storyEvidence(state, row, grouped.get(row.id) ?? [], complete),
      ),
    );
    const accounts = new Set(
      teamIds.flatMap((id) => {
        const team = config.teams[id];
        return team ? [team.lead, ...team.members] : [];
      }),
    );
    const teamFilter = teamIds.length > 0;
    const items = leafStories(scoped).filter(
      ({ row, owner, roles, tasks, detail }) => {
        if (detail?.children?.length) return false;
        if (!teamFilter) return true;
        const module = config.modules[`${row.product}/${row.module}`];
        if (module?.team) return teamIds.includes(module.team);
        return [
          owner,
          roles.receiver,
          ...tasks.map(({ assignedTo }) => assignedTo),
        ].some((account) => account != null && accounts.has(account));
      },
    );
    await state.loadPeople(items);
    const byId = new Map(items.map((item) => [item.row.id, item]));
    const previousIds = [...snapshotIds, ...(historyIds ?? [])].filter(
      (id) => byId.has(id) || !rows.has(id),
    );
    const planFor = (row: StoryRow) =>
      pool.planByStory.get(row.id) ??
      row.plan
        ?.map((id) => plans.get(id))
        .find((plan) => plan && state.planKind(plan) === "l3");
    const queue = classifyMonthlyDevQueue({
      month,
      today: state.today,
      calendar: state.calendar,
      stories: items.map((item) =>
        normalizePlanStory(item, planFor(item.row) ? "l3" : undefined),
      ),
      planStoryIds: pool.planned
        .map(({ id }) => id)
        .filter((id) => byId.has(id)),
      iterationStoryIds: pool.iteration
        .map(({ id }) => id)
        .filter((id) => byId.has(id)),
      ...(snapshots.length
        ? { previousSnapshotStoryIds: previousIds }
        : historyIds
          ? { historyCarryOverStoryIds: previousIds }
          : {}),
    });
    const projectItems = (
      entries: typeof queue.notReady,
    ): GetMonthlyDevQueueOutput["data"]["buckets"]["inDev"] =>
      entries.flatMap(
        ({ id, carriedOver, planNoIteration, iterationNoPlan }) => {
          const item = byId.get(id);
          return item
            ? [
                {
                  ...state.storyItem(item, planFor(item.row)),
                  carriedOver,
                  planNoIteration,
                  iterationNoPlan,
                },
              ]
            : [];
        },
      );
    const buckets = {
      toReceive: projectItems(queue.buckets.toReceive),
      inDev: projectItems(queue.buckets.inDev),
      carriedOver: projectItems(queue.buckets.carriedOver),
      planNoIteration: projectItems(queue.buckets.planNoIteration),
      iterationNoPlan: projectItems(queue.buckets.iterationNoPlan),
    };
    return state.finish<GetMonthlyDevQueueOutput["data"]>(
      {
        buckets,
        ...(input.includeNotReady
          ? { notReady: projectItems(queue.notReady) }
          : {}),
        ...(month === state.today.slice(0, 7) &&
        isInLastWorkdaysOfMonth(state.today, state.calendar)
          ? { monthEndWarnings: projectItems(queue.monthEndWarnings) }
          : {}),
        counts: {
          mainPool: queue.mainPoolIds.length,
          toReceive: buckets.toReceive.length,
          inDev: buckets.inDev.length,
          carriedOver: buckets.carriedOver.length,
          planNoIteration: buckets.planNoIteration.length,
          iterationNoPlan: buckets.iterationNoPlan.length,
          notReady: queue.notReady.length,
          unbucketed: queue.unbucketedStoryIds.length,
          missing: queue.missingStoryIds.length,
        },
        mainPoolIds: queue.mainPoolIds,
        unbucketedStoryIds: queue.unbucketedStoryIds,
        missingStoryIds: queue.missingStoryIds,
        carryOverSource:
          snapshots.length > 0
            ? fallbackProducts.length > 0
              ? "mixed"
              : "snapshot"
            : historyIds?.length
              ? "history"
              : null,
      },
      {
        month,
        teamIds,
        productIds: products.map(({ id }) => id),
        includeNotReady: input.includeNotReady ?? false,
      },
      `${executionMonth}，月末提醒采用最后 7 个工作日。`,
    );
  }
}

function isSerious(bug: Pick<Bug, "severity">) {
  return bug.severity === 1 || bug.severity === 2;
}
