import { spawnSync } from "node:child_process";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { expect, it } from "vitest";
import { markStory, batchDetails } from "../../src/core/ai-mark.ts";
import { ZentaoHttp } from "../../src/core/http.ts";
import {
  ConfigError, createBetterZentao, resolveConfig, ZentaoApiError, ZentaoAuthExpiredError,
  ZentaoCreateUnconfirmedError,
} from "../../src/index.ts";
import { assertNoSecrets } from "../fixtures/local-scenarios.mjs";
import { envFor, FIXED_NOW, newFixture, PASSWORD, PRIVATE_HASH, RESET_VALUE, TOKEN } from "../fixtures/zentao.mjs";

const env = envFor();
const response = (body, status = 200) =>
  new Response(JSON.stringify(body), { status, headers: { "Content-Type": "application/json" } });
const clientFor = (fixture, options = {}) => createBetterZentao({ env, fetchImpl: fixture.fetchImpl, ...options });
const payload = {
  title: "测试需求", spec: "<p>说明</p>", type: "story", category: "feature",
  status: "draft", reviewer: [], pri: 2, source: "", module: 421,
};

it("TC-CORE-01 构造参数、环境变量、本地配置和默认值逐级覆盖", async () => {
  const folder = await mkdtemp(join(tmpdir(), "bzt-config-"));
  try {
    const path = join(folder, "better-zentao.local.json");
    await writeFile(path, JSON.stringify({
      mode: "strict-ai", defaults: { designProductId: 81, defaultPri: 3 },
      teams: { 本部门: { department: "样例部门" } }, password: "profile-password-ignored",
    }));
    const defaults = resolveConfig({ env });
    expect(defaults).toMatchObject({
      mode: "personal", timeoutMs: 30_000, cacheTtlMs: 600_000,
      defaults: { designProductId: 42, runtimeProductId: 43, deliveryProductId: 44, defaultPri: 2 },
    });
    const local = resolveConfig({ env: { ...env, ZENTAO_PROFILE_PATH: path } });
    expect(local).toMatchObject({ mode: "strict-ai", password: PASSWORD, defaults: { designProductId: 81, runtimeProductId: 43, defaultPri: 3 } });
    const blankOptionals = resolveConfig({
      env: { ...env, ZENTAO_PROFILE_PATH: path, ZENTAO_MODE: "  ", ZENTAO_PRODUCT_ID: "", ZENTAO_TIMEOUT_MS: " ", ZENTAO_CACHE_TTL_MS: "" },
    });
    expect(blankOptionals).toMatchObject({ mode: "strict-ai", timeoutMs: 30_000, cacheTtlMs: 600_000, productId: undefined });
    const environment = { ...env, ZENTAO_PROFILE_PATH: path, ZENTAO_MODE: "personal",
      ZENTAO_TIMEOUT_MS: "987", ZENTAO_PRODUCT_ID: "14", ZENTAO_CACHE_TTL_MS: " 0 " };
    expect(resolveConfig({ env: environment })).toMatchObject({ mode: "personal", timeoutMs: 987, productId: 14, cacheTtlMs: 0 });
    expect(resolveConfig({
      env: environment, mode: "strict-ai", timeoutMs: 333, productId: 29,
      baseUrl: "https://other.example.invalid/zentao///", account: "example", defaults: { defaultPri: 1 },
    })).toMatchObject({
      mode: "strict-ai", timeoutMs: 333, baseUrl: "https://other.example.invalid/zentao", account: "example",
      productId: 29, defaults: { designProductId: 81, defaultPri: 1 }, teams: { 本部门: { department: "样例部门" } },
    });
  } finally {
    await rm(folder, { recursive: true, force: true });
  }
});

it.each([["空字符串", ""], ["纯空白", " \t  "]])("TC-CORE-01 可选环境变量为%s时读取默认 profile 并使用默认数值", async (_, blank) => {
  const folder = await mkdtemp(join(tmpdir(), "bzt-blank-config-"));
  try {
    await writeFile(join(folder, "better-zentao.local.json"), JSON.stringify({ mode: "strict-ai", defaults: { defaultPri: 4 } }));
    const entry = new URL("../../dist/index.js", import.meta.url).href;
    const processResult = spawnSync(process.execPath, ["--input-type=module", "-e",
      "import { resolveConfig } from " + JSON.stringify(entry) + ";\n" +
      "const { mode, productId, timeoutMs, cacheTtlMs, defaults } = resolveConfig();\n" +
      "console.log(JSON.stringify({ mode, productId, timeoutMs, cacheTtlMs, defaultPri: defaults.defaultPri }));",
    ], {
      cwd: folder, timeout: 5000, encoding: "utf8",
      env: { ...process.env, ...env, ZENTAO_PROFILE_PATH: blank, ZENTAO_MODE: blank, ZENTAO_PRODUCT_ID: blank,
        ZENTAO_TIMEOUT_MS: blank, ZENTAO_CACHE_TTL_MS: blank },
    });
    expect(processResult.status).toBe(0);
    expect(JSON.parse(processResult.stdout)).toEqual({
      mode: "strict-ai", timeoutMs: 30_000, cacheTtlMs: 600_000, defaultPri: 4,
    });
  } finally {
    await rm(folder, { recursive: true, force: true });
  }
});

it("TC-CORE-02 列出全部缺失变量并隐藏凭据和无效配置值", () => {
  expect(() => resolveConfig({ env: {} })).toThrow(ConfigError);
  try {
    resolveConfig({ env: {} });
  } catch (error) {
    expect(error.missingVars).toEqual(["ZENTAO_BASE_URL", "ZENTAO_ACCOUNT", "ZENTAO_PASSWORD"]);
    for (const key of error.missingVars) expect(error.message).toContain(key);
    assertNoSecrets(error.message);
  }
  expect(() => resolveConfig({ env: { ...env, ZENTAO_BASE_URL: "http://x:" + PASSWORD + "@example.invalid" } }))
    .toThrow(/^ZENTAO_BASE_URL 必须是 HTTP/);
  expect(() => resolveConfig({ env: { ...env, ZENTAO_MODE: PASSWORD } })).toThrow(/^ZENTAO_MODE 必须为 personal/);
});

it("TC-CORE-03 十个并发请求只认证一次且共享 Token 请求头", async () => {
  const fixture = newFixture({
    override: async request => {
      if (request.path.endsWith("/tokens")) {
        await new Promise(resolve => setTimeout(resolve, 30));
      }
    },
  });
  const client = clientFor(fixture);
  expect(await Promise.all(Array.from({ length: 10 }, () => client.api.org.self())))
    .toEqual(Array.from({ length: 10 }, () => expect.objectContaining({ account: "jia" })));
  const logins = fixture.requests.filter(request => request.path.endsWith("/tokens"));
  expect(logins).toHaveLength(1);
  expect(logins[0]).toMatchObject({ method: "POST", token: null, body: { account: "jia", password: PASSWORD } });
  const calls = fixture.requests.filter(request => request.path.endsWith("/user"));
  expect(calls).toHaveLength(10);
  expect(calls.every(request => request.token === TOKEN && request.authorization === null)).toBe(true);
});

it("TC-CORE-04 迟到的旧 Token 401 保留新 Token，重放上限为一次", async () => {
  let loginCount = 0;
  let releaseLate, oldBSeen;
  const late = new Promise(resolve => { releaseLate = resolve; });
  const bWaiting = new Promise(resolve => { oldBSeen = resolve; });
  const calls = [];
  const http = new ZentaoHttp(resolveConfig({ env }), async (url, init) => {
    const path = new URL(url).pathname.split("/").at(-1);
    const token = init.headers.get("Token");
    calls.push([path, token]);
    if (path === "tokens") return response({ token: "T" + ++loginCount }, 201);
    if (path === "b" && token === "T1") {
      oldBSeen();
      await late;
      return response({}, 401);
    }
    if (path === "a" && token === "T1") {
      await bWaiting;
      return response({}, 401);
    }
    if (path === "always-401") return response({}, 401);
    return response({ ok: true });
  });
  const a = http.request(1, "GET", "/a");
  const b = http.request(2, "GET", "/b");
  await expect(a).resolves.toEqual({ ok: true });
  releaseLate();
  await expect(b).resolves.toEqual({ ok: true });
  expect(loginCount).toBe(2);
  expect(calls.filter(([path]) => path === "b")).toEqual([["b", "T1"], ["b", "T2"]]);
  await expect(http.request(1, "GET", "/always-401")).rejects.toBeInstanceOf(ZentaoApiError);
  expect(calls.filter(([path]) => path === "always-401")).toEqual([["always-401", "T2"], ["always-401", "T3"]]);
  expect(loginCount).toBe(3);
});

it("TC-CORE-05 initialToken 的 401 触发显式重新授权且不跟随重定向", async () => {
  const observed = [];
  const http = new ZentaoHttp(resolveConfig({ env, initialToken: TOKEN }), async (url, init) => {
    observed.push([new URL(url).pathname, init.redirect, init.headers.get("Token")]);
    return response({ error: PASSWORD }, 401);
  });
  await expect(http.request(2, "GET", "/users")).rejects.toBeInstanceOf(ZentaoAuthExpiredError);
  expect(observed).toEqual([["/api.php/v2/users", "error", TOKEN]]);
});

it("TC-CORE-06 读取需求列表时 HTTP 201 是有效成功响应", async () => {
  const fixture = newFixture();
  const page = await clientFor(fixture).api.stories.list(42, "story", "all", 1);
  expect(page.items.map(story => story.id)).toEqual([101, 102, 103]);
  expect(fixture.requests.at(-1)).toMatchObject({ method: "GET", path: "/api.php/v1/products/42/stories" });
});

it("TC-CORE-07 所有个人和目录 DTO 剔除哈希、重置令牌与 2086 人字典", async () => {
  const fixture = newFixture({ leaks: true });
  const { api } = clientFor(fixture);
  const [tasks, stories, opened, todos, people, self, departmentPeople] = await Promise.all([
    api.my.assignedTasks(), api.my.assignedStories(), api.my.openedStories(), api.my.todos(),
    api.org.users(), api.org.self(), api.org.usersByDepartment(2),
  ]);
  expect(tasks.items.length).toBeGreaterThan(0);
  expect(stories.items.length).toBeGreaterThan(0);
  expect(opened.items.map(item => item.id)).toContain(102);
  expect(todos).toMatchObject({ todoCount: 3, items: [{ id: 76, name: "样例待办", status: "wait" }] });
  // v1 profile has a role object and the v2 directory still uses strings.
  expect(self).toMatchObject({ account: "jia", role: "dev" });
  expect(people.find(user => user.account === "yi")?.role).toBe("qa");
  expect(people.map(user => user.account)).toEqual(["jia", "yi", "bing", "wang1", "wang2"]);
  expect(departmentPeople.map(user => user.account)).toEqual(["yi", "wang1"]);
  expect(fixture.requests.find(request => request.path.endsWith("/company/browse")).query)
    .toMatchObject({ recPerPage: "500", type: "bydept", param: "2" });
  const output = JSON.stringify({ tasks, stories, opened, todos, people, self, departmentPeople });
  assertNoSecrets(output);
  expect(output).not.toMatch(/directory-account-\d|pageCookie|目录成员|userDictionary|"users":/);
  expect(output).not.toContain(PRIVATE_HASH);
  expect(output).not.toContain(RESET_VALUE);
});

const htmlError = "<html>" + TOKEN + PASSWORD + "</html>";
const errorBody = { error: TOKEN + PASSWORD };
const errorBytes = Buffer.byteLength(JSON.stringify(errorBody));
it.each([
  ["空体", () => new Response("", { headers: { "Content-Type": "application/json" } }), 200, "application/json", 0, "empty"],
  ["HTML", () => new Response(htmlError, { headers: { "Content-Type": "text/html; nonce=" + TOKEN } }), 200, "text/html", Buffer.byteLength(htmlError), "non-json"],
  ["JSON null", () => response(null), 200, "application/json", 4, "null"],
  ["JSON 错误对象", () => response(errorBody), 200, "application/json", errorBytes, "object"],
  ["网络异常", () => { throw new Error(TOKEN + PASSWORD); }, "unknown", "unknown", "unknown", "unknown"],
  ["HTTP 401", () => response(errorBody, 401), 401, "application/json", errorBytes, "object"],
])("TC-CORE-08 创建回应 %s 的诊断只含安全元数据且只 POST 一次", async (_, reply, status, mediaType, bytes, bodyKind) => {
  const fixture = newFixture({
    override: request => request.method === "POST" && request.path.endsWith("/stories") ? reply() : undefined,
  });
  const caught = await clientFor(fixture).api.stories.create(42, payload, false).catch(error => error);
  expect(caught).toBeInstanceOf(ZentaoCreateUnconfirmedError);
  expect(caught.metadata).toEqual({ status, mediaType, bytes, bodyKind });
  expect(caught.message).toContain("禁止重试创建");
  for (const field of ["status", "mediaType", "bytes", "bodyKind"]) expect(caught.message).toContain(field + "=");
  assertNoSecrets(caught.message + JSON.stringify(caught));
  expect(caught.message).not.toContain("<html>");
  expect(fixture.businessWrites()).toHaveLength(1);
});

it("TC-CORE-09 strict-ai 固定来源、标题与幂等正文头，残缺头保留在正文", () => {
  const config = { ...resolveConfig({ env }).aiMark, source: "operation" };
  const first = markStory({ title: "需求", spec: "<p>正文</p>" }, "strict-ai", config, batchDetails("AI-Agent", "阶段-First", FIXED_NOW));
  expect(first).toMatchObject({ title: "[AI创建] 需求", source: "ai", sourceNote: "AI-Agent-20261119-first" });
  expect(first.spec).toMatch(/^<p>【AI创建】.*批次：AI-Agent-20261119-first/);
  const next = markStory(first, "strict-ai", config, batchDetails("AI-Agent", "second", FIXED_NOW));
  expect(next.title).toBe(first.title);
  expect(next.spec.match(/【AI创建】/g)).toHaveLength(1);
  expect(next.spec).toContain("AI-Agent-20261119-second");
  expect(next.spec).not.toContain("20261119-first");
  expect(next.spec).toMatch(/<p>正文<\/p>$/);
  const fake = "<p>【AI创建】未按约定格式的前缀</p><p>正文</p>";
  const preserved = markStory({ title: "需求", spec: fake }, "strict-ai", config, batchDetails("AI-Agent", undefined, FIXED_NOW));
  expect(preserved.sourceNote).toBe("AI-Agent-20261119-120000");
  expect(preserved.spec).toContain(fake);
  expect(preserved.spec.match(/【AI创建】/g)).toHaveLength(2);
});

it("TC-CORE-10 personal 保留正常标题、正文、来源并默认空来源", () => {
  const config = resolveConfig({ env }).aiMark;
  const batch = batchDetails("AI-Agent", undefined, FIXED_NOW);
  const input = { title: "研发需求", spec: "  <p>业务描述</p>  ", source: "operation" };
  expect(markStory(input, "personal", config, batch)).toEqual({ ...input, sourceNote: undefined });
  expect(markStory({ ...input, source: undefined }, "personal", config, batch).source).toBe("");
});
