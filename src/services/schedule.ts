import type { ZentaoReadClient } from "../api/client.ts";
import { listExecutionsIncludingClosed } from "../api/execution.ts";
import { getCurrentUser } from "../api/org.ts";
import { getTaskDetail, listExecutionTasks } from "../api/task.ts";
import {
  getMemberScheduleInputSchema,
  getMemberScheduleOutputSchema,
  type GetMemberScheduleOutput,
} from "../contracts/tools/get_member_schedule.ts";
import { normalizeZentaoBaseUrl } from "../core/base-url.ts";
import {
  addWorkdays,
  countWorkdaysBetween,
  createWorkCalendar,
  formatLocalDate,
  isWorkday,
  monthDateRange,
  nextWorkday,
  overlapsDateRange,
  type WorkCalendar,
} from "../core/calendar.ts";
import type { Clock } from "../core/clock.ts";
import type { TeamConfig } from "../core/config.ts";
import type { Execution } from "../core/dto/execution.ts";
import type { Task, TaskDetail } from "../core/dto/task.ts";
import { BztError } from "../core/errors.ts";
import { readGapReason } from "./read-gap.ts";
import { summarizeLeafWork } from "../domain/task.ts";
import { DirectoryService } from "./directory.ts";

interface ScheduleOptions {
  readonly client: ZentaoReadClient;
  readonly config: TeamConfig;
  readonly clock: Clock;
  readonly baseUrl: string;
}

type Member = GetMemberScheduleOutput["data"]["members"][number];
type Person = Pick<Member, "account" | "realname">;
type TaskItem = Member["overdue"][number];
type Bucket = Member["buckets"][number];
type ReadState = Pick<GetMemberScheduleOutput, "gaps" | "truncated">;
type DateRange = Pick<Bucket, "start" | "end">;
type Assignment = {
  task: Task;
  execution: Execution;
  left: number | null;
};
type MemberWork = { person: Person; scheduled: Assignment[]; member: Member };

const allDays = createWorkCalendar({ workdays: [1, 2, 3, 4, 5, 6, 7] });
const workBasis = "禅道可见投入（不含禅道外工作）";
const utcTime = new Intl.DateTimeFormat("en-GB", {
  timeZone: "UTC",
  hour: "2-digit",
  minute: "2-digit",
  second: "2-digit",
  fractionalSecondDigits: 3,
  hourCycle: "h23",
});

function compare<T extends number | string>(a: T, b: T): number {
  return a < b ? -1 : a > b ? 1 : 0;
}

function workdaysIn(start: string, end: string, calendar: WorkCalendar) {
  return start > end
    ? 0
    : countWorkdaysBetween(start, end, calendar) +
        Number(isWorkday(start, calendar));
}

async function read<T>(
  state: ReadState,
  source: string,
  load: () => Promise<T>,
) {
  try {
    return await load();
  } catch (error) {
    if (!(error instanceof BztError)) throw error;
    state.gaps.push({ source, reason: readGapReason(source, error) });
    return undefined;
  }
}

async function readRows<T>(
  state: ReadState,
  source: string,
  load: () => Promise<{ items: T[]; truncated: boolean }>,
) {
  const rows = await read(state, source, load);
  if (rows?.truncated) {
    state.truncated = true;
    state.gaps.push({ source, reason: "分页未读完整。" });
  }
  return rows?.items ?? [];
}

async function readInBatches<T, U>(
  items: readonly T[],
  load: (item: T) => Promise<U>,
): Promise<U[]> {
  const results: U[] = [];
  const concurrency = 8;
  for (let index = 0; index < items.length; index += concurrency) {
    results.push(
      ...(await Promise.all(items.slice(index, index + concurrency).map(load))),
    );
  }
  return results;
}

function toTaskItem(
  { task, execution, left }: Assignment,
  person: Person,
  timeState: TaskItem["timeState"],
  today: string,
  calendar: WorkCalendar,
  baseUrl: URL,
): TaskItem {
  const { id, name, status, estStarted, deadline, story, storyTitle } = task;
  return {
    id,
    name,
    status,
    url: new URL(`task-view-${id}.html`, baseUrl).href,
    assignedTo: person,
    estStarted: estStarted ?? undefined,
    deadline: deadline ?? undefined,
    left: left ?? undefined,
    timeState,
    overdueDays:
      timeState === "overdue" && deadline
        ? countWorkdaysBetween(deadline, today, calendar)
        : undefined,
    story:
      story !== null && storyTitle !== undefined
        ? { id: story, title: storyTitle }
        : undefined,
    execution: { id: execution.id, name: execution.name },
    isParent: false,
  };
}

function suggestionFor(
  { person, member, scheduled }: MemberWork,
  estimateHours: number,
  start: string,
  deadline: string,
  calendar: WorkCalendar,
  dailyHours: number,
) {
  const due = [
    ...member.overdue,
    ...scheduled
      .filter(({ task }) => task.deadline !== null && task.deadline <= deadline)
      .map(({ task, left }) => ({ id: task.id, left: left ?? undefined })),
  ];
  const load = due.reduce((total, { left }) => total + (left ?? 0), 0);
  const remaining = workdaysIn(start, deadline, calendar) * dailyHours - load;
  const projectedDeadline = (hours: number) =>
    addWorkdays(start, Math.ceil(hours / dailyHours) - 1, calendar);
  // docs/04 §4.9 截止日前的已知承诺优先占用容量，顺延时也计入新落点覆盖的任务。
  let hours = load + estimateHours;
  let suggestedDeadline = projectedDeadline(hours);
  for (const { task, left } of scheduled) {
    if (!task.deadline || task.deadline <= deadline) continue;
    if (task.deadline > suggestedDeadline) break;
    hours += left ?? 0;
    suggestedDeadline = projectedDeadline(hours);
  }
  const missing = due.filter(({ left }) => left === undefined).length;
  const tasks = due.map(({ id }) => `#${id}`).join("、") || "无";
  const reason = [
    `截至 ${deadline}，已知剩余容量 ${remaining} 小时，逾期 ${member.overdue.length} 项。`,
    `截止日前的任务（含逾期）：${tasks}。`,
    missing ? `其中缺工时 ${missing} 项。` : "",
    remaining < estimateHours
      ? `期望截止日前容量不足，按已知工时建议顺延至 ${suggestedDeadline}。`
      : "",
  ].join("");
  return {
    remaining,
    overdueCount: member.overdue.length,
    suggestion: { ...person, suggestedDeadline, reason },
  };
}

export class ScheduleService {
  private readonly directory: DirectoryService;

  constructor(private readonly options: ScheduleOptions) {
    this.directory = new DirectoryService(options);
  }

  async getMemberSchedule(
    raw: unknown,
    month?: string,
  ): Promise<GetMemberScheduleOutput> {
    const parsed = getMemberScheduleInputSchema.safeParse(raw);
    if (!parsed.success)
      throw new BztError(
        "INVALID_INPUT",
        "排期参数不合法，请检查成员、周数和任务日期。",
      );
    const input = parsed.data;
    const { config, clock } = this.options;
    const baseUrl = normalizeZentaoBaseUrl(this.options.baseUrl);
    if (!baseUrl) throw new BztError("INVALID_INPUT", "禅道地址不合法。");
    const now = clock();
    const today = formatLocalDate(now, config.timezone);
    const calendar = createWorkCalendar(config.calendar);
    const weeks = input.weeks ?? config.schedule.weeks;
    const period = month ? monthDateRange(month) : undefined;
    const start = period?.start ?? today;
    const end = period?.end ?? addWorkdays(today, weeks * 7 - 1, allDays);
    const dayCount = workdaysIn(start, end, allDays);
    const width = input.bucket === "week" ? 7 : 1;
    const ranges: DateRange[] = Array.from(
      { length: Math.ceil(dayCount / width) },
      (_, index) => ({
        start: addWorkdays(start, index * width, allDays),
        end: addWorkdays(
          start,
          Math.min(index * width + width, dayCount) - 1,
          allDays,
        ),
      }),
    );
    const newTask = input.newTask;
    const earliest =
      newTask?.earliestStart && newTask.earliestStart > today
        ? newTask.earliestStart
        : today;
    const deadline = newTask?.deadline ?? (end < earliest ? earliest : end);
    if (newTask && deadline < earliest)
      throw new BztError("INVALID_INPUT", "期望截止日不能早于可开始日期。");

    const state: ReadState = { gaps: [] };
    const { people, team } = await this.resolvePeople(input.members, state);
    const hints: string[] = [];
    const matrix = people.length
      ? await this.matrix(
          people,
          today,
          end,
          ranges,
          width,
          calendar,
          baseUrl,
          state,
          hints,
          period,
        )
      : [];
    const hasMissingHours = matrix.some(
      ({ member }) =>
        member.buckets.some(({ missingEstimate }) => missingEstimate > 0) ||
        [...member.overdue, ...member.unscheduled].some(
          ({ left }) => left === undefined,
        ),
    );
    if (hasMissingHours)
      hints.push("缺工时的任务已计入任务数，容量只扣除已知剩余工时。");
    if (matrix.some(({ member }) => member.unscheduled.length))
      hints.push("未排期任务单列，未扣减日期范围内的容量。");
    if (newTask?.skills?.length)
      hints.push("现有人员目录未记录技能，请人工核对技能要求。");
    if (state.gaps.length)
      hints.push("读取不完整，排期和容量仅反映已读取的数据。");
    if (newTask && state.gaps.length) hints.push("数据补齐后可生成指派建议。");
    if (newTask && period && period.end < today)
      hints.push("所选月份已结束，切换至当前或未来月份可查看指派建议。");
    const suggestions =
      newTask && !state.gaps.length && (!period || period.end >= today)
        ? matrix
            .map((work) =>
              suggestionFor(
                work,
                newTask.estimateHours,
                nextWorkday(earliest, calendar),
                deadline,
                calendar,
                config.schedule.dailyHours,
              ),
            )
            .sort(
              (a, b) =>
                compare(b.remaining, a.remaining) ||
                compare(a.overdueCount, b.overdueCount) ||
                compare(a.suggestion.account, b.suggestion.account),
            )
            .slice(0, Math.min(3, config.schedule.suggestTop))
            .map(({ suggestion }) => suggestion)
        : undefined;
    const output = getMemberScheduleOutputSchema.safeParse({
      ok: true,
      data: {
        members: matrix.map(({ member }) => member),
        ...(suggestions && { suggestions }),
      },
      scope: {
        asOf: `${formatLocalDate(now, "UTC")}T${utcTime.format(now)}Z`,
        filters: {
          ...input,
          ...(month ? { month } : { weeks }),
          start,
          end,
          ...(team && { team }),
        },
        timeBasis: `按业务时区（${config.timezone}）的截止日期分桶，容量按工作日日历计算。缺工时仅计任务数。${workBasis}。`,
      },
      completeness: state.gaps.length ? "partial" : "complete",
      ...state,
      inferences: suggestions?.length
        ? [
            {
              field: "suggestions",
              level: "inferred",
              basis: "按工作日日历、已知剩余工时和逾期任务数估算。",
            },
          ]
        : [],
      hints,
    });
    if (!output.success)
      throw new BztError("ZENTAO_SCHEMA_MISMATCH", "排期结果不符合工具契约。");
    return output.data;
  }

  private async resolvePeople(inputs: string[] | undefined, state: ReadState) {
    const { config, client } = this.options;
    let team: string | undefined;
    if (!inputs) {
      const me = await read(state, "me", () => getCurrentUser(client));
      if (!me) return { people: [] };
      if (!me.account) {
        state.gaps.push({ source: "me", reason: "当前禅道用户缺少账号。" });
        return { people: [] };
      }
      const teams = Object.entries(config.teams).filter(
        ([, { lead, members }]) =>
          lead === me.account || members.includes(me.account),
      );
      if (teams.length > 1)
        throw new BztError(
          "AMBIGUOUS_ENTITY",
          "当前用户属于多个团队，请明确指定成员。",
          {
            candidates: teams.map(([id, { name }]) => ({ id, name })),
          },
        );
      const match = teams[0];
      if (!match)
        throw new BztError(
          "CONFIG_MISSING",
          "当前用户未配置所属团队，请指定成员。",
        );
      const [id, { lead, members }] = match;
      team = id;
      inputs = [lead, ...members];
    }
    let directory;
    try {
      directory = await this.directory.resolveContext({
        people: [...new Set(inputs)],
      });
    } catch (error) {
      if (
        !(error instanceof BztError) ||
        error.details?.completeness !== "partial" ||
        error.details.field !== undefined
      )
        throw error;
      state.gaps.push({
        source: "me",
        reason: `无法确认当前用户（${error.code}）。`,
      });
      return { people: [], team };
    }
    state.gaps.push(...directory.gaps);
    if (directory.truncated) state.truncated = true;
    const unique = new Map(
      directory.data.people.map(({ account, realname }) => [
        account,
        { account, realname },
      ]),
    );
    const people = [...unique.values()].sort((a, b) =>
      compare(a.account, b.account),
    );
    return { people, team };
  }

  private async matrix(
    people: Person[],
    today: string,
    end: string,
    ranges: DateRange[],
    width: number,
    calendar: WorkCalendar,
    baseUrl: URL,
    state: ReadState,
    hints: string[],
    period?: DateRange,
  ): Promise<MemberWork[]> {
    const { client, config } = this.options;
    const executions = await readRows(state, "executions", () =>
      listExecutionsIncludingClosed(client),
    );
    const uniqueExecutions = new Map(
      executions
        .filter(
          ({ begin, end }) => !period || overlapsDateRange(period, begin, end),
        )
        .map((execution) => [execution.id, execution]),
    );
    const lists = await readInBatches(
      [...uniqueExecutions.values()],
      async (execution) => {
        const items = await readRows(state, `tasks:${execution.id}`, () =>
          listExecutionTasks(client, execution.id),
        );
        return items.map((task) => ({ task, execution }));
      },
    );
    const rows = new Map(
      lists
        .flat()
        .filter(({ task }) => !task.deleted)
        .map((row) => [row.task.id, row]),
    );
    const tasks = [...rows.values()].map(({ task }) => task);
    const inPeriod = (taskId: number) => {
      const task = rows.get(taskId)?.task;
      return Boolean(
        task &&
        (!period ||
          overlapsDateRange(
            period,
            task.estStarted ?? task.deadline,
            task.deadline ?? task.estStarted,
          )),
      );
    };
    const context = { today, calendar, timezone: config.timezone };
    const leafWork = summarizeLeafWork(tasks, context);
    const teams = new Map<number, TaskDetail["team"]>();
    const multiIds = leafWork.leaves.filter(
      ({ taskId, time }) =>
        time.status !== "completed" &&
        inPeriod(taskId) &&
        rows.get(taskId)?.task.mode === "multi",
    );
    await readInBatches(multiIds, async ({ taskId }) => {
      const detail = await read(state, `task:${taskId}:detail`, () =>
        getTaskDetail(client, taskId),
      );
      if (detail?.id === taskId) teams.set(taskId, detail.team);
    });
    const summary = multiIds.length
      ? summarizeLeafWork(
          tasks.map((task) => ({ ...task, team: teams.get(task.id) })),
          context,
        )
      : leafWork;
    for (const gap of summary.gaps) {
      if (!("taskId" in gap) || !inPeriod(gap.taskId)) continue;
      if (gap.kind === "children")
        state.gaps.push({
          source: `task:${gap.taskId}:children`,
          reason: "父任务缺少子任务记录。",
        });
      if (gap.kind === "team")
        state.gaps.push({
          source: `task:${gap.taskId}:team`,
          reason: "多人任务成员或状态不完整。",
        });
    }
    const accounts = new Set(people.map(({ account }) => account));
    const overdueParents = summary.parentRisks.filter(
      ({ taskId }) =>
        inPeriod(taskId) &&
        accounts.has(rows.get(taskId)?.task.assignedTo ?? ""),
    );
    if (overdueParents.length)
      hints.push(
        `父级风险：${overdueParents
          .map(({ taskId }) => `#${taskId}`)
          .sort()
          .join("、")}。`,
      );

    const capacityHours =
      workdaysIn(period?.start ?? today, end, calendar) *
      config.schedule.dailyHours;
    const work = new Map<string, MemberWork>(
      people.map((person) => [
        person.account,
        {
          person,
          scheduled: [],
          member: {
            ...person,
            capacityHours,
            buckets: ranges.map((range) => ({
              ...range,
              leftHours: 0,
              taskCount: 0,
              missingEstimate: 0,
            })),
            overdue: [],
            unscheduled: [],
          },
        },
      ]),
    );
    const leaves = summary.leaves.sort((a, b) => a.taskId - b.taskId);
    for (const { taskId, time, participants } of leaves) {
      const row = rows.get(taskId);
      if (!row || !inPeriod(taskId) || time.status === "completed") continue;
      for (const { account, active } of participants) {
        const item = work.get(account);
        if (item && active === null)
          hints.push(`多人任务 #${taskId}：${account} 的参与状态待确认。`);
        if (item && active)
          this.addAssignment(
            row,
            item,
            teams.get(taskId),
            time.status,
            today,
            width,
            calendar,
            baseUrl,
            period?.start ?? today,
          );
      }
    }
    for (const { member, scheduled } of work.values()) {
      scheduled.sort(
        (a, b) =>
          compare(a.task.deadline ?? "", b.task.deadline ?? "") ||
          a.task.id - b.task.id,
      );
      member.capacityHours -= member.buckets.reduce(
        (total, { leftHours }) => total + leftHours,
        0,
      );
    }
    state.gaps.sort(
      (a, b) => compare(a.source, b.source) || compare(a.reason, b.reason),
    );
    return [...work.values()];
  }

  private addAssignment(
    row: Omit<Assignment, "left">,
    { person, member, scheduled }: MemberWork,
    team: TaskDetail["team"] | undefined,
    status: string,
    today: string,
    width: number,
    calendar: WorkCalendar,
    baseUrl: URL,
    start: string,
  ) {
    const { task } = row;
    const left =
      task.mode === "multi"
        ? (team?.findLast(({ account }) => account === person.account)?.left ??
          null)
        : task.left;
    const assignment = { ...row, left };
    if (status === "overdue" || status === "unscheduled") {
      member[status].push(
        toTaskItem(assignment, person, status, today, calendar, baseUrl),
      );
      return;
    }
    if (!task.deadline || task.deadline < start) return;
    scheduled.push(assignment);
    const index = Math.floor(
      countWorkdaysBetween(start, task.deadline, allDays) / width,
    );
    const bucket = member.buckets[index];
    if (!bucket) return;
    bucket.taskCount++;
    if (left === null) bucket.missingEstimate++;
    else bucket.leftHours += left;
  }
}
