import { describe, expect, it, vi } from "vitest";
import {
  addWorkdays,
  countWorkdaysBetween,
  createWorkCalendar,
  deadlineEndOfDayMs,
  formatLocalDate,
  isWorkday,
  monthDateRange,
  overlapsDateRange,
  nextWorkday,
  parseZentaoDateTime,
} from "../../src/core/calendar.ts";
import type { Clock } from "../../src/core/clock.ts";
import fixture from "../fixtures/calendar.json" with { type: "json" };

const calendar = () => createWorkCalendar(fixture);
const invalidInput = expect.objectContaining({ code: "INVALID_INPUT" });

describe("WP-01 工作日历（04 §4.1、09 §2）", () => {
  it("CR-007 按完整自然月计算边界，包含闰日和重叠边界", () => {
    const range = monthDateRange("2028-02");
    expect(range).toEqual({ start: "2028-02-01", end: "2028-02-29" });
    expect(overlapsDateRange(range, "2028-02-29", "2028-03-02")).toBe(true);
    expect(overlapsDateRange(range, "2028-01-03", "2028-01-31")).toBe(false);
    expect(() => monthDateRange("2028-13")).toThrow();
  });
  it("默认周一到周五为工作日，也支持自定义周工作日", () => {
    const defaults = createWorkCalendar();
    expect(isWorkday("2026-12-09", defaults)).toBe(true);
    expect(isWorkday("2026-12-13", defaults)).toBe(false);
    const onlySundays = createWorkCalendar({ workdays: [7] });
    expect(nextWorkday("2026-12-09", onlySundays)).toBe("2026-12-13");
  });

  it("N07 遇到节假日顺延，已经是工作日则保留原日期", () => {
    expect(isWorkday("2026-12-10", calendar())).toBe(false);
    expect(isWorkday("2026-12-12", calendar())).toBe(true);
    expect(nextWorkday("2026-12-10", calendar())).toBe("2026-12-11");
    expect(nextWorkday("2026-12-09", calendar())).toBe("2026-12-09");
    expect(nextWorkday("2026-12-12", calendar())).toBe("2026-12-12");
  });

  it.each([
    ["2026-12-09", 1, "2026-12-11"],
    ["2026-12-09", 2, "2026-12-12"],
    ["2026-12-10", 0, "2026-12-10"],
    ["2026-12-12", -2, "2026-12-09"],
    ["2026-12-30", 1, "2027-01-02"],
    ["2027-01-04", -2, "2026-12-30"],
    ["2027-03-31", 1, "2027-04-01"],
    ["2028-02-25", 1, "2028-02-29"],
  ] as const)("%s 加 %i 个工作日得到 %s", (start, offset, expected) => {
    expect(addWorkdays(start, offset, calendar())).toBe(expected);
  });

  it("按计数方向排除起点，终点是工作日才计入", () => {
    expect(countWorkdaysBetween("2026-12-09", "2026-12-12", calendar())).toBe(
      2,
    );
    expect(countWorkdaysBetween("2026-12-10", "2026-12-09", calendar())).toBe(
      -1,
    );
    expect(countWorkdaysBetween("2026-12-09", "2026-12-10", calendar())).toBe(
      0,
    );
    expect(countWorkdaysBetween("2026-12-09", "2026-12-09", calendar())).toBe(
      0,
    );
  });

  it.each([
    { workdays: [] },
    { workdays: [0, 8] },
    { workdays: [1, 1] },
    { holidays: ["2026-02-30"] },
    { holidays: ["2026-12-09\r\n"] },
    { extraWorkdays: ["2026-13-01"] },
    { holidays: ["2026-12-12"], extraWorkdays: ["2026-12-12"] },
  ])("拒绝不可用或冲突的日历配置 %j", (config) => {
    expect(() => createWorkCalendar(config)).toThrow(invalidInput);
  });

  it("拒绝非法工作日偏移及超出四位年份范围的运算", () => {
    expect(() => addWorkdays("2026-12-09", 0.5, calendar())).toThrow(
      invalidInput,
    );
    expect(() => addWorkdays("0001-01-01", -1, calendar())).toThrow(
      invalidInput,
    );
    expect(() => addWorkdays("9999-12-31", 1, calendar())).toThrow(
      invalidInput,
    );
    expect(() => isWorkday("2026-02-30", calendar())).toThrow(invalidInput);
  });
});

describe("WP-01 禅道本地时间（06 §2.2）", () => {
  it("09 §1.1 固定时钟跨时区日界并使用业务日末", () => {
    const clock: Clock = () => Date.UTC(2026, 11, 8, 16, 30);
    expect(formatLocalDate(clock())).toBe("2026-12-09");
    expect(formatLocalDate(clock(), "America/Los_Angeles")).toBe("2026-12-08");
    expect(parseZentaoDateTime("2026-12-09")).toBe(Date.UTC(2026, 11, 8, 16));
    expect(parseZentaoDateTime("2026-12-09 00:30:00")).toBe(clock());
    expect(parseZentaoDateTime("2026-12-09T00:30:00", "UTC")).toBe(
      Date.UTC(2026, 11, 9, 0, 30),
    );
    expect(deadlineEndOfDayMs("2026-12-09")).toBe(
      Date.UTC(2026, 11, 9, 15, 59, 59),
    );
    expect(deadlineEndOfDayMs("2026-12-09", "America/Los_Angeles")).toBe(
      Date.UTC(2026, 11, 10, 7, 59, 59),
    );
  });

  it.each([
    null,
    undefined,
    "",
    "0000-00-00",
    "0000-00-00 00:00:00",
    "0000-00-00T00:00:00",
  ])("空时间 %s 统一解析为 null", (value) =>
    expect(parseZentaoDateTime(value)).toBeNull(),
  );

  it.each([
    "2026-02-30",
    "2026-13-01",
    "2026-01-00",
    "0000-01-01",
    "0000-00-00T00:00:01",
    "1900-02-29",
    "2026-12-09 24:00:00",
    "2026-12-09 00:60:00",
    "2026-12-09 00:00:60",
    "2026-12-09T00:00:00Z",
    "2026-12-09\n",
    "2026-12-09T12:00:00\u2028",
  ])("拒绝非法或带偏移的时间 %j，不静默进位", (value) => {
    expect(() => parseZentaoDateTime(value)).toThrow(invalidInput);
  });

  it("正确处理公历闰世纪、Unix 纪元之前及有效年份边界", () => {
    expect(parseZentaoDateTime("2000-02-29", "UTC")).toBe(
      Date.UTC(2000, 1, 29),
    );
    expect(parseZentaoDateTime("1969-12-31T23:59:59", "UTC")).toBe(-1000);
    const firstDay = parseZentaoDateTime("0001-01-01", "UTC");
    expect(typeof firstDay).toBe("number");
    expect(formatLocalDate(Number(firstDay), "UTC")).toBe("0001-01-01");
    expect(() => formatLocalDate(Number(firstDay) - 1, "UTC")).toThrow(
      invalidInput,
    );
  });

  it("夏令时跳过的本地时间报错，重复时刻取较早的一次", () => {
    const zone = "America/New_York";
    expect(() => parseZentaoDateTime("2026-03-08 02:30:00", zone)).toThrow(
      invalidInput,
    );
    expect(parseZentaoDateTime("2026-11-01 01:30:00", zone)).toBe(
      Date.UTC(2026, 10, 1, 5, 30),
    );
  });

  it("夏令时回拨重复日末时，日期型截止日使用后一次 23:59:59", () => {
    const zone = "America/Santiago";
    expect(parseZentaoDateTime("2026-04-04 23:59:59", zone)).toBe(
      Date.UTC(2026, 3, 5, 2, 59, 59),
    );
    expect(deadlineEndOfDayMs("2026-04-04", zone)).toBe(
      Date.UTC(2026, 3, 5, 3, 59, 59),
    );
  });

  it("拒绝无法解析的时区、毫秒时间戳和截止日期", () => {
    expect(() => formatLocalDate(0, "Not/A_Zone")).toThrow(invalidInput);
    expect(() => formatLocalDate(Infinity)).toThrow(invalidInput);
    expect(() => deadlineEndOfDayMs("2026-02-30")).toThrow(invalidInput);
  });

  it("P2-3 同一时区复用格式化器，非法时区不入缓存", () => {
    const formatter = vi.spyOn(Intl, "DateTimeFormat");
    const zone = "+04:15";
    const invalidZone = "Invalid/CacheFixture";
    try {
      expect(parseZentaoDateTime("1970-01-01 04:15:00", zone)).toBe(0);
      expect(formatLocalDate(0, zone)).toBe("1970-01-01");
      expect(deadlineEndOfDayMs("1970-01-01", zone)).toBe(
        Date.UTC(1970, 0, 1, 19, 44, 59),
      );
      expect(() => formatLocalDate(0, invalidZone)).toThrow(invalidInput);
      expect(() => formatLocalDate(0, invalidZone)).toThrow(invalidInput);
      expect(
        formatter.mock.calls.map(([, options]) => options?.timeZone),
      ).toEqual([zone, invalidZone, invalidZone]);
    } finally {
      formatter.mockRestore();
    }
  });

  it("P2-3 时区缓存有界，最早放入的格式化器被淘汰后可重建", () => {
    const formatter = vi.spyOn(Intl, "DateTimeFormat");
    const first = "+01:00";
    try {
      expect(formatLocalDate(0, first)).toBe("1970-01-01");
      expect(formatLocalDate(0, first)).toBe("1970-01-01");
      for (let i = 1; i <= 32; i++) {
        formatLocalDate(0, `+01:${String(i).padStart(2, "0")}`);
      }
      expect(formatLocalDate(0, first)).toBe("1970-01-01");
      expect(
        formatter.mock.calls.filter(
          ([, options]) => options?.timeZone === first,
        ),
      ).toHaveLength(2);
    } finally {
      formatter.mockRestore();
    }
  });
});
