import {
  addWorkdays,
  nextWorkday,
  type WorkCalendar,
} from "../core/calendar.ts";
import { BztError } from "../core/errors.ts";
import type { Stage } from "./stage.ts";

const stagesByCategory = {
  feature: ["dev", "interface", "test", "acceptance", "delivery"],
  design: ["design", "review", "handoff"],
} as const satisfies Record<string, readonly Stage[]>;
type StageCategory = keyof typeof stagesByCategory;
type CategoryStage<K extends StageCategory> =
  (typeof stagesByCategory)[K][number];

interface StageRule {
  readonly after?: Stage;
  readonly startOffset: number;
  readonly durationDays: number;
}

type StageDefaults = {
  readonly [K in StageCategory]: Readonly<Record<CategoryStage<K>, StageRule>>;
};

type StageDatesInput = Readonly<
  Partial<
    Record<
      Stage,
      {
        readonly estStarted?: string;
        readonly deadline?: string;
      }
    >
  >
>;

interface PlannedDate {
  readonly value: string;
  readonly origin: "user" | "default";
}

interface StageDates {
  readonly estStarted: PlannedDate;
  readonly deadline: PlannedDate;
}

// docs/03 N07、docs/04 §4.1、docs/08 stageDefaults 依赖阶段以采用的截止日为准。
export function planStageDates(
  category: StageCategory,
  stageDefaults: StageDefaults,
  baseDate: string,
  calendar: WorkCalendar,
  userDates: StageDatesInput = {},
) {
  const rules: Readonly<Partial<Record<Stage, StageRule>>> =
    stageDefaults[category];
  const planned = new Map<Stage, StageDates>();
  const visiting = new Set<Stage>();

  function plan(stage: Stage): StageDates {
    const existing = planned.get(stage);
    if (existing) return existing;
    const rule = rules[stage];
    if (!rule || visiting.has(stage))
      throw new BztError("INVALID_INPUT", "阶段日期配置包含无效依赖。");
    visiting.add(stage);
    const after = rule.after ? plan(rule.after) : undefined;
    const provided = userDates[stage];
    const estStarted: PlannedDate =
      provided?.estStarted === undefined
        ? {
            value: addWorkdays(
              after
                ? addWorkdays(after.deadline.value, 1, calendar)
                : nextWorkday(baseDate, calendar),
              rule.startOffset,
              calendar,
            ),
            origin: "default",
          }
        : { value: provided.estStarted, origin: "user" };
    const deadline: PlannedDate =
      provided?.deadline === undefined
        ? {
            value: addWorkdays(estStarted.value, rule.durationDays, calendar),
            origin: "default",
          }
        : { value: provided.deadline, origin: "user" };
    const result = { estStarted, deadline };
    planned.set(stage, result);
    visiting.delete(stage);
    return result;
  }

  const entries = stagesByCategory[category].map(
    (stage) => [stage, plan(stage)] as const,
  );
  const dates: Readonly<Partial<Record<Stage, StageDates>>> =
    Object.fromEntries(entries);
  return dates;
}
