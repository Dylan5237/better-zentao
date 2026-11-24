import { countWorkdaysBetween, formatLocalDate } from "../core/calendar.ts";
import type { summarizeLeafWork } from "../domain/task.ts";
import type { summarizeStages } from "../domain/stage.ts";
import type { featureProgress } from "../domain/progress.ts";
import type { resolveStoryRoles } from "../domain/roles.ts";
import type { StoryDetail } from "../core/dto/story.ts";

export type RuleId = "R01" | "R02" | "R03" | "R04" | "R05";

interface Threshold {
  readonly workdays: number;
  readonly source: "default" | "configured";
}

export type RuleTime = Pick<
  Parameters<typeof summarizeLeafWork>[1],
  "today" | "calendar" | "timezone"
>;

export interface RuleContext extends RuleTime {
  readonly developmentAccounts?: ReadonlySet<string>;
  readonly thresholds?: {
    readonly R02?: {
      readonly missingAfter?: Threshold;
      readonly waitAfter?: Threshold;
    };
    readonly R03?: { readonly after?: Threshold };
  };
  readonly disabledRules?: ReadonlySet<RuleId>;
}

type Story = Pick<
  StoryDetail,
  "id" | "status" | "category" | "deleted" | "closedReason"
> &
  Parameters<typeof resolveStoryRoles>[0]["story"];
type WorkTask = Parameters<typeof summarizeLeafWork>[0][number];
type StageTask = Parameters<typeof summarizeStages>[0][number];

export interface StoryInput {
  readonly story?: Story;
}

export interface StageInput extends StoryInput {
  readonly tasks?: readonly StageTask[];
  readonly tasksComplete?: boolean;
  readonly required?: Parameters<typeof featureProgress>[0]["required"];
}

export interface RuleInput extends Omit<StageInput, "tasks"> {
  readonly tasks?: readonly (WorkTask & StageTask)[];
  readonly handoffAt?: number | null;
  readonly roles?: Omit<Parameters<typeof resolveStoryRoles>[0], "story">;
  readonly waivers?: readonly RuleWaiver[];
}

interface RuleWaiver {
  readonly ruleId: RuleId;
  readonly objectType: RiskHit["objectType"];
  readonly objectId: number;
  readonly by: string;
  readonly reason: string;
}

// docs/04 §5.1。证据使用固定业务说明，仅返回用于判断的对象 ID 和日期。
export interface RiskHit {
  readonly ruleId: RuleId;
  readonly objectType: "task" | "story";
  readonly objectId: number;
  readonly state: "gap" | "stalled";
  readonly severity: "high" | "medium" | "low";
  readonly confidence: "recorded" | "inferred" | "unknown";
  readonly since: string | null;
  readonly evidence: readonly string[];
  readonly suggestion: string;
  readonly threshold?: Threshold;
}

export function elapsedWorkdays(timestamp: number, context: RuleTime) {
  const since = formatLocalDate(timestamp, context.timezone);
  return {
    since,
    workdays: countWorkdaysBetween(since, context.today, context.calendar),
  };
}
