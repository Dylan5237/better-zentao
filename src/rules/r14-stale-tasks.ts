import { civilDate, deadlineEndOfDayMs } from "../core/calendar.ts";
import { featureProgress } from "../domain/progress.ts";
import { summarizeStages } from "../domain/stage.ts";
import { localDate, storyBugs, storyTasks } from "./p2-evidence.ts";
import type { RiskHit, RuleContext, RuleInput, RuleTask } from "./types.ts";

export const id = "R14";
export const name = "历史任务待清理";

const evidenceByClass = {
  A: "A 类：已完成的任务关联已完成或已关闭的需求",
  B: "B 类：未完成的任务关联已关闭的需求",
  C: "C 类：任务没有关联需求",
};

// docs/03 N14、docs/04 §5 R14。只列仍需核对的任务，按业务时区的自然日计算。
export function evaluate(input: RuleInput, context: RuleContext): RiskHit[] {
  const { story, tasks = [], required, tasksComplete } = input;
  const closed = !story?.deleted && story?.status === "closed";
  const completed =
    closed ||
    (story?.category === "feature" &&
      !story.deleted &&
      featureProgress({
        ...story,
        ...summarizeStages(storyTasks(tasks, story.id)),
        required,
        tasksComplete,
        bugs: storyBugs(input.bugs, story.id),
      }).progress === "可关闭");
  const threshold = context.thresholds?.R14?.olderThanDays ?? {
    days: 30,
    unit: "calendarDays",
    source: "default",
  };
  const hits: RiskHit[] = [];
  for (const task of tasks) {
    if (task.deleted || task.status === "closed" || task.status === "cancel")
      continue;
    let cleanupClass: RiskHit["cleanupClass"];
    if (task.story === null) cleanupClass = "C";
    else if (story && task.story === story.id) {
      if (task.status === "done" && completed) cleanupClass = "A";
      if (task.status !== "done" && closed) cleanupClass = "B";
    }
    if (!cleanupClass) continue;

    const since = ageStart(task, context);
    if (since !== null) {
      // 两个日期已经转换到业务时区，用 UTC 求公历日差以排除夏令时影响。
      const elapsed =
        (deadlineEndOfDayMs(context.today, "UTC") -
          deadlineEndOfDayMs(since, "UTC")) /
        86_400_000;
      if (elapsed <= threshold.days) continue;
    }
    hits.push({
      ruleId: id,
      objectType: "task",
      objectId: task.id,
      severity: "low",
      confidence: "recorded",
      cleanupClass,
      state: since === null ? "gap" : "stalled",
      since,
      threshold,
      evidence:
        since === null
          ? [evidenceByClass[cleanupClass], "起点未知"]
          : [evidenceByClass[cleanupClass]],
      suggestion:
        cleanupClass === "C"
          ? "请先确认任务归属。"
          : "请核对任务状态和清理条件。",
    });
  }
  return hits;
}

function ageStart(task: RuleTask, context: RuleContext) {
  const lastActivity = localDate(
    task.lastEditedDate ?? task.finishedDate ?? task.openedDate,
    context,
  );
  const carriedSince = civilDate.safeParse(task.carriedSince).data;
  if (carriedSince && (lastActivity === null || carriedSince < lastActivity))
    return carriedSince;
  return lastActivity;
}
