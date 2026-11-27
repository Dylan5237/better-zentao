import { expect, it } from "vitest";
import { readFile } from "node:fs/promises";
import { createHash } from "node:crypto";
// @ts-expect-error Native browser module.
import * as guide from "../../web/review-page.js";

it("按原型保留五个业务入口与独立的评审入口，操作受当前职责限制", () => {
  const nav = guide.sectionsFor({
    id: "FB",
    actions: ["get_my_work", "query_stories", "create_story"],
  });
  expect(nav.map((entry: { id: string }) => entry.id)).toEqual([
    "workbench",
    "intake",
  ]);
  expect(
    nav.find((entry: { id: string }) => entry.id === "intake").recommended,
  ).toBe(true);
});

it("真实入口使用原型角色标签、侧栏与原型样式，加载业务页面", async () => {
  const html = await readFile("web/index.html", "utf8");
  expect(html).toContain('class="role-switcher"');
  expect(html).toContain('class="bzt-sidebar"');
  expect(html).toContain('class="bzt-main"');
  expect(html).toContain("/meridian.css");
});

it("导出的结果区分待讨论和用户在本次会议记录的意见", () => {
  const minutes = guide.meetingMarkdown(
    new Map([["D-01", { status: "需调整", note: "保留月度目标" }]]),
  );
  expect(minutes).toContain("保留月度目标");
  expect(minutes).toMatch(/D-01[^\n]*需调整/u);
  expect(minutes).toMatch(/D-02[^\n]*待讨论/u);
  expect(minutes).toContain("D-16");
});

it("产品化外壳统一品牌并保留命令检索、折叠及深浅主题（Issue #6 / M2-01）", async () => {
  const html = await readFile("web/index.html", "utf8");
  for (const value of [
    "better-zentao",
    "sidebar-scroll",
    "sidebar-role-card",
    "theme-button",
    "command-button",
  ])
    expect(html).toContain(value);
  expect(html).not.toContain("脉序 × better-zentao");
  expect(html).not.toContain("bzt-version-pill");
  expect(html).not.toContain("本机门户");
});

it("载入伏羲 mwskyptfsv2y4a 第 11 版的两段原始样式", async () => {
  const css = (await readFile("web/meridian.css", "utf8")).replaceAll(
    "\r\n",
    "\n",
  );
  // 伏羲 v11 正式入口的两个 style 按原顺序拼接并用项目 Prettier 格式化。
  expect(createHash("sha256").update(css).digest("hex")).toBe(
    "35ce5dbf2e1bc48939d08563cdaada3ce6c38d15d24777dda65a28b30e450ae2",
  );
});
