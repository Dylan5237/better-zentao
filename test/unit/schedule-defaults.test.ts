import { describe, expect, it } from "vitest";
import { createWorkCalendar } from "../../src/core/calendar.ts";
import { teamConfigSchema } from "../../src/core/config.ts";
import { planStageDates } from "../../src/domain/schedule.ts";

const { stageDefaults } = teamConfigSchema.parse({});
const calendar = createWorkCalendar({
  holidays: ["2026-11-30", "2026-12-03"],
  extraWorkdays: ["2026-12-05"],
});
const date = (value: string, origin: "default" | "user" = "default") => ({
  value,
  origin,
});

describe("docs/03 N07 默认日期（AC-43/46）", () => {
  it("研发阶段顺延周末和节假日，并从研发之后向前偏移接口开始日", () => {
    expect(
      planStageDates("feature", stageDefaults, "2026-11-28", calendar),
    ).toEqual({
      dev: { estStarted: date("2026-12-01"), deadline: date("2026-12-08") },
      interface: {
        estStarted: date("2026-12-07"),
        deadline: date("2026-12-09"),
      },
      test: { estStarted: date("2026-12-09"), deadline: date("2026-12-11") },
      acceptance: {
        estStarted: date("2026-12-14"),
        deadline: date("2026-12-15"),
      },
      delivery: {
        estStarted: date("2026-12-16"),
        deadline: date("2026-12-17"),
      },
    });
  });

  it("按字段保留明确日期，并用实际采用的截止日作为后续起点", () => {
    expect(
      planStageDates("design", stageDefaults, "2026-11-26", calendar, {
        design: { deadline: "2026-11-29" },
        review: { estStarted: "2026-12-03" },
        handoff: { estStarted: "2026-12-08", deadline: "2026-12-08" },
      }),
    ).toEqual({
      design: {
        estStarted: date("2026-11-26"),
        deadline: date("2026-11-29", "user"),
      },
      review: {
        estStarted: date("2026-12-03", "user"),
        deadline: date("2026-12-04"),
      },
      handoff: {
        estStarted: date("2026-12-08", "user"),
        deadline: date("2026-12-08", "user"),
      },
    });
  });

  it("设计三阶段默认可跨周，支持阶段配置覆盖", () => {
    const defaults = {
      ...stageDefaults,
      design: {
        ...stageDefaults.design,
        design: {
          ...stageDefaults.design.design,
          startOffset: 1,
          durationDays: 1,
        },
      },
    };
    expect(planStageDates("design", defaults, "2026-11-26", calendar)).toEqual({
      design: { estStarted: date("2026-11-27"), deadline: date("2026-12-01") },
      review: { estStarted: date("2026-12-02"), deadline: date("2026-12-04") },
      handoff: { estStarted: date("2026-12-05"), deadline: date("2026-12-07") },
    });
  });

  it("拒绝跨类别依赖和循环依赖", () => {
    for (const after of ["delivery", "handoff"] as const) {
      const defaults = {
        ...stageDefaults,
        feature: {
          ...stageDefaults.feature,
          dev: { ...stageDefaults.feature.dev, after },
        },
      };
      expect(() =>
        planStageDates("feature", defaults, "2026-11-26", calendar),
      ).toThrow(expect.objectContaining({ code: "INVALID_INPUT" }));
    }
  });

  it.each([
    [
      "feature",
      "delivery",
      { estStarted: "2026-02-30", deadline: "2026-12-10" },
    ],
    ["feature", "delivery", { estStarted: "2026-12-08", deadline: "" }],
    ["design", "handoff", { estStarted: "2026/12/08", deadline: "2026-12-10" }],
    ["design", "handoff", { estStarted: "2026-12-08", deadline: "2026-13-01" }],
  ] as const)(
    "拒绝 %s 末端阶段 %s 的非法用户日期 %j",
    (category, stage, dates) => {
      expect(() =>
        planStageDates(category, stageDefaults, "2026-11-26", calendar, {
          [stage]: dates,
        }),
      ).toThrow(expect.objectContaining({ code: "INVALID_INPUT" }));
    },
  );
});
