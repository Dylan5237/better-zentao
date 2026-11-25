import { randomUUID } from "node:crypto";
import { constants } from "node:fs";
import { mkdir, open, writeFile } from "node:fs/promises";
import { homedir } from "node:os";
import { join } from "node:path";
import { z } from "zod";
import { listProductBugs } from "../api/bug.ts";
import {
  createZentaoReadClient,
  type ZentaoReadClient,
} from "../api/client.ts";
import { listExecutionsIncludingClosed } from "../api/execution.ts";
import { getPlanDetail, listProductPlans } from "../api/plan.ts";
import { getStoryDetail, listProductStories } from "../api/story.ts";
import { getTaskDetail, listExecutionTasks } from "../api/task.ts";
import { civilDate, formatLocalDate } from "../core/calendar.ts";
import type { Clock } from "../core/clock.ts";
import { checkCollector } from "../core/config-checks.ts";
import {
  loadFileConfig,
  type ConfigEnv,
  type TeamConfig,
} from "../core/config.ts";
import { walkProductPlans } from "../core/dto/plan.ts";
import type { Story, StoryDetail } from "../core/dto/story.ts";
import type { Task, TaskDetail } from "../core/dto/task.ts";
import { BztError, type ErrorCode } from "../core/errors.ts";
import {
  instanceHashOf,
  openLocalStore,
  sanitizeAccount,
  type LocalStore,
  type SnapshotRecord,
  type SnapshotWithItems,
} from "../core/store/index.ts";
import { isDevExecutionInMonth, planOverlapDays } from "../domain/month.ts";
import { featureProgress, type FeatureProgress } from "../domain/progress.ts";
import { summarizeStages } from "../domain/stage.ts";
import { foldStageRequirements } from "./structured-notes.ts";

const maxSnapshotBytes = 8 * 1024 * 1024;
const id = z.int().positive();
const portableId = z
  .string()
  .regex(/^[A-Za-z0-9_][A-Za-z0-9_.-]{0,127}$/u)
  .refine((value) => !/[a-f\d]{32}/iu.test(value));
const monthKey = z
  .string()
  .regex(/^\d{4}-\d{2}$/u)
  .refine((value) => civilDate.safeParse(`${value}-01`).success);
const monthInput = z.union([monthKey, z.enum(["本月", "上月", "下月"])]);
const pathInput = z
  .string()
  .refine((value) => value.trim().length > 0 && !value.includes("\0"));
const progressValues = [
  "未就绪",
  "已取消",
  "已完成",
  "已关闭·证据缺失",
  "无法判断",
  "待接收",
  "研发中",
  "待测试",
  "测试中",
  "待验收",
  "待交付",
  "可关闭",
] satisfies readonly FeatureProgress[];

const snapshotDocument = z
  .strictObject({
    schemaVersion: z.literal(1),
    snapId: portableId,
    month: monthKey,
    productId: id,
    takenAt: z.int().nonnegative(),
    takenBy: portableId,
    items: z.array(
      z.strictObject({
        storyId: id,
        planId: id.nullable(),
        executionId: id.nullable(),
        progressAtSnap: z.enum(progressValues),
      }),
    ),
  })
  .refine(
    ({ items }) =>
      new Set(items.map(({ storyId }) => storyId)).size === items.length,
  );

type SnapshotDocument = z.output<typeof snapshotDocument>;
type SnapshotItem = SnapshotDocument["items"][number];
type SnapshotMetadata = Omit<SnapshotDocument, "schemaVersion" | "items">;

export const snapshotCommandSchema = z.discriminatedUnion("action", [
  z.strictObject({
    action: z.literal("capture"),
    month: monthInput.optional(),
    product: id.optional(),
    out: pathInput.optional(),
    config: pathInput.optional(),
  }),
  z.strictObject({
    action: z.literal("export"),
    snapId: portableId,
    out: pathInput.optional(),
    config: pathInput.optional(),
  }),
  z.strictObject({
    action: z.literal("import"),
    input: pathInput,
    config: pathInput.optional(),
  }),
]);

type SnapshotCommand = z.input<typeof snapshotCommandSchema>;
type CaptureInput = Omit<
  Extract<SnapshotCommand, { action: "capture" }>,
  "action" | "config"
>;
type ExportInput = Omit<
  Extract<SnapshotCommand, { action: "export" }>,
  "action" | "config"
>;
type ImportInput = Omit<
  Extract<SnapshotCommand, { action: "import" }>,
  "action" | "config"
>;

export interface SnapshotRuntimeOptions {
  readonly command: SnapshotCommand;
  readonly env: ConfigEnv;
  readonly homeDir?: string;
  readonly clock: Clock;
  readonly logSink?: (line: string) => void;
}

interface SnapshotOptions {
  readonly config: TeamConfig;
  readonly store: LocalStore;
  readonly clock: Clock;
  readonly client?: ZentaoReadClient;
  readonly protectedValues?: readonly string[];
}

interface Gap {
  readonly source: string;
  readonly code: ErrorCode | "TRUNCATED";
}

interface CaptureResult {
  readonly snapshots: readonly SnapshotMetadata[];
  readonly completeness: "complete" | "partial";
  readonly gaps: readonly Gap[];
}

function normalizeMonth(input: string, now: number, timezone: string): string {
  if (monthKey.safeParse(input).success) return input;
  if (!monthInput.safeParse(input).success)
    throw new BztError("INVALID_INPUT", "月份须为 YYYY-MM、本月、上月或下月。");
  const current = formatLocalDate(now, timezone).slice(0, 7);
  const offset = input === "上月" ? -1 : input === "下月" ? 1 : 0;
  const index =
    Number(current.slice(0, 4)) * 12 + Number(current.slice(5)) - 1 + offset;
  const month = `${String(Math.floor(index / 12)).padStart(4, "0")}-${String((index % 12) + 1).padStart(2, "0")}`;
  if (!monthKey.safeParse(month).success)
    throw new BztError("INVALID_INPUT", "月份超出可记录的日期范围。");
  return month;
}

async function readEvidence<T>(
  gaps: Gap[],
  source: string,
  load: () => Promise<T>,
): Promise<T | undefined> {
  try {
    return await load();
  } catch (error) {
    gaps.push({
      source,
      code: error instanceof BztError ? error.code : "ZENTAO_UNAVAILABLE",
    });
    return undefined;
  }
}

async function readPage<T>(
  gaps: Gap[],
  source: string,
  load: () => Promise<{ items: T[]; truncated: boolean }>,
) {
  const page = await readEvidence(gaps, source, load);
  if (page?.truncated) gaps.push({ source, code: "TRUNCATED" });
  return page;
}

function isFeature(story: Story | StoryDetail, product: number) {
  return (
    story.type === "story" &&
    story.category !== "design" &&
    !story.deleted &&
    story.product === product
  );
}

async function readSnapshotFile(input: string): Promise<unknown> {
  try {
    // POSIX 上不等待管道写入，随后只接受有大小上限的普通文件。
    const file = await open(
      input,
      constants.O_RDONLY | (constants.O_NONBLOCK ?? 0),
    );
    try {
      const stat = await file.stat();
      if (!stat.isFile() || stat.size > maxSnapshotBytes)
        throw new BztError(
          "INVALID_INPUT",
          "快照须为不超过 8 MiB 的普通文件。",
        );
      // 再检查 EOF 前的字节数，文件在检查大小后仍可能增长。
      const buffer = Buffer.alloc(
        Math.min(stat.size + 1, maxSnapshotBytes + 1),
      );
      let bytes = 0;
      while (bytes < buffer.length) {
        const { bytesRead } = await file.read({
          buffer,
          offset: bytes,
          length: buffer.length - bytes,
        });
        if (!bytesRead) break;
        bytes += bytesRead;
      }
      if (bytes !== stat.size)
        throw new BztError("INVALID_INPUT", "读取期间快照文件大小发生变化。");
      const decoded: unknown = JSON.parse(
        new TextDecoder("utf-8", { fatal: true }).decode(
          buffer.subarray(0, bytes),
        ),
      );
      return decoded;
    } finally {
      await file.close();
    }
  } catch (error) {
    if (error instanceof BztError) throw error;
    throw new BztError(
      "INVALID_INPUT",
      "无法读取快照，请提供有效的 UTF-8 JSON 文件。",
    );
  }
}

function projectSnapshot({
  snapId,
  month,
  productId,
  takenAt,
  takenBy,
  items,
}: SnapshotWithItems) {
  return {
    schemaVersion: 1,
    snapId,
    month,
    productId,
    takenAt,
    takenBy,
    items: items.map(({ storyId, planId, executionId, progressAtSnap }) => ({
      storyId,
      planId,
      executionId,
      progressAtSnap,
    })),
  };
}

function ensureSafeIdentifiers(
  values: readonly string[],
  protectedValues: readonly string[] = [],
) {
  if (
    values.some(
      (value) =>
        !portableId.safeParse(value).success ||
        protectedValues.some(
          (secret) =>
            value === secret || (secret.length >= 8 && value.includes(secret)),
        ),
    )
  ) {
    throw new BztError("INVALID_INPUT", "快照编号或采集人格式不合法。");
  }
}

function snapshotMetadata({
  snapId,
  month,
  productId,
  takenAt,
  takenBy,
}: SnapshotDocument): SnapshotMetadata {
  return { snapId, month, productId, takenAt, takenBy };
}

async function writeSnapshotFile(
  document: SnapshotDocument,
  out: string | undefined,
  directory: string | undefined,
): Promise<void> {
  if (out === undefined && directory === undefined) return;
  const contents = JSON.stringify(document, null, 2) + "\n";
  if (Buffer.byteLength(contents) > maxSnapshotBytes)
    throw new BztError("INVALID_INPUT", "导出的快照超过 8 MiB。");
  try {
    if (out !== undefined) {
      await writeFile(out, contents, { encoding: "utf8", flag: "wx" });
    } else if (directory !== undefined) {
      await mkdir(directory, { recursive: true });
      await writeFile(join(directory, `${document.snapId}.json`), contents, {
        encoding: "utf8",
        flag: "wx",
      });
    }
  } catch {
    throw new BztError(
      "INVALID_INPUT",
      "无法导出快照，请检查输出路径、权限及目标文件是否已存在。",
    );
  }
}

function indexById<T extends { readonly id: number }>(rows: readonly T[]) {
  return new Map(rows.map((row) => [row.id, row]));
}

type TaskRow = Task | TaskDetail;

function taskStoryId(task: TaskRow, tasks: ReadonlyMap<number, TaskRow>) {
  const visited = new Set([task.id]);
  let current: TaskRow | undefined = task;
  while (current && !current.deleted) {
    if (current.story != null) return current.story;
    const parent = current.parent;
    if (parent == null || visited.has(parent)) break;
    visited.add(parent);
    current = tasks.get(parent);
  }
}

function groupByStory<T>(
  rows: Iterable<T>,
  storyIdOf: (row: T) => number | null | undefined,
) {
  const grouped = new Map<number, T[]>();
  for (const row of rows) {
    const storyId = storyIdOf(row);
    if (storyId == null) continue;
    const group = grouped.get(storyId);
    if (group) group.push(row);
    else grouped.set(storyId, [row]);
  }
  return grouped;
}

class SnapshotCapture {
  readonly gaps: Gap[] = [];
  private readonly executionTasks = new Map<
    number,
    ReturnType<typeof this.loadExecutionTasks>
  >();

  constructor(
    private readonly client: ZentaoReadClient,
    private readonly config: TeamConfig,
    private readonly store: Pick<LocalStore, "stageRequirements">,
  ) {}

  executions() {
    return readPage(this.gaps, "executions", () =>
      listExecutionsIncludingClosed(this.client),
    );
  }

  private loadExecutionTasks(executionId: number) {
    return readPage(this.gaps, `execution:${executionId}:tasks`, async () => {
      const page = await listExecutionTasks(this.client, executionId);
      if (page.items.some((task) => task.execution !== executionId))
        throw new BztError(
          "ZENTAO_SCHEMA_MISMATCH",
          "任务返回的执行编号不一致。",
        );
      return page;
    });
  }

  private tasks(executionId: number) {
    const pending =
      this.executionTasks.get(executionId) ??
      this.loadExecutionTasks(executionId);
    this.executionTasks.set(executionId, pending);
    return pending;
  }

  private async planStories(product: number, month: string) {
    const page = await readPage(this.gaps, `product:${product}:plans`, () =>
      listProductPlans(this.client, product),
    );
    const legacy = this.config.legacyReleasePlans;
    const pattern = legacy ? new RegExp(legacy.titlePattern, "u") : undefined;
    const plans = [
      ...indexById([...walkProductPlans(page?.items ?? [])]).values(),
    ]
      .filter((plan) => {
        if (
          plan.parent == null ||
          plan.parent <= 0 ||
          plan.deleted ||
          pattern?.test(plan.title)
        )
          return false;
        if (!plan.begin || !plan.end || plan.begin > plan.end) {
          this.gaps.push({
            source: `plan:${plan.id}`,
            code: "ZENTAO_SCHEMA_MISMATCH",
          });
          return false;
        }
        return planOverlapDays({ ...plan, kind: "l3" }, month) > 0;
      })
      .sort((left, right) => left.id - right.id);
    return Promise.all(
      plans.map(async ({ id: planId }) => ({
        planId,
        detail: await readEvidence(this.gaps, `plan:${planId}`, async () => {
          const detail = await getPlanDetail(this.client, planId);
          if (detail.plan.product !== product || detail.plan.deleted)
            throw new BztError(
              "ZENTAO_SCHEMA_MISMATCH",
              "计划详情与采集产品不一致。",
            );
          return detail;
        }),
      })),
    );
  }

  private storyDetail(storyId: number, product: number) {
    return readEvidence(this.gaps, `story:${storyId}`, async () => {
      const detail = await getStoryDetail(this.client, storyId);
      if (detail.id !== storyId || detail.product !== product)
        throw new BztError(
          "ZENTAO_SCHEMA_MISMATCH",
          "需求详情与采集对象不一致。",
        );
      return detail;
    });
  }

  private async resolveTasks(
    storyId: number,
    detail: StoryDetail | undefined,
    known: readonly Task[],
  ) {
    const tasks = indexById<TaskRow>(known);
    const parentIds = new Set(known.map(({ parent }) => parent));
    const missingIds = new Set([
      ...(detail?.tasks ?? [])
        .filter(({ id }) => !tasks.has(id))
        .map(({ id }) => id),
      ...known
        .filter(({ id, isParent }) => isParent && !parentIds.has(id))
        .map(({ id }) => id),
    ]);
    const details = await Promise.all(
      [...missingIds].map((id) =>
        readEvidence(this.gaps, `task:${id}`, async () => {
          const row = await getTaskDetail(this.client, id);
          if (row.id !== id)
            throw new BztError(
              "ZENTAO_SCHEMA_MISMATCH",
              "任务详情编号不一致。",
            );
          return row;
        }),
      ),
    );
    for (const task of details) {
      if (task)
        for (const row of [task, ...task.children]) tasks.set(row.id, row);
    }
    const rows = [...tasks.values()].filter(
      (task) => !task.deleted && taskStoryId(task, tasks) === storyId,
    );
    const ids = new Set(rows.map(({ id }) => id));
    const parents = new Set(rows.map(({ parent }) => parent));
    const missingTasks = detail?.tasks?.some(({ id }) => !ids.has(id)) ?? false;
    const brokenTree = rows.some(
      ({ id, parent, isParent }) =>
        (isParent && !parents.has(id)) || (parent != null && !ids.has(parent)),
    );
    if (missingTasks || brokenTree) {
      this.gaps.push({
        source: `story:${storyId}:tasks`,
        code: "ZENTAO_SCHEMA_MISMATCH",
      });
    }
    return {
      complete:
        !!detail && !missingTasks && !brokenTree && details.every(Boolean),
      stages: summarizeStages(
        rows.map((task) => ({
          ...task,
          isParent: task.isParent || parents.has(task.id),
          evidence: { prefixes: this.config.naming.taskPrefix },
        })),
      ),
    };
  }

  async items(
    product: number,
    month: string,
    executions: Awaited<ReturnType<SnapshotCapture["executions"]>>,
  ): Promise<SnapshotItem[]> {
    const projects = this.config.products[product]?.projects;
    const developmentIds = new Set(
      (executions?.items ?? [])
        .filter(
          (execution) =>
            (!projects?.length || projects.includes(execution.project)) &&
            isDevExecutionInMonth(execution, month, {
              devLabel: this.config.naming.execution.kinds.dev,
            }),
        )
        .map(({ id }) => id),
    );
    const [plans, catalog] = await Promise.all([
      this.planStories(product, month),
      developmentIds.size > 0
        ? readPage(this.gaps, `product:${product}:stories`, () =>
            listProductStories(this.client, product),
          )
        : undefined,
    ]);
    const stories = indexById(
      (catalog?.items ?? []).filter((story) => isFeature(story, product)),
    );
    const planIds = new Map<number, number>();
    for (const { planId, detail } of plans) {
      for (const story of detail?.planStories ?? []) {
        if (!isFeature(story, product)) continue;
        if (!planIds.has(story.id)) planIds.set(story.id, planId);
        if (!stories.has(story.id)) stories.set(story.id, story);
      }
    }

    // 06 §3.1 没有已验证的执行下需求清单接口。以详情的执行关联纳入未拆任务的需求。
    const candidates = await Promise.all(
      [...stories.values()].map(async (story) => {
        const detail = await this.storyDetail(story.id, product);
        const linkedExecutions = [
          ...new Set(detail?.executions.map(({ id }) => id)),
        ];
        const executionId =
          linkedExecutions
            .filter((id) => developmentIds.has(id))
            .sort((a, b) => a - b)[0] ?? null;
        const planId = planIds.get(story.id) ?? null;
        if (
          !isFeature(detail ?? story, product) ||
          (planId === null && executionId === null)
        )
          return undefined;
        return { story, detail, linkedExecutions, planId, executionId };
      }),
    );
    const members = candidates.filter((member) => member !== undefined);
    if (!members.length) return [];

    const allExecutionIds = new Set(
      members.flatMap(({ linkedExecutions }) => linkedExecutions),
    );
    const [taskPages, bugs] = await Promise.all([
      Promise.all(
        [...allExecutionIds].map(async (id) => ({
          id,
          page: await this.tasks(id),
        })),
      ),
      readPage(this.gaps, `product:${product}:bugs`, () =>
        listProductBugs(this.client, product),
      ),
    ]);
    const pagesByExecution = new Map(
      taskPages.map(({ id, page }) => [id, page]),
    );
    const tasksById = indexById(
      taskPages.flatMap(({ page }) => page?.items ?? []),
    );
    const tasksByStory = groupByStory(tasksById.values(), (task) =>
      taskStoryId(task, tasksById),
    );
    const bugsByStory = groupByStory(bugs?.items ?? [], (bug) =>
      bug.product === product ? bug.story : null,
    );
    return Promise.all(
      members
        .sort((a, b) => a.story.id - b.story.id)
        .map(async (member) => {
          const { story, detail, linkedExecutions, planId, executionId } =
            member;
          const known = (tasksByStory.get(story.id) ?? []).filter(
            ({ execution }) => linkedExecutions.includes(execution),
          );
          const tasks = await this.resolveTasks(story.id, detail, known);
          const cachedRequirements = await readEvidence(
            this.gaps,
            "stageRequirements:" + story.id,
            async () => this.store.stageRequirements.listByStory(story.id),
          );
          const progress = featureProgress({
            ...(detail ?? story),
            ...tasks.stages,
            required: foldStageRequirements(
              this.config.stageDefaults.feature,
              cachedRequirements,
              detail?.actions,
            ),
            tasksComplete:
              tasks.complete &&
              linkedExecutions.every(
                (id) => pagesByExecution.get(id)?.truncated === false,
              ),
            bugs: bugsByStory.get(story.id),
          }).progress;
          const needsBugEvidence = [
            "待验收",
            "待交付",
            "可关闭",
            "无法判断",
          ].includes(progress);
          return {
            storyId: story.id,
            planId,
            executionId,
            progressAtSnap:
              needsBugEvidence && bugs?.truncated !== false
                ? "无法判断"
                : progress,
          };
        }),
    );
  }
}

export class SnapshotService {
  constructor(private readonly options: SnapshotOptions) {}

  async capture(input: CaptureInput): Promise<CaptureResult> {
    const { config, store, clock, client, protectedValues } = this.options;
    checkCollector(config, "snapshot", store.location.account);
    const takenAt = clock();
    const month = normalizeMonth(
      input.month ?? "本月",
      takenAt,
      config.timezone,
    );
    ensureSafeIdentifiers([store.location.account], protectedValues);
    if (!client)
      throw new BztError("CONFIG_MISSING", "快照采集缺少禅道读取配置。");
    const products =
      input.product === undefined
        ? Object.entries(config.products)
            .filter(
              ([, product]) => product.enabled !== false && !product.probeOnly,
            )
            .map(([id]) => Number(id))
        : [input.product];
    if (!products.length)
      throw new BztError(
        "CONFIG_MISSING",
        "请配置启用的采集产品或用 --product 指定产品。",
      );
    if (!products.every((product) => id.safeParse(product).success))
      throw new BztError("INVALID_INPUT", "产品编号必须是正整数。");
    if (input.out !== undefined && !pathInput.safeParse(input.out).success)
      throw new BztError("INVALID_INPUT", "输出路径不合法。");
    const capture = new SnapshotCapture(client, config, store);
    const executions = await capture.executions();
    const snapshots: SnapshotMetadata[] = [];
    for (const productId of products) {
      const items = await capture.items(productId, month, executions);
      const document = this.validate({
        schemaVersion: 1,
        snapId: randomUUID(),
        month,
        productId,
        takenAt,
        takenBy: store.location.account,
        items,
      });
      const metadata = snapshotMetadata(document);
      store.snapshots.createSnapshotWithItems(
        { ...metadata, source: "local" },
        document.items,
      );
      snapshots.push(metadata);
      try {
        await writeSnapshotFile(
          document,
          products.length === 1 ? input.out : undefined,
          input.out ?? config.snapshot.exportDir,
        );
      } catch {
        throw new BztError(
          "INVALID_INPUT",
          `快照 ${metadata.snapId} 已保存到本地状态库，文件导出失败。`,
        );
      }
    }
    return {
      snapshots,
      completeness: capture.gaps.length ? "partial" : "complete",
      gaps: capture.gaps,
    };
  }

  async export(input: ExportInput): Promise<SnapshotDocument> {
    ensureSafeIdentifiers([input.snapId], this.options.protectedValues);
    const snapshot = this.options.store.snapshots.getSnapshot(input.snapId);
    if (!snapshot) throw new BztError("NOT_FOUND", "未找到指定快照。");
    const document = this.validate(projectSnapshot(snapshot));
    await writeSnapshotFile(
      document,
      input.out,
      this.options.config.snapshot.exportDir,
    );
    return document;
  }

  async import({ input }: ImportInput) {
    const document = this.validate(await readSnapshotFile(input));
    const { snapshots } = this.options.store;
    if (snapshots.getSnapshot(document.snapId))
      throw new BztError("INVALID_INPUT", "快照编号已存在，请保留现有记录。");
    const record: SnapshotRecord = {
      ...snapshotMetadata(document),
      source: "imported",
    };
    snapshots.createSnapshotWithItems(record, document.items);
    return record;
  }

  private validate(raw: unknown): SnapshotDocument {
    const parsed = snapshotDocument.safeParse(raw);
    if (!parsed.success)
      throw new BztError("INVALID_INPUT", "快照版本、字段或明细不合法。");
    ensureSafeIdentifiers(
      [parsed.data.snapId, parsed.data.takenBy],
      this.options.protectedValues,
    );
    return parsed.data;
  }
}

export async function runSnapshotCommand({
  env,
  homeDir,
  clock,
  command,
  logSink,
}: SnapshotRuntimeOptions) {
  const parsed = snapshotCommandSchema.safeParse(command);
  if (!parsed.success)
    throw new BztError("INVALID_INPUT", "快照命令参数不合法。");
  const input = parsed.data;
  const { config, stateDir } = await loadFileConfig({
    env,
    homeDir: homeDir ?? homedir(),
    cli: { config: input.config },
  });
  const account = env.ZENTAO_ACCOUNT?.trim();
  if (input.action === "capture") checkCollector(config, "snapshot", account);
  const baseUrl = env.ZENTAO_BASE_URL?.trim();
  if (!stateDir || !baseUrl || !account)
    throw new BztError(
      "CONFIG_MISSING",
      "请配置本地状态目录、禅道实例地址和当前账号。",
    );
  const password = env.ZENTAO_PASSWORD;
  let client: ZentaoReadClient | undefined;
  if (input.action === "capture") {
    if (!password?.trim())
      throw new BztError("CONFIG_MISSING", "采集快照需要配置禅道密码。");
    client = createZentaoReadClient({
      baseUrl,
      account,
      password,
      clock,
      logSink,
      timezone: config.timezone,
      env,
    });
  }
  const webhook = URL.parse(env.BZT_WECOM_WEBHOOK ?? "");
  const webhookKeys = [...(webhook?.searchParams ?? [])]
    .filter(([name]) => name.toLowerCase() === "key")
    .map(([, value]) => value);
  const protectedValues = [password, ...webhookKeys].filter(
    (value): value is string => !!value,
  );
  const store = openLocalStore({
    baseUrl,
    account,
    clock,
    dbPath: join(
      stateDir,
      instanceHashOf(baseUrl),
      sanitizeAccount(account),
      "state.db",
    ),
  });
  try {
    const service = new SnapshotService({
      config,
      store,
      clock,
      client,
      protectedValues,
    });
    if (input.action === "capture") return await service.capture(input);
    if (input.action === "export") return await service.export(input);
    return await service.import(input);
  } finally {
    store.close();
  }
}

export function snapshotCommandError(error: unknown) {
  return error instanceof BztError
    ? { code: error.code, message: error.message }
    : { message: "快照命令执行失败。" };
}
