import {
  addWorkdays,
  civilDate,
  deadlineEndOfDayMs,
  type WorkCalendar,
} from "../core/calendar.ts";
import type { Task, TaskDetail } from "../core/dto/task.ts";

interface TimeContext {
  readonly today: string;
  readonly calendar: WorkCalendar;
  readonly timezone?: string;
  readonly dueSoonWorkdays?: number;
}

type TaskTimeStatus =
  "completed" | "unscheduled" | "overdue" | "due_today" | "due_soon" | "normal";

function isFinished(status: Task["status"]): boolean {
  return status === "done" || status === "closed" || status === "cancel";
}

// docs/04 §4.2 终态仍须比较真实完成时间和业务时区的截止时刻。
export function taskTimeStatus(
  task: Pick<Task, "status" | "deadline" | "finishedDate">,
  context: TimeContext,
): { readonly status: TaskTimeStatus; readonly historicallyLate: boolean } {
  const { today, calendar, timezone, dueSoonWorkdays = 3 } = context;
  const deadline = civilDate.safeParse(task.deadline).data;
  if (isFinished(task.status)) {
    const historicallyLate =
      deadline !== undefined &&
      task.finishedDate != null &&
      task.finishedDate > deadlineEndOfDayMs(deadline, timezone);
    return { status: "completed", historicallyLate };
  }
  if (!deadline) return { status: "unscheduled", historicallyLate: false };
  if (today > deadline) return { status: "overdue", historicallyLate: false };
  if (today === deadline)
    return { status: "due_today", historicallyLate: false };
  const soon = deadline <= addWorkdays(today, dueSoonWorkdays, calendar);
  return { status: soon ? "due_soon" : "normal", historicallyLate: false };
}

type TeamMember = Pick<TaskDetail["team"][number], "account" | "status">;
type WorkTask = Pick<
  Task,
  | "id"
  | "parent"
  | "isParent"
  | "status"
  | "deadline"
  | "finishedDate"
  | "mode"
  | "assignedTo"
  | "deleted"
> & { readonly team?: readonly TeamMember[] };

interface WorkContext extends TimeContext {
  readonly directory?: ReadonlyMap<string, string>;
  readonly tasksComplete?: boolean;
}

interface Participant {
  readonly account: string;
  readonly name: string | undefined;
  readonly active: boolean | null;
}

type WorkGap =
  | { readonly kind: "task_list" }
  | { readonly kind: "children" | "team"; readonly taskId: number };

interface LeafWork {
  readonly taskId: number;
  readonly time: ReturnType<typeof taskTimeStatus>;
  readonly participants: readonly Participant[];
}

function taskParticipants(
  task: WorkTask,
  directory?: ReadonlyMap<string, string>,
): Participant[] {
  const participant = (
    account: string,
    active: Participant["active"],
  ): Participant => ({
    account,
    name: directory?.get(account),
    active,
  });
  const finished = isFinished(task.status);
  if (task.mode !== "multi" || !task.team?.length) {
    if (!task.assignedTo) return [];
    return [
      participant(
        task.assignedTo,
        finished ? false : task.mode === "multi" ? null : true,
      ),
    ];
  }
  const members = new Map(
    task.team.map((member) => [member.account, member.status]),
  );
  return [...members].map(([account, status]) =>
    participant(
      account,
      finished ? false : status == null ? null : !isFinished(status),
    ),
  );
}

function childrenFinished(
  parentId: number,
  directChildren: readonly WorkTask[],
  children: ReadonlyMap<number, readonly WorkTask[]>,
): boolean | null {
  const queue = [...directChildren];
  const seen = new Set([parentId]);
  for (const task of queue) {
    if (seen.has(task.id)) return null;
    seen.add(task.id);
    const descendants = children.get(task.id);
    if (descendants) queue.push(...descendants);
    else if (!isFinished(task.status)) return false;
  }
  return true;
}

// docs/04 §4.3 父任务只展示风险，成员状态缺失只保留参与关系。
export function summarizeLeafWork(
  tasks: readonly WorkTask[],
  context: WorkContext,
) {
  const unique = new Map(
    tasks.filter((task) => !task.deleted).map((task) => [task.id, task]),
  );
  const children = new Map<number, WorkTask[]>();
  for (const task of unique.values()) {
    if (task.parent == null) continue;
    const siblings = children.get(task.parent);
    if (siblings) siblings.push(task);
    else children.set(task.parent, [task]);
  }

  const gaps: WorkGap[] = [];
  if (context.tasksComplete === false) gaps.push({ kind: "task_list" });
  const leaves: LeafWork[] = [];
  const overdueParents: number[] = [];

  for (const task of unique.values()) {
    const time = taskTimeStatus(task, context);
    if (task.isParent || children.has(task.id)) {
      if (!children.has(task.id))
        gaps.push({ kind: "children", taskId: task.id });
      if (time.status === "overdue") overdueParents.push(task.id);
      continue;
    }
    const participants = taskParticipants(task, context.directory);
    if (
      task.mode === "multi" &&
      !isFinished(task.status) &&
      (!task.team?.length || participants.some(({ active }) => active === null))
    )
      gaps.push({ kind: "team", taskId: task.id });
    leaves.push({ taskId: task.id, time, participants });
  }

  const treeComplete = gaps.every(({ kind }) => kind === "team");
  const complete = gaps.length === 0;
  const activeCounts = leaves.map(
    ({ participants }) => participants.filter(({ active }) => active).length,
  );
  return {
    completeness: complete ? "complete" : "partial",
    gaps,
    leaves,
    parentRisks: overdueParents.map((taskId) => {
      const directChildren = children.get(taskId);
      return {
        taskId,
        allChildrenFinished:
          directChildren && treeComplete
            ? childrenFinished(taskId, directChildren, children)
            : null,
      };
    }),
    overdueTaskCount: treeComplete
      ? leaves.filter(({ time }) => time.status === "overdue").length
      : null,
    workload: complete
      ? {
          taskCount: activeCounts.filter((count) => count > 0).length,
          assignments: activeCounts.reduce((sum, count) => sum + count, 0),
        }
      : null,
  };
}
