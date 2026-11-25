import { featureProgress } from "../domain/progress.ts";
import { summarizeStages, type Stage } from "../domain/stage.ts";
import {
  isActiveFeature,
  latestRecordedTime,
  knownStageCompletion,
  storyBugs,
  storyTasks,
  workdayGap,
} from "./p2-evidence.ts";
import type { RiskHit, RuleContext, RuleInput } from "./types.ts";

export const id = "R09";
export const name = "应关未关";

const featureStages = [
  "dev",
  "interface",
  "test",
  "acceptance",
  "delivery",
] as const satisfies readonly Stage[];

// docs/04 §4.4、§5 R09。以业务进展判定，关闭阻塞解除的时间也计入起点。
export function evaluate(input: RuleInput, context: RuleContext): RiskHit[] {
  const { story, tasksComplete, required } = input;
  if (!isActiveFeature(story)) return [];
  const tasks = storyTasks(input.tasks, story.id);
  const summary = summarizeStages(tasks);
  const bugs = storyBugs(input.bugs, story.id);
  if (
    featureProgress({ ...story, ...summary, tasksComplete, required, bugs })
      .progress !== "可关闭"
  )
    return [];

  const stageDates = featureStages
    .filter((stage) => summary.stages[stage]?.status === "completed")
    .map(knownStageCompletion(tasks));
  const bugDates =
    bugs
      ?.filter((bug) => bug.severity === 1 || bug.severity === 2)
      .map((bug) => bug.closedDate) ?? [];
  const threshold = context.thresholds?.R09?.after ?? {
    workdays: 5,
    source: "default",
  };
  return [
    {
      ruleId: id,
      objectType: "story",
      objectId: story.id,
      severity: "low",
      confidence: "inferred",
      ...workdayGap(
        latestRecordedTime([...stageDates, ...bugDates]),
        context,
        threshold,
        ["需求业务进展已达到可关闭"],
      ),
      suggestion: "请状态维护人核对验收和交付记录并收尾。",
    },
  ];
}
