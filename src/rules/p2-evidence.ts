import { formatLocalDate } from "../core/calendar.ts";
import { summarizeStages, type Stage } from "../domain/stage.ts";
import { isCancelledTask, isTaskFinished } from "../domain/task.ts";
import {
  elapsedWorkdays,
  type RuleInput,
  type RuleTask,
  type RuleTime,
  type WorkdayThreshold,
} from "./types.ts";

export function localDate(
  timestamp: number | null | undefined,
  context: RuleTime,
) {
  return timestamp == null
    ? null
    : formatLocalDate(timestamp, context.timezone);
}

// docs/04 §5.1 缺少任何必需的完成时间时，不能确定最后一个完成时间。
export function latestRecordedTime(
  dates: readonly (number | null | undefined)[],
) {
  let latest: number | undefined;
  for (const date of dates) {
    if (date == null) return undefined;
    latest = latest === undefined ? date : Math.max(latest, date);
  }
  return latest;
}

// docs/04 §5.1 仅用于确认起点。任何完成叶子缺少日期，该阶段的完成时刻都未知。
export function knownStageCompletion(tasks: readonly RuleTask[]) {
  const { stages } = summarizeStages(
    tasks.map((task) =>
      task.finishedDate == null &&
      isTaskFinished(task.status) &&
      !isCancelledTask(task)
        ? { ...task, status: "doing" as const }
        : task,
    ),
  );
  return (stage: Stage) => {
    const result = stages[stage];
    return result?.status === "completed" ? result.finishedDate : undefined;
  };
}

export function workdayGap(
  timestamp: number | null | undefined,
  context: RuleTime,
  threshold: WorkdayThreshold,
  evidence: readonly string[],
) {
  const elapsed =
    timestamp == null ? null : elapsedWorkdays(timestamp, context);
  return {
    state:
      elapsed !== null && elapsed.workdays > threshold.workdays
        ? ("stalled" as const)
        : ("gap" as const),
    since: elapsed?.since ?? null,
    threshold,
    evidence: elapsed === null ? [...evidence, "起点未知"] : evidence,
  };
}

export function isActiveFeature(
  story: RuleInput["story"],
): story is NonNullable<RuleInput["story"]> {
  return (
    story?.category === "feature" && story.status === "active" && !story.deleted
  );
}

export function storyTasks(tasks: RuleInput["tasks"], storyId: number) {
  // 调用方可传入已按需求归集的任务；有明确归属时排除其他需求的任务。
  return (tasks ?? []).filter(
    (task) => task.story === undefined || task.story === storyId,
  );
}

export function storyBugs(bugs: RuleInput["bugs"], storyId: number) {
  return bugs?.filter((bug) => bug.story === storyId && !bug.deleted);
}
