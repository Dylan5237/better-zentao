import { afterEach, expect, it } from "vitest";
import {
  getMyWorkInputSchema,
  getMyWorkOutputSchema,
} from "../../src/contracts/tools/get_my_work.ts";
import { getTeamWorkOutputSchema } from "../../src/contracts/tools/get_team_work.ts";
import { queryStoriesOutputSchema } from "../../src/contracts/tools/query_stories.ts";
import {
  getStoryProgressInputSchema,
  getStoryProgressOutputSchema,
} from "../../src/contracts/tools/get_story_progress.ts";
import { scanWorkflowRisksOutputSchema } from "../../src/contracts/tools/scan_workflow_risks.ts";
import { teamConfigSchema } from "../../src/core/config.ts";
import { openLocalStore } from "../../src/core/store/index.ts";
import { TrackingService } from "../../src/services/tracking.ts";
import { mockReadClient } from "../contract/read-fixture.ts";
import { assertNoSensitiveData } from "../helpers/assert-no-sensitive-data.ts";

const baseUrl = "https://zentao.fixture.test/zentao/";
const clock = () => Date.UTC(2026, 10, 24, 4);
const config = teamConfigSchema.parse({
  products: { 29: { name: "示例产品", state: "runtime", projects: [8] } },
  teams: { dev: { name: "研发", lead: "dev", members: ["other"] } },
  roles: { RM: ["dev"] },
  moduleDefaults: { 29: { designLead: "design", devLead: "dev" } },
});
const users = ["dev", "other", "qa", "design"].map((account, index) => ({
  id: index + 1,
  account,
  realname: `同事${index + 1}`,
  role: account,
  dept: 0,
  deleted: false,
}));
const execution = {
  id: 7,
  project: 8,
  name: "【研发】2026年11月迭代",
  type: "sprint",
  status: "doing",
  begin: "2026-11-01",
  end: "2026-11-30",
};
const plan = {
  id: 22,
  product: 29,
  parent: 0,
  title: "查询计划",
  status: "wait",
  begin: "2026-11-01",
  end: "2026-11-30",
  deleted: false,
};
const story = {
  id: 31,
  type: "story",
  category: "feature",
  product: 29,
  module: 2,
  title: "查询能力",
  status: "active",
  openedBy: "design",
  assignedTo: "dev",
  executions: [execution],
  keywords: "版本:V7.0.3",
  feedbackBy: "同事3",
  openedDate: "2026-11-24 10:00:00",
  spec: "<h3>背景与问题</h3><p>内部背景示例</p><h3>本次实现范围</h3><p>增加查询入口</p><h3>设计文档</h3><p>章节：2.1</p>",
  verify: "<p>可以搜索</p>",
  password: "discard-this-field",
};
const task = {
  id: 11,
  name: "【研发】查询",
  type: "devel",
  execution: 7,
  story: 31,
  product: 29,
  parent: 0,
  isParent: false,
  mode: "",
  status: "doing",
  assignedTo: "dev",
  estStarted: "2026-11-17",
  deadline: "2026-11-19",
  assignedDate: "2026-11-24 10:00:00",
  estimate: 1,
  consumed: 0,
  left: 1,
  storyTitle: "查询能力",
};
const draft = { ...story, id: 32, status: "draft", executions: [] };
const closed = { ...story, id: 33, status: "closed", executions: [] };
const req = {
  ...story,
  id: 41,
  type: "requirement",
  executions: [],
  linkStories: "",
};
const store = openLocalStore({
  dbPath: ":memory:",
  baseUrl,
  account: "dev",
  clock,
});
afterEach(() => {
  store.seenCursor.set("my_work", 0);
});

function setup({
  account = "dev",
  extraUsers = [],
  tasks = [task],
  stories = [story, draft, closed],
  failedExecution = false,
  requirements = [req],
  localStore = store,
  useCache = false,
  detailStatus = {},
  taskDetails = {},
  currentExecution = execution,
  queryClock = clock,
  contributeStatus = 200,
  bugs = [
    {
      id: 81,
      product: 29,
      story: 31,
      severity: 2,
      status: "active",
      title: "示例问题",
    },
  ],
}: {
  account?: string;
  extraUsers?: typeof users;
  tasks?: (typeof task & { closedReason?: string })[];
  stories?: (typeof story & {
    plan?: string;
    deleted?: boolean;
    assignedDate?: string;
  })[];
  failedExecution?: boolean;
  requirements?: (typeof req)[];
  localStore?: typeof store;
  useCache?: boolean;
  detailStatus?: Record<number, number>;
  taskDetails?: Record<number, unknown>;
  currentExecution?: typeof execution;
  queryClock?: typeof clock;
  contributeStatus?: number;
  bugs?: unknown[];
} = {}) {
  const allUsers = [...users, ...extraUsers];
  const { client, fetch } = mockReadClient((url) => {
    const path = url.pathname.replace("/zentao", "");
    const id = Number(path.split("/").at(-1));
    if (path.startsWith("/api.php/v1/stories/"))
      return Response.json(stories.find((row) => row.id === id) ?? {}, {
        status:
          detailStatus[id] ??
          (stories.some((row) => row.id === id) ? 200 : 404),
      });
    if (path.startsWith("/api.php/v1/tasks/"))
      return Response.json(taskDetails[id] ?? {}, {
        status: taskDetails[id] ? 200 : 404,
      });
    if (path === "/api.php/v1/executions/9/tasks")
      return Response.json({}, { status: 403 });
    if (path === "/api.php/v2/my/contribute" && contributeStatus !== 200)
      return Response.json({}, { status: contributeStatus });
    const rows: Record<string, unknown> = {
      "/api.php/v1/user": {
        profile: allUsers.find((person) => person.account === account),
      },
      "/api.php/v2/users": { users: allUsers },
      "/api.php/v1/products": {
        products: [
          { id: 29, name: "示例产品", status: "normal", deleted: false },
        ],
      },
      "/api.php/v1/products/29/stories": { stories },
      "/api.php/v1/products/29": {
        id: 29,
        moduleOptionMenu: [{ id: 2, name: "/查询" }],
      },
      "/api.php/v1/products/29/bugs": { bugs },
      "/api.php/v1/products/29/plans": { plans: [plan] },
      "/api.php/v2/product/browse": { stories: requirements },
      "/api.php/v2/requirement/view": {
        story: requirements.find(
          (row) => row.id === Number(url.searchParams.get("storyID")),
        ),
      },
      "/api.php/v2/my/work": {
        stories: [],
        pager: { recTotal: 0 },
        todoCount: {},
      },
      "/api.php/v2/my/contribute": {
        stories: [],
        pager: { recTotal: 0 },
        todoCount: {},
      },
      "/api.php/v1/executions": {
        executions: failedExecution
          ? [currentExecution, { ...currentExecution, id: 9 }]
          : [currentExecution],
      },
      "/api.php/v1/executions/7/tasks": { tasks },
    };
    return Response.json(rows[path] ?? {}, { status: rows[path] ? 200 : 404 });
  });
  return {
    service: new TrackingService({
      client,
      clock: queryClock,
      config,
      baseUrl,
      store: {
        seenCursor: localStore.seenCursor,
        sourceLinks: localStore.sourceLinks,
        intake: localStore.intake,
        storyRoles: localStore.storyRoles,
        cache: useCache ? localStore.cache : undefined,
      },
    }),
    fetch,
  };
}

function paths(fetch: ReturnType<typeof setup>["fetch"]) {
  return fetch.mock.calls.map(([input]) =>
    new URL(String(input)).pathname.replace("/zentao", ""),
  );
}

it("AC-20/21/22/25 按到期和就绪状态分组并推进已读游标", async () => {
  const { service } = setup({
    tasks: [
      task,
      { ...task, id: 12, deadline: "" },
      { ...task, id: 13, deadline: "2026-11-24" },
      { ...task, id: 14, deadline: "2026-11-25" },
    ],
  });
  const result = getMyWorkOutputSchema.parse(await service.getMyWork({}));
  expect(result.scope.asOf).toBe("2026-11-24T04:00:00.000Z");
  expect(result.completeness).toBe("complete");
  expect(result.data.action.overdue.map(({ id }) => id)).toEqual([11]);
  expect(result.data.action.unscheduled.map(({ id }) => id)).toEqual([12]);
  expect(result.data.action.dueToday.map(({ id }) => id)).toEqual([13]);
  expect(result.data.action.dueSoon.map(({ id }) => id)).toEqual([14]);
  expect(result.data.new.map(({ id }) => id)).toContain(11);
  expect(result.data.waiting_ready).toEqual([
    expect.objectContaining({
      id: 32,
      waitingFor: expect.objectContaining({ account: "design" }),
      riskCodes: ["R04"],
    }),
  ]);
  expect(result.data.action.toReceive).toEqual([]);
  expect(store.seenCursor.get("my_work")?.lastSeenAt).toBe(clock());
  expect((await service.getMyWork({})).data.new).toEqual([]);
  expect(getMyWorkInputSchema.safeParse({ extra: true }).success).toBe(false);
  assertNoSensitiveData(result, ["discard-this-field"]);
});

it("AC-23/24/26 团队只统计叶子和串行当前顺位，并报告执行读取失败", async () => {
  const { service } = setup({
    failedExecution: true,
    tasks: [
      { ...task, id: 10, isParent: true },
      { ...task, parent: 10, status: "done" },
      { ...task, id: 12, mode: "linear", assignedTo: "other" },
    ],
  });
  const result = getTeamWorkOutputSchema.parse(await service.getTeamWork({}));
  expect(result.completeness).toBe("partial");
  expect(result.gaps).toContainEqual(
    expect.objectContaining({ source: "tasks:9" }),
  );
  expect(result.data.totals).toEqual({ overdue: 1, dueSoon: 0, open: 1 });
  expect(result.data.parentRisks?.map(({ task }) => task.id)).toEqual([10]);
  expect(result.data.groups.map(({ key }) => key)).toEqual(["other"]);
  assertNoSensitiveData(result, ["discard-this-field"]);
});

it("AC-27/29 进度卡片与研发视图只展示各自所需内容，并用产品级问题判进展", async () => {
  const { service } = setup({
    tasks: [
      { ...task, status: "done" },
      { ...task, id: 12, name: "测试查询", status: "done" },
      {
        ...task,
        id: 13,
        name: "【验收】查询",
        status: "wait",
        deadline: "2026-11-26",
      },
    ],
  });
  const full = getStoryProgressOutputSchema.parse(
    await service.getStoryProgress({ storyId: 31, format: "card" }),
  );
  expect(full.data).toMatchObject({
    progress: { value: "测试中", level: "inferred" },
    related: { bugs: [{ id: 81 }] },
  });
  if (!("card" in full.data)) throw new Error("未返回进度卡片");
  expect(full.data.card).toEqual(expect.stringContaining("推测"));
  expect(full.data.card).toContain("预计 2026-11-26");
  expect(full.data.card).toContain(`数据时间：${full.scope.asOf}`);
  expect(full.data.card).toEqual(
    expect.stringContaining(
      "https://zentao.fixture.test/zentao/story-view-31.html",
    ),
  );
  expect(full.data.card).not.toMatch(/内部背景示例|禅道|Bug/u);
  const dev = await service.getStoryProgress({ storyId: 31, view: "dev" });
  expect(dev.data).toEqual({
    scope: "增加查询入口",
    designRef: "章节：2.1",
    verify: "可以搜索",
    tasks: expect.any(Array),
    untrusted: true,
  });
  expect(
    getStoryProgressInputSchema.safeParse({
      storyId: 31,
      intakeId: "duplicate",
    }).success,
  ).toBe(false);
  assertNoSensitiveData([full, dev], ["discard-this-field", "内部背景示例"]);
});

it("AC-28 设计、评审完成但传递未完成时显示待传递", async () => {
  const { service } = setup({
    stories: [{ ...story, category: "design" }],
    tasks: [
      { ...task, name: "【设计】查询", status: "done" },
      { ...task, id: 12, name: "【评审】查询", status: "done" },
      { ...task, id: 13, name: "【传递】查询", status: "wait" },
    ],
  });
  expect((await service.getStoryProgress({ storyId: 31 })).data).toMatchObject({
    progress: { value: "待传递" },
  });
});

it("AC-30/31 有上游完成证据后才展示可开始的测试、验收及交付", async () => {
  const tasks = [
    { ...task, status: "done" },
    { ...task, id: 12, name: "【测试】查询", status: "wait", assignedTo: "qa" },
    {
      ...task,
      id: 13,
      name: "【验收】查询",
      status: "wait",
      assignedTo: "design",
    },
    {
      ...task,
      id: 14,
      name: "【交付】查询",
      status: "wait",
      assignedTo: "design",
    },
  ];
  expect(
    (
      await setup({ account: "qa", tasks }).service.getMyWork({
        groups: ["can_start"],
      })
    ).data.can_start.tests.map(({ id }) => id),
  ).toEqual([12]);
  const upcoming = tasks.map((row) =>
    row.id === 11 ? { ...row, status: "doing", deadline: "2026-11-25" } : row,
  );
  const next = await setup({
    account: "qa",
    tasks: upcoming,
  }).service.getMyWork({ groups: ["can_start"] });
  expect(next.data.can_start.upcomingTests.map(({ id }) => id)).toEqual([12]);
  expect(next.data.can_start.tests).toEqual([]);
  const done = tasks.map((row) =>
    row.id === 12 ? { ...row, status: "done" } : row,
  );
  const blocked = await setup({
    account: "design",
    tasks: done,
  }).service.getMyWork({ groups: ["can_start"] });
  expect(blocked.data.can_start.acceptDeliver).toEqual([]);
  expect(
    (
      await setup({
        account: "design",
        tasks: done,
        bugs: [],
      }).service.getMyWork({ groups: ["can_start"] })
    ).data.can_start.acceptDeliver.map(({ id }) => id),
  ).toEqual([13, 14]);
});

it("AC-32/33/34 查询按本地来源、状态、月份和版本过滤，条目去重后统计", async () => {
  const { service, fetch } = setup({
    stories: [story, story, draft, closed],
    requirements: [req, { ...req, id: 42, linkStories: "31" }],
  });
  expect(
    (
      await service.queryStories({ type: "requirement", unlinked: true })
    ).data.items.map(({ id }) => id),
  ).toEqual([41]);
  expect(
    fetch.mock.calls.filter(([input]) =>
      String(input).includes("/requirement/view"),
    ),
  ).toHaveLength(1);
  const closedResult = queryStoriesOutputSchema.parse(
    await service.queryStories({ status: ["closed"] }),
  );
  expect(closedResult.data.items.map(({ id }) => id)).toEqual([33]);
  const filtered = await service.queryStories({
    status: ["all"],
    feedbackBy: "qa",
    month: "本月",
    version: "V7.0.3",
    limit: 1,
  });
  expect(filtered.data.items.map(({ id }) => id)).toEqual([31]);
  expect(filtered.truncated).toBe(true);
  expect(
    Object.values(filtered.data.countsByProgress).reduce((a, b) => a + b, 0),
  ).toBe(3);
});

it("AC-32/33 使用 WP-17 的来源键查询反馈者、双向配对和派生关系", async () => {
  const localStore = openLocalStore({
    dbPath: ":memory:",
    baseUrl,
    account: "dev",
    clock,
  });
  try {
    const origin = { origin: "local", verifiedAt: null } satisfies Pick<
      Parameters<typeof store.sourceLinks.upsert>[0],
      "origin" | "verifiedAt"
    >;
    localStore.intake.insert({
      intakeId: "intake-1",
      rawText: "原始诉求隐私内容",
      feedbackByText: "同事2",
      feedbackByAccount: "other",
      channel: null,
      createdBy: "design",
      createdAt: Date.UTC(2026, 10, 18, 4),
      backfilled: false,
      actualStartedAt: null,
    });
    localStore.sourceLinks.upsert({
      ...origin,
      fromType: "intake",
      fromId: "intake-1",
      toType: "story",
      toId: "31",
      relation: "source",
    });
    localStore.sourceLinks.upsert({
      ...origin,
      fromType: "requirement",
      fromId: "41",
      toType: "story",
      toId: "31",
      relation: "links",
    });
    localStore.sourceLinks.upsert({
      ...origin,
      fromType: "story",
      fromId: "31",
      toType: "story",
      toId: "32",
      relation: "pairs",
    });
    localStore.sourceLinks.upsert({
      ...origin,
      fromType: "story",
      fromId: "33",
      toType: "story",
      toId: "31",
      relation: "pairs",
    });
    localStore.sourceLinks.upsert({
      ...origin,
      fromType: "story",
      fromId: "31",
      toType: "story",
      toId: "34",
      relation: "derives",
    });
    const { service } = setup({ localStore });
    const input = {
      feedbackBy: "other",
      openedFrom: "2026-11-16",
      openedTo: "2026-11-22",
    };
    const query = await service.queryStories(input);
    expect(query.data.items.map(({ id }) => id)).toEqual([31]);
    expect(
      (await service.queryStories({ ...input, openedTo: "2026-11-17" })).data
        .items,
    ).toEqual([]);
    expect(
      (await service.queryStories({ type: "requirement", unlinked: true })).data
        .items,
    ).toEqual([]);
    const byIntake = await service.getStoryProgress({ intakeId: "intake-1" });
    const byRequirement = await service.getStoryProgress({ requirementId: 41 });
    expect(byIntake.completeness).toBe("complete");
    expect(byIntake.data).toEqual(byRequirement.data);
    expect(byIntake.data).toMatchObject({
      story: { id: 31, feedbackBy: "同事2" },
      related: { requirement: 41, pairs: [33, 32], derivesFrom: 34 },
    });
    assertNoSensitiveData(
      [query, byIntake, byRequirement],
      ["原始诉求隐私内容"],
    );
    localStore.sourceLinks.upsert({
      ...origin,
      fromType: "intake",
      fromId: "intake-1",
      toType: "story",
      toId: "32",
      relation: "source",
    });
    expect(
      (await service.getStoryProgress({ intakeId: "intake-1" })).data,
    ).toMatchObject({
      candidates: [{ id: 31 }, { id: 32 }],
    });
  } finally {
    localStore.close();
  }
});

it("AC-21/26 部分读取时保留新增游标，执行恢复后仍能看见新增任务", async () => {
  const partial = await setup({ failedExecution: true }).service.getMyWork({
    groups: ["new"],
  });
  expect(partial.completeness).toBe("partial");
  expect(partial.gaps).toContainEqual(
    expect.objectContaining({ source: "tasks:9" }),
  );
  expect(store.seenCursor.get("my_work")?.lastSeenAt).toBe(0);
  const complete = await setup().service.getMyWork({
    groups: ["new"],
    markSeen: false,
  });
  expect(complete.data.new.map(({ id }) => id)).toEqual([11]);
  expect(store.seenCursor.get("my_work")?.lastSeenAt).toBe(0);
});

it("B2 需求进展的规则命中遵守风险扫描的完整契约", async () => {
  const result = await setup().service.getStoryProgress({ storyId: 32 });
  if (!("risks" in result.data)) throw new Error("未返回需求风险");
  const hits = scanWorkflowRisksOutputSchema.shape.data.shape.hits.parse(
    result.data.risks,
  );
  expect(hits).toEqual([
    expect.objectContaining({
      rule: "R04",
      level: "recorded",
      severity: "medium",
      object: {
        id: 32,
        type: "story",
        title: "查询能力",
        untrusted: true,
        url: `${baseUrl}story-view-32.html`,
      },
      owner: { account: "dev", realname: "同事1" },
      reason: expect.stringContaining("需求尚未就绪"),
    }),
  ]);
});

it("B3 只读取未关闭的候选详情，命中统一缓存键，缓存失效后重新取数", async () => {
  const unrelated = Array.from({ length: 20 }, (_, index) => ({
    ...story,
    id: index + 100,
    openedBy: "other",
    assignedTo: "other",
    feedbackBy: "",
  }));
  const { service, fetch } = setup({
    useCache: true,
    stories: [
      story,
      draft,
      { ...closed, openedBy: "other", feedbackBy: "" },
      ...unrelated,
    ],
  });
  try {
    await service.getMyWork({});
    expect(
      paths(fetch).filter((path) => path.startsWith("/api.php/v1/stories/")),
    ).toEqual(["/api.php/v1/stories/31", "/api.php/v1/stories/32"]);
    expect(store.cache.get("stories:29")).toBeDefined();
    expect(store.cache.get("story:31")).toBeDefined();
    fetch.mockClear();
    const cached = await service.getMyWork({});
    expect(cached.completeness).toBe("complete");
    expect(paths(fetch)).not.toContain("/api.php/v1/products/29/stories");
    expect(
      paths(fetch).some((path) => path.startsWith("/api.php/v1/stories/")),
    ).toBe(false);
    store.cache.delete("story:31");
    store.cache.delete("stories:29");
    fetch.mockClear();
    await service.getMyWork({});
    expect(paths(fetch)).toContain("/api.php/v1/stories/31");
    expect(paths(fetch)).toContain("/api.php/v1/products/29/stories");
  } finally {
    for (const key of ["stories:29", "story:31", "story:32"])
      store.cache.delete(key);
  }
});

it("B4 辅助需求 404 仍推进游标，显式 since 按北京时间和 ISO 时间查询", async () => {
  const { service } = setup({ detailStatus: { 32: 404 } });
  const first = await service.getMyWork({});
  expect(first.completeness).toBe("partial");
  expect(first.gaps).toContainEqual(
    expect.objectContaining({ source: "story:32" }),
  );
  expect(first.data.new.map(({ id }) => id)).toEqual([11]);
  expect(store.seenCursor.get("my_work")?.lastSeenAt).toBe(clock());
  expect((await service.getMyWork({})).data.new).toEqual([]);
  expect(
    (
      await service.getMyWork({
        groups: ["new"],
        since: "2026-11-24",
        markSeen: false,
      })
    ).data.new.map(({ id }) => id),
  ).toEqual([11]);
  expect(
    (
      await service.getMyWork({
        groups: ["new"],
        since: "2026-11-24T10:00:00+08:00",
        markSeen: false,
      })
    ).data.new,
  ).toEqual([]);
});

it("B4 贡献列表读取失败时保留游标，过期于新增窗口的列表快照不会掩盖新指派", async () => {
  const failed = await setup({ contributeStatus: 403 }).service.getMyWork({});
  expect(failed.gaps).toContainEqual(
    expect.objectContaining({ source: "my_contribute" }),
  );
  expect(store.seenCursor.get("my_work")?.lastSeenAt).toBe(0);
  let now = clock();
  const queryClock = () => now;
  const localStore = openLocalStore({
    dbPath: ":memory:",
    baseUrl,
    account: "dev",
    clock: queryClock,
  });
  try {
    await setup({ queryClock, localStore, useCache: true }).service.getMyWork({
      groups: ["new"],
    });
    now += 30_000;
    const { service, fetch } = setup({
      queryClock,
      localStore,
      useCache: true,
      stories: [{ ...story, assignedDate: "2026-11-24 12:00:15" }],
    });
    const result = await service.getMyWork({ groups: ["new"] });
    expect(result.data.new.map(({ id }) => id)).toEqual([31]);
    expect(paths(fetch)).toContain("/api.php/v1/products/29/stories");
    expect(localStore.seenCursor.get("my_work")?.lastSeenAt).toBe(now);
  } finally {
    localStore.close();
  }
});

it("AC-24 并行参与者状态来自详情，团队按需求、执行分组并区分今日和临期", async () => {
  const multi = {
    ...task,
    mode: "multi",
    deadline: "2026-11-25",
    password: "discard-team-field",
  };
  const { service, fetch } = setup({
    tasks: [multi, { ...task, id: 12, deadline: "2026-11-24" }],
    taskDetails: {
      11: {
        ...multi,
        team: [
          { account: "dev", status: "done" },
          { account: "other", status: "doing", realname: "错误的队内姓名" },
        ],
      },
    },
  });
  const due = await service.getTeamWork({
    team: "研发",
    view: "due_soon",
    groupBy: "story",
  });
  expect(due.data.groups).toMatchObject([
    {
      key: "31",
      label: "查询能力",
      count: 1,
      items: [{ id: 11, assignedTo: { account: "other", realname: "同事2" } }],
    },
  ]);
  expect(paths(fetch)).toContain("/api.php/v1/tasks/11");
  expect(paths(fetch)).not.toContain("/api.php/v1/stories/31");
  const open = await service.getTeamWork({
    team: "dev",
    view: "all_open",
    groupBy: "execution",
  });
  expect(open.data.groups).toMatchObject([
    {
      key: "7",
      count: 2,
      items: [{ id: 11 }, { id: 12, timeState: "due_today" }],
    },
  ]);
  assertNoSensitiveData([due, open], ["discard-team-field", "错误的队内姓名"]);
});

it("N4 查询产品工作纳入其他项目的执行，缺失产品归属时返回缺口", async () => {
  const { service } = setup({
    currentExecution: { ...execution, project: 81 },
    tasks: [task, { ...task, id: 12, story: 0, product: 0 }],
  });
  const result = await service.getTeamWork({ product: "示例产品" });
  expect(result.data.totals.overdue).toBe(1);
  expect(result.gaps).toContainEqual(
    expect.objectContaining({ source: "task:12:product" }),
  );
});

it("query_stories 可组合产品、模块、计划、关键字、人员、角色、业务进展和类型", async () => {
  const { service } = setup({
    stories: [
      { ...story, plan: "22" },
      { ...draft, category: "design", plan: "22" },
    ],
  });
  const input = {
    product: "示例产品",
    module: "查询",
    plan: "查询计划",
    keyword: "增加查询",
    who: "同事4",
    role: "maintainer",
    category: "feature",
    progress: ["研发中"],
  };
  expect(
    (await service.queryStories(input)).data.items.map(({ id }) => id),
  ).toEqual([31]);
  for (const change of [
    { keyword: "其他" },
    { role: "receiver" },
    { who: "同事2" },
    { category: "design" },
    { progress: ["待接收"] },
  ])
    expect(
      (await service.queryStories({ ...input, ...change })).data.items,
    ).toEqual([]);
});

it("N5/N6 较长文档保留可用内容，缺范围提示 R05，卡片不预计过去日期", async () => {
  const designRef = "章节：2.1。".repeat(400);
  const verify = "可以搜索。".repeat(75);
  const { service } = setup({
    stories: [
      { ...story, spec: `<h3>设计文档</h3><p>${designRef}</p>`, verify },
    ],
  });
  const dev = getStoryProgressOutputSchema.parse(
    await service.getStoryProgress({ storyId: 31, view: "dev" }),
  );
  expect(dev.data).toMatchObject({
    designRef: `${designRef.slice(0, 1999)}…`,
    verify,
  });
  expect(dev.hints?.join(" ")).toContain("R05");
  const full = await service.getStoryProgress({ storyId: 31, format: "card" });
  expect(full.data).toMatchObject({ card: expect.stringContaining("记录") });
  expect(full.data).not.toMatchObject({
    card: expect.stringContaining("预计 2026-11-19"),
  });
});

it("N11 按编号读取需求保留错误码和重试语义", async () => {
  await expect(
    setup({ detailStatus: { 31: 404 } }).service.getStoryProgress({
      storyId: 31,
    }),
  ).rejects.toMatchObject({ code: "NOT_FOUND", retryable: false });
  await expect(
    setup({
      stories: [{ ...story, deleted: true }],
      detailStatus: {},
    }).service.getStoryProgress({ storyId: 31 }),
  ).rejects.toMatchObject({ code: "NOT_FOUND", retryable: false });
  await expect(
    setup({ detailStatus: { 31: 503 } }).service.getStoryProgress({
      storyId: 31,
    }),
  ).rejects.toMatchObject({ code: "ZENTAO_UNAVAILABLE", retryable: true });
});

it("B-1 仅正文标签指定维护人且已移交研发时明示未读提示，刷新角色缓存后纳入我维护的", async () => {
  const localStore = openLocalStore({
    dbPath: ":memory:",
    baseUrl,
    account: "tag_dm",
    clock,
  });
  try {
    const taggedStory = {
      ...story,
      openedBy: "other",
      assignedTo: "dev",
      status: "active",
      feedbackBy: "",
      spec: "<p>需求说明</p><p>[bzt:v1 maintainer=tag_dm;receiver=dev]</p>",
    };
    const { service } = setup({
      account: "tag_dm",
      extraUsers: [
        {
          id: 5,
          account: "tag_dm",
          realname: "标签维护人",
          role: "po",
          dept: 0,
          deleted: false,
        },
      ],
      stories: [taggedStory],
      tasks: [],
      requirements: [],
      localStore,
    });
    const first = await service.getMyWork({ groups: ["maintained"] });
    expect(first.data.maintained).toEqual([]);
    expect(first.inferences).toContainEqual(
      expect.objectContaining({ field: "maintained", level: "inferred" }),
    );
    expect(first.hints?.join(" ")).toContain(
      'query_stories(role="maintainer")',
    );

    const queried = await service.queryStories({ role: "maintainer" });
    expect(queried.data.items.map(({ id }) => id)).toEqual([31]);
    expect(localStore.storyRoles.get(31)).toMatchObject({
      maintainer: "tag_dm",
      receiver: "dev",
    });

    const second = await service.getMyWork({ groups: ["maintained"] });
    expect(second.data.maintained.map(({ id }) => id)).toEqual([31]);
    expect(second.inferences.some(({ field }) => field === "maintained")).toBe(
      false,
    );
    expect(second.hints).toBeUndefined();
  } finally {
    localStore.close();
  }
});

it("get_my_work 支持 raised 分组与 horizonDays=0 窗口，N4 进展卡片跳过已取消阶段", async () => {
  const { service: designService } = setup({
    account: "design",
    tasks: [{ ...task, id: 14, assignedTo: "design", deadline: "2026-11-25" }],
  });
  const mine = await designService.getMyWork({
    groups: ["action", "raised"],
    horizonDays: 0,
  });
  expect(mine.scope.filters).toMatchObject({ horizonDays: 0 });
  expect(mine.data.action.dueSoon).toEqual([]);
  expect(mine.data.raised.map(({ id }) => id)).toEqual([31, 32, 33]);

  const { service: cardService } = setup({
    tasks: [
      { ...task, id: 11, name: "【研发】查询", status: "done" },
      {
        ...task,
        id: 12,
        name: "【测试】查询",
        status: "cancel",
        closedReason: "cancel",
        deadline: "2026-11-28",
      },
      {
        ...task,
        id: 13,
        name: "【验收】查询",
        status: "wait",
        assignedTo: "design",
        deadline: "2026-11-29",
      },
    ],
  });
  const progress = await cardService.getStoryProgress({
    storyId: 31,
    format: "card",
  });
  expect(progress.data).toMatchObject({
    card: expect.stringContaining("下一步：产品验收（预计 2026-11-29）"),
  });
  expect(progress.data).not.toMatchObject({
    card: expect.stringContaining("下一步：功能测试"),
  });
});
