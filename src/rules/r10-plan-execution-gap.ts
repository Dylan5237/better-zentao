import { countWorkdaysBetween, isWorkday } from "../core/calendar.ts";
import { planOverlapDays } from "../domain/month.ts";
import { isActiveFeature } from "./p2-evidence.ts";
import type { RiskHit, RuleContext, RuleInput } from "./types.ts";

export const id = "R10";
export const name = "计划与迭代脱节";

// docs/04 §4.6、§5 R10。当前月从第 N 个工作日起持续检查。
export function evaluate(input: RuleInput, context: RuleContext): RiskHit[] {
  const { story, plan, inMonthL3Plan, inMonthDevExecution } = input;
  const { today, calendar, month = today.slice(0, 7) } = context;
  if (
    !isActiveFeature(story) ||
    inMonthDevExecution !== false ||
    month !== today.slice(0, 7)
  )
    return [];
  const inPlan =
    inMonthL3Plan ?? (plan != null && planOverlapDays(plan, month) > 0);
  if (!inPlan) return [];
  const first = month + "-01";
  const workday =
    context.monthWorkdayIndex ??
    countWorkdaysBetween(first, today, calendar) +
      Number(isWorkday(first, calendar));
  const threshold = context.thresholds?.R10?.fromWorkday ?? {
    workdays: 5,
    source: "default",
  };
  if (workday < threshold.workdays) return [];

  return [
    {
      ruleId: id,
      objectType: "story",
      objectId: story.id,
      state: "gap",
      severity: "medium",
      confidence: "recorded",
      since: null,
      threshold,
      evidence: ["本月 L3 计划中的需求未关联本月研发迭代", "起点未知"],
      suggestion: "请研发主管核对计划范围并补齐迭代关联。",
    },
  ];
}
