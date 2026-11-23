import { z } from "zod";
import { BztError } from "./errors.ts";

const defaultTimezone = "Asia/Shanghai";
const msPerDay = 86_400_000;
const datePattern = /^(\d{4})-(\d{2})-(\d{2})$/u;
const dateTimePattern =
  /^(\d{4}-\d{2}-\d{2})(?:[ T](\d{2}):(\d{2}):(\d{2}))?$/u;
const maxCachedTimeZones = 32;
const formatters = new Map<string, Intl.DateTimeFormat>();

function daysInMonth(year: number, month: number): number {
  if (month === 2) {
    const leap = year % 4 === 0 && (year % 100 !== 0 || year % 400 === 0);
    return leap ? 29 : 28;
  }
  return [4, 6, 9, 11].includes(month) ? 30 : 31;
}

function daysBeforeYear(year: number): number {
  const years = year - 1;
  return (
    365 * years +
    Math.floor(years / 4) -
    Math.floor(years / 100) +
    Math.floor(years / 400)
  );
}

// 公历 0001-01-01 为第 0 天，也是星期一。
function civilDay(year: number, month: number, day: number): number {
  let index = daysBeforeYear(year) + day - 1;
  for (let previous = 1; previous < month; previous++) {
    index += daysInMonth(year, previous);
  }
  return index;
}

const lastCivilDay = daysBeforeYear(10_000) - 1;
const epochDay = daysBeforeYear(1970);

function parseDay(date: string): number | undefined {
  const match = datePattern.exec(date);
  if (!match) return undefined;
  const year = Number(match[1]);
  const month = Number(match[2]);
  const day = Number(match[3]);
  if (
    year < 1 ||
    month < 1 ||
    month > 12 ||
    day < 1 ||
    day > daysInMonth(year, month)
  ) {
    return undefined;
  }
  return civilDay(year, month, day);
}

function requireDay(date: string): number {
  const index = parseDay(date);
  if (index === undefined) throw new BztError("INVALID_INPUT", "日期不合法。");
  return index;
}

function formatDay(year: number, month: number, day: number): string {
  return [
    String(year).padStart(4, "0"),
    String(month).padStart(2, "0"),
    String(day).padStart(2, "0"),
  ].join("-");
}

function dateOfDay(index: number): string {
  let year = Math.floor(index / 366) + 1;
  while (daysBeforeYear(year + 1) <= index) year++;
  let remaining = index - daysBeforeYear(year);
  let month = 1;
  while (remaining >= daysInMonth(year, month)) {
    remaining -= daysInMonth(year, month);
    month++;
  }
  return formatDay(year, month, remaining + 1);
}

const dateString = z.string().refine((value) => parseDay(value) !== undefined);
const calendarConfig = z.strictObject({
  workdays: z
    .array(z.int().min(1).max(7))
    .min(1)
    .refine((days) => new Set(days).size === days.length)
    .default([1, 2, 3, 4, 5]),
  holidays: z.array(dateString).default([]),
  extraWorkdays: z.array(dateString).default([]),
});

export type CalendarConfig = z.input<typeof calendarConfig>;

export interface WorkCalendar {
  readonly workdays: ReadonlySet<number>;
  readonly holidays: ReadonlySet<number>;
  readonly extraWorkdays: ReadonlySet<number>;
}

export function createWorkCalendar(input: unknown = {}): WorkCalendar {
  const config = calendarConfig.safeParse(input);
  if (!config.success)
    throw new BztError("INVALID_INPUT", "工作日历配置不合法。");
  const holidays = new Set(config.data.holidays.map(requireDay));
  const extraWorkdays = config.data.extraWorkdays.map(requireDay);
  if (extraWorkdays.some((day) => holidays.has(day))) {
    throw new BztError(
      "INVALID_INPUT",
      "同一天不能同时配置为节假日和调休工作日。",
    );
  }
  return {
    workdays: new Set(config.data.workdays),
    holidays,
    extraWorkdays: new Set(extraWorkdays),
  };
}

function isWorkingDay(index: number, calendar: WorkCalendar): boolean {
  return (
    calendar.extraWorkdays.has(index) ||
    (!calendar.holidays.has(index) && calendar.workdays.has((index % 7) + 1))
  );
}

export function isWorkday(date: string, calendar: WorkCalendar): boolean {
  return isWorkingDay(requireDay(date), calendar);
}

export function nextWorkday(date: string, calendar: WorkCalendar): string {
  return isWorkday(date, calendar) ? date : addWorkdays(date, 1, calendar);
}

export function addWorkdays(
  date: string,
  offset: number,
  calendar: WorkCalendar,
): string {
  if (!Number.isSafeInteger(offset) || Math.abs(offset) > lastCivilDay) {
    throw new BztError("INVALID_INPUT", "工作日偏移不合法。");
  }
  let index = requireDay(date);
  // docs/04 §4.1 从起算日之后计数，反向时先向前走一天。
  const direction = Math.sign(offset);
  for (let remaining = Math.abs(offset); remaining > 0;) {
    index += direction;
    if (index < 0 || index > lastCivilDay) {
      throw new BztError("INVALID_INPUT", "工作日计算超出日期范围。");
    }
    if (isWorkingDay(index, calendar)) remaining--;
  }
  return dateOfDay(index);
}

/** docs/04 §4.1 沿起点到终点计数，排除起点并包含工作日终点。 */
export function countWorkdaysBetween(
  fromDate: string,
  toDate: string,
  calendar: WorkCalendar,
): number {
  const from = requireDay(fromDate);
  const to = requireDay(toDate);
  const direction = Math.sign(to - from);
  let count = 0;
  for (let index = from; index !== to;) {
    index += direction;
    if (isWorkingDay(index, calendar)) count += direction;
  }
  return count;
}

function localFormatter(timeZone: string): Intl.DateTimeFormat {
  const cached = formatters.get(timeZone);
  if (cached) return cached;

  let formatter: Intl.DateTimeFormat;
  try {
    formatter = new Intl.DateTimeFormat("en-GB", {
      timeZone,
      calendar: "iso8601",
      numberingSystem: "latn",
      era: "short",
      year: "numeric",
      month: "2-digit",
      day: "2-digit",
      hour: "2-digit",
      minute: "2-digit",
      second: "2-digit",
      hourCycle: "h23",
    });
  } catch {
    throw new BztError("INVALID_INPUT", "业务时区不合法。");
  }

  const oldest = formatters.keys().next();
  if (!oldest.done && formatters.size >= maxCachedTimeZones) {
    formatters.delete(oldest.value);
  }
  formatters.set(timeZone, formatter);
  return formatter;
}

function localParts(formatter: Intl.DateTimeFormat, timestampMs: number) {
  const parts = new Map(
    formatter
      .formatToParts(timestampMs)
      .map(({ type, value }) => [type, value]),
  );
  const year = Number(parts.get("year"));
  return {
    year: parts.get("era") === "BC" ? 1 - year : year,
    month: Number(parts.get("month")),
    day: Number(parts.get("day")),
    seconds:
      Number(parts.get("hour")) * 3600 +
      Number(parts.get("minute")) * 60 +
      Number(parts.get("second")),
  };
}

export function formatLocalDate(
  timestampMs: number,
  timezone = defaultTimezone,
): string {
  if (
    !Number.isSafeInteger(timestampMs) ||
    Math.abs(timestampMs) > 8_640_000_000_000_000
  ) {
    throw new BztError("INVALID_INPUT", "毫秒时间戳不合法。");
  }
  const { year, month, day } = localParts(
    localFormatter(timezone),
    timestampMs,
  );
  if (year < 1 || year > 9999)
    throw new BztError("INVALID_INPUT", "日期超出四位年份范围。");
  return formatDay(year, month, day);
}

function interpretLocalTime(
  index: number,
  seconds: number,
  timezone: string,
  disambiguation: "earlier" | "later",
): number {
  const localMs = (index - epochDay) * msPerDay + seconds * 1000;
  const formatter = localFormatter(timezone);
  const wallTime = (timestamp: number) => {
    const parts = localParts(formatter, timestamp);
    return (
      (civilDay(parts.year, parts.month, parts.day) - epochDay) * msPerDay +
      parts.seconds * 1000
    );
  };

  // 用相邻日期的时区偏移寻找候选时刻，再按本地时间回验。
  const choose = disambiguation === "earlier" ? Math.min : Math.max;
  let timestamp: number | undefined;
  for (const probe of [localMs - msPerDay, localMs, localMs + msPerDay]) {
    const candidate = localMs - (wallTime(probe) - probe);
    if (wallTime(candidate) === localMs)
      timestamp = choose(timestamp ?? candidate, candidate);
  }
  if (timestamp === undefined)
    throw new BztError("INVALID_INPUT", "本地时间在该时区不存在。");
  return timestamp;
}

export function parseZentaoDateTime(
  value: string | null | undefined,
  timezone = defaultTimezone,
): number | null {
  if (
    value == null ||
    value === "" ||
    value === "0000-00-00" ||
    value === "0000-00-00 00:00:00" ||
    value === "0000-00-00T00:00:00"
  )
    return null;
  const match = dateTimePattern.exec(value);
  if (!match?.[1]) {
    throw new BztError("INVALID_INPUT", "禅道日期时间格式不合法。");
  }
  const hour = Number(match[2] ?? 0);
  const minute = Number(match[3] ?? 0);
  const second = Number(match[4] ?? 0);
  if (hour > 23 || minute > 59 || second > 59) {
    throw new BztError("INVALID_INPUT", "禅道日期时间不合法。");
  }
  return interpretLocalTime(
    requireDay(match[1]),
    hour * 3600 + minute * 60 + second,
    timezone,
    "earlier",
  );
}

export function deadlineEndOfDayMs(
  date: string,
  timezone = defaultTimezone,
): number {
  // docs/04 §4.1 日期型截止日为业务时区 23:59:59。
  return interpretLocalTime(requireDay(date), 86_399, timezone, "later");
}
