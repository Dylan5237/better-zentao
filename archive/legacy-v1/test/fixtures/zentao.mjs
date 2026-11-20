import { createServer } from "node:http";
import { once } from "node:events";

export const FIXED_NOW = new Date(2026, 10, 19, 12);
export const TOKEN = "fake-login-token";
export const PASSWORD = "fake-login-password";
export const PRIVATE_HASH = "9f47263f2410099e11cfbfc0767777ab";
export const RESET_VALUE = "fixture-reset-token";
export const envFor = (base = "http://zentao.example.invalid") => ({
  ZENTAO_BASE_URL: base, ZENTAO_ACCOUNT: "jia", ZENTAO_PASSWORD: PASSWORD,
  ZENTAO_PROFILE_PATH: "./test/fixtures/profile-not-present.json",
});

function day(now, offset) {
  const date = new Date(now);
  date.setDate(date.getDate() + offset);
  return [date.getFullYear(), date.getMonth() + 1, date.getDate()].map(value => String(value).padStart(2, "0")).join("-");
}

const users = [
  { id: 1, account: "jia", realname: "用户甲", pinyin: "yonghujia", dept: 1, role: "dev", deleted: "0" },
  { id: 2, account: "yi", realname: "用户乙", pinyin: "yonghuyi", dept: 2, role: "qa", deleted: 0 },
  { id: 3, account: "bing", realname: "用户丙", pinyin: "yonghubing", dept: 3, role: "po", deleted: 0 },
  { id: 4, account: "wang1", realname: "王同名", pinyin: "wangtongming", dept: 2, role: "dev", deleted: 0 },
  { id: 5, account: "wang2", realname: "王同名", pinyin: "wangtongming", dept: 3, role: "qa", deleted: 0 },
  { id: 6, account: "old", realname: "已删除用户", dept: 2, deleted: "1" },
];
const departments = [
  { id: 1, name: "研发部", parent: 0, items: [{ id: 2, name: "平台组", parent: 1, items: [] }] },
  { id: 3, name: "交付部", parent: 0, items: [] },
];
const products = [
  { id: 42, name: "天宫平台（正式）", code: "design", status: "normal" },
  { id: 43, name: "OneLink 7.0（正式）", code: "runtime", status: "normal" },
  { id: 44, name: "运营交付平台（正式）", code: "delivery", status: "normal" },
  { id: 29, name: "禅道研发验证项目", code: "validation", status: "normal" },
];

const workTodoCounts = {
  task: 5, aitask: 1, story: 2, bug: 3, case: 0, testtask: 1, requirement: 2, issue: 0,
  risk: 0, reviewissue: 0, qa: 0, meeting: 0, ticket: 0, feedback: 0, epic: 1,
};

const planId = id => id * 100 + 21;
const moduleId = id => id === 29 ? 564 : id * 10 + 1;
const owner = account => typeof account === "string" ? account : account?.account;
const mapById = list => Object.fromEntries(list.map(item => [item.id, item]));
const json = (data, status = 200) => new Response(JSON.stringify(data), {
  status, headers: { "Content-Type": "application/json" },
});
const bad = (status = 400) => json({ error: "模拟上游错误 " + TOKEN + " " + PASSWORD }, status);

export function newFixture({
  now = FIXED_NOW, requiredFields = ["title", "module", "assignedTo", "verify", "spec"], override,
  userRows = users, departmentRows = departments, leaks = false,
} = {}) {
  const requests = [];
  const user = { ...users[0], password: PRIVATE_HASH, resetToken: RESET_VALUE };
  const userDictionary = leaks
    ? Object.fromEntries(Array.from({ length: 2_086 }, (_, index) => ["directory-account-" + index, "目录成员" + index]))
    : { jia: "用户甲", yi: "用户乙" };
  const story = (id, product, fields = {}) => ({
    id, product, title: "需求 " + id, type: "story", category: "feature", status: "active", stage: "developing",
    pri: 2, module: moduleId(product), plan: String(planId(product)), assignedTo: "jia", openedBy: "yi",
    feedbackBy: "", source: "user", spec: "<p>需求正文</p>", verify: "<p>验证</p>", deleted: "0", ...fields,
  });
  const stories = new Map([
    [101, story(101, 42, {
      title: "提交入口改进", keywords: "自测", category: "design", stage: "designed",
      assignedTo: { id: 1, account: "jia", realname: "用户甲", resetToken: RESET_VALUE },
      feedbackBy: "反馈人甲、反馈人乙", executions: { 601: { id: 601, name: "设计迭代" } },
      tasks: [{ id: 13, name: "开发子任务", type: "devel", status: "changed", assignedTo: "jia" }],
      actions: [{ id: 88, action: "opened", actor: "yi", date: day(now, -4), comment: "不在白名单的内容" }],
    })],
    [102, story(102, 42, { title: "草稿需求", status: "draft", stage: "wait", openedBy: "jia" })],
    [103, story(103, 42, { title: "历史需求", status: "closed", stage: "closed", category: "interface" })],
    [201, story(201, 43, { title: "运行态反馈", feedbackBy: "反馈人甲" })],
    [301, story(301, 44, { title: "交付态反馈", feedbackBy: "反馈人甲" })],
  ]);
  const requirements = new Map([[701, story(701, 42, {
    type: "requirement", title: "用户需求样例", stage: "projected", plan: "0",
  })]]);
  const links = new Map([[701, new Set([101])], [101, new Set([701])]]);
  let nextStory = 9001;
  const tasks = [
    { id: 11, name: "父任务", assignedTo: "jia", isParent: "1", status: "doing", deadline: day(now, -7) },
    { id: 12, name: "测试子任务", assignedTo: "yi", parent: 11, status: "pause", deadline: day(now, -4), type: "test" },
    { id: 13, name: "开发子任务", assignedTo: "jia", parent: 11, status: "changed", deadline: day(now, -3), left: "2.5", story: 101 },
    { id: 14, name: "多人任务", assignedTo: "bing", status: "doing", deadline: day(now, -2), mode: "linear", team: [
      { account: "jia", status: "wait", realname: "481", left: 0 },
      { account: "yi", status: "done", realname: "482", left: 0 },
      { account: "bing", status: "doing", realname: "483", left: 2 },
    ] },
    { id: 15, name: "临期任务", assignedTo: "jia", status: "wait", deadline: day(now, 2) },
  ].map(task => ({ execution: 601, type: "devel", left: "0", ...task }));
  const execs = [{ id: 601, name: "设计迭代", project: 179, projectName: "设计项目", status: "doing", progress: 21 }];
  const context = { requests, stories, requirements, tasks, links, userRows, departmentRows, products, execs };
  const isOpen = item => !["done", "closed", "cancel"].includes(item.status);
  function v1(list, query, key, status = 200) {
    const page = Number(query.page ?? 1);
    const limit = Number(query.limit ?? 200);
    return json({ page, limit, total: list.length, [key]: list.slice((page - 1) * limit, page * limit) }, status);
  }
  function v2(list, query, key, extras = {}) {
    const pageID = Number(query.pageID ?? 1);
    const recPerPage = Number(query.recPerPage ?? 20);
    const page = list.slice((pageID - 1) * recPerPage, pageID * recPerPage);
    return json({
      [key]: extras.map ? mapById(page) : page, status: "success", ...extras.fields,
      pager: { pageID, pageTotal: Math.ceil(list.length / recPerPage), recTotal: list.length, recPerPage, pageCookie: "ignored" },
    });
  }

  async function fetchImpl(input, init) {
    const request = new Request(input, init);
    const url = new URL(request.url);
    const source = await request.text();
    const event = {
      method: request.method, path: url.pathname, query: Object.fromEntries(url.searchParams),
      token: request.headers.get("Token"), authorization: request.headers.get("Authorization"),
      body: source ? JSON.parse(source) : undefined,
    };
    requests.push(event);
    const changed = await override?.(event, context);
    if (changed) return changed;
    const { method, path, query, body } = event;
    if (method === "GET" && path === "/index.php" && query.mode === "getconfig") return json({ version: "22.6" });
    if (method === "POST" && path === "/api.php/v1/tokens") {
      return body?.account === "jia" && body?.password === PASSWORD ? json({ token: TOKEN }, 201) : bad(401);
    }
    if (event.token !== TOKEN || event.authorization) return bad(401);
    let match;
    if (method === "GET") {
      if (path === "/api.php/v1/user") return json({ profile: { ...user, role: { code: user.role, name: "研发" } } });
      if (path === "/api.php/v1/departments") return json(departmentRows);
      if (path === "/api.php/v2/users") {
        if (!query.recPerPage || !query.pageID) return bad();
        return v2(userRows.map(item => ({ ...item, password: PRIVATE_HASH, resetToken: RESET_VALUE })), query, "users");
      }
      if (path === "/api.php/v2/company/browse") {
        if (query.type !== "bydept" || !query.param || !query.recPerPage || query.deptID) return bad();
        return v2(userRows.filter(item => item.dept === Number(query.param)), query, "users", { fields: { userDictionary } });
      }
      if (path === "/api.php/v1/products") return v1(products, query, "products");
      if ((match = /^\/api\.php\/v1\/products\/(\d+)$/.exec(path))) {
        const product = products.find(item => item.id === Number(match[1]));
        if (!product || query.fields !== "moduleOptionMenu") return bad(404);
        return json({ ...product, moduleOptionMenu: [
          { id: 0, name: "/" }, { id: moduleId(product.id), name: "/平台/提交入口" }, { id: product.id * 10 + 2, name: "/平台/审核" },
        ] });
      }
      if ((match = /^\/api\.php\/v1\/products\/(\d+)\/plans$/.exec(path))) {
        const id = Number(match[1]);
        return v1([{
          id: id * 100 + 10, product: id, parent: -1, title: "【L2-建设目标】产品计划", status: "wait", children: [
            { id: planId(id), product: id, parent: id * 100 + 10, title: "【负责甲】改进入口", begin: "2026-11-02", end: "2026-11-30", status: "wait" },
            { id: planId(id) + 1, product: id, title: "【负责乙】跨月改进", begin: "2026-11-01", end: "2027-01-01", status: "doing" },
            { id: planId(id) + 2, product: id, title: "【张三】2026年11月待定事项", begin: "待定", end: "", status: "wait" },
            { id: planId(id) + 3, product: id, title: "已归档计划", begin: "2026-11-01", end: "2026-11-10", status: "closed" },
          ],
        }, { id: id * 100 + 50, product: id, parent: 0, title: "独立计划", status: "wait" }], query, "plans");
      }
      if (path === "/api.php/v2/story/create") {
        if (!products.some(item => item.id === Number(query.productID))) return bad(404);
        return json({ forceReview: false, needReview: true, needNotReview: true, fields: {
          category: { name: "category", options: { feature: "研发类", design: "设计类" } },
          source: { name: "source", options: { user: "用户反馈", service: "客户服务" } },
        } });
      }
      if (path === "/api.php/v1/requiredFields") return json({ story: { create: { fields: requiredFields } } });
      if ((match = /^\/api\.php\/v1\/products\/(\d+)\/stories$/.exec(path))) {
        if (!["all", "unclosed", undefined].includes(query.status)) return v1([], query, "stories", 201);
        if (query.type) return bad();
        return v1([...stories.values()].filter(item => item.product === Number(match[1]) && item.deleted !== "1" &&
          (query.status === "all" || item.status !== "closed")), query, "stories", 201);
      }
      if (path === "/api.php/v2/product/browse") {
        if (query.storyType !== "requirement" || !query.productID || !query.pageID) return bad();
        return v2([...requirements.values()].filter(item => String(item.product) === query.productID), query, "stories", {
          map: true, fields: { users: userDictionary, user },
        });
      }
      if (path === "/api.php/v2/requirement/view") {
        const entry = requirements.get(Number(query.storyID));
        if (!entry) return bad(404);
        const related = [...(links.get(entry.id) ?? [])].map(id => stories.get(id)).filter(item => item && item.deleted !== "1");
        return json({ status: "success", story: entry, relations: { story: mapById(related) }, users: userDictionary, user });
      }
      if ((match = /^\/api\.php\/v1\/stories\/(\d+)$/.exec(path))) {
        const entry = stories.get(Number(match[1]));
        if (!entry) return bad(requirements.has(Number(match[1])) ? 400 : 404);
        return json(entry);
      }
      if (path === "/api.php/v2/executions") {
        if (query.recPerPage !== "200" || !query.pageID) return bad();
        return v2(execs, query, "executions", { fields: { users: userDictionary } });
      }
      if ((match = /^\/api\.php\/v1\/executions\/(\d+)\/tasks$/.exec(path))) {
        return v1(tasks.filter(task => task.execution === Number(match[1]) &&
          (query.status === "delayed" ? isOpen(task) && task.deadline && task.deadline !== "0000-00-00" && task.deadline < day(now, 0)
            : query.status !== "undone" || isOpen(task))).map(({ team, ...entry }) => entry), query, "tasks");
      }
      if ((match = /^\/api\.php\/v1\/tasks\/(\d+)$/.exec(path))) {
        const entry = tasks.find(task => task.id === Number(match[1]));
        return entry ? json(entry) : bad(404);
      }
      if (path === "/api.php/v2/my/work" || path === "/api.php/v2/my/contribute") {
        if (query.type || query.browseType !== (path.endsWith("/work") ? "assignedTo" : "openedBy")) return bad();
        if (query.mode === "task") return v2(tasks.filter(task => owner(task.assignedTo) === user.account), query, "tasks", {
          map: true, fields: { todoCount: workTodoCounts, user, users: userDictionary },
        });
        return v2([...stories.values()].filter(item => item.deleted !== "1" && owner(item[query.browseType]) === user.account),
          query, "stories", { fields: { todoCount: workTodoCounts, user, users: userDictionary } });
      }
      if (path === "/api.php/v2/my/todo") {
        return v2([{ id: 76, name: "样例待办", status: "wait", date: day(now, 0), password: PRIVATE_HASH }],
          query, "todos", { fields: { user, users: userDictionary, waitCount: 2, doingCount: 1 } });
      }
    }
    if (method === "POST" && (path === "/api.php/v2/stories" || (match = /^\/api\.php\/v1\/products\/(\d+)\/stories$/.exec(path)))) {
      const v2Create = path === "/api.php/v2/stories";
      const id = v2Create ? Number(query.productID) : Number(match[1]);
      if (!products.some(product => product.id === id) || body?.type !== "story" ||
        !Array.isArray(body.reviewer) || !["draft", "active"].includes(body.status)) return bad();
      if (v2Create && (body.modules?.[0] !== body.module || !body.assignedTo ||
        (body.status === "active" && !body.reviewer.length && body.needNotReview !== true))) return bad();
      if (!v2Create && Object.hasOwn(body, "assignedTo")) return bad();
      const item = story(nextStory, id, {
        ...body, assignedTo: v2Create ? body.assignedTo : null, module: body.module ?? 0, plan: body.plan ?? "0",
        feedbackBy: ["user", "customer", "market", "service", "operation", "support", "forum"].includes(body.source)
          ? (body.feedbackBy ?? "") : "",
        verify: body.verify ?? "", stage: body.plan ? "planned" : "wait",
      });
      stories.set(nextStory++, item);
      return v2Create ? json({ status: "success", id: item.id }) : json(item, 201);
    }
    if (method === "POST" && (match = /^\/api\.php\/v1\/stories\/(\d+)\/assign$/.exec(path))) {
      const story = stories.get(Number(match[1]));
      if (!story || !userRows.some(user => user.account === body?.assignedTo)) return bad();
      story.assignedTo = body.assignedTo;
      return json(story);
    }
    if (method === "DELETE" && (match = /^\/api\.php\/v1\/stories\/(\d+)$/.exec(path))) {
      const entry = stories.get(Number(match[1]));
      if (!entry) return bad(404);
      entry.deleted = "1";
      return json({ message: "success" });
    }
    if (method === "POST" && (match = /^\/api\.php\/v2\/(story|requirement)\/linkStory$/.exec(path))) {
      const id = Number(query.storyID);
      if (!(match[1] === "story" ? stories : requirements).has(id) ||
        !Array.isArray(body?.stories) || !body.stories.every(id => stories.has(id))) return bad();
      for (const target of body.stories) {
        if (!links.has(id)) links.set(id, new Set());
        links.get(id).add(target);
        if (!links.has(target)) links.set(target, new Set());
        links.get(target).add(id);
      }
      return json({ status: "success" });
    }
    return bad(404);
  }
  return {
    ...context, fetchImpl,
    businessWrites: () => requests.filter(request => request.method !== "GET" && request.path !== "/api.php/v1/tokens"),
  };
}

export async function startMock(options = {}) {
  const fixture = newFixture({ now: new Date(), ...options });
  const server = createServer(async (request, response) => {
    try {
      const chunks = [];
      for await (const chunk of request) chunks.push(chunk);
      const reply = await fixture.fetchImpl(new URL(request.url, "http://127.0.0.1"), {
        method: request.method, headers: request.headers, body: chunks.length ? Buffer.concat(chunks) : undefined,
      });
      response.writeHead(reply.status, Object.fromEntries(reply.headers.entries()));
      response.end(await reply.text());
    } catch {
      response.writeHead(500, { "Content-Type": "application/json" });
      response.end(JSON.stringify({ error: "mock failure" }));
    }
  });
  server.listen(0, "127.0.0.1");
  await once(server, "listening");
  const base = "http://127.0.0.1:" + server.address().port;
  return {
    ...fixture, base, env: envFor(base),
    close: async () => {
      const closed = once(server, "close");
      server.close();
      server.closeAllConnections();
      await closed;
    },
  };
}

export const draftInput = {
  title: "样例提交", spec: "<p>样例正文</p>", verify: "<p>确认成功</p>",
  module: "平台/提交入口", assignTo: "用户甲",
};
