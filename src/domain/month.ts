import {
  civilDate,
  countWorkdaysBetween,
  deadlineEndOfDayMs,
  isWorkday,
  type WorkCalendar,
} from "../core/calendar.ts";
import type { Execution } from "../core/dto/execution.ts";
import type { ProductPlan } from "../core/dto/plan.ts";

type DateRange = Pick<ProductPlan, "begin" | "end">;
type MonthlyPlan = DateRange &
  Partial<Pick<ProductPlan, "deleted" | "title">> & {
    readonly kind: "l3" | "legacyRelease" | "other";
  };

function isMonth(month: string): boolean {
  return (
    /^\d{4}-\d{2}$/u.test(month) && civilDate.safeParse(`${month}-01`).success
  );
}

function lastDayOfMonth(month: string): string {
  let day = 31;
  while (!civilDate.safeParse(`${month}-${day}`).success) day--;
  return `${month}-${day}`;
}

function overlap(range: DateRange, month: string): number {
  const begin = civilDate.safeParse(range.begin).data;
  const end = civilDate.safeParse(range.end).data;
  if (!begin || !end) return 0;
  const first = `${month}-01`;
  const last = lastDayOfMonth(month);
  const from = begin > first ? begin : first;
  const to = end < last ? end : last;
  if (from > to) return 0;
  // UTC 只用于计算公历日差，避免夏令时改变一天的长度。
  const startMs = deadlineEndOfDayMs(from, "UTC");
  const endMs = deadlineEndOfDayMs(to, "UTC");
  return (endMs - startMs) / 86_400_000 + 1;
}

// docs/04 §4.6、§6 有日期重叠即归入当月，历史版本计划排除。
export function planOverlapDays(plan: MonthlyPlan, month: string): number {
  return plan.kind === "l3" && !plan.deleted && isMonth(month)
    ? overlap(plan, month)
    : 0;
}

interface ExecutionMonthOptions {
  readonly month?: string;
  readonly kind?: "dev" | "design" | "ui";
  readonly devLabel?: string;
}

function monthInName(execution: Pick<Execution, "name" | "begin" | "end">) {
  const title = execution.name.replace(/【[^】]*】/gu, " ");
  const match = /(?<!\d)(?:(\d{4})年\s*)?(\d{1,2})月/u.exec(title);
  const monthNumber = match?.[2]?.padStart(2, "0");
  if (!monthNumber) return null;
  const year = match?.[1];
  if (year) {
    const month = `${year}-${monthNumber}`;
    return isMonth(month) ? month : null;
  }
  const years = [execution.begin, execution.end]
    .map((date) => civilDate.safeParse(date).data?.slice(0, 4))
    .filter((anchor) => anchor !== undefined);
  const candidates = years
    .map((anchor) => `${anchor}-${monthNumber}`)
    .filter(isMonth);
  return (
    candidates.find((month) => overlap(execution, month) > 0) ??
    candidates[0] ??
    null
  );
}

// docs/04 §4.6 配置可覆盖识别结果。日期只补月份，研发职能必须有来源。
export function isDevExecutionInMonth(
  execution: Pick<Execution, "name" | "begin" | "end">,
  month: string,
  options: ExecutionMonthOptions = {},
): boolean {
  if (!isMonth(month)) return false;
  const label = [...execution.name.matchAll(/【([^】]+)】/gu)].at(-1)?.[1];
  const isDev = options.kind
    ? options.kind === "dev"
    : label === (options.devLabel ?? "研发");
  if (!isDev) return false;
  const namedMonth = options.month ?? monthInName(execution);
  return namedMonth ? namedMonth === month : overlap(execution, month) > 0;
}

// docs/04 §4.6 窗口从倒数第 N 个工作日起持续至月底。
export function isInLastWorkdaysOfMonth(
  today: string,
  calendar: WorkCalendar,
  workdays = 7,
): boolean {
  if (
    !civilDate.safeParse(today).success ||
    !Number.isSafeInteger(workdays) ||
    workdays <= 0
  )
    return false;
  const month = today.slice(0, 7);
  const first = `${month}-01`;
  const last = lastDayOfMonth(month);
  const total =
    countWorkdaysBetween(first, last, calendar) +
    Number(isWorkday(first, calendar));
  return (
    countWorkdaysBetween(today, last, calendar) < Math.min(workdays, total)
  );
}

// docs/04 §4.6 同一需求同时属于计划和迭代时只计一次。
export function monthlyDevPoolIds(
  planStoryIds: readonly number[],
  iterationStoryIds: readonly number[],
): number[] {
  return [...new Set([...planStoryIds, ...iterationStoryIds])];
}
