import { createHash } from "node:crypto";
import { Script } from "node:vm";
import { describe, expect, it } from "vitest";
import { renderTeamConfigEditorHtml } from "../../src/adapters/cli/render/config-editor-html.ts";

const data = {
  products: [{ id: 42, name: "天宫平台" }],
  modules: { 42: [{ id: 1201, name: "权限管理" }] },
  users: [
    { account: "zhangsan", realname: "张三", pinyin: "zhang san", dept: 2 },
  ],
  gaps: [],
  completeness: "complete" as const,
};

function payload(html: string): string {
  const json =
    /<script type="application\/json" id="editor-data">([^]*?)<\/script>/u.exec(
      html,
    )?.[1];
  if (!json) throw new Error("缺少页面初始数据。");
  return json;
}

describe("CR-001 团队配置页面", () => {
  it("生成五个页签和自包含的中文配置页面", () => {
    const html = renderTeamConfigEditorHtml({ ...data, config: {} });
    expect(html).toMatch(/^<!doctype html>/u);
    expect(html.trimEnd()).toMatch(/<\/html>$/u);
    expect(html.match(/<button[^>]+role="tab"/gu)).toHaveLength(5);
    for (const label of [
      "产品与默认兜底",
      "一级模块覆盖",
      "团队分组",
      "角色权限与称呼别名",
      "校验与导入/导出",
      "中文姓名、拼音或账号",
      "权限管理",
      "张三",
    ]) {
      expect(html).toContain(label);
    }
    expect(html).toContain("color-scheme: dark");
    expect(html).toContain("default-src 'none'");
    expect(html).not.toMatch(/<script[^>]*src=|<link\b|\binnerHTML\b/iu);
    const script = /<script>([^]*?)<\/script>/u.exec(html)?.[1] ?? "";
    expect(script).not.toBe("");
    expect(() => new Script(script)).not.toThrow();
    const hash = createHash("sha256").update(script).digest("base64");
    expect(html).toContain("script-src 'sha256-" + hash + "'");
  });

  it("转义脚本数据中的闭合标签及 HTML 和 JS 特殊字符", () => {
    const malicious = "</script><img onerror=alert(1)> &\u2028\u2029";
    const html = renderTeamConfigEditorHtml({
      ...data,
      products: [{ id: 42, name: malicious }],
      users: [
        { account: "zhangsan", realname: malicious, pinyin: null, dept: null },
      ],
      config: {},
    });
    expect(html).not.toContain("<img");
    expect(html.match(/<\/script>/gu)).toHaveLength(2);
    const json = payload(html);
    expect(json).not.toMatch(/[<>&\u2028\u2029]/u);
    for (const character of [
      "\\u003c",
      "\\u003e",
      "\\u0026",
      "\\u2028",
      "\\u2029",
    ]) {
      expect(json).toContain(character);
    }
    expect(JSON.parse(json)).toMatchObject({
      products: [{ name: malicious }],
      users: [{ realname: malicious }],
    });
  });

  it("本地文件导入在原 JSON 预览区等待读取，仍支持离线和减少动态效果", () => {
    const html = renderTeamConfigEditorHtml({ ...data, config: {} });
    expect(html).toContain("import-preview");
    expect(html).toContain("aria-busy");
    expect(html).toContain("prefers-reduced-motion");
    expect(html).toContain("sk-pulse");
  });

  it("保留非编辑配置段，且目录的额外字段不进入页面", () => {
    const config = {
      calendar: {
        holidays: ["2026-12-25", "2027-01-01"],
        extraWorkdays: ["2027-01-02"],
      },
      pairs: [{ design: 42, runtime: 43 }],
      rules: { R06: { enabled: false, systemStartDate: "2027-01-01" } },
      notify: { digest: { time: "08:15" } },
      http: { concurrency: 3 },
    };
    const users = data.users.map((user) => ({
      ...user,
      passwordHash: "hidden-fixture",
    }));
    const products = [
      { id: 42, name: "天宫", baseUrl: "https://internal.invalid/zentao" },
    ];
    const html = renderTeamConfigEditorHtml({
      ...data,
      config,
      users,
      products,
    });
    expect(JSON.parse(payload(html))).toMatchObject({
      config,
      users: data.users,
    });
    expect(JSON.parse(payload(html))).toHaveProperty("config", config);
    expect(html).not.toMatch(
      /hidden-fixture|https:\/\/internal\.invalid|passwordHash|BZT_WECOM_WEBHOOK/u,
    );
  });

  it.each([
    { notify: { secret: "example-do-not-embed" } },
    { aliases: { 临时账号: "Bearer synthetic-auth-fixture" } },
    { aliases: { 禅道地址: "http://internal.invalid/zentao" } },
    { aliases: { 误填环境变量名: "BZT_WECOM_WEBHOOK" } },
  ])("拒绝不安全的初始配置", (config) => {
    expect(() => renderTeamConfigEditorHtml({ ...data, config })).toThrow(
      /凭据|地址/u,
    );
  });
});
