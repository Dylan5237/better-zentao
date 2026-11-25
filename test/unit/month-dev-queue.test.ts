import { describe, expect, it } from "vitest";
import { createWorkCalendar } from "../../src/core/calendar.ts";
import {
  isInLastWorkdaysOfMonth,
  monthlyDevPoolIds,
} from "../../src/domain/month.ts";

describe("docs/04 §4.6 月度主池与月底窗口", () => {
  it("用工作日历确定窗口首日，窗口从该工作日持续到月底", () => {
    const calendar = createWorkCalendar({
      holidays: ["2026-11-30"],
      extraWorkdays: ["2026-11-28"],
    });
    expect(isInLastWorkdaysOfMonth("2026-11-19", calendar)).toBe(false);
    expect(isInLastWorkdaysOfMonth("2026-11-20", calendar)).toBe(true);
    expect(isInLastWorkdaysOfMonth("2026-11-30", calendar)).toBe(true);
    expect(isInLastWorkdaysOfMonth("2026-11-27", calendar, 1)).toBe(false);
    expect(isInLastWorkdaysOfMonth("2026-11-28", calendar, 1)).toBe(true);
  });

  it("识别闰月和没有工作日的月份，忽略无效日期或窗口", () => {
    expect(isInLastWorkdaysOfMonth("2028-02-29", createWorkCalendar(), 1)).toBe(
      true,
    );
    const calendar = createWorkCalendar({
      workdays: [1],
      holidays: [
        "2026-11-02",
        "2026-11-09",
        "2026-11-16",
        "2026-11-23",
        "2026-11-30",
      ],
    });
    expect(isInLastWorkdaysOfMonth("2026-11-30", calendar)).toBe(false);
    expect(isInLastWorkdaysOfMonth("2026-02-29", calendar)).toBe(false);
    expect(isInLastWorkdaysOfMonth("2026-11-30", calendar, 0)).toBe(false);
    expect(isInLastWorkdaysOfMonth("2026-11-30", calendar, 2.5)).toBe(false);
  });

  it("合并本月 L3 与研发迭代需求 ID，保留首次出现的顺序", () => {
    expect(monthlyDevPoolIds([2, 1, 2], [1, 3, 3])).toEqual([2, 1, 3]);
    expect(monthlyDevPoolIds([], [])).toEqual([]);
  });
});
