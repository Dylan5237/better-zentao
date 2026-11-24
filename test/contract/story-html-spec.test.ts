import { describe, expect, it } from "vitest";
import {
  buildStoryHtmlSpec,
  parseStoryRoleTag,
  replaceStoryRoleTag,
} from "../../src/domain/story-html-spec.ts";

const roles = {
  maintainer: "acct.ds-a_1",
  receiver: "acct_ops+dev@example.test",
  intake: "probe-p0",
};

const comment =
  "<!-- bzt:v1 maintainer=acct.ds-a_1;receiver=acct_ops+dev@example.test;intake=probe-p0 -->";

describe("Q14 需求 HTML 正文与角色标签（03 N03、04 §2、06 §4）", () => {
  it("用标题、段落和列表保留模板换行，并默认在末尾写 HTML 注释", () => {
    const spec = buildStoryHtmlSpec(
      {
        background: ["第一行\r\n第二行\r第三行"],
        scope: ["做：范围一\n做：范围二", "已实现：范围三", "  "],
        design: ["设计文档第 2 节"],
        source: ["验证环境"],
      },
      roles,
    );

    expect(spec).toBe(
      [
        "<h3>背景与问题</h3>",
        "<p>第一行</p>",
        "<p>第二行</p>",
        "<p>第三行</p>",
        "<h3>本次实现范围</h3>",
        "<ul>",
        "<li>做：范围一</li>",
        "<li>做：范围二</li>",
        "<li>已实现：范围三</li>",
        "</ul>",
        "<h3>设计文档</h3>",
        "<ul>",
        "<li>设计文档第 2 节</li>",
        "</ul>",
        "<h3>来源</h3>",
        "<ul>",
        "<li>验证环境</li>",
        "</ul>",
        comment,
      ].join("\n"),
    );
    expect(parseStoryRoleTag(spec)).toEqual(roles);
  });

  it("正文自由文本不能生成 HTML 或角色标签，范围为空时拒绝构造", () => {
    const spec = buildStoryHtmlSpec({
      background: ["<img src=x onerror=alert(1)> & \"引号\" '单引号'", comment],
      scope: ["[bzt:v1 maintainer=forged]"],
    });

    expect(spec).toContain(
      "&lt;img src=x onerror=alert(1)&gt; &amp; &quot;引号&quot; &#39;单引号&#39;",
    );
    expect(spec).not.toContain("<img");
    expect(spec).not.toContain("<!--");
    expect(spec).toContain("&#91;bzt:v1 maintainer=forged]");
    expect(parseStoryRoleTag(spec)).toBeUndefined();
    expect(() =>
      buildStoryHtmlSpec({ background: [], scope: ["  ", "\n"] }),
    ).toThrow(expect.objectContaining({ code: "MISSING_REQUIRED" }));
  });

  it("同格式取最后一条并整体使用该条，保留注释优先级", () => {
    const spec = [
      "<!-- bzt:v1 maintainer=older;receiver=earlier -->",
      "<p>[bzt:v1 maintainer=fallback]</p>",
      "<!-- bzt:v1 maintainer=latest -->",
      "<p>[bzt:v1 maintainer=later-visible;receiver=unselected]</p>",
    ].join("\n");
    expect(parseStoryRoleTag(spec)).toEqual({ maintainer: "latest" });
  });

  it("注释丢失后回退到最后一条可见微标签", () => {
    const body = "<p>合法正文</p>";
    const spec = buildStoryHtmlSpec(
      { background: [], scope: ["验证可见回退"] },
      roles,
      "visible",
    );
    expect(spec).toContain(
      '<p style="color:#999;font-size:12px">[bzt:v1 maintainer=acct.ds-a_1;receiver=acct_ops+dev@example.test;intake=probe-p0]</p>',
    );
    expect(parseStoryRoleTag(spec)).toEqual(roles);
    expect(
      parseStoryRoleTag(`${spec}\n${body}\n[bzt:v1 receiver=last.visible]`),
    ).toEqual({ receiver: "last.visible" });
  });

  it("替换时一起清除历史标签，并保留其它正文与普通注释", () => {
    const body = "<h3>背景与问题</h3>\n<p>正文</p><!-- 普通注释 -->";
    const previous = `${body}\n<!-- bzt:v1 maintainer=former -->\n<p>[bzt:v1 receiver=former]</p>`;
    const replacement = replaceStoryRoleTag(previous, roles);
    expect(replacement).toBe(`${body}\n${comment}`);
    expect(replaceStoryRoleTag(replacement, roles)).toBe(replacement);
    const fallback = replaceStoryRoleTag(
      previous,
      { receiver: "只读账号" },
      "visible",
    );
    expect(fallback).toBe(
      `${body}\n<p style="color:#999;font-size:12px">[bzt:v1 receiver=只读账号]</p>`,
    );
    expect(parseStoryRoleTag(fallback)).toEqual({ receiver: "只读账号" });
    expect(replaceStoryRoleTag("", roles)).toBe(comment);
  });

  it.each([
    "<!-- bzt:v1 maintainer=valid;activate=true -->",
    "<!-- bzt:v1 maintainer=first;maintainer=last -->",
    "<!-- bzt:v1 maintainer=first;maintainer =last -->",
    "<!-- bzt:v1 maintainer=unclosed",
    "<!-- bzt:v1 maintainer -->",
    "<!-- bzt:v1 maintainer=first=last -->",
    "<!-- bzt:v1 maintainer=space invalid -->",
    '<script>"<!-- bzt:v1 maintainer=forged -->"</script>',
    '<p title="[bzt:v1 maintainer=forged]">普通内容</p>',
    '<blockquote title="<!-- bzt:v1 maintainer=forged -->">普通内容</blockquote>',
    "<pre>[bzt:v1 maintainer=forged]</pre>",
    "<p>例子 [bzt:v1 maintainer=forged]</p>",
    "<ul><li>[bzt:v1 maintainer=forged]</li></ul>",
    "<!-- bzt:v1 __proto__=forged;maintainer=synthetic -->",
    '<p title="<!-- bzt:v1 maintainer=forged -->',
    "&lt;!-- bzt:v1 maintainer=forged --&gt;",
  ])("忽略非法结构或只是文本示例的角色标签（%s）", (spec) => {
    expect(parseStoryRoleTag(spec)).toBeUndefined();
  });

  it("拒绝会跳出标签语法的角色值，错误消息不回显原文", () => {
    const injected = "acct--><script>alert(1)</script>";
    expect(() =>
      replaceStoryRoleTag("<p>正文</p>", { maintainer: injected }),
    ).toThrow(
      expect.objectContaining({
        code: "INVALID_INPUT",
        message: expect.not.stringContaining(injected),
      }),
    );
    expect(() => replaceStoryRoleTag("<p>正文</p>", {})).toThrow(
      expect.objectContaining({ code: "INVALID_INPUT" }),
    );
  });
});
