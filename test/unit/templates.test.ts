import { describe, expect, it } from "vitest";
import {
  buildIntakeSpec,
  formatIntakeReceipt,
  formatVersionTag,
  parseCsv,
  parseMarkdownTable,
  recommendStoryCategory,
  validateIntakeContent,
} from "../../src/domain/templates.ts";
import { assertNoSensitiveData } from "../helpers/assert-no-sensitive-data.ts";

describe("N02 类别推荐", () => {
  it.each([
    [{ title: "角色列表支持按部门筛选" }, "feature"],
    [{ title: "新页面" }, "design"],
    [{ title: "修改文案", body: "需要评审" }, "design"],
    [{ title: "修改文案", crossProduct: true }, "design"],
    [{ title: "修改文案", crossModule: true }, "feature"],
    [{ title: "涉及多个模块的权限联动" }, "design"],
  ])("给出可解释的推导 %j", (input, category) => {
    expect(recommendStoryCategory(input)).toEqual({
      value: category,
      origin: "derived",
      reason: expect.any(String),
    });
  });
});

it("AC-01/04/05 一次列出空白验收、范围及缺失章节", () => {
  expect(() =>
    validateIntakeContent({ scope: " ", designRef: { doc: "设计稿" } }),
  ).toThrow(
    expect.objectContaining({
      code: "MISSING_REQUIRED",
      details: { missing: ["spec.scope", "spec.designRef.section", "verify"] },
    }),
  );
  expect(() => validateIntakeContent(undefined, "验收")).toThrow(
    expect.objectContaining({ details: { missing: ["spec.scope"] } }),
  );
  expect(() => validateIntakeContent({ scope: "范围" }, "通过")).not.toThrow();
  expect(() =>
    buildIntakeSpec({ notInScope: "另做" }, {}, { intake: "INT-1" }),
  ).toThrow(expect.objectContaining({ details: { missing: ["spec.scope"] } }));
});

it("N03 构造安全正文和可见页脚，保留来源与版本", () => {
  const html = buildIntakeSpec(
    {
      background: "<背景>",
      scope: "做的内容",
      notInScope: "已经完成的内容",
      designRef: {
        doc: "https://example.test/design",
        section: "2",
        version: "1",
      },
    },
    {
      feedbackBy: "甲",
      channel: "企微",
      source: "user",
      sourceNote: "会议补充",
      requirementId: 2,
      derivesFrom: 3,
    },
    { maintainer: "alice", receiver: "bob", intake: "INT-1" },
  );
  for (const text of [
    "&lt;背景&gt;",
    "做的内容",
    "不做 / 已实现：已经完成的内容",
    "https://example.test/design",
    "章节：2",
    "版本：1",
    "反馈者：甲",
    "渠道：企微",
    "来源：user",
    "会议补充",
    "用户需求 #2",
    "衍生自 #3",
    "[bzt:v1 maintainer=alice;receiver=bob;intake=INT-1]",
  ])
    expect(html).toContain(text);
  expect(
    buildIntakeSpec(
      { scope: "范围", designRef: { doc: "设计稿", section: "2" } },
      {},
      { intake: "INT-2" },
    ),
  ).not.toContain("版本");
  expect(
    buildIntakeSpec({ scope: "范围" }, {}, { intake: "INT-3" }),
  ).not.toContain("<h3>来源");
  assertNoSensitiveData(html);
});

it("N04 版本关键词与 AC-10 业务回执", () => {
  expect(formatVersionTag("v7.0.3")).toBe("版本:V7.0.3");
  expect(formatVersionTag("7.0.3")).toBe("版本:V7.0.3");
  expect(() => formatVersionTag("7.0")).toThrow(
    expect.objectContaining({ code: "INVALID_INPUT" }),
  );
  expect(formatIntakeReceipt("INT-9")).toMatch(/INT-9.*查.*进度/u);
  expect(formatIntakeReceipt("INT-9")).not.toMatch(/禅道|研发需求|计划|草稿/u);
});

it("解析 RFC-4180 引号、双引号、嵌入换行与空字段", () => {
  expect(parseCsv('\uFEFF"甲,乙",c\r\n"x""y","a\r\nb"\r\n,\n')).toEqual([
    ["甲,乙", "c"],
    ['x"y', "a\r\nb"],
    ["", ""],
  ]);
  expect(parseCsv("a,")).toEqual([["a", ""]]);
  expect(parseCsv("")).toEqual([]);
  expect(parseCsv('"a"')).toEqual([["a"]]);
  for (const input of ['a"b', '"a', '"a"x', '"a" '])
    expect(() => parseCsv(input)).toThrow(
      expect.objectContaining({ code: "INVALID_INPUT" }),
    );
});

it("解析 Markdown 表格边框、对齐和转义竖线", () => {
  expect(
    parseMarkdownTable(
      "说明\n\n| 标题 | 模块 |\n| :--- | ---: |\n| 甲\\|乙 | 权限 |\n\n备注",
    ),
  ).toEqual([
    ["标题", "模块"],
    ["甲|乙", "权限"],
  ]);
  expect(parseMarkdownTable("a | b\n--- | :---:\nx | y")).toEqual([
    ["a", "b"],
    ["x", "y"],
  ]);
  expect(parseMarkdownTable("| a | b |\n| --- | --- |\n| x | y\\|")).toEqual([
    ["a", "b"],
    ["x", "y|"],
  ]);
  for (const input of ["无表格", "a | b\n--- | x", "a | b\n--- | --- | ---"])
    expect(() => parseMarkdownTable(input)).toThrow(
      expect.objectContaining({ code: "INVALID_INPUT" }),
    );
});
