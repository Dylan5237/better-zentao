import { detectStage, summarizeStages } from "../domain/stage.ts";
import {
  isActiveFeature,
  knownStageCompletion,
  storyTasks,
  workdayGap,
} from "./p2-evidence.ts";
import type { RiskHit, RuleContext, RuleInput } from "./types.ts";

export const id = "R11";
export const name = "测试后缺验收或交付";

// docs/04 §3.1、§5 R11。以测试实际完成时间起算，已有下游任务不计缺失。
export function evaluate(input: RuleInput, context: RuleContext): RiskHit[] {
  const { story, required, tasksComplete } = input;
  if (!isActiveFeature(story) || tasksComplete === false) return [];
  const tasks = storyTasks(input.tasks, story.id);
  const {
    stages: { test, acceptance, delivery },
  } = summarizeStages(tasks);
  if (test?.status !== "completed") return [];

  const evidence = ["测试已完成"];
  if (
    required?.acceptance !== false &&
    (!acceptance || acceptance.status === "missing")
  )
    evidence.push("缺少必需的验收任务");
  if (required?.delivery && (!delivery || delivery.status === "missing"))
    evidence.push("缺少必需的交付任务");
  if (evidence.length === 1) return [];

  const inferred = tasks.some((task) => {
    if (task.deleted) return false;
    const detection = detectStage(task, task.evidence);
    return detection.stage === "test" && detection.confidence === "inferred";
  });
  const threshold = context.thresholds?.R11?.after ?? {
    workdays: 1,
    source: "default",
  };
  return [
    {
      ruleId: id,
      objectType: "story",
      objectId: story.id,
      severity: "medium",
      confidence: inferred ? "inferred" : "recorded",
      ...workdayGap(
        knownStageCompletion(tasks)("test"),
        context,
        threshold,
        evidence,
      ),
      suggestion: "请补齐必需的验收或交付任务。",
    },
  ];
}
