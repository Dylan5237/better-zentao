import { describe, expect, it } from "vitest";
import { resolveStoryRoles } from "../../src/domain/roles.ts";
import {
  planOverlapDays,
  isDevExecutionInMonth,
} from "../../src/domain/month.ts";

describe("docs/04 §2 人员角色", () => {
  const story = {
    openedBy: "author",
    assignedTo: "handler",
    feedbackBy: " 张三、王;unknown，BOB, 张三 ",
  };
  const directory = [
    { account: "zs", realname: "张三" },
    { account: "wa", realname: "王一" },
    { account: "wb", realname: "王二" },
    { account: "bob", realname: "鲍勃" },
    { account: "legacy", realname: "王", deleted: true },
  ];
  const module = { maintainer: "design", devLead: "dev" };
  const stored = { maintainer: "cached-m", receiver: "cached-r" };

  it("角色标签按字段优先，反馈记录优先于自由文本", () => {
    expect(
      resolveStoryRoles({
        story: { ...story, spec: "<!-- bzt:v1 maintainer=tagged -->" },
        directory,
        module,
        stored,
        intake: { feedbackByAccount: "verified" },
      }),
    ).toEqual({
      maintainer: "tagged",
      receiver: "cached-r",
      proposer: "author",
      currentHandler: "handler",
      feedback: splitFeedback("verified"),
    });
  });

  it("按账号或目录姓名匹配，保留原文和同名候选", () => {
    expect(resolveStoryRoles({ story, directory, module }).feedback).toEqual({
      original: story.feedbackBy,
      matches: [
        { text: "张三", account: "zs" },
        { text: "王", code: "AMBIGUOUS_ENTITY", candidates: ["wa", "wb"] },
        { text: "unknown", account: null },
        { text: "BOB", account: "bob" },
        { text: "张三", account: "zs" },
      ],
    });
    expect(
      resolveStoryRoles({ story: { feedbackBy: "Bob? / 张三" }, directory })
        .feedback.matches,
    ).toEqual([{ text: "Bob? / 张三", account: null }]);
    expect(
      resolveStoryRoles({ story: { feedbackBy: "张" }, directory }).feedback
        .matches,
    ).toEqual([{ text: "张", account: "zs" }]);
    expect(
      resolveStoryRoles({
        story: { feedbackBy: "王，wa" },
        directory: [...directory, { account: "wang", realname: "王" }],
      }).feedback.matches,
    ).toEqual([
      { text: "王", account: "wang" },
      { text: "wa", account: "wa" },
    ]);
  });

  it("按本地、模块、提出人回退，跨模块取被依赖方研发主管", () => {
    expect(resolveStoryRoles({ story, stored, module })).toMatchObject(stored);
    expect(resolveStoryRoles({ story, module })).toMatchObject({
      maintainer: "design",
      receiver: "dev",
    });
    expect(resolveStoryRoles({ story })).toMatchObject({
      maintainer: "author",
      receiver: null,
    });
    expect(resolveStoryRoles({ story: {} })).toEqual({
      maintainer: null,
      receiver: null,
      proposer: null,
      currentHandler: null,
      feedback: { original: null, matches: [] },
    });
    expect(
      resolveStoryRoles({
        story: {
          ...story,
          spec: "<!-- bzt:v1 maintainer=old;receiver=other -->",
        },
        stored,
        module,
        crossModule: { requester: "designer", dependencyDevLead: "backend" },
      }),
    ).toMatchObject({ maintainer: "old", receiver: "other" });
    const crossModule = { requester: "designer", dependencyDevLead: "backend" };
    expect(
      resolveStoryRoles({ story, stored, module, crossModule }),
    ).toMatchObject(stored);
    expect(resolveStoryRoles({ story, module, crossModule })).toMatchObject({
      maintainer: "designer",
      receiver: "backend",
    });
    expect(
      resolveStoryRoles({
        story,
        module,
        crossModule: { requester: "designer" },
      }).receiver,
    ).toBeNull();
    expect(
      resolveStoryRoles({
        story: { spec: "<p>[bzt:v1 receiver=visible]</p>" },
        stored,
      }).receiver,
    ).toBe("visible");
  });
});

function splitFeedback(account: string) {
  return { original: account, matches: [{ text: account, account }] };
}

describe("docs/04 §4.6 月份归属", () => {
  const l3 = {
    kind: "l3",
    title: "后台需求",
    begin: "2026-10-29",
    end: "2026-11-04",
  } as const;
  it("跨月计划按自然日重叠，日期优先于标题，边界包含首尾", () => {
    expect(planOverlapDays(l3, "2026-10")).toBe(3);
    expect(planOverlapDays(l3, "2026-11")).toBe(4);
    expect(planOverlapDays({ ...l3, title: "2026年12月" }, "2026-12")).toBe(0);
    expect(
      planOverlapDays(
        { ...l3, begin: "2024-02-29", end: "2024-02-29" },
        "2024-02",
      ),
    ).toBe(1);
    expect(
      planOverlapDays(
        { ...l3, begin: "2026-01-01", end: "2026-12-31" },
        "2026-11",
      ),
    ).toBe(30);
    expect(planOverlapDays({ ...l3, end: "2026-10-01" }, "2026-11")).toBe(0);
    expect(planOverlapDays({ ...l3, end: null }, "2026-11")).toBe(0);
    expect(planOverlapDays({ ...l3, kind: "legacyRelease" }, "2026-11")).toBe(
      0,
    );
    expect(planOverlapDays({ ...l3, deleted: true }, "2026-11")).toBe(0);
    expect(planOverlapDays(l3, "2026-13")).toBe(0);
  });

  it("解析迭代名称中的月份和职能，缺少名称月份时按日期", () => {
    const execution = {
      name: "【模块】【研发】2026年9月迭代",
      begin: "2026-11-01",
      end: "2026-11-30",
    };
    expect(isDevExecutionInMonth(execution, "2026-09")).toBe(true);
    expect(isDevExecutionInMonth(execution, "2026-11")).toBe(false);
    expect(
      isDevExecutionInMonth(
        { ...execution, name: "【模块】【研发】迭代" },
        "2026-11",
      ),
    ).toBe(true);
    expect(
      isDevExecutionInMonth({ ...execution, name: "【模块】迭代" }, "2026-11", {
        kind: "dev",
      }),
    ).toBe(true);
    expect(
      isDevExecutionInMonth(
        { ...execution, name: "【模块】【设计】2026年11月迭代" },
        "2026-11",
      ),
    ).toBe(false);
    expect(
      isDevExecutionInMonth(
        { ...execution, name: "【研发】【UI】2026年11月迭代" },
        "2026-11",
      ),
    ).toBe(false);
    expect(
      isDevExecutionInMonth(
        { ...execution, name: "【模块】2026年11月迭代" },
        "2026-11",
      ),
    ).toBe(false);
  });

  it("无年份用日期锚定，支持跨年与配置覆盖，拒绝猜测无锚点年份", () => {
    const execution = {
      name: "【模块】【研发】1月迭代",
      begin: "2026-12-28",
      end: "2027-01-09",
    };
    expect(isDevExecutionInMonth(execution, "2027-01")).toBe(true);
    expect(isDevExecutionInMonth(execution, "2026-01")).toBe(false);
    expect(
      isDevExecutionInMonth(
        { ...execution, begin: null, end: null },
        "2027-01",
      ),
    ).toBe(false);
    expect(
      isDevExecutionInMonth({ ...execution, begin: null }, "2027-01"),
    ).toBe(true);
    expect(
      isDevExecutionInMonth(
        { ...execution, name: "【模块】【实现】2026年11月迭代" },
        "2026-11",
        { devLabel: "实现" },
      ),
    ).toBe(true);
    expect(
      isDevExecutionInMonth(execution, "2026-11", { month: "2026-11" }),
    ).toBe(true);
    expect(
      isDevExecutionInMonth(execution, "2026-11", {
        month: "2026-11",
        kind: "design",
      }),
    ).toBe(false);
    expect(isDevExecutionInMonth(execution, "bad")).toBe(false);
    const invalidNamedMonth = { ...execution, name: "【研发】2026年13月迭代" };
    expect(isDevExecutionInMonth(invalidNamedMonth, "2027-01")).toBe(true);
    expect(isDevExecutionInMonth(invalidNamedMonth, "2027-02")).toBe(false);
  });
});

it("月份取迭代名称正文，产品标签中包含月份时也使用迭代月份", () => {
  expect(
    isDevExecutionInMonth(
      { name: "【10月发布】【研发】2026年11月迭代", begin: null, end: null },
      "2026-11",
    ),
  ).toBe(true);
});
