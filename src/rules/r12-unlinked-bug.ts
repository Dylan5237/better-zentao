import { localDate } from "./p2-evidence.ts";
import type { RiskHit, RuleContext, RuleInput } from "./types.ts";

export const id = "R12";
export const name = "Bug 未关联";

// docs/03 N11、docs/04 §5 R12。测试期间创建需要调用方提供证据。
export function evaluate(
  { bugs = [] }: RuleInput,
  context: RuleContext,
): RiskHit[] {
  const hits: RiskHit[] = [];
  for (const bug of bugs) {
    if (bug.deleted) continue;
    const evidence: string[] = [];
    if (!bug.story) evidence.push("Bug 未关联需求");
    if (bug.openedDuringTest && !bug.execution)
      evidence.push("测试期间创建的 Bug 未关联执行");
    if (!evidence.length) continue;
    hits.push({
      ruleId: id,
      objectType: "bug",
      objectId: bug.id,
      state: "gap",
      severity: "medium",
      confidence: "recorded",
      since: localDate(bug.openedDate, context),
      evidence,
      suggestion: "请核对 Bug 的研发需求和执行关联。",
    });
  }
  return hits;
}
