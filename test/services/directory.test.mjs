import { expect, it } from "vitest";
import { createBetterZentao } from "../../src/index.ts";
import { planMatchesMonth } from "../../src/api/product.api.ts";
import { envFor, FIXED_NOW, newFixture } from "../fixtures/zentao.mjs";

const setup = (fixture = newFixture(), options = {}) =>
  createBetterZentao({ env: envFor(), fetchImpl: fixture.fetchImpl, now: () => FIXED_NOW, ...options });
const respond = data => new Response(JSON.stringify(data), { headers: { "Content-Type": "application/json" } });

it("TC-DIR-01 v2 用户翻页、剔除已删除项、TTL 内共享缓存并在超时后刷新", async () => {
  const fixture = newFixture({
    override: (request, { userRows }) => {
      if (request.path !== "/api.php/v2/users") return;
      const page = Number(request.query.pageID);
      return respond({ users: userRows.slice((page - 1) * 3, page * 3), pager: { pageID: page, pageTotal: 2 } });
    },
  });
  let now = FIXED_NOW.getTime();
  const { directory } = setup(fixture, { cacheTtlMs: 100, now: () => new Date(now) });
  const [first, concurrent] = await Promise.all([directory.users(), directory.users()]);
  expect(first.map(item => item.account)).toEqual(["jia", "yi", "bing", "wang1", "wang2"]);
  expect(concurrent).toEqual(first);
  const pages = () => fixture.requests.filter(request => request.path === "/api.php/v2/users").map(request => request.query);
  expect(pages()).toEqual([{ recPerPage: "3000", pageID: "1" }, { recPerPage: "3000", pageID: "2" }]);
  const requestCount = fixture.requests.length;
  now += 99;
  await directory.users();
  expect(fixture.requests).toHaveLength(requestCount);
  now += 2;
  await directory.users();
  expect(pages().map(page => page.pageID)).toEqual(["1", "2", "1", "2"]);
});

it("TC-DIR-02 中文、拼音和账号精确匹配，重名和同姓给齐候选部门路径与角色", async () => {
  const { directory } = setup();
  for (const query of ["用户甲", "YONGHUJIA", "jia"]) {
    expect(await directory.findUser(query)).toMatchObject({ match: "exact", ambiguous: false, candidates: [{ account: "jia" }] });
  }
  for (const [query, mode] of [["王同名", "exact"], ["王", "fuzzy"]]) {
    const output = await directory.resolveContext({ query, kinds: ["user"] });
    expect(output.ambiguous).toBe(true);
    expect(output.matches.user).toMatchObject({
      match: mode, ambiguous: true, candidates: [
        { account: "wang1", departmentPath: "研发部 / 平台组", role: "dev" },
        { account: "wang2", departmentPath: "交付部", role: "qa" },
      ],
    });
  }
});

it("TC-DIR-03 展平 424 个节点与五级面包屑，部门包含直属和后代成员", async () => {
  const node = (id, name, parent, items = []) => ({ id, name, parent, items });
  const leaf = node(5, "实现小组", 4);
  const main = node(1, "总部门", 0, [
    node(2, "研发二部", 1, [node(3, "系统组", 2, [node(4, "平台小队", 3, [leaf])])]),
    ...Array.from({ length: 419 }, (_, index) => node(index + 6, "样例分部" + index, 1)),
  ]);
  const fixture = newFixture({
    departmentRows: [main],
    userRows: [
      { account: "root", realname: "根成员", dept: 1 },
      { account: "child", realname: "子组成员", dept: 2 },
      { account: "leaf", realname: "最深成员", dept: 5 },
      { account: "outside", realname: "外部成员", dept: 0 },
    ],
  });
  const { directory } = setup(fixture);
  expect(await directory.departments()).toHaveLength(424);
  expect(await directory.findDepartment("实现")).toMatchObject({
    match: "fuzzy", candidates: [{ id: 5, path: "总部门 / 研发二部 / 系统组 / 平台小队 / 实现小组", ancestorIds: [1, 2, 3, 4] }],
  });
  expect((await directory.membersOf(1)).map(user => user.account)).toEqual(["root", "child", "leaf"]);
  expect((await directory.membersOf(2)).map(user => user.account)).toEqual(["child", "leaf"]);
});

it("TC-DIR-04 L2 与 L3 展平后保留父计划、负责人和计划链接", async () => {
  const fixture = newFixture();
  const { directory } = setup(fixture);
  const plans = await directory.plans(42);
  expect(plans.find(plan => plan.id === 4210)).toMatchObject({ level: "L2", title: "【L2-建设目标】产品计划" });
  expect(plans.find(plan => plan.id === 4223)).toMatchObject({
    parentId: 4210, parentTitle: "【L2-建设目标】产品计划", level: "L3", ownerHint: "张三", url: expect.stringContaining("planID=4223"),
  });
  expect(plans.find(plan => plan.id === 4250).level).toBe("standalone");
  expect(fixture.requests.find(request => request.path.endsWith("/plans")).query.limit).toBe("200");
});

it("TC-DIR-05 按有效日期重叠优先匹配月份，无日期才解析标题月份", async () => {
  const { directory } = setup();
  const november = await directory.findPlan(42, "2026-11");
  expect(november.candidates.map(plan => plan.id)).toEqual([4221, 4222, 4223, 4224]);
  expect(november.candidates[0].title).not.toContain("11月");
  expect((await directory.findPlan(42, "2027-01")).candidates.map(plan => plan.id)).toEqual([4222]);
  expect((await directory.findPlan(42, "2027-11")).candidates).toEqual([]);
  expect(planMatchesMonth({ title: "2026年11月，实际调整到12月", begin: "2026-12-01", end: "2026-12-31" }, "2026-11")).toBe(false);
  expect(planMatchesMonth({ title: "第11版任务", begin: "0000-00-00", end: "" }, "2026-11")).toBe(false);
});

it("TC-DIR-06 三态默认产品、中文与英文关键词、模块路径和产品候选摘要", async () => {
  const { directory } = setup();
  expect((await Promise.all(["design", "runtime", "delivery"].map(state => directory.chooseProduct({ state }))))
    .map(product => product.id)).toEqual([42, 43, 44]);
  for (const [query, expected] of [["天宫", 42], ["OneLink", 43], ["运营交付", 44]]) {
    const result = await directory.resolveContext({ query, kinds: ["product"] });
    expect(result.matches.product.candidates[0]).toMatchObject({
      id: expected, moduleSummary: { count: 3 }, activeL3Plans: [expect.objectContaining({ level: "L3" }), expect.anything(), expect.anything()],
    });
  }
  const module = await directory.resolveContext({ query: "平台/提交", product: "运营交付", kinds: ["module"] });
  expect(module.matches.module).toMatchObject({
    match: "fuzzy", ambiguous: false, candidates: [{ id: 441, name: "提交入口", path: "平台/提交入口" }],
  });
});
