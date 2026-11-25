import { z } from "zod";
import type { ZentaoReadClient } from "../api/client.ts";
import { listExecutionsIncludingClosed } from "../api/execution.ts";
import { getCurrentUser, listUsers } from "../api/org.ts";
import { listProducts } from "../api/product.ts";
import { getStoryDetail, listProductStories } from "../api/story.ts";
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
import { DirectoryService } from "./directory.ts";

interface RiskOptions {
  readonly client: ZentaoReadClient;
  readonly config: TeamConfig;
  readonly clock: Clock;
  readonly baseUrl: string;
  readonly store?: Pick<LocalStore, "cache"> &
    Partial<Pick<LocalStore, "storyRoles">>;
}

type OutputHit = ScanWorkflowRisksOutput["data"]["hits"][number];
type RuleResult = ReturnType<typeof evaluateRules>;
type Hit = RuleResult["hits"][number] | RuleResult["waived"][number];
type ObjectType = Hit["objectType"];
type Gaps = ScanWorkflowRisksOutput["gaps"];
type Waiver = NonNullable<RuleInput["waivers"]>[number];
const severityOrder = ["info", "low", "medium", "high"] as const;
// WP-32 注册纯规则。巡检的数据采集仍只支持 P1。
const serviceRules = rules.filter(({ id }) => id <= "R05");
const registered = new Set<string>(serviceRules.map(({ id }) => id));
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
    if (!(error instanceof BztError)) throw error;
    gaps.push({ source, reason: `读取失败（${error.code}）。` });
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
    const selected = serviceRules.filter(
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
        timeBasis: "截止日与本地工作日日历；月份按迭代起止日期相交范围。",
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

    const storyRules = selected.some(({ id }) => id !== "R01");
    const overdue = enabled.has("R01");
    const stageRules = enabled.has("R02") || enabled.has("R03");
    const products = product
      ? [product]
      : storyRules
        ? ((await page(gaps, "products", () => listProducts(client)))?.items
            .filter(({ deleted }) => !deleted)
            .map(({ id }) => id) ?? [])
        : [];
    const storyRows = new Map(
      (
        await Promise.all(
          [...new Set(products)].map(async (id) => {
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
    const executions =
      overdue || month
        ? ((
            await page(gaps, "executions", () =>
              listExecutionsIncludingClosed(client),
            )
          )?.items ?? [])
        : [];
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
    const executionIds = new Set(overdue ? monthExecutions : []);
    if (stageRules)
      for (const story of stories)
        if (story.category === "feature" && story.status === "active")
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
      timezone: config.timezone,
      calendar: createWorkCalendar(config.calendar),
      thresholds: {
        R02: {
          missingAfter: threshold(config.rules.R02.missingAfter, 1),
          waitAfter: threshold(config.rules.R02.waitAfter, 2),
        },
        R03: { after: threshold(config.rules.R03.after, 3) },
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
    if (overdue) {
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
    for (const story of stories) {
      const linked = byStory.get(story.id) ?? [];
      if (
        month &&
        !story.executions.some(({ id }) => monthExecutions.has(id)) &&
        !linked.some(({ execution }) => monthExecutions.has(execution))
      )
        continue;
      const relevantTasks =
        stageRules && story.category === "feature" && story.status === "active";
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
      const required = {
        test: config.stageDefaults.feature.test.required,
        interface: config.stageDefaults.feature.interface.required,
      };
      const result = evaluateRules(
        {
          story,
          roles,
          tasks: linked,
          tasksComplete,
          required,
          waivers,
          handoffAt: handoffTime(story, receiver),
        },
        storyContext,
      );
      for (const hit of [...result.hits, ...result.waived])
        evaluated.push({
          hit,
          title: story.title,
          account: story.assignedTo,
          storyId: story.id,
        });
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
            ? `task:${hit.objectId}`
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
