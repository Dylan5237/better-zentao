import { describe, expect, it } from "vitest";
import { createWorkCalendar } from "../../src/core/calendar.ts";
import {
  summarizeRelease,
  type ReleaseStory,
} from "../../src/domain/release.ts";

const story = (
  id: number,
  fields: Partial<ReleaseStory> = {},
): ReleaseStory => ({
  id,
  product: 29,
  keywords: "版本:V7.0.3",
  progress: "测试中",
  stages: { test: { status: "in_progress" } },
  tasks: [],
  bugs: [],
  ...fields,
});
const task = (id: number, deadline: string | null) => ({
  id,
  deadline,
  parent: null,
  isParent: false,
  status: "wait" as const,
});
const context = {
  product: 29,
  version: "V7.0.3",
  today: "2026-11-25",
  calendar: createWorkCalendar({ holidays: ["2026-11-27"] }),
};
const sources = {
  releases: [
    { product: 30, name: "V7.0.3", date: "2026-11-26" },
    { product: 29, name: "V7.0.30", date: "2026-11-26" },
    { product: 29, name: "V7.0.3", date: null },
    { product: 29, name: "V7.0.3", date: "2026-12-01" },
  ],
  releaseCalendar: [{ product: 29, version: "V7.0.3", date: "2026-12-03" }],
  legacyPlans: [
    { id: 10, product: 29, version: "V7.0.3", end: "2026-12-05" },
    { id: 11, product: 29, version: "V7.0.30", end: "2026-12-06" },
  ],
};

describe("docs/04 §4.8 版本就绪（AC-62/63）", () => {
  const stories = [
    story(1, {
      keywords: "客户需求，版本:V7.0.3；常用",
      tasks: [
        task(101, "2026-12-02"),
        { ...task(102, "2026-12-02"), parent: 101 },
        task(103, "2026-12-01"),
        task(104, null),
        { ...task(105, "2026-12-02"), isParent: true },
      ],
      bugs: [
        { id: 21, severity: 2, status: "active" },
        { id: 22, severity: 1, status: "resolved" },
        { id: 23, severity: 1, status: "closed" },
        { id: 24, severity: 1, status: "active", deleted: true },
        { id: 25, severity: 3, status: "active" },
      ],
    }),
    story(2, {
      keywords: null,
      plan: [10],
      stages: { test: { status: "completed" } },
      progress: "待验收",
    }),
    story(2),
    story(3, { keywords: "版本:V7.0.30", plan: [11] }),
    story(4, { keywords: "前缀版本:V7.0.3" }),
    story(5, { product: 30 }),
  ];

  it("精确匹配版本标签及存量计划，并给出日期、工作日与门禁证据", () => {
    const result = summarizeRelease({ ...context, ...sources, stories });
    expect(result).toMatchObject({
      releaseDate: "2026-12-01",
      dateSource: "release",
      workdaysUntilRelease: 3,
      storyIds: [1, 2],
      progressGroups: [
        { progress: "测试中", storyIds: [1] },
        { progress: "待验收", storyIds: [2] },
      ],
      testCompletionRate: { numerator: 1, denominator: 2, rate: 0.5 },
      testIncompleteStoryIds: [1],
      lateLeafTasks: [{ storyId: 1, taskId: 102, deadline: "2026-12-02" }],
      openSeriousBugs: [
        { id: 22, severity: 1, status: "resolved" },
        { id: 21, severity: 2, status: "active" },
      ],
      openBugs: [{ id: 22 }, { id: 21 }, { id: 25 }],
      gate: "blocked",
      flags: [],
    });
  });

  it("发布日期依次降级到发布日历、存量版本计划或未知", () => {
    expect(
      summarizeRelease({ ...context, stories, ...sources, releases: [] }),
    ).toMatchObject({ releaseDate: "2026-12-03", dateSource: "calendar" });
    expect(
      summarizeRelease({
        ...context,
        stories,
        legacyPlans: sources.legacyPlans,
      }),
    ).toMatchObject({ releaseDate: "2026-12-05", dateSource: "legacyPlan" });
    expect(
      summarizeRelease({
        ...context,
        stories,
        releaseCalendar: [
          { product: 29, version: "V7.0.30", date: "2026-12-03" },
        ],
      }),
    ).toMatchObject({
      releaseDate: null,
      dateSource: null,
      workdaysUntilRelease: null,
      lateLeafTasks: [],
    });
  });

  it("发布日期当天不标记，日期已过且测试未完时仍标记例外放行项", () => {
    const base = {
      ...context,
      ...sources,
      stories,
      waivers: [
        {
          storyId: 1,
          version: "V7.0.3",
          approvedBy: "pm",
          reason: "先发布后补测",
        },
      ],
    };
    expect(summarizeRelease({ ...base, today: "2026-12-01" })).toMatchObject({
      gate: "waiver",
      waivers: base.waivers,
      workdaysUntilRelease: 0,
      flags: [],
    });
    expect(summarizeRelease({ ...base, today: "2026-12-02" })).toMatchObject({
      gate: "waiver",
      workdaysUntilRelease: -1,
      flags: ["已发布·测试未完成"],
    });
  });

  it("门禁要求测试证据完整且严重 Bug 已关闭，例外必须匹配所有阻塞需求及版本", () => {
    const tested = story(1, { stages: { test: { status: "completed" } } });
    expect(summarizeRelease({ ...context, stories: [tested] }).gate).toBe(
      "ready",
    );
    expect(
      summarizeRelease({
        ...context,
        stories: [{ ...tested, tasksComplete: false }],
      }).gate,
    ).toBe("blocked");
    expect(summarizeRelease({ ...context, stories: [] })).toMatchObject({
      gate: "unknown",
      testCompletionRate: { numerator: 0, denominator: 0, rate: null },
    });
    const bug = { id: 21, severity: 2, status: "active" };
    const result = summarizeRelease({
      ...context,
      stories: [
        { ...tested, bugs: [bug] },
        story(2, { stages: {}, bugs: [bug] }),
      ],
      waivers: [
        { storyId: 1, version: "V7.0.30", approvedBy: "pm", reason: "批准" },
        { storyId: 2, version: "V7.0.3", approvedBy: "pm", reason: "批准" },
      ],
    });
    expect(result).toMatchObject({
      gate: "blocked",
      testIncompleteStoryIds: [2],
      openSeriousBugs: [bug],
    });
  });

  it("发布日已过时，任务读取缺失不被解释为测试实际未完成", () => {
    expect(
      summarizeRelease({
        ...context,
        ...sources,
        today: "2026-12-02",
        stories: [story(1, { tasksComplete: false })],
      }),
    ).toMatchObject({
      gate: "blocked",
      testIncompleteStoryIds: [1],
      flags: [],
    });
  });
});
