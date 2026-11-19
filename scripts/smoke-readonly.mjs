import assert from "node:assert/strict";
import { performance } from "node:perf_hooks";
import { createBetterZentao, resolveConfig, ZentaoError } from "../dist/index.js";

const gates = ["TC-LIVE-01", "TC-LIVE-02", "TC-LIVE-03", "TC-LIVE-04", "TC-LIVE-05"];
const states = ["design", "runtime", "delivery"];

async function verify() {
  const config = resolveConfig();
  const base = config.baseUrl;
  const login = base + "/api.php/v1/tokens";
  const todoEndpoint = base + "/api.php/v2/my/todo";
  let getCount = 0;
  let todoReads = 0;
  let loginCount = 0;
  let blockedCount = 0;
  const guardedFetch = (url, options = {}) => {
    const target = String(url);
    const method = options.method ?? "GET";
    if (method === "GET" && target.startsWith(base + "/")) {
      getCount++;
      if (target === todoEndpoint || target.startsWith(todoEndpoint + "?")) todoReads++;
    } else if (method === "POST" && target === login) loginCount++;
    else {
      blockedCount++;
      throw new Error("只读冒烟拦截了未授权请求");
    }
    return fetch(url, { ...options, redirect: "error" });
  };
  const platform = await guardedFetch(base + "/index.php?mode=getconfig", { signal: AbortSignal.timeout(config.timeoutMs) });
  assert(platform.ok && (await platform.json()).version === "22.6", "目标接口未确认是禅道 22.6");
  const client = createBetterZentao({ fetchImpl: guardedFetch });
  let currentUser;
  let failed = false;

  function secretCheck(value) {
    const output = JSON.stringify(value);
    assert(!/"(?:password|resetToken|token)"\s*:/i.test(output) &&
      !/\b[a-f0-9]{32}\b/i.test(output) &&
      output === client.redactText(output), "结果触发凭据检测");
  }

  async function gate(id, check, cap) {
    const start = performance.now();
    try {
      const result = await check();
      const elapsed = performance.now() - start;
      if (cap !== undefined) assert(elapsed < cap, "耗时 " + Math.round(elapsed) + " ms，超过 " + cap + " ms");
      console.log(id, "PASS", Math.round(elapsed) + " ms", result);
    } catch (error) {
      failed = true;
      const message = error instanceof ZentaoError || error instanceof assert.AssertionError ? error.message : "请求或响应无法验证";
      console.error(id, "FAIL", client.redactText(message));
    }
  }

  await gate(gates[0], async () => {
    const [user, departments, users, products] = await Promise.all([
      client.directory.currentUser(), client.directory.departments(), client.directory.users(), client.directory.products(),
    ]);
    currentUser = user;
    assert(users.some(item => item.account === user.account && item.dept === user.dept) && user.deptName && user.role &&
      departments.some(item => item.id === user.dept), "当前用户及部门/角色未成功解析");
    assert([42, 43, 44].every(id => products.some(product => product.id === id)), "三态正式产品未齐全");
    secretCheck({ departments, users, products });
    return departments.length + " 个部门，" + users.length + " 个目录账号，三态产品已找到";
  }, 2_000);

  await gate(gates[1], async () => {
    const previousTodoReads = todoReads;
    const output = await client.tracking.getMyDashboard();
    assert(output.me.account && output.me.deptName && Number.isInteger(output.todoCount) && output.todoCount >= 0 &&
      output.todoBreakdown && Number.isInteger(output.todoBreakdown.story), "个人地盘字段或分项待办不完整");
    assert(Object.values(output.todoBreakdown).reduce((total, count) => total + count, 0) === output.todoCount,
      "待办总数与分项合计不一致");
    assert(todoReads === previousTodoReads, "有分项待办时多发了 /v2/my/todo 请求");
    assert(output.overdueTasks.every(task => task.overdueDays > 0) && output.upcomingTasks.every(task => task.overdueDays === 0),
      "逾期和临期任务分类存在差异");
    secretCheck(output);
    return "分项待办合计 " + output.todoCount + "，/v2/my/todo 补查 0 次，凭据扫描通过";
  }, 1_500);

  await gate(gates[2], async () => {
    const output = await client.tracking.getTeamOverdue();
    const items = output.byMember.flatMap(member => member.tasks);
    assert(output.scope.departmentId && output.affectedMembersCount === output.byMember.length, "当前部门或影响人数未确认");
    assert(items.every(task => !task.isParent && task.overdueDays > 0) &&
      new Set(items.map(task => task.id)).size === output.totalOverdueTasks, "父任务过滤或任务计数不一致");
    assert(output.byMember.every(member => !/^\d+$/.test(member.realname)) &&
      items.every(task => !/^\d+$/.test(task.assignedTo?.realname ?? "")), "发现数字 ID 被当作姓名");
    secretCheck(output);
    return "默认部门、叶子任务唯一计数和姓名校验通过";
  }, 3_000);

  await gate(gates[3], async () => {
    const storyLists = await Promise.all([42, 43, 44].map(product =>
      client.tracking.queryStories({ product, status: "all", limit: 30, maxScanPages: 2 })));
    const hasLabels = item => typeof item?.statusLabel === "string" && /[\u3400-\u9fff]/.test(item.statusLabel) &&
      typeof item.stageLabel === "string" && /[\u3400-\u9fff]/.test(item.stageLabel) && item.url;
    assert(storyLists.every(list => list.stories.length && list.stories.every(hasLabels)), "三态需求样例或中文标签查验失败");
    const details = await Promise.all(storyLists.map(list => client.tracking.getStoryProgress({ storyId: list.stories[0].id })));
    assert(details.every(detail => hasLabels(detail) && detail.feedbackSummary), "三态需求进度卡缺字段");
    const candidate = storyLists.flatMap(list => list.stories).find(story => story.feedbackBy?.trim());
    const feedbackBy = candidate?.feedbackBy.split(/[、,，;；]/)[0].trim();
    assert(feedbackBy, "三态查询样本缺少可用反馈者");
    const feedback = await client.tracking.getStoryProgress({ feedbackBy, product: candidate.productId });
    assert(feedback.stories.length && feedback.stories.every(hasLabels) && feedback.feedbackSummary, "反馈者进度缺少样例或中文标签");
    const requests = await client.tracking.queryStories({ product: 42, storyType: "requirement", status: "all", limit: 1, maxScanPages: 1 });
    assert(requests.stories[0]?.type === "requirement", "未找到 #42 用户需求样例");
    const requirement = await client.tracking.getStoryProgress({ requirementId: requests.stories[0].id });
    assert(hasLabels(requirement.requirement) && Array.isArray(requirement.linkedStories) &&
      requirement.linkedStories.every(hasLabels) && requirement.feedbackSummary, "用户需求进度缺少字段或中文标签");
    secretCheck({ storyLists, details, feedback, requirement });
    return "#42/#43/#44 需求、反馈者及 #42 用户需求已真实回读";
  });

  await gate(gates[4], async () => {
    const ids = [42, 43, 44, 29];
    const modules = await Promise.all(ids.map(id => client.directory.modules(id)));
    const who = currentUser ?? await client.directory.currentUser();
    const input = {
      title: "只读冒烟草稿", spec: "<p>验证预检返回字段</p>", verify: "<p>只读检查</p>",
      assignTo: who.account, dryRun: true,
    };
    const previews = await Promise.all(ids.map((product, index) => {
      const module = modules[index].find(item => item.id > 0)?.id;
      assert(module, "产品没有可用模块");
      return client.intake.createStory({ ...input, product, module });
    }));
    assert(previews.every(preview => preview.dryRun && preview.allOk &&
      preview.drafts[0].availableModules.length && Array.isArray(preview.drafts[0].candidatePlans)), "单产品创建预检缺少模块或计划数据");
    assert(previews.every(preview => preview.drafts.every(draft => draft.payloadPreview.status === "draft" &&
      !Object.hasOwn(draft.payloadPreview, "needNotReview"))), "草稿预检意外携带跳过评审字段");
    assert(previews[0].drafts[0].candidatePlans.length > 0, "#42 未返回活跃 L3 计划");
    const normalized = name => name.normalize("NFKC").trim().toLowerCase();
    const forms = list => list.filter(item => item.id > 0).map(item => normalized(item.name));
    const [design, runtime] = modules.slice(0, 2).map(forms);
    const common = design.find(name => design.indexOf(name) === design.lastIndexOf(name) &&
      runtime.includes(name) && runtime.indexOf(name) === runtime.lastIndexOf(name));
    const across = await client.intake.createStory({ ...input, states: states.slice(0, 2), module: common });
    assert(across.dryRun && across.drafts.map(item => item.product.id).join(",") === "42,43" &&
      across.drafts.every(draft => draft.availableModules.length && Array.isArray(draft.candidatePlans)),
      "跨态创建预检缺少逐产品候选");
    assert(common ? across.allOk : across.drafts.every(draft =>
      draft.errors.every(issue => issue === "缺少禅道必填项 module")), "跨态预检出现模块以外的未解决问题");
    assert(blockedCount === 0, "发现未授权写入尝试");
    return "#42/#43/#44/#29 单产品预检通过，" +
      (across.allOk ? "跨态预检通过" : "跨态返回两套候选模块，待分别指定模块");
  });
  console.log("禅道请求", getCount + " GET，" + loginCount + " 次认证，业务写请求 0，拦截 " + blockedCount);
  if (failed || blockedCount) process.exitCode = 1;
}

try {
  await verify();
} catch (error) {
  const message = error instanceof ZentaoError || error instanceof assert.AssertionError ? error.message : "无法连接或读取目标配置";
  for (const gate of gates) console.error(gate, "UNVERIFIED", message);
  process.exitCode = 1;
}
