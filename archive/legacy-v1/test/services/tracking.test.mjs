import { expect, it } from "vitest";
import { createBetterZentao } from "../../src/index.ts";
import { envFor, FIXED_NOW, newFixture } from "../fixtures/zentao.mjs";

const setup = (fixture = newFixture(), options = {}) => ({
  fixture, client: createBetterZentao({ env: envFor(), fetchImpl: fixture.fetchImpl, now: () => FIXED_NOW, ...options }),
});
const respond = (data, status = 200) => new Response(JSON.stringify(data), { status, headers: { "Content-Type": "application/json" } });

it("TC-READ-01 我的地盘聚合用户、对象 Map 任务、数组需求、分项待办及临期窗", async () => {
  const { client, fixture } = setup();
  fixture.stories.get(102).assignedTo = { account: "yi", realname: "旧名称" };
  Object.assign(fixture.stories.get(103), { assignedTo: "closed", openedBy: "jia" });
  const dashboard = await client.tracking.getMyDashboard();
  expect(dashboard).toMatchObject({
    me: { account: "jia", realname: "用户甲", deptName: "研发部" },
    todoCount: 15,
  });
  expect(dashboard.todoBreakdown).toEqual({
    task: 5, aitask: 1, story: 2, bug: 3, case: 0, testtask: 1, requirement: 2, issue: 0,
    risk: 0, reviewissue: 0, qa: 0, meeting: 0, ticket: 0, feedback: 0, epic: 1,
  });
  expect(dashboard.overdueTasks.map(task => [task.id, task.overdueDays])).toEqual([[13, 3]]);
  expect(dashboard.upcomingTasks.map(task => [task.id, task.overdueDays])).toEqual([[15, 0]]);
  expect(dashboard.assignedStories).toContainEqual(expect.objectContaining({
    id: 101, openedBy: { account: "yi", realname: "用户乙" },
  }));
  expect(dashboard.openedStories).toMatchObject([
    { id: 102, assignedTo: { account: "yi", realname: "用户乙" } }, { id: 103, assignedTo: null },
  ]);
  expect(dashboard.summary).toContain("待办 15");
  expect((await client.tracking.getMyDashboard({ upcomingDays: 1 })).upcomingTasks).toEqual([]);
  expect(fixture.requests.filter(request => request.path === "/api.php/v2/users")).toHaveLength(1);
  const reads = fixture.requests.filter(request => request.path.includes("/my/"));
  expect(reads).toEqual(expect.arrayContaining([
    expect.objectContaining({ path: "/api.php/v2/my/work", query: expect.objectContaining({ mode: "task", browseType: "assignedTo" }) }),
    expect.objectContaining({ path: "/api.php/v2/my/work", query: expect.objectContaining({ mode: "story", browseType: "assignedTo" }) }),
    expect.objectContaining({ path: "/api.php/v2/my/contribute", query: expect.objectContaining({ browseType: "openedBy" }) }),
  ]));
  expect(reads.some(item => item.path.endsWith("/my/todo"))).toBe(false);
  expect(reads.every(item => item.query.type === undefined)).toBe(true);
});

it.each([
  ["有分项", { task: "2", story: 3, bug: -1, requirement: 1.5, epic: 0, password: 1000, unknown: 10 },
    5, { task: 2, story: 3, epic: 0 }, 0],
  ["有效零值", { task: 0, story: 0, unknown: 4 }, 0, { task: 0, story: 0 }, 0],
  ["旧版总数", { todo: 4 }, 4, undefined, 0],
  ["缺少可识别分项", { unknown: 10 }, 3, undefined, 1],
])("TC-READ-01 待办为%s时只统计白名单且只在统计缺失时回退", async (_, raw, total, breakdown, todoRequests) => {
  const { client, fixture } = setup(newFixture({
    override: request => ["/api.php/v2/my/work", "/api.php/v2/my/contribute"].includes(request.path)
      ? respond({ tasks: [], stories: [], todoCount: raw }) : undefined,
  }));
  const dashboard = await client.tracking.getMyDashboard();
  expect(dashboard.todoCount).toBe(total);
  expect(dashboard.todoBreakdown).toEqual(breakdown);
  expect(fixture.requests.filter(request => request.path === "/api.php/v2/my/todo")).toHaveLength(todoRequests);
});

it("TC-READ-01 待办总数与明细取自同一工作列表", async () => {
  const { client, fixture } = setup(newFixture({
    override: request => request.path === "/api.php/v2/my/work" ? respond({
      tasks: [], stories: [], todoCount: request.query.mode === "task" ? 99 : { task: 1, bug: 3 },
    }) : undefined,
  }));
  const dashboard = await client.tracking.getMyDashboard();
  expect(dashboard).toMatchObject({ todoCount: 4, todoBreakdown: { task: 1, bug: 3 } });
  expect(fixture.requests.some(request => request.path === "/api.php/v2/my/todo")).toBe(false);
});

it("TC-READ-02 团队按默认部门、指定部门、别名或成员确定范围并列出未解析姓名", async () => {
  const { client } = setup(newFixture(), { teams: { 交付协作: { department: "交付部", members: ["用户乙", "未知成员"] } } });
  const defaults = await client.tracking.getTeamOverdue();
  expect(defaults.scope).toMatchObject({ type: "department", departmentId: 1, memberCount: 3 });
  expect(defaults.byMember.map(member => member.account)).toEqual(["yi", "jia"]);
  const department = await client.tracking.getTeamOverdue({ department: "平台组" });
  expect(department.scope).toMatchObject({ departmentId: 2, memberCount: 2 });
  expect(department.byMember.map(member => member.account)).toEqual(["yi"]);
  const alias = await client.tracking.getTeamOverdue({ team: "交付协作" });
  expect(alias.scope).toMatchObject({ type: "team", name: "交付协作", departmentId: 3 });
  expect(alias.byMember.map(member => member.account)).toEqual(["yi", "bing"]);
  expect(alias.unresolvedMembers).toEqual(["未知成员"]);
  const explicit = await client.tracking.getTeamOverdue({ members: ["用户甲", "王同名", "不存在的账号"] });
  expect(explicit.scope).toMatchObject({ type: "members", memberCount: 1 });
  expect(explicit.byMember.map(user => user.account)).toEqual(["jia"]);
  expect(explicit.unresolvedMembers).toEqual(["王同名", "不存在的账号"]);
});

it("TC-READ-03 父子任务默认只计两个叶子任务，显式包含时标记父任务", async () => {
  const { client, fixture } = setup();
  const input = { members: ["用户甲", "用户乙"], includeMultiUserDetail: false };
  const leaves = await client.tracking.getTeamOverdue(input);
  expect(leaves.totalOverdueTasks).toBe(2);
  expect(leaves.byMember.flatMap(member => member.tasks.map(task => task.id))).toEqual([12, 13]);
  const all = await client.tracking.getTeamOverdue({ ...input, includeParentTasks: true });
  expect(all.totalOverdueTasks).toBe(3);
  expect(all.byMember.flatMap(member => member.tasks).find(task => task.id === 11).isParent).toBe(true);
  expect(fixture.requests.some(request => request.path === "/api.php/v1/tasks/14")).toBe(false);
});

it("TC-READ-04 linear/multi 按未完成协作者归属并使用目录姓名，团队总数按任务去重", async () => {
  const { client, fixture } = setup();
  fixture.tasks.push({
    id: 16, name: "并行任务", execution: 601, mode: "multi", assignedTo: "yi", status: "doing", deadline: "2026-11-17",
    team: [{ account: "yi", status: "closed", realname: "93142" }, { account: "jia", status: "doing", realname: "93143" },
      { account: "bing", status: "wait", realname: "93144" }],
  });
  const result = await client.tracking.getTeamOverdue({ members: ["用户甲", "用户乙", "用户丙"] });
  expect(result.totalOverdueTasks).toBe(4);
  const participants = id => result.byMember.flatMap(user => user.tasks.filter(task => task.id === id).map(task => task.assignedTo));
  expect(participants(14)).toEqual([{ account: "jia", realname: "用户甲" }, { account: "bing", realname: "用户丙" }]);
  expect(participants(16)).toEqual(participants(14));
  expect(JSON.stringify(result)).not.toMatch(/"realname":"\d+"/);
  expect(fixture.requests.filter(request => /^\/api\.php\/v1\/tasks\/(14|16)$/.test(request.path))).toHaveLength(2);
  expect(fixture.requests.find(request => request.path.endsWith("/601/tasks")).query).toMatchObject({ limit: "200", page: "1", status: "delayed" });
});

it("TC-READ-05 四种未完成状态均可逾期，排除终态、无效日期与当天截止，按最大逾期倒序", async () => {
  const task = (id, status, deadline, assignedTo = "jia") => ({ id, execution: 601, assignedTo, name: "任务 " + id, status, deadline });
  const data = [
    task(1, "wait", "2026-11-16"), task(2, "doing", "2026-11-14", "yi"),
    task(3, "pause", "2026-11-17"), task(4, "changed", "2026-11-18", "yi"),
    task(5, "done", "2026-11-01"), task(6, "closed", "2026-11-02"), task(7, "cancel", "2026-11-03"),
    task(8, "wait", null), task(9, "doing", ""), task(10, "doing", "0000-00-00"), task(11, "wait", "2026-11-19"),
  ];
  const fixture = newFixture({
    override: request => request.path.endsWith("/601/tasks") ? respond({ page: 1, total: data.length, limit: 200, tasks: data }) : undefined,
  });
  const { client } = setup(fixture);
  const result = await client.tracking.getTeamOverdue({ members: ["用户甲", "用户乙"] });
  expect(result.totalOverdueTasks).toBe(4);
  expect(result.byMember.map(entry => [entry.account, entry.maxOverdueDays])).toEqual([["yi", 5], ["jia", 3]]);
  expect(result.byMember.flatMap(entry => entry.tasks.map(task => [task.id, task.status])))
    .toEqual([[2, "doing"], [4, "changed"], [1, "wait"], [3, "pause"]]);
});

it("TC-READ-06 跨页用相容状态参数，具体状态本地筛选且声明扫描截断", async () => {
  const fixture = newFixture({
    override: (request, { stories }) => {
      if (!request.path.endsWith("/42/stories")) return;
      const pool = request.query.status === "all" ? [102, 101, 103] : [102, 101, 102];
      const page = Number(request.query.page);
      return respond({ page, total: pool.length, limit: 1, stories: [stories.get(pool[page - 1])] }, 201);
    },
  });
  const { client } = setup(fixture);
  const active = await client.tracking.queryStories({ product: 42, status: "active", maxScanPages: 2 });
  expect(active).toMatchObject({ totalScanned: 2, truncated: true, matchedCount: 1, stories: [{ id: 101 }] });
  const calls = () => fixture.requests.filter(request => request.path.endsWith("/42/stories")).map(request => [request.query.status, request.query.page]);
  expect(calls()).toEqual([["unclosed", "1"], ["unclosed", "2"]]);
  const closed = await client.tracking.queryStories({ product: 42, status: "closed", maxScanPages: 3 });
  expect(closed).toMatchObject({ totalScanned: 3, truncated: false, matchedCount: 1, stories: [{ id: 103 }] });
  expect(calls().slice(2)).toEqual([["all", "1"], ["all", "2"], ["all", "3"]]);
  expect((await client.tracking.queryStories({ product: 42, status: "draft", maxScanPages: 2 })).stories.map(row => row.id)).toEqual([102]);
  expect(calls().slice(-2).map(([status]) => status)).toEqual(["unclosed", "unclosed"]);
});

it("TC-READ-07 组合关键词、中文类别/阶段、计划、人员和多人反馈者过滤，兼容历史类别", async () => {
  const { client } = setup();
  const result = await client.tracking.queryStories({
    product: "天宫", keyword: "自测", category: "design", status: "active", stage: "设计完成", plan: "改进入口",
    assignedTo: "用户甲", openedBy: "用户乙", feedbackBy: "反馈人乙",
  });
  expect(result.stories).toMatchObject([{
    id: 101, categoryLabel: "设计类", statusLabel: "激活", stageLabel: "设计完成", planId: 4221,
    planTitle: "【负责甲】改进入口", planUrl: expect.stringContaining("planID=4221"),
    assignedTo: { account: "jia", realname: "用户甲" }, openedBy: { account: "yi", realname: "用户乙" },
    url: expect.stringContaining("storyID=101"),
  }]);
  expect((await client.tracking.queryStories({ state: "design", category: "feature" })).stories.map(story => story.categoryLabel)).toEqual(["研发类"]);
  expect((await client.tracking.queryStories({ state: "design", status: "all", category: "interface" })).stories[0].category).toBe("interface");
  expect((await client.tracking.queryStories({ product: 42, feedbackBy: "未命中", assignedTo: "jia" })).matchedCount).toBe(0);
});

it("TC-READ-08 用户需求经 v2 专用接口读取且本地剔除混入的研发需求", async () => {
  const fixture = newFixture({
    override: (request, { requirements, stories }) => {
      if (request.path !== "/api.php/v2/product/browse" || request.query.storyType !== "requirement") return;
      return respond({ stories: { 701: requirements.get(701), 101: stories.get(101) }, pager: { pageID: 1, pageTotal: 1 } });
    },
  });
  const { client } = setup(fixture);
  const result = await client.tracking.queryStories({ state: "design", storyType: "requirement" });
  expect(result.stories).toMatchObject([{ id: 701, type: "requirement", url: expect.stringContaining("m=requirement") }]);
  expect(fixture.requests.some(request => request.path === "/api.php/v1/products/42/stories")).toBe(false);
  expect(fixture.requests.find(request => request.path.endsWith("/product/browse")).query)
    .toEqual({ productID: "42", storyType: "requirement", recPerPage: "100", pageID: "1" });
});

it("TC-READ-09 需求任务从关联执行补齐截止日期、工时和逾期天数，输出反馈者摘要", async () => {
  const { client, fixture } = setup();
  const result = await client.tracking.getStoryProgress({ storyId: 101 });
  expect(result).toMatchObject({
    id: 101, plan: { id: 4221, level: "L3" }, overdueCount: 1,
    tasks: [{ id: 13, deadline: "2026-11-16", left: 2.5, overdueDays: 3, url: expect.stringContaining("taskID=13") }],
  });
  expect(result.feedbackSummary).toContain("《提交入口改进》");
  expect(result.feedbackSummary).toContain("逾期 1 项");
  expect(result).not.toHaveProperty("actions");
  expect(fixture.requests.some(request => request.path.endsWith("/601/tasks"))).toBe(true);
  expect(fixture.requests.some(request => request.path === "/api.php/v1/tasks/13")).toBe(false);
  const actions = await client.tracking.getStoryProgress({ storyId: 101, includeActions: true });
  expect(actions.actions).toEqual([expect.objectContaining({ id: 88, action: "opened" })]);
  expect(actions.actions[0]).not.toHaveProperty("comment");
  fixture.stories.get(101).executions = {};
  expect((await client.tracking.getStoryProgress({ storyId: 101 })).tasks[0]).toMatchObject({ deadline: "2026-11-16", left: 2.5 });
  expect(fixture.requests.some(request => request.path === "/api.php/v1/tasks/13")).toBe(true);
});

it("TC-READ-10 按单个反馈者跨三态匹配多人字符串并汇总反馈卡片", async () => {
  const { client, fixture } = setup();
  const result = await client.tracking.getStoryProgress({ feedbackBy: "反馈人甲" });
  expect(result.stories.map(story => story.id)).toEqual([101, 201, 301]);
  expect(result.stories[0].feedbackBy).toBe("反馈人甲、反馈人乙");
  expect(result.feedbackSummary).toContain("交付态反馈");
  expect(result.feedbackSummary).toContain("运行态反馈");
  expect(result.products.map(product => product.id)).toEqual([42, 43, 44]);
  expect(fixture.requests.filter(request => /\/products\/\d+\/stories$/.test(request.path))).toHaveLength(3);
});

it("TC-READ-10 多张进度卡共享任务请求并发上限", async () => {
  let running = 0;
  let peak = 0;
  const fixture = newFixture({
    override: async request => {
      if (!/^\/api\.php\/v1\/executions\/\d+\/tasks$/.test(request.path)) return;
      peak = Math.max(peak, ++running);
      await new Promise(resolve => setTimeout(resolve, 5));
      running--;
    },
  });
  for (let index = 0; index < 10; index++) {
    const id = 1000 + index;
    const execution = 7000 + index * 3;
    const task = { id: 2000 + index, name: "实施", status: "doing", assignedTo: "jia" };
    fixture.stories.set(id, {
      ...fixture.stories.get(101), id, feedbackBy: "并发样例", tasks: [task],
      executions: [{ id: execution }, { id: execution + 1 }, { id: execution + 2 }],
    });
    fixture.tasks.push({ ...task, execution, left: 1, deadline: "2026-11-18" });
  }
  const { client } = setup(fixture);
  const result = await client.tracking.getStoryProgress({ product: 42, feedbackBy: "并发样例" });
  expect(result.stories).toHaveLength(10);
  expect(result.stories.every(card => card.tasks[0].overdueDays === 1)).toBe(true);
  expect(peak).toBeGreaterThan(1);
  expect(peak).toBeLessThanOrEqual(8);
});

it("TC-READ-11 用户需求走 v2 详情并展示分组关系中的研发需求进度", async () => {
  const { client, fixture } = setup();
  const result = await client.tracking.getStoryProgress({ requirementId: 701 });
  expect(result.requirement).toMatchObject({ id: 701, type: "requirement", statusLabel: "激活" });
  expect(result.linkedStories).toMatchObject([{ id: 101, stageLabel: "设计完成", overdueCount: 1 }]);
  expect(result.feedbackSummary).toContain("《用户需求样例》");
  expect(result.feedbackSummary).toContain("《提交入口改进》");
  expect(fixture.requests.some(request => request.path === "/api.php/v2/requirement/view" && request.query.storyID === "701")).toBe(true);
  expect(fixture.requests.some(request => request.path === "/api.php/v1/stories/701")).toBe(false);
});
