import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { collectProbeFixtures } from "../../src/api/internal/probe-capture.ts";
import { captureProbeFixtures } from "../../src/api/probe-capture.ts";
import { assertNoSensitiveData } from "../helpers/assert-no-sensitive-data.ts";

const baseUrl = "https://fixture-instance.private.test/zentao";
const account = "example.private.user";
const password = "fixture-passphrase-example";
const token = "fixture-opaque-access-value";
const refetchedToken = "fixture-reissued-access-value";
const name = "测试人员甲";
const secrets = [
  "fixture-instance.private.test",
  account,
  password,
  token,
  refetchedToken,
  name,
];
const blockedFetch = vi.fn<typeof fetch>(() => {
  throw new Error("离线测试必须使用模拟 fetch。");
});

interface Sample {
  readonly endpoint: string;
  readonly path: string;
  readonly query?: Readonly<Record<string, string>>;
  readonly status?: number;
  readonly body: Readonly<Record<string, unknown>>;
  readonly empty?: Readonly<Record<string, unknown>>;
}

function samples(productId = 42): readonly Sample[] {
  return [
    {
      endpoint: "instance-config",
      path: "/index.php",
      query: { mode: "getconfig" },
      body: { version: "22.6", URAndSR: true },
    },
    {
      endpoint: "current-user",
      path: "/api.php/v1/user",
      body: { profile: { account, realname: name, dept: "0" } },
    },
    {
      endpoint: "required-fields",
      path: "/api.php/v1/requiredFields",
      body: { story: { create: ["title", "module"] } },
    },
    {
      endpoint: "departments",
      path: "/api.php/v1/departments",
      body: { departments: [{ id: "0", items: [{ id: "13" }] }] },
    },
    {
      endpoint: "users",
      path: "/api.php/v2/users",
      query: { recPerPage: "3000", pageID: "1" },
      body: { data: { users: [{ id: "19", account, realname: name }] } },
      empty: { data: { users: [] } },
    },
    {
      endpoint: "users-by-department",
      path: "/api.php/v2/company/browse",
      query: { param: "13", type: "bydept", recPerPage: "200" },
      body: { data: { users: [{ id: "19", account }] } },
      empty: { data: { users: [] } },
    },
    {
      endpoint: "my-work",
      path: "/api.php/v2/my/work",
      query: { mode: "task", browseType: "assignedTo" },
      body: { tasks: [{ id: "610" }] },
      empty: { tasks: [] },
    },
    {
      endpoint: "my-contribute",
      path: "/api.php/v2/my/contribute",
      query: { mode: "story", browseType: "openedBy" },
      body: { stories: [{ id: "51" }] },
      empty: { stories: [] },
    },
    {
      endpoint: "products",
      path: "/api.php/v1/products",
      query: { limit: "100" },
      body: {
        products: [
          { id: "17", status: "closed" },
          { id: "../../injected" },
          { id: "42", status: "normal" },
          { id: 43, status: "normal" },
        ],
        total: 4,
      },
      empty: { products: [], total: 4 },
    },
    {
      endpoint: "product-modules",
      path: `/api.php/v1/products/${productId}`,
      query: { fields: "moduleOptionMenu" },
      body: {
        id: productId,
        moduleOptionMenu: [{ id: "11", name: "测试模块" }],
      },
    },
    {
      endpoint: "product-plans",
      path: `/api.php/v1/products/${productId}/plans`,
      query: { limit: "100" },
      body: {
        plans: [
          { id: "211", parent: "-1", children: [{ id: "213", parent: "211" }] },
        ],
      },
      empty: { plans: [] },
    },
    {
      endpoint: "plan-detail",
      path: "/api.php/v2/productplan/view",
      query: { planID: "213" },
      body: { plan: { id: 213 }, planStories: [{ id: "51" }] },
    },
    {
      endpoint: "product-stories",
      path: `/api.php/v1/products/${productId}/stories`,
      query: { status: "all", limit: "100", page: "1" },
      status: 201,
      body: {
        stories: [
          { id: 61, type: "requirement" },
          { id: "51", type: "story", openedBy: account },
        ],
      },
      empty: { stories: [], total: "2" },
    },
    {
      endpoint: "product-requirements",
      path: "/api.php/v2/product/browse",
      query: { productID: String(productId), storyType: "requirement" },
      body: { data: { stories: { "61": { id: "61", type: "requirement" } } } },
      empty: { data: { stories: [] } },
    },
    {
      endpoint: "story-detail",
      path: "/api.php/v1/stories/51",
      body: { story: { id: "51", assignedTo: account } },
    },
    {
      endpoint: "story-detail-v2",
      path: "/api.php/v2/story/view",
      query: { storyID: "51" },
      body: { story: { id: 51 } },
    },
    {
      endpoint: "requirement-detail",
      path: "/api.php/v2/requirement/view",
      query: { storyID: "61" },
      body: { requirement: { id: "61" } },
    },
    {
      endpoint: "projects",
      path: "/api.php/v1/projects",
      query: { limit: "100" },
      body: {
        projects: [
          { id: 503, status: "doing" },
          { id: "501", status: "doing", product: productId },
        ],
      },
      empty: { projects: [] },
    },
    {
      endpoint: "executions-v2",
      path: "/api.php/v2/executions",
      query: { recPerPage: "200" },
      body: {
        executions: [
          { id: "701", project: "503" },
          { id: "601", project: "501" },
        ],
      },
      empty: { executions: [] },
    },
    {
      endpoint: "executions-v1",
      path: "/api.php/v1/executions",
      query: { limit: "200" },
      body: {
        executions: [
          { id: "601", project: "501" },
          { id: 602, project: 501, status: "closed" },
        ],
      },
      empty: { executions: [] },
    },
    {
      endpoint: "execution-tasks",
      path: "/api.php/v1/executions/601/tasks",
      query: { status: "all" },
      body: {
        tasks: [
          { id: "610", isParent: "1" },
          { id: 611, parent: "610", mode: "multi" },
        ],
      },
      empty: { tasks: [] },
    },
    {
      endpoint: "task-detail",
      path: "/api.php/v1/tasks/611",
      body: { task: { id: 611, mode: "multi", team: [{ account }] } },
    },
    {
      endpoint: "product-bugs",
      path: `/api.php/v1/products/${productId}/bugs`,
      query: { status: "unclosed", limit: "100", page: "1" },
      body: { bugs: [{ id: "808" }] },
      empty: { bugs: [] },
    },
    {
      endpoint: "project-bugs",
      path: "/api.php/v1/projects/501/bugs",
      query: { limit: "100", page: "1" },
      body: { bugs: [{ id: "808" }] },
      empty: { bugs: [] },
    },
    {
      endpoint: "releases",
      path: `/api.php/v1/products/${productId}/releases`,
      body: { releases: [{ id: "901" }] },
    },
    {
      endpoint: "story-create-metadata",
      path: "/api.php/v2/story/create",
      query: { productID: String(productId) },
      body: { category: { design: "设计类" }, source: { user: "用户" } },
    },
  ];
}

type ResponseOverride = (
  url: URL,
  init: RequestInit | undefined,
) => Response | undefined;

function setup(
  routes: readonly Sample[] = samples(),
  override?: ResponseOverride,
) {
  const unsafe = {
    password,
    email: "fixture-person@example.test",
    users: { [account]: { realname: name } },
    serviceUrl: `${baseUrl}/private?key=fixture`,
    opaque: token,
    lastIP: "10.2.3.4",
  };
  const fetch = vi.fn<typeof globalThis.fetch>(async (input, init) => {
    const url = new URL(String(input));
    const changed = override?.(url, init);
    if (changed) return changed;
    if (url.pathname === "/zentao/api.php/v1/tokens") {
      return Response.json({ token, users: unsafe.users }, { status: 201 });
    }
    const path = url.pathname.replace(/^\/zentao/u, "");
    const route = routes.find((route) => route.path === path);
    if (!route) return Response.json({ message: unsafe }, { status: 404 });
    const page = Number(
      url.searchParams.get("page") ?? url.searchParams.get("pageID") ?? "1",
    );
    const body = (page > 1 ? route.empty : undefined) ?? route.body;
    return Response.json(
      { ...body, diagnostics: unsafe },
      { status: route.status ?? 200 },
    );
  });
  const sleep = vi
    .fn<(ms: number) => Promise<void>>()
    .mockResolvedValue(undefined);
  const logSink = vi.fn<(line: string) => void>();
  const options = {
    baseUrl,
    account,
    password,
    clock: () => 1,
    fetch,
    sleep,
    logSink,
  };
  return { options, fetch, sleep, logSink };
}

function requests(fetch: ReturnType<typeof setup>["fetch"]) {
  return fetch.mock.calls.map(
    ([url, init]) => [new URL(String(url)), init] as const,
  );
}

beforeEach(() => {
  blockedFetch.mockClear();
  vi.stubGlobal("fetch", blockedFetch);
});

afterEach(() => {
  try {
    expect(blockedFetch).not.toHaveBeenCalled();
  } finally {
    vi.unstubAllGlobals();
  }
});

describe("WP-03 夹具采集（06 §3、09 §1.1、AC-82）", () => {
  it("按真实查询参数访问 26 个只读端点，保留实际状态、类型和空页", async () => {
    const routes = samples();
    const { options, fetch, logSink } = setup(routes);
    const report = await collectProbeFixtures(options);
    expect(report).toMatchObject({ completeness: "complete", gaps: [] });
    expect(routes).toHaveLength(26);
    expect(
      report.fixtures
        .filter(({ sample }) => sample === "normal")
        .map(({ endpoint }) => endpoint)
        .sort(),
    ).toEqual(routes.map(({ endpoint }) => endpoint).sort());
    expect(
      report.fixtures
        .filter(({ sample }) => sample === "empty")
        .map(({ endpoint }) => endpoint)
        .sort(),
    ).toEqual(
      routes
        .filter(({ empty }) => empty)
        .map(({ endpoint }) => endpoint)
        .sort(),
    );

    const storyFixtures = report.fixtures.filter(
      ({ endpoint }) => endpoint === "product-stories",
    );
    expect(storyFixtures).toMatchObject([
      {
        status: 201,
        sample: "normal",
        body: { stories: [{ id: 61 }, { id: "51", openedBy: "acct_001" }] },
      },
      { status: 201, sample: "empty", body: { stories: [], total: "2" } },
    ]);
    expect(report.fixtures).toContainEqual(
      expect.objectContaining({
        endpoint: "current-user",
        body: expect.objectContaining({
          profile: expect.objectContaining({
            account: "acct_001",
            realname: expect.stringMatching(/^人员/u),
          }),
        }),
      }),
    );

    const sent = requests(fetch);
    const posts = sent.filter(([, init]) => init?.method === "POST");
    expect(posts).toHaveLength(1);
    expect(posts[0]?.[0].pathname).toBe("/zentao/api.php/v1/tokens");
    const get = sent.filter(([, init]) => init?.method === "GET");
    expect(get).toHaveLength(sent.length - 1);
    expect(new Set(get.map(([url]) => url.pathname))).toEqual(
      new Set(routes.map(({ path }) => `/zentao${path}`)),
    );
    expect(
      sent.every(
        ([url, init]) =>
          url.origin === new URL(baseUrl).origin && init?.redirect === "error",
      ),
    ).toBe(true);
    for (const route of routes) {
      const matches = get.filter(
        ([url]) => url.pathname === `/zentao${route.path}`,
      );
      const first = matches[0]?.[0];
      expect(first).toBeDefined();
      for (const [key, value] of Object.entries(route.query ?? {})) {
        expect(first?.searchParams.get(key)).toBe(value);
      }
      expect(matches).toHaveLength(route.empty ? 2 : 1);
      expect(
        matches.every(
          ([, init]) =>
            new Headers(init?.headers).get("Token") === token &&
            init?.body === undefined,
        ),
      ).toBe(true);
    }

    const events: unknown[] = logSink.mock.calls.map(([line]) =>
      JSON.parse(line),
    );
    expect(events).toContainEqual({
      method: "GET",
      pathTemplate: "/api.php/v1/products/{id}/stories",
      status: 201,
      durationMs: 0,
      objectId: 42,
    });
    expect(() =>
      assertNoSensitiveData([report, events], secrets),
    ).not.toThrow();
    expect(JSON.stringify([report, events])).not.toContain("10.2.3.4");
    expect(JSON.stringify([report, events])).not.toContain("/private?");
  });

  it("按显式产品采样并继续处理 404、真实空列表和耗尽重试的分支", async () => {
    const { options, fetch, sleep, logSink } = setup(samples(81), (url) => {
      if (url.pathname.endsWith("/requiredFields"))
        return Response.json({ message: token }, { status: 503 });
      if (url.pathname.endsWith("/releases"))
        return Response.json({ message: password }, { status: 404 });
      if (url.pathname.endsWith("/product/browse"))
        return Response.json({ data: { stories: [] } });
      if (url.pathname.endsWith("/v2/executions")) return Response.json([]);
    });
    const report = await collectProbeFixtures(options, 81);
    expect(report.completeness).toBe("partial");
    expect(report.gaps).toEqual(
      expect.arrayContaining([
        { endpoint: "required-fields", code: "ZENTAO_UNAVAILABLE" },
        { endpoint: "requirement-detail", code: "NOT_FOUND" },
        { endpoint: "releases", code: "NOT_FOUND" },
      ]),
    );
    expect(report.gaps).toHaveLength(3);
    expect(report.fixtures).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          endpoint: "product-requirements",
          sample: "empty",
          body: { data: { stories: [] } },
        }),
        expect.objectContaining({
          endpoint: "executions-v2",
          sample: "empty",
          body: [],
        }),
        expect.objectContaining({ endpoint: "task-detail" }),
        expect.objectContaining({ endpoint: "story-create-metadata" }),
      ]),
    );
    const sent = requests(fetch);
    expect(
      sent.some(([url]) => url.pathname.endsWith("/requirement/view")),
    ).toBe(false);
    expect(
      sent.some(([url]) => url.pathname.endsWith("/products/81/plans")),
    ).toBe(true);
    expect(sleep.mock.calls).toEqual([[300], [900]]);
    expect(logSink.mock.calls.flat()).toContain(
      JSON.stringify({
        method: "GET",
        pathTemplate: "/api.php/v1/products/{id}/releases",
        status: 404,
        durationMs: 0,
        objectId: 81,
      }) + "\n",
    );
    expect(() =>
      assertNoSensitiveData([report, logSink.mock.calls.flat()], secrets),
    ).not.toThrow();
  });

  it("服务端把越界页钳回正常页时只保留已观察到的正常样本", async () => {
    const { options, fetch } = setup(samples(), (url) => {
      if (
        url.pathname.endsWith("/products") &&
        url.searchParams.get("page") === "2"
      ) {
        return Response.json({ products: [{ id: 42 }], total: 1 });
      }
    });
    const report = await collectProbeFixtures(options);
    expect(report.completeness).toBe("complete");
    expect(
      report.fixtures
        .filter(({ endpoint }) => endpoint === "products")
        .map(({ sample }) => sample),
    ).toEqual(["normal"]);
    expect(
      requests(fetch).filter(([url]) => url.pathname.endsWith("/products")),
    ).toHaveLength(2);
  });

  it.each([400, 500])(
    "P1-4 正常产品页已采集时，空页试探返回 %i 不产生缺口",
    async (status) => {
      const { options, fetch, sleep, logSink } = setup(samples(), (url) => {
        if (
          url.pathname.endsWith("/products") &&
          url.searchParams.get("page") === "2"
        )
          return Response.json({ message: token }, { status });
      });

      const report = await collectProbeFixtures(options);
      expect(report.completeness).toBe("complete");
      expect(report.gaps).toEqual([]);
      expect(
        report.fixtures.filter(({ endpoint }) => endpoint === "products"),
      ).toEqual([expect.objectContaining({ sample: "normal" })]);
      const emptyRequests = requests(fetch).filter(
        ([url]) =>
          url.pathname.endsWith("/products") &&
          url.searchParams.get("page") === "2",
      );
      expect(emptyRequests).toHaveLength(status === 400 ? 1 : 3);
      expect(sleep.mock.calls).toEqual(status === 400 ? [] : [[300], [900]]);
      assertNoSensitiveData([report, logSink.mock.calls], secrets);
    },
  );

  it("P1-4 空页试探仍因认证失败中止整批采集", async () => {
    const { options, fetch, logSink } = setup(samples(), (url) => {
      if (
        url.pathname.endsWith("/products") &&
        url.searchParams.get("page") === "2"
      )
        return Response.json({ message: token }, { status: 401 });
    });

    const capture = collectProbeFixtures(options);
    await expect(capture).rejects.toMatchObject({ code: "AUTH_FAILED" });
    expect(
      requests(fetch).filter(([url]) => url.pathname.endsWith("/tokens")),
    ).toHaveLength(2);
    await capture.catch((error: unknown) =>
      assertNoSensitiveData([error, logSink.mock.calls], secrets),
    );
  });

  it("真实空产品、项目、部门和执行可入库，跳过无合法 ID 的详情", async () => {
    const { options, fetch } = setup([], (url) => {
      const emptyKey = new Map([
        ["/zentao/api.php/v1/products", "products"],
        ["/zentao/api.php/v1/projects", "projects"],
        ["/zentao/api.php/v1/departments", "departments"],
        ["/zentao/api.php/v1/executions", "executions"],
        ["/zentao/api.php/v2/executions", "executions"],
      ]).get(url.pathname);
      if (emptyKey) return Response.json({ [emptyKey]: [] });
    });
    const report = await collectProbeFixtures(options);
    expect(report.completeness).toBe("partial");
    expect(report.fixtures.map(({ sample }) => sample)).toEqual(
      Array(5).fill("empty"),
    );
    expect(report.gaps).toContainEqual({
      endpoint: "product-modules",
      code: "NOT_FOUND",
    });
    expect(report.gaps).toContainEqual({
      endpoint: "users-by-department",
      code: "NOT_FOUND",
    });
    expect(report.gaps).toContainEqual({
      endpoint: "project-bugs",
      code: "NOT_FOUND",
    });
    expect(report.gaps).toContainEqual({
      endpoint: "execution-tasks",
      code: "NOT_FOUND",
    });
    expect(
      requests(fetch)
        .map(([url]) => url.pathname)
        .every((path) => !/\/\d+(?:\/|$)/u.test(path)),
    ).toBe(true);
  });

  it("登录认证失败时立即退出并屏蔽失败响应", async () => {
    const { options, fetch, logSink } = setup(samples(), (url) => {
      if (url.pathname.endsWith("/tokens"))
        return Response.json(
          { message: `${account} ${password} ${token}` },
          { status: 403 },
        );
    });
    const report = collectProbeFixtures(options);
    await expect(report).rejects.toMatchObject({ code: "AUTH_FAILED" });
    await report.catch((error: unknown) =>
      assertNoSensitiveData([error, logSink.mock.calls.flat()], secrets),
    );
    expect(fetch).toHaveBeenCalledTimes(1);
  });

  it("没有核心业务入口可读时安全退出，即使实例配置可达", async () => {
    const { options, logSink } = setup(
      samples().filter(({ endpoint }) => endpoint === "instance-config"),
    );
    const report = collectProbeFixtures(options);
    await expect(report).rejects.toMatchObject({ code: "ZENTAO_UNAVAILABLE" });
    await report.catch((error: unknown) =>
      assertNoSensitiveData([error, logSink.mock.calls.flat()], secrets),
    );
  });

  it("登录刷新后，整批夹具一起扫描新旧凭据", async () => {
    let logins = 0;
    const { options, fetch } = setup(samples(), (url, init) => {
      if (url.pathname.endsWith("/tokens"))
        return Response.json(
          { token: ++logins === 1 ? token : refetchedToken },
          { status: 201 },
        );
      if (url.pathname.endsWith("/index.php"))
        return Response.json({ version: "22.6", opaque: refetchedToken });
      if (
        url.pathname.endsWith("/user") &&
        new Headers(init?.headers).get("Token") === token
      )
        return Response.json({ message: token }, { status: 401 });
    });
    const report = await collectProbeFixtures(options);
    expect(report.completeness).toBe("complete");
    expect(
      requests(fetch).filter(([url]) => url.pathname.endsWith("/tokens")),
    ).toHaveLength(2);
    expect(() => assertNoSensitiveData(report, secrets)).not.toThrow();
  });

  it("非 JSON 正文成为安全采集缺口", async () => {
    const { options, logSink } = setup(samples(), (url) => {
      if (url.pathname.endsWith("/requiredFields"))
        return new Response(`<p>${password} ${token}</p>`);
    });
    const report = await collectProbeFixtures(options);
    expect(report.gaps).toEqual([
      { endpoint: "required-fields", code: "ZENTAO_SCHEMA_MISMATCH" },
    ]);
    expect(() =>
      assertNoSensitiveData([report, logSink.mock.calls.flat()], secrets),
    ).not.toThrow();
  });

  it("拒绝 2xx 结构化错误，保留含成功提示的实际主体", async () => {
    const { options } = setup(samples(), (url) => {
      if (url.pathname.endsWith("/requiredFields")) {
        return Response.json({ status: 200, error: { fields: [password] } });
      }
      if (url.pathname.endsWith("/story/view")) {
        return Response.json({
          result: "success",
          message: `操作成功 ${token}`,
          story: { id: 51 },
        });
      }
    });
    const report = await collectProbeFixtures(options);
    expect(report.gaps).toEqual([
      { endpoint: "required-fields", code: "ZENTAO_BUSINESS_ERROR" },
    ]);
    expect(report.fixtures).toContainEqual(
      expect.objectContaining({
        endpoint: "story-detail-v2",
        body: expect.objectContaining({ story: { id: 51 } }),
      }),
    );
    expect(() => assertNoSensitiveData(report, secrets)).not.toThrow();
  });

  it.each([0, -1, 1.5, Number.NaN, Number.MAX_SAFE_INTEGER + 1])(
    "不为非法产品 ID %s 发送任何请求",
    async (productId) => {
      const { options, fetch } = setup();
      await expect(
        collectProbeFixtures(options, productId),
      ).rejects.toMatchObject({ code: "INVALID_INPUT" });
      expect(fetch).not.toHaveBeenCalled();
    },
  );

  it("公共门面产出同样的安全报告并使用受控传输", async () => {
    const { options, fetch } = setup();
    vi.stubGlobal("fetch", fetch);
    const report = await captureProbeFixtures({
      ...options,
      timeoutMs: 1_500,
      productId: 42,
    });
    expect(report.completeness).toBe("complete");
    expect(
      requests(fetch).every(([, init]) => init?.redirect === "error"),
    ).toBe(true);
    expect(() => assertNoSensitiveData(report, secrets)).not.toThrow();
  });
});
