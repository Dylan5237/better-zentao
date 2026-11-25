import { mkdtemp, readFile, readdir, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { runCli } from "../../src/adapters/cli/run-cli.ts";
import { runProbeWrite } from "../../src/services/probe-write.ts";
import { assertNoSensitiveData } from "../helpers/assert-no-sensitive-data.ts";

const account = "probe_directory_identity";
const alternate = "probe_other_identity";
const password = "probe-test-password-secret";
const token = "probe-test-session-secret";
const env = {
  ZENTAO_BASE_URL: "http://probe.invalid/zentao",
  ZENTAO_ACCOUNT: account,
  ZENTAO_PASSWORD: password,
};
const clock = () => 1_800_000_000_000;
const runtime = { env, homeDir: tmpdir(), clock, logSink: vi.fn() };

const directoryUser = (value: string, deleted = false) => ({
  id: value === account ? 1 : 2,
  account: value,
  realname: "私有姓名测试",
  dept: 0,
  role: "dev",
  deleted,
  password,
});

interface FakeStory {
  id: number;
  product: number;
  type: "story";
  title: string;
  status: string;
  module: number;
  plan: number;
  category: string;
  feedbackBy: string;
  assignedTo: string;
  spec: string;
  keywords?: string;
  openedBy: string;
  openedDate: string;
  actions: {
    id: number;
    actor: string;
    action: string;
    date: string;
    comment: string;
  }[];
}

type Entry = { method: string; path: string; body?: Record<string, unknown> };

function fakeZentao(
  options: {
    sources?: string[];
    module?: number;
    planStatus?: string;
    planDeleted?: boolean;
    users?: ReturnType<typeof directoryUser>[];
    uncertainCreate?: boolean;
    missingId?: boolean;
    badFirstDetail?: boolean;
    commentUnsupported?: boolean;
    activateUnsupported?: boolean;
    closeUnsupported?: boolean;
    includeOtherStory?: boolean;
    fixtureSecret?: boolean;
    unrelatedReceiptId?: boolean;
    normalizeSpec?: (spec: string) => string;
    executionProducts?: number[];
    projectProducts?: number[];
    linkStatus?: number;
    linkDespite404?: boolean;
    requirementProduct?: number;
    unreportedTasks?: boolean;
    childParent?: number;
    batchReceiptId?: number;
  } = {},
) {
  const entries: Entry[] = [];
  const stories = new Map<number, FakeStory>();
  const tasks = new Map<number, Record<string, unknown>>();
  const taskDefaults = {
    isParent: false,
    mode: "",
    estimate: 0,
    consumed: 0,
    left: 0,
  };
  const executionStories = new Set<number>();
  const storyLinks = new Map<number, number[]>();
  let failDetailOnce = options.badFirstDetail;
  const date = "2027-01-15 16:00:00";
  const makeStory = (id: number, input: Record<string, unknown> = {}) => ({
    id,
    product: Number(input.product ?? 29),
    type: "story" as const,
    title: String(input.title ?? "synthetic"),
    status: "draft",
    module: Number(input.module ?? 11),
    plan: Number(input.plan ?? 0),
    category: String(input.category ?? "feature"),
    feedbackBy: String(input.feedbackBy ?? ""),
    assignedTo: String(input.assignedTo ?? account),
    spec: String(input.spec ?? ""),
    openedBy: account,
    openedDate: date,
    actions: [],
  });
  if (options.includeOtherStory)
    stories.set(91, makeStory(91, { product: 42 }));
  if (options.unrelatedReceiptId) stories.set(90, makeStory(90));

  const respond = (body: unknown, status = 200) =>
    Response.json(body, { status });
  const sender = vi.fn<typeof fetch>(async (resource, init) => {
    const url = new URL(String(resource));
    const path = url.pathname.replace(/^\/zentao/u, "");
    const method = init?.method ?? "GET";
    const body: Record<string, unknown> | undefined =
      typeof init?.body === "string" ? JSON.parse(init.body) : undefined;
    entries.push({ method, path: path + url.search, body });
    expect(url.origin).toBe("http://probe.invalid");
    expect(init?.redirect).toBe("error");
    if (path === "/api.php/v1/tokens") return respond({ token }, 201);
    expect(new Headers(init?.headers).get("Token")).toBe(token);
    if (path === "/index.php")
      return respond({ version: "22.6", URAndSR: true });
    if (path === "/api.php/v1/user")
      return respond({ profile: directoryUser(account) });
    if (path === "/api.php/v1/requiredFields")
      return respond({
        story: {
          create: options.sources ?? [
            "title",
            "module",
            "verify",
            "spec",
            "assignedTo",
          ],
        },
        task: { create: [], finish: [], batchcreate: [] },
        bug: { create: [] },
      });
    if (path === "/api.php/v2/users") {
      const users = options.users ?? [
        directoryUser(account),
        directoryUser(alternate),
      ];
      return respond({ users, total: users.length });
    }
    if (path === "/api.php/v1/products/29")
      return respond({
        id: 29,
        moduleOptionMenu: [{ id: options.module ?? 11, name: "/Synthetic" }],
        projects: 0,
        executions: 0,
      });
    if (path === "/api.php/v1/products/29/plans")
      return respond({
        plans: [
          {
            id: 33,
            product: 29,
            parent: -1,
            title: "Synthetic",
            status: options.planStatus ?? "wait",
            begin: "2027-01-01",
            end: "2027-04-01",
            deleted: options.planDeleted ?? false,
          },
        ],
        total: 1,
      });
    if (path === "/api.php/v1/products/29/projects")
      return respond({
        projects: options.executionProducts
          ? [
              {
                id: 50,
                multiple: "1",
                status: "doing",
                products: options.projectProducts ?? [29],
              },
            ]
          : [],
        total: options.executionProducts ? 1 : 0,
      });
    const execution = {
      id: 60,
      project: 50,
      status: "doing",
      products: options.executionProducts,
    };
    if (path === "/api.php/v1/projects/50/executions")
      return respond({ executions: [execution], total: 1 });
    if (path === "/api.php/v1/executions/60") return respond(execution);
    if (
      path === "/api.php/v1/executions/60/stories" ||
      path === "/api.php/v2/execution/linkStory"
    ) {
      if (method === "GET")
        return respond({
          stories: [...executionStories].map((id) => stories.get(id)),
          total: executionStories.size,
        });
      if (
        path.includes("/v1/") &&
        options.linkStatus &&
        !options.linkDespite404
      )
        return respond({}, options.linkStatus);
      if (path.includes("/v2/"))
        expect(url.searchParams.get("objectID")).toBe("60");
      for (const id of body?.stories as number[]) executionStories.add(id);
      return respond(
        {},
        path.includes("/v1/") ? (options.linkStatus ?? 201) : 200,
      );
    }
    if (path === "/api.php/v1/executions/60/tasks" && method === "GET")
      return respond({ tasks: [...tasks.values()], total: tasks.size });
    if (path === "/api.php/v1/executions/60/tasks" && method === "POST") {
      expect(executionStories.has(Number(body?.story))).toBe(true);
      expect(body).toMatchObject({
        execution: 60,
        module: 11,
        type: "devel",
        assignedTo: account,
        pri: 3,
        estStarted: "2027-01-15",
        deadline: "2027-01-15",
        desc: expect.stringContaining("<!-- bzt:stage=dev -->"),
      });
      tasks.set(70, {
        ...taskDefaults,
        ...body,
        id: 70,
        parent: 0,
        status: "wait",
        openedBy: account,
      });
      return respond(options.unreportedTasks ? {} : { id: 70, token }, 201);
    }
    if (path === "/api.php/v2/task/batchCreate") {
      expect(Object.fromEntries(url.searchParams)).toMatchObject({
        executionID: "60",
        moduleID: "11",
        taskID: "70",
      });
      const [task] = (body?.name as string[]).map((_, i) =>
        Object.fromEntries(
          Object.entries(body ?? {}).map(([key, values]) => [
            key,
            (values as unknown[])[i],
          ]),
        ),
      );
      tasks.set(71, {
        ...taskDefaults,
        ...task,
        id: 71,
        execution: 60,
        parent: options.childParent ?? 70,
        status: "wait",
        openedBy: account,
      });
      return respond({
        status: "success",
        changes: options.unreportedTasks
          ? {}
          : { objectList: [options.batchReceiptId ?? 71] },
        password,
      });
    }
    const taskRoute = /^\/api\.php\/v1\/tasks\/(\d+)(\/close)?$/u.exec(path);
    if (taskRoute) {
      const task = tasks.get(Number(taskRoute[1]));
      if (!task) return respond({}, 404);
      if (method === "POST") task.status = "closed";
      return respond(task);
    }
    const requirement = {
      ...makeStory(99, { product: options.requirementProduct }),
      type: "requirement",
      status: "active",
    };
    if (path === "/api.php/v2/product/browse")
      return respond({
        stories: options.requirementProduct === undefined ? [] : [requirement],
      });
    if (
      path === "/api.php/v2/story/view" ||
      path === "/api.php/v2/requirement/view"
    ) {
      const id = Number(url.searchParams.get("storyID"));
      return respond({
        story: {
          ...(id === 99 ? requirement : stories.get(id)),
          linkStories: (storyLinks.get(id) ?? []).join(","),
        },
      });
    }
    if (
      path === "/api.php/v2/story/linkStory" ||
      path === "/api.php/v2/requirement/linkStory"
    ) {
      const id = Number(url.searchParams.get("storyID"));
      const [target] = body?.stories as number[];
      storyLinks.set(id, [Number(target)]);
      if (id !== 99) storyLinks.set(Number(target), [id]);
      return respond({ status: "success", password });
    }
    if (path === "/api.php/v1/products/29/stories")
      return respond({
        stories: [...stories.values()].filter((story) => story.product === 29),
        total: [...stories.values()].filter((story) => story.product === 29)
          .length,
      });
    if (path === "/api.php/v2/stories" && method === "POST") {
      expect(url.searchParams.get("productID")).toBe("29");
      expect(body).toMatchObject({
        product: 29,
        module: 11,
        modules: [11],
        reviewer: [],
        status: "draft",
      });
      const story = makeStory(101 + stories.size, body);
      story.spec = options.normalizeSpec?.(story.spec) ?? story.spec;
      stories.set(story.id, story);
      if (options.uncertainCreate) throw new Error(token);
      return respond(
        {
          status: "success",
          ...(options.missingId
            ? {}
            : { id: options.unrelatedReceiptId ? 90 : story.id }),
          ...(options.fixtureSecret ? { token, password, account } : {}),
        },
        201,
      );
    }
    const match = /^\/api\.php\/v1\/stories\/(\d+)(?:\/(\w+))?$/u.exec(path);
    const storyId = Number(match?.[1] ?? url.searchParams.get("objectID"));
    const action =
      match?.[2] ??
      (path === "/api.php/v2/action/comment" ? "comment" : undefined);
    const story = stories.get(storyId);
    if (!story) return respond({ password }, 404);
    if (method === "GET") {
      if (failDetailOnce) {
        failDetailOnce = false;
        return respond({ password }, 404);
      }
      return respond(story);
    }
    expect(story.product).toBe(29);
    if (action === "assign") story.assignedTo = String(body?.assignedTo);
    if (action === "close" && options.closeUnsupported) return respond({}, 404);
    if (action === "close") story.status = "closed";
    if (action === "activate" && options.activateUnsupported)
      return respond({}, 405);
    if (action === "activate") story.status = "active";
    if (method === "PUT" && body?.status === "active") story.status = "active";
    if (method === "PUT" && body?.keywords)
      story.keywords = String(body.keywords);
    if (method === "PUT" && body?.plan) story.plan = Number(body.plan);
    if (method === "PUT" && typeof body?.spec === "string")
      story.spec = options.normalizeSpec?.(body.spec) ?? body.spec;
    if (action === "comment") {
      if (match && options.commentUnsupported) return respond({}, 404);
      story.actions.push({
        id: 1,
        actor: account,
        action: "commented",
        date,
        comment: String(body?.comment),
      });
    }
    return respond({ id: story.id, password }, 200);
  });
  vi.stubGlobal("fetch", sender);
  return {
    entries,
    stories,
    tasks,
    sends: (contains: string) =>
      entries.filter(
        ({ method, path }) => method !== "GET" && path.includes(contains),
      ),
  };
}

afterEach(() => vi.unstubAllGlobals());

function phaseA(capability?: string, out?: string) {
  return runProbeWrite({
    ...runtime,
    cli: {
      action: "write",
      product: "29",
      capability,
      all: capability === undefined,
      assignee: alternate,
      out,
    },
  });
}

describe("WP-30 Phase A", () => {
  it("串行探通所有配方、复读子任务及父任务关闭，落盘夹具通过 S01", async () => {
    const zen = fakeZentao({
      executionProducts: [29],
      requirementProduct: 29,
      fixtureSecret: true,
    });
    const out = await mkdtemp(join(tmpdir(), "bzt-wp30-"));
    try {
      const result = await phaseA(undefined, out);
      expect(result).toMatchObject({ ok: true });
      for (const capability of [
        "story.create.plan",
        "story.edit",
        "story.linkExecution",
        "story.linkStory",
        "requirement.linkStory",
        "task.create",
        "task.close",
      ]) {
        expect(result.attempts).toContainEqual(
          expect.objectContaining({ capability, status: "confirmed" }),
        );
      }
      expect(zen.sends("/api.php/v1/tasks/").map(({ path }) => path)).toEqual([
        "/api.php/v1/tasks/71/close",
        "/api.php/v1/tasks/70/close",
      ]);
      for (const [id, task] of zen.tasks) {
        expect(task.status).toBe("closed");
        const closed = zen.entries.findIndex(
          ({ path }) => path === `/api.php/v1/tasks/${id}/close`,
        );
        expect(zen.entries.slice(closed + 1)).toContainEqual(
          expect.objectContaining({
            method: "GET",
            path: `/api.php/v1/tasks/${id}`,
          }),
        );
      }
      expect(
        [...zen.stories.values()].every(({ status }) => status === "closed"),
      ).toBe(true);
      expect(
        zen.entries.find(({ method }) => method === "PUT")?.body,
      ).toMatchObject({
        plan: 33,
        spec: expect.stringContaining("[bzt:v1 "),
      });
      const files = await readdir(out);
      expect(files).toEqual(
        expect.arrayContaining([
          "task-create.70.json",
          "task-create.71.json",
          "task-close.70.json",
          "task-close.71.json",
        ]),
      );
      for (const file of files) {
        const fixture: unknown = JSON.parse(
          await readFile(join(out, file), "utf8"),
        );
        expect(fixture).toMatchObject({
          endpoint: expect.any(String),
          status: expect.any(Number),
          body: { request: expect.any(Object), response: expect.anything() },
        });
        assertNoSensitiveData(fixture, [
          password,
          token,
          account,
          env.ZENTAO_BASE_URL,
        ]);
      }
    } finally {
      await rm(out, { recursive: true, force: true });
    }
  });

  it.each([
    [404, false, 1],
    [404, true, 0],
    [503, false, 0],
  ] as const)(
    "只有 404 且未关联才试 v2（%i / %s）",
    async (linkStatus, linkDespite404, fallback) => {
      const zen = fakeZentao({
        executionProducts: [29],
        linkStatus,
        linkDespite404,
      });
      const result = await phaseA("story.linkExecution");
      expect(zen.sends("/executions/60/stories")).toHaveLength(1);
      expect(zen.sends("/execution/linkStory")).toHaveLength(fallback);
      expect(result.attempts.at(-1)?.status).toBe(
        fallback ? "confirmed" : "unknown",
      );
    },
  );

  it.each([
    { executionProducts: [29, 42] },
    { executionProducts: [29], projectProducts: [29, 42] },
    { executionProducts: [] },
    { requirementProduct: 42 },
  ])("ADR-19 跨产品或缺归属时没有业务写入 %#", async (options) => {
    const zen = fakeZentao(options);
    const result = await phaseA(
      options.requirementProduct ? "requirement.linkStory" : "task.create",
    );
    expect(result.ok).toBe(false);
    expect(
      zen.entries.filter(
        ({ method, path }) => method !== "GET" && path !== "/api.php/v1/tokens",
      ),
    ).toEqual([]);
  });

  it("没有用户需求时报告原因且不发业务写入", async () => {
    const zen = fakeZentao();
    const result = await phaseA("requirement.linkStory");
    expect(result.attempts).toContainEqual(
      expect.objectContaining({
        capability: "requirement.linkStory",
        status: "not_executed",
        reason: expect.stringContaining("无可用用户需求"),
      }),
    );
    expect(zen.sends("/v2/stories")).toHaveLength(0);
  });

  it("父任务创建未返回 ID 时按本次身份反查并收尾，禁止重建或继续建子任务", async () => {
    const zen = fakeZentao({ executionProducts: [29], unreportedTasks: true });
    const result = await phaseA("task.create");
    expect(result.attempts.at(-1)).toMatchObject({
      capability: "task.create",
      status: "unknown",
      taskId: 70,
    });
    expect(zen.sends("/executions/60/tasks")).toHaveLength(1);
    expect(zen.sends("/task/batchCreate")).toHaveLength(0);
    expect(zen.tasks.get(70)?.status).toBe("closed");
  });

  it("子任务回读的父编号不符时，仅报告创建结果不明并关闭两条任务", async () => {
    const zen = fakeZentao({ executionProducts: [29], childParent: 0 });
    const result = await phaseA("task.create");
    expect(result.ok).toBe(false);
    expect(result.attempts.at(-1)).toMatchObject({
      capability: "task.create",
      status: "unknown",
      taskId: 71,
    });
    expect(zen.sends("/task/batchCreate")).toHaveLength(1);
    expect(result.cleanup.slice(0, 2)).toMatchObject([
      { capability: "task.close", taskId: 71, status: "confirmed" },
      { capability: "task.close", taskId: 70, status: "confirmed" },
    ]);
  });

  it("子任务回执误指父任务时，反查子任务并保留父任务清理记录", async () => {
    const zen = fakeZentao({ executionProducts: [29], batchReceiptId: 70 });
    const result = await phaseA("task.create");
    expect(result.attempts.at(-1)).toMatchObject({
      status: "unknown",
      taskId: 71,
    });
    expect(result.cleanup.slice(0, 2)).toMatchObject([
      { capability: "task.close", taskId: 71, status: "confirmed" },
      { capability: "task.close", taskId: 70, status: "confirmed" },
    ]);
    expect(zen.sends("/task/batchCreate")).toHaveLength(1);
  });

  it.each(["story.linkStory", "requirement.linkStory", "task.close"])(
    "可独立运行 %s 并回读确认",
    async (capability) => {
      const zen = fakeZentao({
        executionProducts: [29],
        requirementProduct: 29,
      });
      const result = await phaseA(capability);
      expect(result.ok).toBe(true);
      expect(result.attempts.at(-1)).toMatchObject({
        capability,
        status: "confirmed",
      });
      expect(zen.sends("/task/batchCreate")).toHaveLength(0);
    },
  );
});

const stripRoleComment = (spec: string) =>
  spec.replace(/<!-- bzt:v1 [^<>]+ -->/gu, "");
const visibleFooter = /<p style="[^"]+">(\[bzt:v1 [^\]]+\])<\/p>/u;

describe("WP-05 #29 探查闭环", () => {
  it("注释被服务器剥离时保留原探查结果，关闭已建需求且不自动改用微标签重建", async () => {
    const zen = fakeZentao({ normalizeSpec: stripRoleComment });
    const result = await runProbeWrite({
      ...runtime,
      cli: { action: "write", product: "29", all: true, assignee: alternate },
    });
    expect(result.attempts).toEqual([
      expect.objectContaining({
        capability: "story.create",
        status: "unknown",
        storyId: 101,
        readback: { htmlStructure: true, roleTag: false },
      }),
    ]);
    expect(zen.sends("/v2/stories")).toHaveLength(1);
    expect(zen.sends("/close")).toHaveLength(1);
    expect(zen.stories.get(101)?.status).toBe("closed");
  });

  it.each([
    "<p>$1</p>",
    '<p>\n<span style="font-size: 12px">$1</span>\n</p>',
    "<br />\n$1<br>",
  ])(
    "CLI 显式选用微标签，并在编辑回读接受服务器规范化的页脚 %s",
    async (footer) => {
      const zen = fakeZentao({
        normalizeSpec: (spec) =>
          stripRoleComment(spec).replace(visibleFooter, footer),
      });
      const cli = {
        ...runtime,
        nodeVersion: "24.11.0",
        stdout: vi.fn(),
        stderr: vi.fn(),
      };
      expect(
        await runCli(
          ["probe", "write", "story.edit", "--product", "29", "--visible-tag"],
          cli,
        ),
      ).toBe(0);
      expect(zen.sends("/v2/stories")).toHaveLength(1);
      expect(zen.sends("/v2/stories")[0]?.body?.spec).toMatch(visibleFooter);
      expect(
        zen.entries.filter((entry) => entry.method === "PUT"),
      ).toHaveLength(1);
      expect(zen.stories.get(101)?.status).toBe("closed");
      const report: unknown = JSON.parse(String(cli.stdout.mock.calls[0]?.[0]));
      expect(report).toMatchObject({
        attempts: [
          {
            capability: "story.create",
            status: "confirmed",
            readback: { htmlStructure: true, roleTag: true },
          },
          { capability: "story.edit", status: "confirmed" },
        ],
      });
    },
  );

  it.each([
    (spec: string) =>
      spec.replace(
        visibleFooter,
        (_, tag: string) => `<!-- ${tag.slice(1, -1)} -->`,
      ),
    (spec: string) =>
      spec.replace(`receiver=${account};`, `receiver=${alternate};`),
  ])("拒绝错误标签格式或内容，即使 HTML 正文仍完整", async (normalizeSpec) => {
    const zen = fakeZentao({ normalizeSpec });
    const result = await runProbeWrite({
      ...runtime,
      cli: { action: "write", product: "29", all: true, visibleTag: true },
    });
    expect(result.attempts).toEqual([
      expect.objectContaining({
        capability: "story.create",
        status: "unknown",
        readback: { htmlStructure: true, roleTag: false },
      }),
    ]);
    expect(zen.sends("/v2/stories")).toHaveLength(1);
    expect(zen.stories.get(101)?.status).toBe("closed");
  });

  it("创建保留 HTML 标签与换行，指派覆盖同值跳过和实际改派，自动关闭所有变体并存脱敏证据", async () => {
    const zen = fakeZentao({ fixtureSecret: true });
    const dir = await mkdtemp(join(tmpdir(), "bzt-write-fixtures-"));
    try {
      const result = await runProbeWrite({
        ...runtime,
        cli: {
          action: "write",
          product: "29",
          all: true,
          assignee: alternate,
          out: dir,
        },
      });
      expect(result, JSON.stringify(result)).toMatchObject({
        ok: true,
        scope: { moduleIds: [11], openPlanIds: [33] },
      });
      expect(result.attempts).toEqual(
        expect.arrayContaining([
          expect.objectContaining({
            capability: "story.create",
            status: "confirmed",
            readback: { htmlStructure: true, roleTag: true },
          }),
          expect.objectContaining({
            capability: "story.assign",
            status: "confirmed",
            skipped: true,
          }),
          expect.objectContaining({
            capability: "story.assign",
            status: "confirmed",
            httpStatus: 200,
          }),
          expect.objectContaining({
            capability: "story.create.plan",
            status: "confirmed",
          }),
        ]),
      );
      expect(zen.sends("/assign")).toHaveLength(1);
      expect([...zen.stories.values()].map(({ status }) => status)).toEqual([
        "closed",
        "closed",
        "closed",
        "closed",
        "closed",
        "closed",
      ]);
      const files = await readdir(dir);
      expect(files.length).toBeGreaterThan(7);
      for (const file of files) {
        const contents = await readFile(join(dir, file), "utf8");
        assertNoSensitiveData(contents, [
          account,
          alternate,
          password,
          token,
          "私有姓名测试",
          env.ZENTAO_BASE_URL,
        ]);
      }
      assertNoSensitiveData(result, [
        account,
        alternate,
        password,
        token,
        env.ZENTAO_BASE_URL,
      ]);
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });

  it.each([{ planStatus: "closed" }, { planDeleted: true }])(
    "排除关闭和删除计划 %o",
    async (options) => {
      const zen = fakeZentao(options);
      const result = await runProbeWrite({
        ...runtime,
        cli: {
          action: "write",
          product: "29",
          capability: "story.create.plan",
        },
      });
      expect(result.attempts).toEqual([
        expect.objectContaining({ status: "not_executed", fields: ["plan"] }),
      ]);
      expect(zen.sends("/v2/stories")).toHaveLength(0);
    },
  );

  it.each([[directoryUser(alternate)], [directoryUser(account, true)]])(
    "不存在及被删除的账号不得写入",
    async (user) => {
      const zen = fakeZentao({ users: [user] });
      const result = await runProbeWrite({
        ...runtime,
        cli: { action: "write", product: "29", capability: "story.create" },
      });
      expect(result.attempts).toEqual([
        expect.objectContaining({
          status: "not_executed",
          fields: ["assignedTo"],
        }),
      ]);
      expect(zen.sends("/v2/stories")).toHaveLength(0);
    },
  );

  it("必填缺项直接返回允许公开的字段，无模块则不写", async () => {
    const zen = fakeZentao({ sources: ["title", "keywords"] });
    const cli = {
      action: "write" as const,
      product: "29",
      capability: "story.create",
    };
    expect((await runProbeWrite({ ...runtime, cli })).attempts).toEqual([
      expect.objectContaining({ status: "not_executed", fields: ["keywords"] }),
    ]);
    expect(zen.sends("/v2/stories")).toHaveLength(0);
    const withoutModule = fakeZentao({ module: 0 });
    expect((await runProbeWrite({ ...runtime, cli })).attempts).toEqual([
      expect.objectContaining({ status: "not_executed", fields: ["module"] }),
    ]);
    expect(withoutModule.sends("/v2/stories")).toHaveLength(0);
  });

  it.each([
    { uncertainCreate: true },
    { missingId: true },
    { badFirstDetail: true },
  ])("不确定结果反查或保留已知 ID 并清理，创建只发一次 %o", async (options) => {
    const zen = fakeZentao(options);
    const result = await runProbeWrite({
      ...runtime,
      cli: { action: "write", product: "29", capability: "story.create" },
    });
    expect(result.attempts[0]).toMatchObject({
      status: "unknown",
      storyId: 101,
    });
    expect(result.cleanup).toEqual([
      expect.objectContaining({ status: "confirmed", storyId: 101 }),
    ]);
    expect(zen.sends("/v2/stories")).toHaveLength(1);
    expect(zen.stories.get(101)?.status).toBe("closed");
  });

  it("候选路由只有明确未落库并读回后才回退", async () => {
    const zen = fakeZentao({
      commentUnsupported: true,
      activateUnsupported: true,
    });
    const result = await runProbeWrite({
      ...runtime,
      cli: { action: "write", product: "29", all: true },
    });
    const mutations = zen.entries.map(
      ({ method, path }) => `${method} ${path}`,
    );
    expect(mutations).toContain(
      "POST /api.php/v2/action/comment?objectType=story&objectID=101",
    );
    expect(mutations).toContain("PUT /api.php/v1/stories/101");
    expect(result.attempts).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          capability: "story.comment",
          status: "failed",
          httpStatus: 404,
        }),
        expect.objectContaining({
          capability: "story.comment",
          status: "confirmed",
        }),
        expect.objectContaining({
          capability: "story.activate",
          status: "failed",
          httpStatus: 405,
        }),
        expect.objectContaining({
          capability: "story.activate",
          status: "confirmed",
        }),
      ]),
    );
  });

  it("cleanup 确认需求归属才能发送，非 #29 或异常参数均不得发送", async () => {
    const zen = fakeZentao({ includeOtherStory: true });
    const cleanup = { action: "cleanup" as const, product: "29", story: "91" };
    expect((await runProbeWrite({ ...runtime, cli: cleanup })).ok).toBe(false);
    expect(zen.sends("/close")).toHaveLength(0);
    const count = zen.entries.length;
    expect(
      (await runProbeWrite({ ...runtime, cli: { ...cleanup, product: "42" } }))
        .ok,
    ).toBe(false);
    expect(zen.entries).toHaveLength(count);
  });

  it("创建回执指向同产品其他需求时只反查并关闭本次新建需求", async () => {
    const zen = fakeZentao({ unrelatedReceiptId: true });
    const result = await runProbeWrite({
      ...runtime,
      cli: { action: "write", product: "29", capability: "story.create" },
    });
    expect(result.attempts[0]).toMatchObject({
      status: "unknown",
      storyId: 102,
    });
    expect(zen.stories.get(90)?.status).toBe("draft");
    expect(zen.stories.get(102)?.status).toBe("closed");
    expect(zen.sends("/close")).toHaveLength(1);
  });

  it("当前测试需求无法确认关闭时，不继续创建其他变体", async () => {
    const zen = fakeZentao({ closeUnsupported: true });
    const result = await runProbeWrite({
      ...runtime,
      cli: { action: "write", product: "29", all: true, assignee: alternate },
    });
    expect(result.ok).toBe(false);
    expect(result.cleanup).toEqual([
      expect.objectContaining({ status: "failed", httpStatus: 404 }),
    ]);
    expect(zen.sends("/v2/stories")).toHaveLength(1);
    expect(zen.sends("/close")).toHaveLength(1);
  });

  it("CLI 在进入网络前拒绝跨产品、重复和冲突参数", async () => {
    const zen = fakeZentao();
    const cli = {
      ...runtime,
      nodeVersion: "24.11.0",
      stdout: vi.fn(),
      stderr: vi.fn(),
    };
    for (const args of [
      ["probe", "write", "story.create", "--product", "42"],
      ["probe", "write", "story.create", "--all", "--product", "29"],
      ["probe", "write", "story.create", "--product", "42", "--product", "29"],
      ["probe", "cleanup", "--product", "29", "--story", "4e2"],
      ["probe", "write", "story.delete", "--product", "29"],
      ["probe", "write", "--all", "--product", "29", "--live"],
      [
        "probe",
        "write",
        "--all",
        "--product",
        "29",
        "--visible-tag",
        "--visible-tag",
      ],
      [
        "probe",
        "cleanup",
        "--product",
        "29",
        "--story",
        "101",
        "--visible-tag",
      ],
      ["probe", "capture", "--visible-tag"],
      ["doctor", "--visible-tag"],
    ])
      expect(await runCli(args, cli)).not.toBe(0);
    expect(zen.entries).toHaveLength(0);
  });
});
