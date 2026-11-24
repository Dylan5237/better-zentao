import { resolveStoryRoles } from "../domain/roles.ts";
import type { RiskHit, RuleContext, RuleInput, StoryInput } from "./types.ts";

export const id = "R04";
export const name = "未就绪先指派";

// docs/04 §5 R04、§2。状态维护人与当前处理人按领域口径解析。
export function evaluate(
  { story, roles }: StoryInput & Pick<RuleInput, "roles">,
  { developmentAccounts }: Pick<RuleContext, "developmentAccounts">,
): RiskHit[] {
  if (
    !story ||
    story.deleted ||
    (story.status !== "draft" && story.status !== "reviewing")
  )
    return [];
  const { maintainer, currentHandler } = resolveStoryRoles({ ...roles, story });
  if (
    !currentHandler ||
    currentHandler === maintainer ||
    !developmentAccounts?.has(currentHandler)
  )
    return [];

  return [
    {
      ruleId: id,
      objectType: "story",
      objectId: story.id,
      state: "gap",
      severity: "medium",
      confidence: "recorded",
      since: null,
      evidence: ["需求尚未就绪，当前处理人属于研发侧且不是状态维护人"],
      suggestion: "请先指派给状态维护人，需求激活时再移交研发。",
    },
  ];
}
