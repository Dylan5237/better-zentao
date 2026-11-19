import { expect, it } from "vitest";
import { createBetterZentao, InvalidParamError } from "../../src/index.ts";
import { draftInput, envFor, FIXED_NOW, newFixture, PASSWORD, TOKEN } from "../fixtures/zentao.mjs";

const setup = (fixture = newFixture()) => ({
  fixture, intake: createBetterZentao({ env: envFor(), fetchImpl: fixture.fetchImpl, now: () => FIXED_NOW }).intake,
});
const respond = (data, status = 200) => new Response(JSON.stringify(data), { status, headers: { "Content-Type": "application/json" } });
const upstreamError = () => respond({ error: TOKEN + PASSWORD }, 503);
const createWrites = fixture => fixture.businessWrites().filter(request => request.method === "POST" && request.path.endsWith("/stories"));
const requiredV1 = ["title", "module", "spec", "verify"];

it("TC-WRITE-01 默认预检只读，解出中文实体并拉取动态必填与当前模块菜单", async () => {
  const { intake, fixture } = setup();
  const preview = await intake.createStory({ ...draftInput, product: "天宫", plan: "改进入口" });
  expect(preview).toMatchObject({
    dryRun: true, allOk: true, warnings: [],
    drafts: [{
      product: { id: 42 }, resolvedModule: { id: 421 }, resolvedPlan: { id: 4221, level: "L3" },
      resolvedAssignTo: { account: "jia", realname: "用户甲" }, errors: [],
      payloadPreview: { title: draftInput.title, spec: draftInput.spec, plan: 4221, module: 421, assignedTo: "jia" },
    }],
  });
  expect(preview.drafts[0].payloadPreview).not.toHaveProperty("needNotReview");
  expect(fixture.requests.some(request => request.method === "GET" && request.path.endsWith("/requiredFields"))).toBe(true);
  expect(fixture.requests.find(request => request.path === "/api.php/v1/products/42").query).toEqual({ fields: "moduleOptionMenu" });
  const invalid = await intake.createStory({ ...draftInput, product: 42, module: 441 });
  expect(invalid.allOk).toBe(false);
  expect(invalid.drafts[0].availableModules.map(module => module.id)).toContain(421);
  expect(invalid.drafts[0].errors.join(" ")).toContain("模块");
  expect(fixture.businessWrites()).toEqual([]);
});

it("TC-WRITE-02 缺 L3 计划提示候选但不拦截合规草稿", async () => {
  const { intake, fixture } = setup();
  const preview = await intake.createStory(draftInput);
  expect(preview.allOk).toBe(true);
  expect(preview.warnings).toEqual([expect.stringContaining("未关联 L3 计划")]);
  expect(preview.drafts[0].candidatePlans.map(plan => plan.id)).toEqual([4221, 4222, 4223]);
  expect(preview.drafts[0].candidatePlans.every(plan => plan.level === "L3" && plan.productId === 42)).toBe(true);
  expect(fixture.businessWrites()).toEqual([]);
});

it("TC-WRITE-03 personal 默认 draft、显式跳评审才 active，strict-ai 拒绝 skipReview", async () => {
  const { intake, fixture } = setup();
  const base = { ...draftInput, dryRun: false };
  const activation = await intake.createStory({ ...draftInput, skipReview: true });
  expect(activation.drafts[0].payloadPreview).toMatchObject({ status: "active", reviewer: [], needNotReview: true });
  expect(fixture.businessWrites()).toEqual([]);
  expect((await intake.createStory(base)).results[0].readbackConfirmed).toBe(true);
  expect((await intake.createStory({ ...base, skipReview: true })).results[0].readbackConfirmed).toBe(true);
  expect(createWrites(fixture).map(request => [request.body.status, request.body.reviewer, request.body.needNotReview]))
    .toEqual([["draft", [], undefined], ["active", [], true]]);
  const before = fixture.requests.length;
  await expect(intake.createStory({ ...base, mode: "strict-ai", skipReview: true })).rejects.toBeInstanceOf(InvalidParamError);
  expect(fixture.requests).toHaveLength(before);
  expect((await intake.createStory({ ...base, mode: "strict-ai", source: "user", batch: "phase1" })).allOk).toBe(true);
  expect(createWrites(fixture).at(-1).body).toMatchObject({
    title: "[AI创建] " + base.title, source: "ai", sourceNote: "AI-Agent-20261119-phase1", status: "draft",
  });
  expect(createWrites(fixture).at(-1).body).not.toHaveProperty("needNotReview");
  expect(fixture.stories.get(9001).status).toBe("draft");
  expect(fixture.stories.get(9002).status).toBe("active");
  expect(fixture.stories.get(9003).status).toBe("draft");
});

it("TC-WRITE-04 交付态 #44 支持研发类与设计类，未知类别在工具层拒绝", async () => {
  const { intake, fixture } = setup();
  const design = await intake.createStory({ ...draftInput, state: "delivery", category: "design", dryRun: false });
  expect(design.results[0]).toMatchObject({ product: { id: 44 }, category: "design", readbackConfirmed: true });
  const feature = await intake.createStory({ ...draftInput, product: "运营交付平台", category: "feature" });
  expect(feature.drafts[0]).toMatchObject({ product: { id: 44 }, resolvedModule: { id: 441 }, payloadPreview: { category: "feature" } });
  expect(fixture.requests.filter(request => request.path === "/api.php/v1/products/44").every(request => request.query.fields === "moduleOptionMenu")).toBe(true);
  const before = fixture.requests.length;
  await expect(intake.createStory({ ...draftInput, product: 44, category: "interface", dryRun: false })).rejects.toBeInstanceOf(InvalidParamError);
  expect(fixture.requests).toHaveLength(before);
  expect(createWrites(fixture)).toHaveLength(1);
});

it("TC-WRITE-05 assignedTo 必填路由到 v2，模块双写和回读为同一指派", async () => {
  const { intake, fixture } = setup();
  const result = await intake.createStory({ ...draftInput, plan: 4221, feedbackBy: "样例反馈", source: "user", dryRun: false });
  expect(result).toMatchObject({
    allOk: true, created: 1, failed: 0, readbackUnconfirmed: 0,
    results: [{ id: 9001, readbackConfirmed: true, assignResult: { assignedTo: "jia", confirmed: true } }],
  });
  expect(fixture.businessWrites()).toMatchObject([{
    method: "POST", path: "/api.php/v2/stories", query: { productID: "42" },
    body: { module: 421, modules: [421], reviewer: [], assignedTo: "jia", plan: 4221, feedbackBy: "样例反馈" },
  }]);
  expect(fixture.businessWrites()[0].body).not.toHaveProperty("needNotReview");
  expect(fixture.requests.some(request => request.method === "GET" && request.path === "/api.php/v1/stories/9001")).toBe(true);
  const beforeCreate = fixture.requests.slice(0, fixture.requests.indexOf(fixture.businessWrites()[0]));
  expect(beforeCreate.map(request => request.path)).toEqual(expect.arrayContaining([
    "/api.php/v1/requiredFields", "/api.php/v1/products/42",
  ]));
});

it("TC-WRITE-06 v1 创建先读回字段，再走独立 POST 指派并读取当前负责人", async () => {
  const { intake, fixture } = setup(newFixture({ requiredFields: requiredV1 }));
  const output = await intake.createStory({ ...draftInput, dryRun: false });
  expect(output.results[0]).toMatchObject({ id: 9001, readbackConfirmed: true, assignResult: { confirmed: true, assignedTo: "jia" } });
  const writes = fixture.businessWrites();
  expect(writes.map(request => request.path)).toEqual(["/api.php/v1/products/42/stories", "/api.php/v1/stories/9001/assign"]);
  expect(writes[0].body).not.toHaveProperty("assignedTo");
  expect(writes[0].body).not.toHaveProperty("modules");
  expect(writes[1]).toMatchObject({ method: "POST", body: { assignedTo: "jia" } });
  const sequence = fixture.requests.filter(request => /\/stories\/9001/.test(request.path)).map(request => request.method);
  expect(sequence).toEqual(["GET", "POST", "GET"]);
});

it.each([["读回失败", ["readback"]], ["字段变化", ["product", "title", "module", "verify", "plan", "feedbackBy"]]])(
  "TC-WRITE-07 %s 仍返回 ID 和链接，创建只发送一次", async (scenario, differences) => {
    const { intake, fixture } = setup(newFixture({
      override: (request, { stories }) => {
        if (request.path !== "/api.php/v1/stories/9001") return;
        if (scenario === "读回失败") return upstreamError();
        return respond({ ...stories.get(9001), product: 43, title: "变更标题", module: 999, plan: "0", feedbackBy: "", verify: "" });
      },
    }));
    const result = await intake.createStory({ ...draftInput, plan: 4221, feedbackBy: "样例反馈", source: "user", dryRun: false });
    expect(result).toMatchObject({ allOk: false, created: 1, readbackUnconfirmed: 1, results: [{
      id: 9001, url: expect.stringContaining("storyID=9001"), readbackConfirmed: false, differences,
      notice: expect.stringContaining("禁止重试创建"),
    }] });
    expect(createWrites(fixture)).toHaveLength(1);
    expect(JSON.stringify(result)).not.toContain(TOKEN);
  },
);

it("TC-WRITE-07 禅道按来源清除反馈者时保留 ID 并报告 feedbackBy 回读差异", async () => {
  const { intake, fixture } = setup();
  const input = { ...draftInput, plan: 4221, feedbackBy: "样例反馈" };
  const preview = await intake.createStory(input);
  expect(preview.drafts[0].payloadPreview).toMatchObject({ source: "", feedbackBy: "样例反馈" });
  expect(preview.warnings).toEqual([expect.stringContaining("可能使禅道清空 feedbackBy")]);
  const receipt = await intake.createStory({ ...input, dryRun: false });
  expect(receipt.results[0]).toMatchObject({ id: 9001, readbackConfirmed: false, differences: ["feedbackBy"] });
  expect(createWrites(fixture)).toHaveLength(1);
});

it("TC-WRITE-08 v1 指派失败后保留已建 ID、链接及指派未确认，不重建", async () => {
  const { intake, fixture } = setup(newFixture({
    requiredFields: requiredV1,
    override: request => request.method === "POST" && request.path.endsWith("/assign") ? upstreamError() : undefined,
  }));
  const result = await intake.createStory({ ...draftInput, dryRun: false });
  expect(result).toMatchObject({ allOk: false, created: 1, results: [{
    id: 9001, url: expect.stringContaining("9001"), readbackConfirmed: true,
    assignResult: { confirmed: false, assignError: expect.stringContaining("未确认") },
    notice: expect.stringContaining("禁止重试创建"),
  }] });
  expect(createWrites(fixture)).toHaveLength(1);
  expect(fixture.businessWrites().filter(request => request.path.endsWith("/assign"))).toHaveLength(1);
  expect(JSON.stringify(result)).not.toContain(PASSWORD);
});

it.each([[["design", "runtime"], false], [["design", "runtime", "delivery"], true]])(
  "TC-WRITE-09 states=%j 多态逐产品预检、共享批次，互链失败保留全部 ID", async (states, failLink) => {
    const { intake, fixture } = setup(newFixture({
      override: request => failLink && request.path === "/api.php/v2/story/linkStory" ? upstreamError() : undefined,
    }));
    const input = { ...draftInput, states, plan: "改进入口", batch: "cross-state" };
    const products = [42, 43, 44].slice(0, states.length);
    const preview = await intake.createStory(input);
    expect(preview.allOk).toBe(true);
    expect(preview.drafts.map(draft => [draft.product.id, draft.resolvedModule.id, draft.resolvedPlan.id]))
      .toEqual(products.map(id => [id, id * 10 + 1, id * 100 + 21]));
    expect(fixture.businessWrites()).toEqual([]);
    const result = await intake.createStory({ ...input, dryRun: false });
    const ids = products.map((_, index) => 9001 + index);
    expect(result.results.map(item => [item.product.id, item.id, item.readbackConfirmed])).toEqual(products.map((id, index) => [id, ids[index], true]));
    expect(createWrites(fixture).map(item => [item.query.productID, item.body.sourceNote]))
      .toEqual(products.map(id => [String(id), "AI-Agent-20261119-cross-state"]));
    const linking = fixture.businessWrites().filter(item => item.path === "/api.php/v2/story/linkStory");
    expect(linking.map(item => [Number(item.query.storyID), item.body.stories]))
      .toEqual(ids.slice(0, -1).map((id, index) => [id, ids.slice(index + 1)]));
    if (failLink) {
      expect(result.allOk).toBe(false);
      expect(result.results.every(item => item.linkError?.includes("人工补链") && item.notice.includes("禁止重试创建"))).toBe(true);
    } else {
      expect(result.allOk).toBe(true);
      expect([...fixture.links.get(ids[0])]).toEqual(ids.slice(1));
      expect([...fixture.links.get(ids[1])]).toEqual([ids[0]]);
    }
  },
);

it("TC-WRITE-10 设计和研发双单各一条，独立回读、同一批次且一次互链", async () => {
  const { intake, fixture } = setup();
  const input = { ...draftInput, createDevPair: true };
  const preview = await intake.createStory(input);
  expect(preview.drafts.map(draft => draft.payloadPreview.category)).toEqual(["design", "feature"]);
  expect(fixture.businessWrites()).toEqual([]);
  const result = await intake.createStory({ ...input, dryRun: false });
  expect(result.results).toMatchObject([
    { id: 9001, category: "design", readbackConfirmed: true, linkResult: { storyIds: [9002] } },
    { id: 9002, category: "feature", readbackConfirmed: true, linkResult: { storyIds: [9001] } },
  ]);
  expect(fixture.businessWrites().filter(item => item.path.endsWith("/linkStory"))).toHaveLength(1);
  expect(fixture.requests.filter(request => request.method === "GET" && /\/stories\/900[12]$/.test(request.path))).toHaveLength(2);
});

it.each([false, true])("TC-WRITE-11 用户需求预检及关联降级（关联失败=%s）", async failLink => {
  const { intake, fixture } = setup(newFixture({
    override: request => failLink && request.path === "/api.php/v2/requirement/linkStory" ? upstreamError() : undefined,
  }));
  const invalid = await intake.createStory({ ...draftInput, requirementId: 799 });
  expect(invalid.allOk).toBe(false);
  expect(invalid.drafts[0].errors.join(" ")).toContain("无法回读指定的用户需求");
  const valid = await intake.createStory({ ...draftInput, requirementId: 701 });
  expect(valid.allOk).toBe(true);
  expect(fixture.requests.some(request => request.path === "/api.php/v2/requirement/view" && request.query.storyID === "701")).toBe(true);
  expect(fixture.businessWrites()).toEqual([]);
  const result = await intake.createStory({ ...draftInput, requirementId: 701, dryRun: false });
  expect(result.results[0]).toMatchObject({ id: 9001, readbackConfirmed: true });
  expect(fixture.businessWrites().at(-1)).toMatchObject({
    method: "POST", path: "/api.php/v2/requirement/linkStory", query: { storyID: "701" }, body: { stories: [9001] },
  });
  if (failLink) {
    expect(result.results[0].linkError).toContain("人工补链");
    expect(result.allOk).toBe(false);
  } else {
    expect(result.results[0].linkResult.requirementId).toBe(701);
    expect(fixture.links.get(701).has(9001)).toBe(true);
    expect(fixture.links.get(9001).has(701)).toBe(true);
  }
  expect(createWrites(fixture)).toHaveLength(1);
});

it("TC-WRITE-12 导入严格校验未知字段，默认预检，实写单条失败后继续并按条给回执", async () => {
  const { intake, fixture } = setup(newFixture({
    override: request => {
      if (request.method === "POST" && request.body?.title === "模拟失败") return upstreamError();
      if (request.method === "GET" && request.path === "/api.php/v1/stories/9002") return upstreamError();
    },
  }));
  await expect(intake.importStories({ stories: [{ ...draftInput, unknown: true }] })).rejects.toBeInstanceOf(InvalidParamError);
  expect(fixture.requests).toEqual([]);
  const input = { stories: [
    { ...draftInput, title: "第一条" }, { ...draftInput, title: "模拟失败" }, { ...draftInput, title: "回读未确认" },
    { ...draftInput, title: "缺字段", verify: undefined }, { ...draftInput, title: "最后一条" },
  ] };
  const preview = await intake.importStories(input);
  expect(preview).toMatchObject({ dryRun: true, allOk: false, issueCount: 1, entries: [
    { index: 1, allOk: true }, { index: 2, allOk: true }, { index: 3, allOk: true }, { index: 4, allOk: false }, { index: 5, allOk: true },
  ] });
  expect(fixture.businessWrites()).toEqual([]);
  const result = await intake.importStories({ ...input, dryRun: false });
  expect(result).toMatchObject({ allOk: false, created: 3, failed: 2, readbackUnconfirmed: 1, results: [
    { index: 1, receipts: [{ id: 9001, readbackConfirmed: true }] },
    { index: 2, receipts: [{ error: { code: "CREATE_UNCONFIRMED" } }] },
    { index: 3, receipts: [{ id: 9002, readbackConfirmed: false }] },
    { index: 4, receipts: [], errors: [expect.stringContaining("verify")] },
    { index: 5, receipts: [{ id: 9003, readbackConfirmed: true }] },
  ] });
  expect(createWrites(fixture)).toHaveLength(4);
});

it("TC-WRITE-13 独立指派解析中文账号，仅当前负责人相符才确认", async () => {
  let makeMismatch = true;
  const { intake, fixture } = setup(newFixture({
    override: request => makeMismatch && request.path.endsWith("/assign") ? respond({ assignedTo: "yi" }) : undefined,
  }));
  const mismatch = await intake.assignStory({ storyId: 102, assignedTo: "用户乙", comment: "样例" });
  expect(mismatch).toMatchObject({ assignedTo: "jia", requestedAssignedTo: "yi", confirmed: false });
  expect(fixture.businessWrites()[0]).toMatchObject({
    method: "POST", path: "/api.php/v1/stories/102/assign", body: { assignedTo: "yi", comment: "样例" },
  });
  makeMismatch = false;
  expect(await intake.assignStory({ storyId: 102, assignedTo: "用户乙" }))
    .toMatchObject({ assignedTo: "yi", requestedAssignedTo: "yi", confirmed: true });
  expect(fixture.requests.filter(request => request.method === "GET" && request.path === "/api.php/v1/stories/102")).toHaveLength(2);
});

it("TC-WRITE-14 省略和否定确认均零请求，确认后 DELETE 加 GET 验证软删除", async () => {
  const { intake, fixture } = setup();
  await expect(intake.deleteStory({ storyId: 101 })).rejects.toBeInstanceOf(InvalidParamError);
  await expect(intake.deleteStory({ storyId: 101, confirm: false })).rejects.toBeInstanceOf(InvalidParamError);
  expect(fixture.requests).toEqual([]);
  const result = await intake.deleteStory({ storyId: 101, confirm: true });
  expect(result).toMatchObject({ id: 101, deleted: true, confirmed: true, notice: expect.stringContaining("回收站") });
  expect(fixture.requests.filter(request => request.path === "/api.php/v1/stories/101").map(request => request.method)).toEqual(["DELETE", "GET"]);
});
