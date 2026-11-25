import { z } from "zod";
import { getCapability } from "../api/capabilities.ts";
import { listProductBugs } from "../api/bug.ts";
import { listProductPlans } from "../api/plan.ts";
import {
  listProductRequirements,
  getRequirementDetail,
} from "../api/requirement.ts";
import { listReleases } from "../api/release.ts";
import { walkProductPlans } from "../core/dto/plan.ts";
import { isDevExecutionInMonth, planOverlapDays } from "../domain/month.ts";
import { featureProgress } from "../domain/progress.ts";
import { detectStage, summarizeStages } from "../domain/stage.ts";
import type { ZentaoReadClient } from "../api/client.ts";
import { listExecutionsIncludingClosed } from "../api/execution.ts";
import { getCurrentUser, listUsers } from "../api/org.ts";
import { listProducts } from "../api/product.ts";
import {
  getStoryDetail,
  getStoryDetailV2,
  listProductStories,
} from "../api/story.ts";
import { listExecutionTasks } from "../api/task.ts";
import {
  scanWorkflowRisksInputSchema,
  type ScanWorkflowRisksInput,
  type ScanWorkflowRisksOutput,
} from "../contracts/tools/scan_workflow_risks.ts";
import { createWorkCalendar, formatLocalDate } from "../core/calendar.ts";
import type { Clock } from "../core/clock.ts";
import type { TeamConfig } from "../core/config.ts";
import type { StoryDetail } from "../core/dto/story.ts";
import type { Task } from "../core/dto/task.ts";
import { BztError } from "../core/errors.ts";
import type { LocalStore } from "../core/store/index.ts";
import { resolveStoryRoles } from "../domain/roles.ts";
import {
  evaluateRules,
  rules,
  type RuleContext,
  type RuleInput,
} from "../rules/index.ts";
import { resolveReleaseWaiver } from "./management.ts";
import { DirectoryService } from "./directory.ts";

interface RiskOptions {
  readonly client: ZentaoReadClient;
  readonly config: TeamConfig;
  readonly clock: Clock;
  readonly baseUrl: string;
  readonly store?: Pick<LocalStore, "cache"> &
    Partial<
      Pick<
        LocalStore,
        "storyRoles" | "stageRequirements" | "waivers" | "sourceLinks"
      >
    >;
}

type OutputHit = ScanWorkflowRisksOutput["data"]["hits"][number];
type RuleResult = ReturnType<typeof evaluateRules>;
type Hit = RuleResult["hits"][number] | RuleResult["waived"][number];
type ObjectType = Hit["objectType"];
type Gaps = ScanWorkflowRisksOutput["gaps"];
type Waiver = NonNullable<RuleInput["waivers"]>[number];
const severityOrder = ["info", "low", "medium", "high"] as const;
const registered = new Map<string, (typeof rules)[number]["id"]>(
  rules.map(({ id }) => [id, id]),
);
const waiverRows = z.array(
  z.strictObject({
    ruleId: z.enum(["R01", "R02", "R03", "R04", "R05"]),
    by: z.string().trim().min(1),
    reason: z.string().trim().min(1),
  }),
);

const utc = new Intl.DateTimeFormat("en-GB", {
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

function asOf(timestamp: number) {
  const fields = Object.fromEntries(
    utc.formatToParts(timestamp).map(({ type, value }) => [type, value]),
  );
  const { year, month, day, hour, minute, second, fractionalSecond } = fields;
  return `${year?.padStart(4, "0")}-${month}-${day}T${hour}:${minute}:${second}.${fractionalSecond}Z`;
}

function scanMonth(
  month: ScanWorkflowRisksInput["scope"]["month"],
  today: string,
) {
  if (month !== "上月" && month !== "本月" && month !== "下月") return month;
  const offset = { 上月: -1, 本月: 0, 下月: 1 }[month];
  const index =
    Number(today.slice(0, 4)) * 12 + Number(today.slice(5, 7)) - 1 + offset;
  return `${String(Math.floor(index / 12)).padStart(4, "0")}-${String((((index % 12) + 12) % 12) + 1).padStart(2, "0")}`;
}

async function read<T>(gaps: Gaps, source: string, load: () => T | Promise<T>) {
  try {
    return await load();
  } catch (error) {
    gaps.push({
      source,
      reason:
        error instanceof BztError
          ? "读取失败（" + error.code + "）。"
          : "读取失败。",
    });
    return undefined;
  }
}

async function page<T>(
  gaps: Gaps,
  source: string,
  load: () => Promise<{ items: T[]; truncated: boolean }>,
) {
  const result = await read(gaps, source, load);
  if (result?.truncated) gaps.push({ source, reason: "分页未读完整。" });
  return result;
}

function threshold(workdays: number, fallback: number) {
  return {
    workdays,
    source: workdays === fallback ? "default" : "configured",
  } as const;
}

function bounded(text: string) {
  return text.length > 200 ? `${text.slice(0, 199)}…` : text;
}

function handoffTime(story: StoryDetail, receiver: string | null) {
  const activations = (story.actions ?? [])
    .filter(({ action }) => action.toLowerCase() === "activated")
    .flatMap(({ date }) => (date == null ? [] : [date]));
  if (receiver && receiver === story.assignedTo && story.assignedDate != null)
    activations.push(story.assignedDate);
  return activations.length ? Math.max(...activations) : null;
}

export class RiskService {
  private readonly directory: DirectoryService;

  constructor(private readonly options: RiskOptions) {
    this.directory = new DirectoryService(options);
  }

  async scanWorkflowRisks(raw: unknown): Promise<ScanWorkflowRisksOutput> {
    const parsed = scanWorkflowRisksInputSchema.safeParse(raw);
    if (!parsed.success)
      throw new BztError(
        "INVALID_INPUT",
        "巡检参数不合法，请检查范围、规则和分组。",
      );
    const {
      scope,
      rules: requested,
      minSeverity = "info",
      groupBy = "rule",
    } = parsed.data;
    const { client, clock, config } = this.options;
    const now = clock();
    const today = formatLocalDate(now, config.timezone);
    const month = scanMonth(scope.month, today);
    const selected = rules.filter(
      ({ id }) =>
        config.rules[id].enabled &&
        (requested === undefined || requested.includes(id)),
    );
    const enabled = new Set(selected.map(({ id }) => id));
    const skipped = [
      ...new Set(requested?.filter((id) => !registered.has(id))),
    ];
    const hints = skipped.length
      ? [
          `当前版本尚未注册所请求的 ${skipped.length} 条规则：${skipped.filter((id) => /^R\d{2}$/u.test(id)).join("、") || "规则编号无法识别"}。`,
        ]
      : [];
    const disabled = [...new Set(requested)].filter((id) => {
      const rule = registered.get(id);
      return rule !== undefined && !config.rules[rule].enabled;
    });
    if (disabled.length)
      hints.push("配置中未启用：" + disabled.join("、") + "。");
    const gaps: Gaps = [];
    const hits: OutputHit[] = [];
    const inferences: ScanWorkflowRisksOutput["inferences"] = [];
    const counts = new Map<string, number>();
    const team = scope.team
      ? this.directory.resolveTeam(scope.team)
      : undefined;
    const filters = {
      ...scope,
      ...(month ? { month } : {}),
      ...(team ? { team: team.id } : {}),
      rules: [...enabled],
      minSeverity,
      groupBy,
    };
    const finish = (): ScanWorkflowRisksOutput => ({
      ok: true,
      data: {
        hits,
        summary: selected.flatMap(({ id, name }) => {
          const count = counts.get(id);
          return count ? [{ rule: id, name, count }] : [];
        }),
      },
      scope: {
        asOf: asOf(now),
        filters,
        timeBasis:
          "按业务时区计算截止日、工作日和自然日。月份按已读取的迭代或 L3 计划重叠范围，用户需求和 Bug 按登记月份。",
      },
      completeness: gaps.length ? "partial" : "complete",
      gaps,
      inferences,
      ...(hints.length ? { hints } : {}),
    });
    if (!selected.length) return finish();

    const lookup =
      scope.product || scope.module
        ? await this.resolveScope(scope, gaps)
        : undefined;
    const product = lookup?.product?.id;
    const module = lookup?.module?.id;
    if (
      ((scope.product || scope.module) && !product) ||
      (scope.module && !module)
    )
      return finish();
    const me = scope.mine
      ? (lookup?.me ?? (await read(gaps, "me", () => getCurrentUser(client))))
      : undefined;
    if (scope.mine && !me?.account) return finish();

    const storyRules = selected.some(({ id }) => !["R01", "R08"].includes(id));
    const taskRules = selected.some(({ id }) =>
      ["R01", "R06", "R14"].includes(id),
    );
    const stageRules = selected.some(({ id }) =>
      ["R02", "R03", "R06", "R07", "R09", "R11", "R12", "R13", "R14"].includes(
        id,
      ),
    );
    const p2 = selected.some(({ id }) => id >= "R06");
    const wantsBugs = selected.some(({ id }) =>
      ["R09", "R12", "R13", "R14"].includes(id),
    );
    const evidenceMonth = month ?? today.slice(0, 7);
    const products = product
      ? [product]
      : storyRules || enabled.has("R08")
        ? ((await page(gaps, "products", () => listProducts(client)))?.items
            .filter(({ deleted }) => !deleted)
            .map(({ id }) => id) ?? [])
        : [];
    const storyRows = new Map(
      (
        await Promise.all(
          (storyRules || (product && taskRules)
            ? [...new Set(products)]
            : []
          ).map(async (id) => {
            const rows = await page(gaps, `stories:${id}`, () =>
              listProductStories(client, id),
            );
            return (
              rows?.items.filter(
                (story) => story.product === id && !story.deleted,
              ) ?? []
            );
          }),
        )
      )
        .flat()
        .map((story) => [story.id, story]),
    );
    const matchesOwner = (account: string | null | undefined) =>
      (!me || account === me.account) &&
      (!team ||
        account === team.lead ||
        (account != null && team.members.includes(account)));

    const details = await Promise.all(
      [...storyRows.values()]
        .filter(
          (story) =>
            storyRules &&
            (!module || story.module == null || story.module === module),
        )
        .map(async (story) =>
          read(gaps, `story:${story.id}`, async () => {
            const detail = await getStoryDetail(client, story.id);
            if (detail.id !== story.id || detail.product !== story.product)
              throw new BztError(
                "ZENTAO_SCHEMA_MISMATCH",
                "需求详情与巡检对象不一致。",
              );
            return detail;
          }),
        ),
    );
    const stories = details.filter(
      (story): story is StoryDetail =>
        story !== undefined &&
        !story.deleted &&
        (!module || story.module === module) &&
        matchesOwner(story.assignedTo),
    );
    const executionPage =
      taskRules || month || enabled.has("R10")
        ? await page(gaps, "executions", () =>
            listExecutionsIncludingClosed(client),
          )
        : undefined;
    const executions = executionPage?.items ?? [];
    const [planPages, bugPages] = await Promise.all([
      Promise.all(
        (enabled.has("R06") || enabled.has("R10") ? products : []).map(
          async (id) =>
            [
              id,
              await page(gaps, "plans:" + id, () =>
                listProductPlans(client, id),
              ),
            ] satisfies readonly [
              number,
              Awaited<ReturnType<typeof listProductPlans>> | undefined,
            ],
        ),
      ),
      Promise.all(
        (wantsBugs ? products : []).map(
          async (id) =>
            [
              id,
              await page(gaps, "bugs:" + id, () => listProductBugs(client, id)),
            ] satisfies readonly [
              number,
              Awaited<ReturnType<typeof listProductBugs>> | undefined,
            ],
        ),
      ),
    ]);
    const plansByProduct = new Map(
      planPages.map(([product, planPage]) => [
        product,
        {
          complete: planPage?.truncated === false,
          l3ById: new Map(
            [...walkProductPlans(planPage?.items ?? [])]
              .filter((plan) => this.isL3(plan))
              .map((plan) => [plan.id, plan]),
          ),
        },
      ]),
    );
    const bugsByProduct = new Map(bugPages);
    const monthExecutions = new Set(
      executions
        .filter(({ id, begin, end }) => {
          if (!month) return true;
          if (!begin || !end) {
            gaps.push({
              source: `execution:${id}`,
              reason: "迭代缺少起止日期，无法确认月份。",
            });
            return false;
          }
          return begin.slice(0, 7) <= month && month <= end.slice(0, 7);
        })
        .map(({ id }) => id),
    );
    const executionIds = new Set(taskRules ? monthExecutions : []);
    if (stageRules)
      for (const story of stories)
        if (p2 || (story.category === "feature" && story.status === "active"))
          for (const { id } of story.executions) executionIds.add(id);
    const taskPages = new Map(
      await Promise.all(
        [...executionIds].map(
          async (id) =>
            [
              id,
              await page(gaps, `tasks:${id}`, () =>
                listExecutionTasks(client, id),
              ),
            ] as const,
        ),
      ),
    );
    const tasks = [
      ...new Map(
        [...taskPages.values()].flatMap(
          (rows) => rows?.items.map((task) => [task.id, task] as const) ?? [],
        ),
      ).values(),
    ];
    const byStory = new Map<number, Task[]>();
    for (const task of tasks) {
      if (!task.story) continue;
      const existing = byStory.get(task.story);
      if (existing) existing.push(task);
      else byStory.set(task.story, [task]);
    }

    const context: RuleContext = {
      today,
      month: evidenceMonth,
      systemStartDate: config.rules.R06.systemStartDate,
      timezone: config.timezone,
      calendar: createWorkCalendar(config.calendar),
      thresholds: {
        R02: {
          missingAfter: threshold(config.rules.R02.missingAfter, 1),
          waitAfter: threshold(config.rules.R02.waitAfter, 2),
        },
        R03: { after: threshold(config.rules.R03.after, 3) },
        R07: { after: threshold(config.rules.R07.after, 2) },
        R08: { after: threshold(config.rules.R08.after, 5) },
        R09: { after: threshold(config.rules.R09.after, 5) },
        R10: { fromWorkday: threshold(config.rules.R10.fromWorkday, 5) },
        R11: { after: threshold(config.rules.R11.after, 1) },
        R13: { beforeRelease: threshold(config.rules.R13.beforeRelease, 3) },
        R14: {
          olderThanDays: {
            days: config.rules.R14.olderThanDays,
            unit: "calendarDays",
            source:
              config.rules.R14.olderThanDays === 30 ? "default" : "configured",
          },
        },
      },
      disabledRules: new Set(
        rules.filter(({ id }) => !enabled.has(id)).map(({ id }) => id),
      ),
    };
    const directory = new Map<string, string>();
    const developmentAccounts = new Set([
      ...(config.roles.RM ?? []),
      ...Object.values(config.modules).flatMap(({ devLead }) =>
        devLead ? [devLead] : [],
      ),
      ...Object.values(config.moduleDefaults).flatMap(({ devLead }) =>
        devLead ? [devLead] : [],
      ),
    ]);
    const loadUsers = async () => {
      const users = await page(gaps, "users", () => listUsers(client));
      for (const { account, realname, role, deleted } of users?.items ?? []) {
        if (deleted || !account) continue;
        directory.set(account, bounded(realname));
        if (role === "dev") developmentAccounts.add(account);
      }
    };
    if (
      enabled.has("R04") &&
      stories.some(({ status }) => status === "draft" || status === "reviewing")
    )
      await loadUsers();

    const evaluated: {
      hit: Hit;
      title: string;
      account: string | null | undefined;
      storyId: number | null;
    }[] = [];
    if (taskRules) {
      // 先在完整的执行任务树上判定叶子，再按对象范围筛选。
      const scopedTasks = tasks.filter(({ execution }) =>
        monthExecutions.has(execution),
      );
      const taskIndex = new Map(scopedTasks.map((task) => [task.id, task]));
      const result = evaluateRules({ tasks: scopedTasks }, context);
      for (const hit of result.hits) {
        const task = taskIndex.get(hit.objectId);
        if (!task || !matchesOwner(task.assignedTo)) continue;
        const parent = task.story ? storyRows.get(task.story) : undefined;
        if (product && (parent?.product ?? task.product) !== product) continue;
        if (module && (task.module || parent?.module) !== module) continue;
        const waiver = await this.waivers("task", task.id, gaps);
        const matched = waiver.find(({ ruleId }) => ruleId === hit.ruleId);
        evaluated.push({
          hit: matched
            ? { ...hit, waived: { by: matched.by, reason: matched.reason } }
            : hit,
          title: task.name,
          account: task.assignedTo,
          storyId: task.story,
        });
      }
    }

    const storyContext = {
      ...context,
      developmentAccounts,
      disabledRules: new Set([
        ...(context.disabledRules ?? []),
        "R01",
      ] as const),
    };
    const seenHits = new Set(
      evaluated.map(
        ({ hit }) => hit.ruleId + ":" + hit.objectType + ":" + hit.objectId,
      ),
    );
    const addHits = (
      result: readonly Hit[],
      object: { title: string; assignedTo?: string | null },
      storyId: number | null,
    ) => {
      for (const hit of result) {
        const key = hit.ruleId + ":" + hit.objectType + ":" + hit.objectId;
        if (seenHits.has(key)) continue;
        seenHits.add(key);
        evaluated.push({
          hit,
          title: object.title,
          account: object.assignedTo,
          storyId,
        });
      }
    };
    const storyDetails = new Map(stories.map((story) => [story.id, story]));
    const releaseStories = new Map<
      number,
      NonNullable<RuleInput["release"]>["stories"][number][]
    >();
    for (const story of stories) {
      const linked = byStory.get(story.id) ?? [];
      const planPage = plansByProduct.get(story.product);
      const planIds = story.plan ?? storyRows.get(story.id)?.plan;
      if (
        planPage &&
        planIds === undefined &&
        story.category === "feature" &&
        story.status === "active"
      )
        gaps.push({
          source: "story:" + story.id + ":plan",
          reason: "需求缺少计划归属信息。",
        });
      const linkedPlans = (planIds ?? []).flatMap((id) => {
        const plan = planPage?.l3ById.get(id);
        return plan ? [plan] : [];
      });
      const inMonthPlan = linkedPlans.some(
        (plan) => planOverlapDays({ ...plan, kind: "l3" }, evidenceMonth) > 0,
      );
      if (
        month &&
        !inMonthPlan &&
        !story.executions.some(({ id }) => monthExecutions.has(id)) &&
        !linked.some(({ execution }) => monthExecutions.has(execution))
      )
        continue;
      const relevantTasks =
        stageRules &&
        (p2 || (story.category === "feature" && story.status === "active"));
      const taskIds = new Set(linked.map(({ id }) => id));
      const missingTask =
        relevantTasks && story.tasks?.some(({ id }) => !taskIds.has(id));
      if (missingTask)
        gaps.push({
          source: `story:${story.id}:tasks`,
          reason: "执行任务列表缺少需求详情中引用的任务。",
        });
      const tasksComplete =
        !missingTask &&
        story.executions.every(
          ({ id }) => taskPages.get(id)?.truncated === false,
        );
      const moduleConfig = config.modules[`${story.product}:${story.module}`];
      const defaults = config.moduleDefaults[story.product];
      const stored = await this.readStoryRoles(story.id, gaps);
      const roles = {
        stored,
        module: {
          maintainer: moduleConfig?.designLead ?? defaults?.designLead,
          devLead: moduleConfig?.devLead ?? defaults?.devLead,
        },
      };
      const { receiver } = resolveStoryRoles({ story, ...roles });
      const waivers = await this.waivers(
        "story",
        story.id,
        gaps,
        story.actions,
      );
      const overrides = p2
        ? await read(
            gaps,
            "stageRequirements:" + story.id,
            () =>
              this.options.store?.stageRequirements?.listByStory(story.id) ??
              [],
          )
        : [];
      const required = {
        test: config.stageDefaults.feature.test.required,
        interface: config.stageDefaults.feature.interface.required,
        ...Object.fromEntries(
          (overrides ?? []).map(({ stage, required }) => [stage, required]),
        ),
      };
      const stageTasks = linked.map((task) => ({
        ...task,
        evidence: { prefixes: config.naming.taskPrefix },
      }));
      const bugPage = bugsByProduct.get(story.product);
      const bugs = bugPage?.items.filter(
        (bug) =>
          !bug.deleted &&
          bug.product === story.product &&
          bug.story === story.id,
      );
      if (
        enabled.has("R10") &&
        story.executions.some(
          ({ id }) => !executions.some((execution) => execution.id === id),
        )
      )
        gaps.push({
          source: "story:" + story.id + ":executions",
          reason: "执行列表缺少需求引用的迭代。",
        });
      const hasL3Plan =
        linkedPlans.length > 0
          ? true
          : planIds !== undefined && planPage?.complete
            ? false
            : undefined;
      const inMonthDevExecution =
        executionPage?.truncated === false &&
        story.executions.every(({ id }) =>
          executions.some((execution) => execution.id === id),
        )
          ? story.executions.some(({ id }) =>
              executions.some(
                (execution) =>
                  execution.id === id &&
                  isDevExecutionInMonth(execution, evidenceMonth, {
                    devLabel: config.naming.execution.kinds.dev,
                  }),
              ),
            )
          : undefined;
      const linkedStories =
        enabled.has("R07") && story.category === "design"
          ? await this.storyRelations(story.id, story.product, gaps)
          : undefined;
      const available = new Set(storyContext.disabledRules);
      if (wantsBugs && bugPage?.truncated !== false) {
        available.add("R09");
        if (story.status !== "closed") available.add("R14");
      }
      const result = evaluateRules(
        {
          story,
          roles,
          tasks: stageTasks,
          tasksComplete: tasksComplete && overrides !== undefined,
          bugs,
          hasL3Plan,
          inMonthL3Plan: inMonthPlan,
          inMonthDevExecution,
          linkedStories,
          required,
          waivers,
          handoffAt: handoffTime(story, receiver),
        },
        { ...storyContext, disabledRules: available },
      );
      for (const hit of [...result.hits, ...result.waived]) {
        if (hit.objectType === "story") {
          addHits([hit], story, story.id);
        } else if (hit.ruleId === "R14") {
          const task = linked.find(({ id }) => id === hit.objectId);
          if (
            !task ||
            !matchesOwner(task.assignedTo) ||
            (month && !monthExecutions.has(task.execution))
          )
            continue;
          const waiver = (await this.waivers("task", task.id, gaps)).find(
            ({ ruleId }) => ruleId === hit.ruleId,
          );
          addHits(
            [waiver ? { ...hit, waived: waiver } : hit],
            { title: task.name, assignedTo: task.assignedTo },
            story.id,
          );
        }
      }
      if (
        enabled.has("R13") &&
        story.category === "feature" &&
        !story.isParent &&
        !story.children?.length
      ) {
        const stages = summarizeStages(stageTasks);
        const release = releaseStories.get(story.product) ?? [];
        release.push({
          ...story,
          ...stages,
          progress: featureProgress({
            ...story,
            ...stages,
            required,
            tasksComplete,
            bugs,
          }).progress,
          tasks: linked,
          tasksComplete,
          bugs: bugs ?? [],
        });
        releaseStories.set(story.product, release);
      }
    }
    for (const id of products) {
      if (enabled.has("R08")) {
        const requirements = await page(gaps, "requirements:" + id, () =>
          listProductRequirements(client, id),
        );
        for (const row of requirements?.items ?? []) {
          if (
            row.product !== id ||
            row.deleted ||
            (module && row.module !== module) ||
            !matchesOwner(row.assignedTo) ||
            (month &&
              (row.openedDate == null ||
                formatLocalDate(row.openedDate, config.timezone).slice(0, 7) !==
                  month))
          )
            continue;
          const linked = await this.storyRelations(
            row.id,
            id,
            gaps,
            "requirement",
          );
          const result = evaluateRules(
            {
              requirement: row,
              linkedStories: linked,
              waivers: await this.waivers("requirement", row.id, gaps),
            },
            context,
          );
          addHits([...result.hits, ...result.waived], row, null);
        }
      }
      if (enabled.has("R12")) {
        for (const bug of bugsByProduct.get(id)?.items ?? []) {
          if (
            bug.product !== id ||
            (module &&
              (bug.module ?? storyRows.get(bug.story ?? 0)?.module) !==
                module) ||
            !matchesOwner(bug.assignedTo) ||
            (month &&
              (bug.openedDate == null ||
                formatLocalDate(bug.openedDate, config.timezone).slice(0, 7) !==
                  month))
          )
            continue;
          const openedAt = bug.openedDate;
          const openedDuringTest =
            openedAt != null &&
            bug.story != null &&
            (byStory.get(bug.story) ?? []).some(
              (task) =>
                !task.deleted &&
                task.realStarted != null &&
                task.realStarted <= openedAt &&
                (task.finishedDate != null
                  ? openedAt <= task.finishedDate
                  : task.status === "doing") &&
                detectStage(task, { prefixes: config.naming.taskPrefix })
                  .stage === "test",
            );
          const result = evaluateRules(
            {
              bugs: [{ ...bug, openedDuringTest }],
              waivers: await this.waivers("bug", bug.id, gaps),
            },
            context,
          );
          addHits([...result.hits, ...result.waived], bug, bug.story ?? null);
        }
      }
      const scopedRelease = releaseStories.get(id);
      if (!scopedRelease?.length) continue;
      const releases =
        getCapability("release.read").state === "verified"
          ? await page(gaps, "releases:" + id, () => listReleases(client, id))
          : undefined;
      const versions = new Set([
        ...config.releaseCalendar
          .filter(({ product }) => product === id)
          .map(({ version }) => version),
        ...(releases?.items ?? [])
          .filter(({ product }) => product === id)
          .map(({ name }) => name),
      ]);
      const parents = new Set(
        [...storyRows.values()].map(({ parent }) => parent),
      );
      const leafRelease = scopedRelease.filter(({ id }) => !parents.has(id));
      for (const version of versions) {
        const waivers: Waiver[] = [];
        for (const { id } of leafRelease) {
          const detail = storyDetails.get(id);
          if (!detail) continue;
          const local = await read(
            gaps,
            "waivers:story:" + id,
            () =>
              this.options.store?.waivers?.listByObject("story", String(id)) ??
              [],
          );
          const [waiver] = resolveReleaseWaiver(
            config,
            detail,
            detail.actions ?? [],
            local ?? [],
            version,
          );
          if (waiver)
            waivers.push({
              ruleId: "R13",
              objectType: "story",
              objectId: id,
              by: waiver.approvedBy,
              reason: waiver.reason,
            });
        }
        const result = evaluateRules(
          {
            waivers,
            release: {
              product: id,
              version,
              stories: leafRelease,
              releases: releases?.items,
              releaseCalendar: config.releaseCalendar,
              keywordPrefix: config.versionTag.keywordPrefix,
            },
          },
          context,
        );
        for (const hit of [...result.hits, ...result.waived]) {
          const story = storyDetails.get(hit.objectId);
          if (story) addHits([hit], story, story.id);
        }
      }
    }
    const visible = evaluated.filter(
      ({ hit }) =>
        severityOrder.indexOf(hit.severity) >=
        severityOrder.indexOf(minSeverity),
    );
    if (
      !directory.size &&
      !gaps.some(({ source }) => source === "users") &&
      visible.some(({ account }) => account)
    )
      await loadUsers();
    const group = ({ hit, account, storyId }: (typeof visible)[number]) =>
      groupBy === "owner"
        ? (account ?? "")
        : groupBy === "story"
          ? storyId == null
            ? `${hit.objectType}:${hit.objectId}`
            : `story:${storyId}`
          : hit.ruleId;
    visible.sort(
      (a, b) =>
        group(a).localeCompare(group(b), "en", { numeric: true }) ||
        a.hit.ruleId.localeCompare(b.hit.ruleId) ||
        a.hit.objectId - b.hit.objectId,
    );
    for (const { hit, title, account } of visible) {
      if (!("waived" in hit))
        counts.set(hit.ruleId, (counts.get(hit.ruleId) ?? 0) + 1);
      const level = hit.confidence === "recorded" ? "recorded" : "inferred";
      if (level === "inferred")
        inferences.push({
          field: `data.hits[${hits.length}]`,
          level,
          basis: "规则命中使用了推测的阶段或流程证据。",
        });
      const limit =
        hit.threshold && "workdays" in hit.threshold
          ? `（${hit.threshold.source === "default" ? "默认" : "已确认配置"}阈值：${hit.threshold.workdays} 个工作日）`
          : hit.threshold?.unit === "calendarDays"
            ? "（阈值：" + hit.threshold.days + " 个自然日）"
            : "";
      hits.push({
        rule: hit.ruleId,
        severity: hit.severity,
        level,
        object: {
          type: hit.objectType,
          id: hit.objectId,
          title: bounded(title),
          untrusted: true,
          url: new URL(
            `${hit.objectType}-view-${hit.objectId}.html`,
            `${this.options.baseUrl.replace(/\/+$/u, "")}/`,
          ).href,
        },
        ...(account
          ? { owner: { account, realname: directory.get(account) ?? "" } }
          : {}),
        ...(hit.since ? { since: hit.since } : {}),
        reason: `${hit.state === "stalled" ? "滞留" : "缺口"}：${hit.evidence.join("，")}${limit}`,
        suggestion: hit.suggestion,
        ...("waived" in hit
          ? {
              waived: {
                by: hit.waived.by,
                reason: bounded(hit.waived.reason),
                untrusted: true,
              },
            }
          : {}),
      });
    }
    return finish();
  }

  private isL3(plan: {
    parent: number | null;
    title: string;
    deleted?: boolean;
  }) {
    const { legacyReleasePlans } = this.options.config;
    return (
      !plan.deleted &&
      plan.parent !== null &&
      plan.parent > 0 &&
      (!legacyReleasePlans ||
        !new RegExp(legacyReleasePlans.titlePattern, "iu").test(plan.title))
    );
  }

  private async storyRelations(
    id: number,
    product: number,
    gaps: Gaps,
    type: "story" | "requirement" = "story",
  ) {
    const { client, store } = this.options;
    const related = await read(
      gaps,
      type + ":" + id + ":relations",
      async () => {
        const detail =
          type === "story"
            ? await getStoryDetailV2(client, id)
            : await getRequirementDetail(client, id);
        if (
          detail.story.id !== id ||
          detail.story.product !== product ||
          detail.story.deleted
        )
          throw new BztError(
            "ZENTAO_SCHEMA_MISMATCH",
            "关联详情与巡检对象不一致。",
          );
        const local = [
          ...(store?.sourceLinks?.listFrom(type, String(id)) ?? [])
            .filter(({ toType }) => toType === "story")
            .map(({ toId }) => Number(toId)),
          ...(store?.sourceLinks?.listTo(type, String(id)) ?? [])
            .filter(({ fromType }) => fromType === "story")
            .map(({ fromId }) => Number(fromId)),
        ];
        return [
          ...new Set([
            ...detail.relations
              .filter(({ type }) => type === "story")
              .map(({ id }) => id),
            ...(detail.story.linkStories ?? []),
            ...local,
          ]),
        ].filter(
          (target) =>
            target !== id && Number.isSafeInteger(target) && target > 0,
        );
      },
    );
    if (!related) return undefined;
    const rows = await Promise.all(
      related.map((target) =>
        read(gaps, "story:" + target, async () => {
          const story = await getStoryDetail(client, target);
          if (story.id !== target)
            throw new BztError(
              "ZENTAO_SCHEMA_MISMATCH",
              "关联需求与请求不一致。",
            );
          return { ...story, relation: "derives" };
        }),
      ),
    );
    return rows.every((row) => row !== undefined) ? rows : undefined;
  }

  private async readStoryRoles(id: number, gaps: Gaps) {
    const repository = this.options.store?.storyRoles;
    if (!repository) return undefined;
    return read(gaps, `storyRoles:${id}`, () => {
      try {
        return repository.get(id);
      } catch (error) {
        if (error instanceof BztError && error.code === "NOT_FOUND")
          return undefined;
        throw error;
      }
    });
  }

  private async resolveScope(
    scope: ScanWorkflowRisksInput["scope"],
    gaps: Gaps,
  ) {
    const details = z.object({
      completeness: z.literal("partial"),
      gaps: z.array(z.object({ source: z.string(), reason: z.string() })),
    });
    try {
      const result = await this.directory.resolveContext({
        product: scope.product,
        module: scope.module,
      });
      gaps.push(...result.gaps);
      return result.data;
    } catch (error) {
      if (!(error instanceof BztError) || error.code === "AMBIGUOUS_ENTITY")
        throw error;
      const partial = details.safeParse(error.details);
      if (!partial.success) throw error;
      gaps.push(...partial.data.gaps);
      return undefined;
    }
  }

  private async waivers(
    type: ObjectType,
    id: number,
    gaps: Gaps,
    actions?: StoryDetail["actions"],
  ): Promise<Waiver[]> {
    const { store } = this.options;
    const byRule = new Map<Waiver["ruleId"], Waiver>();
    const local = await read(
      gaps,
      "waivers:" + type + ":" + id,
      () => store?.waivers?.listByObject(type, String(id)) ?? [],
    );
    for (const { ruleId, approvedBy, reason } of local ?? []) {
      const rule = registered.get(ruleId);
      if (rule)
        byRule.set(rule, {
          ruleId: rule,
          objectType: type,
          objectId: id,
          by: approvedBy,
          reason,
        });
    }
    const source = `waivers:${type}:${id}`;
    const cached = store
      ? await read(gaps, source, () => store.cache.get(`risk:${source}`))
      : undefined;
    if (cached !== undefined) {
      try {
        const rows = waiverRows.parse(JSON.parse(cached));
        for (const row of rows)
          byRule.set(row.ruleId, { ...row, objectType: type, objectId: id });
      } catch {
        gaps.push({ source, reason: "本地规则豁免记录格式无效。" });
      }
    }
    // docs/04 §2、docs/07 §4.7：只接受登记人自己发布的结构化豁免。
    const approvers = this.options.config.roles.PM ?? [];
    const comments = [...(actions ?? [])].sort(
      (a, b) => (a.date ?? 0) - (b.date ?? 0) || a.id - b.id,
    );
    for (const { action, actor, comment } of comments) {
      if (action.toLowerCase() !== "commented" || !actor || !comment) continue;
      const match =
        /^\[bzt:waiver v1\]\s+rule=(R0[1-5])\s+\|\s+approvedBy=([^\s|]+)\s+\|\s+reason=(\S[^\r\n]*)$/u.exec(
          comment.trim(),
        );
      if (!match || match[2] !== actor || !approvers.includes(actor)) continue;
      const [row] = waiverRows.parse([
        { ruleId: match[1], by: match[2], reason: match[3] },
      ]);
      if (row)
        byRule.set(row.ruleId, { ...row, objectType: type, objectId: id });
    }
    return [...byRule.values()];
  }
}
