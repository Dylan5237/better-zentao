import { featureProgress } from "../domain/progress.ts";
import { summarizeStages } from "../domain/stage.ts";
import {
  elapsedWorkdays,
  type RiskHit,
  type RuleContext,
  type StageInput,
} from "./types.ts";

interface Input extends StageInput {
  readonly handoffAt?: number | null;
}

export const id = "R03";
export const name = "接收超时";

// docs/04 §5 R03、§4.4。handoffAt 来自激活或指派研发主管的动作记录。
export function evaluate(
  { story, tasks = [], tasksComplete, handoffAt }: Input,
  context: RuleContext,
): RiskHit[] {
  if (
    story?.category !== "feature" ||
    story.deleted ||
    story.status !== "active" ||
    handoffAt == null
  )
    return [];
  const progress = featureProgress({
    ...story,
    ...summarizeStages(tasks),
    tasksComplete,
  });
  if (progress.progress !== "待接收") return [];

  const threshold = context.thresholds?.R03?.after ?? {
    workdays: 3,
    source: "default",
  };
  const { since, workdays } = elapsedWorkdays(handoffAt, context);
  if (workdays <= threshold.workdays) return [];

  return [
    {
      ruleId: id,
      objectType: "story",
      objectId: story.id,
      state: "stalled",
      severity: "medium",
      confidence: "recorded",
      since,
      threshold,
      evidence: ["移交后仍处于待接收，已超过接收时限"],
      suggestion: "请接收的研发主管完成需求拆解。",
    },
  ];
}
