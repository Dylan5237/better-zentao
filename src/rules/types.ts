import { countWorkdaysBetween, formatLocalDate } from "../core/calendar.ts";
import type { summarizeLeafWork } from "../domain/task.ts";
import type { summarizeStages } from "../domain/stage.ts";
import type { featureProgress } from "../domain/progress.ts";
import type { resolveStoryRoles } from "../domain/roles.ts";
import type { StoryDetail } from "../core/dto/story.ts";
import type { Task } from "../core/dto/task.ts";
import type { Bug } from "../core/dto/bug.ts";
import type { planOverlapDays } from "../domain/month.ts";
import type { summarizeRelease } from "../domain/release.ts";

export type RuleId =
  | "R01"
  | "R02"
  | "R03"
  | "R04"
  | "R05"
  | "R06"
  | "R07"
  | "R08"
  | "R09"
  | "R10"
  | "R11"
  | "R12"
  | "R13"
  | "R14";

interface ThresholdSource {
  readonly source: "default" | "configured";
}

export interface WorkdayThreshold extends ThresholdSource {
  readonly workdays: number;
}

interface CalendarDayThreshold extends ThresholdSource {
  readonly days: number;
  readonly unit: "calendarDays";
  readonly workdays?: never;
}

export type RuleTime = Pick<
  Parameters<typeof summarizeLeafWork>[1],
  "today" | "calendar" | "timezone"
>;

export interface RuleContext extends RuleTime {
  readonly developmentAccounts?: ReadonlySet<string>;
  readonly systemStartDate?: string;
  readonly month?: string;
  readonly monthWorkdayIndex?: number;
  readonly thresholds?: {
    readonly R02?: {
      readonly missingAfter?: WorkdayThreshold;
      readonly waitAfter?: WorkdayThreshold;
    };
    readonly R03?: { readonly after?: WorkdayThreshold };
    readonly R07?: { readonly after?: WorkdayThreshold };
    readonly R08?: { readonly after?: WorkdayThreshold };
    readonly R09?: { readonly after?: WorkdayThreshold };
    readonly R10?: { readonly fromWorkday?: WorkdayThreshold };
    readonly R11?: { readonly after?: WorkdayThreshold };
    readonly R13?: { readonly beforeRelease?: WorkdayThreshold };
    readonly R14?: { readonly olderThanDays?: CalendarDayThreshold };
  };
  readonly disabledRules?: ReadonlySet<RuleId>;
}

type Story = Pick<
  StoryDetail,
  "id" | "status" | "category" | "deleted" | "closedReason"
> &
  Partial<Pick<StoryDetail, "openedDate">> & {
    readonly plan?: readonly number[];
  } & Parameters<typeof resolveStoryRoles>[0]["story"];
type WorkTask = Parameters<typeof summarizeLeafWork>[0][number];
type StageTask = Parameters<typeof summarizeStages>[0][number];

export type RuleTask = WorkTask &
  StageTask &
  Partial<Pick<Task, "story" | "openedDate" | "lastEditedDate">> & {
    readonly carriedSince?: string;
  };

type RuleBug = Pick<
  Bug,
  | "id"
  | "status"
  | "severity"
  | "deleted"
  | "story"
  | "execution"
  | "openedDate"
  | "closedDate"
> & {
  readonly openedDuringTest?: boolean;
};

export interface StoryInput {
  readonly story?: Story;
}

export interface StageInput extends StoryInput {
  readonly tasks?: readonly StageTask[];
  readonly tasksComplete?: boolean;
  readonly required?: Parameters<typeof featureProgress>[0]["required"];
}

export interface RuleInput extends Omit<StageInput, "tasks"> {
  readonly tasks?: readonly RuleTask[];
  readonly requirement?: Pick<Story, "id" | "deleted" | "openedDate">;
  // undefined 表示关系数据未提供，空数组表示已确认没有关联。
  readonly linkedStories?: readonly (Pick<
    Story,
    "id" | "category" | "deleted"
  > & {
    readonly relation?: string;
  })[];
  readonly bugs?: readonly RuleBug[];
  readonly release?: Omit<
    Parameters<typeof summarizeRelease>[0],
    "today" | "calendar"
  >;
  // null 表示确认没有计划，undefined 表示未提供计划归属。
  readonly plan?: Parameters<typeof planOverlapDays>[0] | null;
  readonly hasL3Plan?: boolean;
  readonly inMonthL3Plan?: boolean;
  readonly inMonthDevExecution?: boolean;
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
  readonly objectType: "task" | "story" | "bug" | "requirement";
  readonly objectId: number;
  readonly state: "gap" | "stalled";
  readonly severity: "high" | "medium" | "low";
  readonly confidence: "recorded" | "inferred" | "unknown";
  readonly since: string | null;
  readonly evidence: readonly string[];
  readonly suggestion: string;
  readonly threshold?: WorkdayThreshold | CalendarDayThreshold;
  readonly cleanupClass?: "A" | "B" | "C";
}

export function elapsedWorkdays(timestamp: number, context: RuleTime) {
  const since = formatLocalDate(timestamp, context.timezone);
  return {
    since,
    workdays: countWorkdaysBetween(since, context.today, context.calendar),
  };
}
