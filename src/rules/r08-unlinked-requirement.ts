import { workdayGap } from "./p2-evidence.ts";
import type { RiskHit, RuleContext, RuleInput } from "./types.ts";

export const id = "R08";
export const name = "用户需求未关联";

// docs/04 §5 R08。按用户需求的实际创建时间计算未关联时长。
export function evaluate(
  { requirement, linkedStories }: RuleInput,
  context: RuleContext,
): RiskHit[] {
  if (
    !requirement ||
    requirement.deleted ||
    !linkedStories ||
    linkedStories.some((link) => link.category === "feature" && !link.deleted)
  )
    return [];

  const threshold = context.thresholds?.R08?.after ?? {
    workdays: 5,
    source: "default",
  };
  return [
    {
      ruleId: id,
      objectType: "requirement",
      objectId: requirement.id,
      severity: "low",
      confidence: "recorded",
      ...workdayGap(requirement.openedDate, context, threshold, [
        "用户需求未关联研发需求",
      ]),
      suggestion: "请确认是否需要补建或关联研发需求。",
    },
  ];
}
