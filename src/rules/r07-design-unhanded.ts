import { summarizeStages } from "../domain/stage.ts";
import {
  latestRecordedTime,
  knownStageCompletion,
  storyTasks,
  workdayGap,
} from "./p2-evidence.ts";
import type { RiskHit, RuleContext, RuleInput } from "./types.ts";

export const id = "R07";
export const name = "设计完成未移交";

// docs/03 N06、docs/04 §4.5、§5 R07。评审与传递完成后检查研发需求关联。
export function evaluate(input: RuleInput, context: RuleContext): RiskHit[] {
  const { story, linkedStories } = input;
  if (
    story?.category !== "design" ||
    story.deleted ||
    input.tasksComplete === false ||
    !linkedStories
  )
    return [];
  const tasks = storyTasks(input.tasks, story.id);
  const {
    stages: { review, handoff },
  } = summarizeStages(tasks);
  if (review?.status !== "completed" || handoff?.status !== "completed")
    return [];
  if (
    linkedStories.some(
      (link) =>
        link.category === "feature" &&
        !link.deleted &&
        (link.relation === "derives" || link.relation === "pairs"),
    )
  )
    return [];

  const threshold = context.thresholds?.R07?.after ?? {
    workdays: 2,
    source: "default",
  };
  const finishedAt = knownStageCompletion(tasks);
  return [
    {
      ruleId: id,
      objectType: "story",
      objectId: story.id,
      severity: "medium",
      confidence: "inferred",
      ...workdayGap(
        latestRecordedTime([finishedAt("review"), finishedAt("handoff")]),
        context,
        threshold,
        ["设计评审与传递已完成，缺少关联的研发需求"],
      ),
      suggestion: "请确认是否已创建研发需求并补齐移交关系。",
    },
  ];
}
