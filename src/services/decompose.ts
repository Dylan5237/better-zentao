import { assertCapabilityExecutable } from "../api/capabilities.ts";
import type { ZentaoReadClient } from "../api/client.ts";
import { listExecutionsIncludingClosed } from "../api/execution.ts";
import { listProducts } from "../api/product.ts";
import { getStoryDetail } from "../api/story.ts";
import { getTaskDetail, listExecutionTasks } from "../api/task.ts";
import {
  getTaskExecutionTeam,
  getTaskProjectProducts,
} from "../api/task-write.ts";
import type {
  OperationResult,
  OperationStep,
  PreparedOperation,
} from "../contracts/operation.ts";
import { decomposeStoriesInputSchema } from "../contracts/tools/decompose_stories.ts";
import { createWorkCalendar, formatLocalDate } from "../core/calendar.ts";
import { normalizeZentaoBaseUrl } from "../core/base-url.ts";
import type { Clock } from "../core/clock.ts";
import type { TeamConfig } from "../core/config.ts";
import type { Execution } from "../core/dto/execution.ts";
import type { StoryDetail } from "../core/dto/story.ts";
import type { Task, TaskDetail } from "../core/dto/task.ts";
import { BztError } from "../core/errors.ts";
import { planStageDates } from "../domain/schedule.ts";
import { detectStage, type Stage } from "../domain/stage.ts";
import { isCancelledTask } from "../domain/task.ts";
import type { DirectoryService } from "./directory.ts";
import type { OperationExecutor } from "./operation.ts";

type Options = {
  readonly client: ZentaoReadClient;
  readonly directory: Pick<DirectoryService, "resolveContext">;
  readonly executor: Pick<OperationExecutor, "prepare">;
  readonly config: TeamConfig;
  readonly clock: Clock;
  readonly baseUrl: string;
  readonly instanceVersion?: string;
  readonly stageRequirements?: {
    listByStory(
      storyId: number,
    ): readonly { stage: string; required: boolean }[];
  };
  readonly storyRoles?: {
    get(storyId: number): { maintainer?: string | null };
  };
};

const design = ["design", "review", "handoff"] satisfies Stage[];
const feature = [
  "dev",
  "interface",
  "test",
  "acceptance",
  "delivery",
] satisfies Stage[];
const taskTypes: Record<Stage, string> = {
  design: "design",
  review: "discuss",
  handoff: "request",
  dev: "devel",
  interface: "devel",
  test: "test",
  acceptance: "test",
  delivery: "affair",
};
const singleAccount = /^[^\s,，、;；]+$/u;
type Field = OperationStep["fields"][string];

function field(
  value: Field["value"],
  origin: Field["origin"] = "derived",
): Field {
  return { value, origin };
}

async function preflight<T>(
  source: string,
  read: () => Promise<T>,
): Promise<T> {
  try {
    return await read();
  } catch (error) {
    if (!(error instanceof BztError)) throw error;
    throw new BztError(error.code, `无法完整读取 ${source}，拆解预检未通过。`, {
      completeness: "partial",
      gaps: [{ source, reason: error.message }],
    });
  }
}

function completeItems<T>({
  items,
  truncated,
}: {
  items: T[];
  truncated: boolean;
}): T[] {
  if (truncated) throw new BztError("ZENTAO_UNAVAILABLE", "分页列表已截断。");
  return items;
}

function executionName(
  naming: TeamConfig["naming"]["execution"],
  product: string,
  kind: "design" | "dev",
  date: string,
): string {
  const values = new Map([
    ["product", product],
    ["kind", naming.kinds[kind]],
    ["yyyy", date.slice(0, 4)],
    ["mm", date.slice(5, 7)],
  ]);
  return naming.pattern.replace(
    /\{(product|kind|yyyy|mm)\}/gu,
    (match, key: string) => values.get(key) ?? match,
  );
}

function existingStages(
  tasks: readonly (Task | TaskDetail)[],
  naming: TeamConfig["naming"],
): Map<Stage, string | null> {
  const stages = new Map<Stage, string | null>();
  const childTitles = new Map<number, string[]>();
  const active = tasks.filter(
    (task) => !task.deleted && !isCancelledTask(task),
  );
  for (const { parent, name } of active) {
    if (parent === null) continue;
    const titles = childTitles.get(parent) ?? [];
    titles.push(name);
    childTitles.set(parent, titles);
  }
  for (const task of active) {
    const { stage, confidence } = detectStage(task, {
      prefixes: naming.taskPrefix,
      childTitles: childTitles.get(task.id),
    });
    const detected =
      confidence === "confirmed"
        ? stage
        : ([...design, ...feature].find((candidate) =>
            naming.legacyTaskPrefixes[candidate]?.some((prefix) =>
              task.name.startsWith(prefix),
            ),
          ) ?? stage);
    if (detected === "unknown") continue;
    const deadline = stages.get(detected) ?? null;
    stages.set(
      detected,
      task.deadline && (!deadline || task.deadline > deadline)
        ? task.deadline
        : deadline,
    );
  }
  return stages;
}

function defaultAssignee(
  story: StoryDetail,
  stage: Stage,
  { config, storyRoles }: Options,
): string | undefined {
  const module = config.modules[`${story.product}:${story.module}`];
  const defaults = config.moduleDefaults[story.product];
  const designLead = module?.designLead ?? defaults?.designLead;
  const testLead = module?.testLead ?? defaults?.testLead;
  const assignees: Partial<Record<Stage, string>> =
    config.stageDefaults.assignees;
  const configured = assignees[stage];
  if (configured === undefined)
    return stage === "design" ? designLead : undefined;
  if (configured === "module.designLead") return designLead;
  if (configured === "team:qa.lead" && testLead) return testLead;
  const team = /^team:(.+)\.lead$/u.exec(configured)?.[1];
  if (team) return config.teams[team]?.lead;
  if (configured !== "story.maintainer") return configured;
  let maintainedBy: string | null | undefined;
  try {
    maintainedBy = storyRoles?.get(story.id).maintainer;
  } catch (error) {
    if (!(error instanceof BztError) || error.code !== "NOT_FOUND") throw error;
  }
  // Trusted local roles and module defaults supply recipients. Free-form spec text does not select a write target.
  return maintainedBy ?? designLead ?? story.openedBy ?? undefined;
}

export class DecomposeService {
  constructor(private readonly options: Options) {}

  async decomposeStories(raw: unknown): Promise<PreparedOperation> {
    const parsed = decomposeStoriesInputSchema.safeParse(raw);
    if (!parsed.success)
      throw new BztError(
        "INVALID_INPUT",
        "请检查拆解模板、人员、日期和任务参数。",
      );
    const input = parsed.data;
    const {
      client,
      config,
      executor,
      clock,
      instanceVersion,
      stageRequirements,
    } = this.options;
    if (
      Object.values(input.assignees ?? {}).some((account) =>
        /[,，、;；]/u.test(account),
      ) ||
      input.subtasks?.some(({ assignTo }) => /[,，、;；]/u.test(assignTo))
    )
      throw new BztError(
        "RULE_VIOLATION",
        "N08 禁止多人任务，请为每个子任务指定一名负责人。",
      );

    if (input.template === "subtasks") {
      if (!input.taskId || !input.subtasks?.length)
        throw new BztError(
          "MISSING_REQUIRED",
          "请提供父任务编号和子任务清单。",
          {
            missing: [
              !input.taskId ? "taskId" : "",
              !input.subtasks?.length ? "subtasks" : "",
            ].filter(Boolean),
          },
        );
      const url = normalizeZentaoBaseUrl(this.options.baseUrl);
      if (!url) throw new BztError("INVALID_INPUT", "禅道实例地址不合法。");
      const taskUrl = new URL(
        `index.php?m=task&f=view&taskID=${input.taskId}`,
        url,
      );
      const details = {
        capability: "task.create",
        links: [{ label: "在禅道打开父任务", url: taskUrl.href }],
      };
      try {
        assertCapabilityExecutable("task.create", {
          channel: "mcp",
          instanceVersion,
        });
      } catch (error) {
        if (!(error instanceof BztError)) throw error;
        throw new BztError(
          error.code,
          "请在禅道父任务中手动创建子任务。",
          details,
        );
      }
      throw new BztError(
        "CAPABILITY_UNVERIFIED",
        "L4 子任务创建尚未通过 #29 验证，请在禅道父任务中手动创建。",
        details,
      );
    }

    const ids = [...new Set(input.storyIds)];
    if (!ids.length)
      throw new BztError("MISSING_REQUIRED", "请提供要拆解的需求编号。", {
        missing: ["storyIds"],
      });
    assertCapabilityExecutable("task.create", {
      channel: "mcp",
      instanceVersion,
    });

    const stories = await Promise.all(
      ids.map((id) =>
        preflight(`story:${id}`, async () => {
          const story = await getStoryDetail(client, id);
          if (story.id !== id || story.deleted)
            throw new BztError("NOT_FOUND", "未找到待拆解需求。");
          return story;
        }),
      ),
    );
    for (const story of stories) {
      if (story.status !== "active")
        throw new BztError(
          "RULE_VIOLATION",
          `需求 #${story.id} 尚未激活，请先通过 handoff_story 激活移交。`,
        );
      const product = config.products[story.product];
      if (product?.enabled === false || product?.probeOnly)
        throw new BztError(
          "PERMISSION_DENIED",
          `产品 #${story.product} 未开放拆解写入。`,
        );
    }
    const executions = await preflight("executions", async () =>
      completeItems(await listExecutionsIncludingClosed(client)),
    );
    const today = formatLocalDate(clock(), config.timezone);
    const calendar = createWorkCalendar(config.calendar);
    const steps: OperationStep[] = [];
    const warnings: PreparedOperation["warnings"] = [];
    const teamWarnings = new Set<string>();
    const affects = new Set<string>();
    const projectReads = new Map<number, Promise<number[]>>();
    const teamReads = new Map<number, Promise<string[]>>();
    const taskReads = new Map<number, Promise<Task[]>>();
    const people = new Map<
      string,
      Awaited<ReturnType<DecomposeService["readPerson"]>>
    >();
    const products =
      input.execution ||
      stories.every(({ product }) => config.products[product])
        ? []
        : await preflight("products", async () =>
            completeItems(await listProducts(client)),
          );

    for (const story of stories) {
      const { id, product, module } = story;
      const category =
        input.template === "next_stage" ? story.category : input.template;
      if (category !== "design" && category !== "feature")
        throw new BztError(
          "RULE_VIOLATION",
          `无法确定需求 #${id} 的阶段类别，请指定拆解模板。`,
        );
      const kind = category === "design" ? "design" : "dev";
      const productName =
        config.products[product]?.name ??
        products.find((item) => item.id === product && !item.deleted)?.name;
      if (!input.execution && !productName)
        throw new BztError(
          "NOT_FOUND",
          `找不到产品 #${product} 的名称，无法按月匹配执行。`,
        );
      const query =
        input.execution ??
        executionName(config.naming.execution, productName ?? "", kind, today);
      const execution = await this.selectExecution(
        executions,
        projectReads,
        product,
        query,
        input.execution !== undefined,
      );
      const executionIds = new Set([
        execution.id,
        ...story.executions.map(({ id }) => id),
      ]);
      const taskLists = await Promise.all(
        [...executionIds].map((id) => {
          const existing = taskReads.get(id);
          if (existing) return existing;
          const loading = preflight(`tasks:${id}`, async () => {
            const tasks = completeItems(await listExecutionTasks(client, id));
            if (tasks.some(({ execution }) => execution !== id))
              throw new BztError(
                "ZENTAO_SCHEMA_MISMATCH",
                "执行任务列表含有归属不匹配的任务。",
              );
            return tasks;
          });
          taskReads.set(id, loading);
          return loading;
        }),
      );
      const tasks = new Map<number, Task | TaskDetail>(
        taskLists
          .flat()
          .filter(({ story }) => story === id)
          .map((task) => [task.id, task]),
      );
      // The story task index can include tasks omitted by a historical execution list.
      for (const item of story.tasks ?? []) {
        if (tasks.has(item.id)) continue;
        const task = await preflight(`task:${item.id}`, async () => {
          const task = await getTaskDetail(client, item.id);
          if (task.id !== item.id || task.story !== id)
            throw new BztError(
              "ZENTAO_SCHEMA_MISMATCH",
              "任务与需求的关联无法确认。",
            );
          return task;
        });
        tasks.set(task.id, task);
      }

      const existing = existingStages([...tasks.values()], config.naming);
      const overrides = new Map(
        stageRequirements
          ?.listByStory(id)
          .map(({ stage, required }) => [stage, required]),
      );
      const stageList = category === "design" ? design : feature;
      const defaults: Partial<Record<Stage, { required: boolean }>> =
        config.stageDefaults[category];
      const stages = stageList.filter(
        (stage) =>
          !existing.has(stage) &&
          (overrides.get(stage) ??
            (stage === "interface" || stage === "delivery"
              ? input.include?.[stage]
              : undefined) ??
            defaults[stage]?.required),
      );
      if (!stages.length) {
        warnings.push({
          code: "NO_MISSING_STAGES",
          message: `需求 #${id} 没有需要补建的阶段任务。`,
        });
        continue;
      }
      if (module == null)
        throw new BztError(
          "MISSING_REQUIRED",
          `需求 #${id} 缺少创建任务所需的模块。`,
          { missing: ["module"] },
        );

      const begin = execution.begin;
      const end = execution.end;
      if (!begin || !end || begin > end)
        throw new BztError(
          "RULE_VIOLATION",
          `执行 #${execution.id} 缺少有效的起止日期。`,
        );
      const dateInputs = { ...input.dates };
      for (const [stage, deadline] of existing) {
        if (deadline && dateInputs[stage]?.deadline === undefined)
          dateInputs[stage] = { ...dateInputs[stage], deadline };
      }
      const planned = planStageDates(
        category,
        config.stageDefaults,
        today < begin ? begin : today,
        calendar,
        dateInputs,
      );
      const cacheKeys = [
        `story:${id}`,
        `stories:${product}`,
        `tasks:${execution.id}`,
      ];
      const executionField = field(
        execution.id,
        input.execution === String(execution.id) ? "user" : "derived",
      );
      if (!story.executions.some(({ id }) => id === execution.id))
        steps.push({
          action: "story.linkExecution",
          type: "story",
          id,
          product,
          cacheKeys,
          fields: { execution: executionField, story: field(id, "user") },
        });

      let team = teamReads.get(execution.id);
      if (!team) {
        team = preflight(`execution:${execution.id}:team`, () =>
          getTaskExecutionTeam(client, execution.id),
        );
        teamReads.set(execution.id, team);
      }
      const members = await team;
      for (const stage of stages) {
        const dates = planned[stage];
        if (
          !dates ||
          dates.estStarted.value < begin ||
          dates.deadline.value > end ||
          dates.estStarted.value > dates.deadline.value
        )
          throw new BztError(
            "RULE_VIOLATION",
            `需求 #${id} 的 ${stage} 排期超出执行 #${execution.id} 的日期范围或起止顺序不合法，请指定计划日期。`,
          );
        const explicit = input.assignees?.[stage];
        const assignee =
          explicit ?? defaultAssignee(story, stage, this.options);
        if (!assignee)
          throw new BztError(
            "MISSING_REQUIRED",
            `请指定需求 #${id} 的 ${stage} 阶段负责人。`,
            { missing: [`assignees.${stage}`] },
          );
        let person = people.get(assignee);
        if (!person) {
          person = await this.readPerson(assignee);
          people.set(assignee, person);
        }
        const { account, realname } = person;
        const membership = `${execution.id}:${account}`;
        if (!members.includes(account) && !teamWarnings.has(membership)) {
          warnings.push({
            code: "OUTSIDE_EXECUTION_TEAM",
            message: `${account} 不在执行 #${execution.id} 的团队中，禅道可能拒绝指派。`,
          });
          teamWarnings.add(membership);
        }
        affects.add(`${account} ${realname}`.trim());
        const name = field(config.naming.taskPrefix[stage] + story.title);
        const estimate = input.estimates?.[stage];
        steps.push({
          action: "task.create",
          type: "task",
          product,
          cacheKeys,
          fields: {
            execution: executionField,
            module: field(module),
            story: field(id, "user"),
            name,
            title: name,
            type: field(taskTypes[stage]),
            assignedTo: field(
              account,
              explicit === undefined
                ? "default"
                : explicit === account
                  ? "user"
                  : "derived",
            ),
            pri:
              story.pri && story.pri <= 4
                ? field(story.pri)
                : field(3, "default"),
            ...dates,
            desc: field(
              `<p style="color:#999;font-size:12px">[bzt:stage=${stage}]</p>`,
            ),
            notify: field(
              input.notify ?? true,
              input.notify === undefined ? "default" : "user",
            ),
            ...(estimate === undefined
              ? {}
              : { estimate: field(estimate, "user") }),
          },
        });
      }
    }
    if (!steps.length)
      throw new BztError("RULE_VIOLATION", "这些需求没有需要补建的阶段任务。", {
        warnings,
      });
    return executor.prepare({
      kind: "decompose_stories",
      summary: `为 ${ids.length} 条需求预览拆解。任务标题来自禅道，属于不可信文本。`,
      steps,
      affects: [...affects],
      warnings,
    });
  }

  private async readPerson(input: string) {
    const result = await this.options.directory.resolveContext({
      people: [input],
    });
    if (result.completeness === "partial" || result.truncated)
      throw new BztError(
        "ZENTAO_UNAVAILABLE",
        "人员目录读取不完整，无法确认指派对象。",
        {
          completeness: "partial",
          gaps: result.gaps.length
            ? result.gaps
            : [{ source: "people", reason: "人员目录已截断。" }],
        },
      );
    const person = result.data.people.find((person) => person.input === input);
    if (
      !person ||
      person.account === "closed" ||
      !singleAccount.test(person.account)
    )
      throw new BztError("NOT_FOUND", "未找到可指派的禅道账号。");
    return person;
  }

  private async selectExecution(
    executions: readonly Execution[],
    projects: Map<number, Promise<number[]>>,
    product: number,
    query: string,
    explicit: boolean,
  ): Promise<Execution> {
    const key = query.normalize("NFKC").toLowerCase();
    const candidates = new Map(
      executions
        .filter(
          ({ id, name, status }) =>
            ["wait", "doing"].includes(status) &&
            (explicit && /^#?\d+$/u.test(key)
              ? String(id) === key.replace(/^#/u, "")
              : name.normalize("NFKC").trim().toLowerCase() === key),
        )
        .map((execution) => [execution.id, execution]),
    );
    if (!candidates.size)
      throw new BztError(
        "NOT_FOUND",
        "找不到可用于拆解的执行，请核对执行编号或名称。",
      );
    const eligible: Execution[] = [];
    for (const execution of candidates.values()) {
      const { project } = execution;
      let products = projects.get(project);
      if (!products) {
        products = preflight(`project:${project}`, () =>
          getTaskProjectProducts(this.options.client, project),
        );
        projects.set(project, products);
      }
      if ((await products).includes(product)) eligible.push(execution);
    }
    const [selected] = eligible;
    if (!selected)
      throw new BztError(
        "RULE_VIOLATION",
        `目标执行没有可写的项目关联产品 #${product}。`,
      );
    if (eligible.length > 1)
      throw new BztError(
        "AMBIGUOUS_ENTITY",
        "有多个匹配的执行，请指定执行编号。",
        {
          candidates: eligible.map(({ id, name }) => ({ id, name })),
        },
      );
    return selected;
  }
}

// WP-37 can consume these events after confirmation or resume and dedupe by task ID.
export function buildDecomposeNotifications(
  prepared: PreparedOperation,
  result: OperationResult,
) {
  if (
    prepared.kind !== "decompose_stories" ||
    prepared.opId !== result.opId ||
    !["confirmed", "partial"].includes(result.status)
  )
    return [];
  const confirmed = new Map(
    result.steps
      .filter(({ state }) => state === "done")
      .map((step) => [step.seq, step]),
  );
  return prepared.preview.steps.flatMap(({ seq, action, fields }) => {
    const task = confirmed.get(seq);
    const account = fields.assignedTo?.value;
    const storyId = fields.story?.value;
    const name = fields.name?.value;
    if (
      action !== "task.create" ||
      task?.action !== action ||
      task.zentaoId === undefined ||
      !task.url ||
      fields.notify?.value !== true ||
      typeof account !== "string" ||
      typeof storyId !== "number" ||
      typeof name !== "string"
    )
      return [];
    const display = prepared.preview.affects.find((person) =>
      person.startsWith(`${account} `),
    );
    return [
      {
        event: "decompose",
        account,
        realname: display?.slice(account.length + 1) || account,
        storyId,
        taskId: task.zentaoId,
        name,
        url: task.url,
      },
    ];
  });
}
