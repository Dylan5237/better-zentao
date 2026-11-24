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
  tasks = [task],
  stories = [story, draft, closed],
  failedExecution = false,
  requirements = [req],
  localStore = store,
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
  tasks?: (typeof task)[];
  stories?: (typeof story)[];
  failedExecution?: boolean;
  requirements?: (typeof req)[];
  localStore?: typeof store;
  bugs?: unknown[];
} = {}) {
  const { client, fetch } = mockReadClient((url) => {
    const path = url.pathname.replace("/zentao", "");
    const id = Number(path.split("/").at(-1));
    if (path.startsWith("/api.php/v1/stories/"))
      return Response.json(stories.find((row) => row.id === id) ?? {}, {
        status: stories.some((row) => row.id === id) ? 200 : 404,
      });
    if (path === "/api.php/v1/executions/9/tasks")
      return Response.json({}, { status: 403 });
    const rows: Record<string, unknown> = {
      "/api.php/v1/user": {
        profile: users.find((person) => person.account === account),
      },
      "/api.php/v2/users": { users },
      "/api.php/v1/products": {
        products: [
          { id: 29, name: "示例产品", status: "normal", deleted: false },
        ],
      },
      "/api.php/v1/products/29/stories": { stories },
      "/api.php/v1/products/29/bugs": { bugs },
      "/api.php/v1/products/29/plans": { plans: [] },
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
      "/api.php/v1/executions": {
        executions: failedExecution
          ? [execution, { ...execution, id: 9 }]
          : [execution],
      },
      "/api.php/v1/executions/7/tasks": { tasks },
    };
    return Response.json(rows[path] ?? {}, { status: rows[path] ? 200 : 404 });
  });
  return {
    service: new TrackingService({
      client,
      clock,
      config,
      baseUrl,
      store: localStore,
    }),
    fetch,
  };
}

it("AC-20/21/22/25 按到期和就绪状态分组并推进已读游标", async () => {
  const { service } = setup({
    tasks: [task, { ...task, id: 12, deadline: "" }],
  });
  const result = getMyWorkOutputSchema.parse(await service.getMyWork({}));
  expect(result.scope.asOf).toBe("2026-11-24T04:00:00.000Z");
  expect(result.completeness).toBe("complete");
  expect(result.data.action.overdue.map(({ id }) => id)).toEqual([11]);
  expect(result.data.action.unscheduled.map(({ id }) => id)).toEqual([12]);
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
  expect(result.data.parentRisks.map(({ task }) => task.id)).toEqual([10]);
  expect(result.data.groups.map(({ key }) => key)).toEqual(["other"]);
});

it("AC-27/29 进度卡片与研发视图只展示各自所需内容，并用产品级问题判进展", async () => {
  const { service } = setup({
    tasks: [
      { ...task, status: "done" },
      { ...task, id: 12, name: "测试查询", status: "done" },
      { ...task, id: 13, name: "【验收】查询", status: "wait" },
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
  expect(full.data.card).toEqual(
    expect.stringContaining(
      "https://zentao.fixture.test/zentao/story-view-31.html",
    ),
  );
  expect(full.data.card).not.toMatch(/内部背景示例|禅道|Bug/u);
  const dev = await service.getStoryProgress({ storyId: 31, view: "dev" });
  expect(dev.data).toEqual({
    scope: "增加查询入口",
    design: "章节：2.1",
    acceptance: "可以搜索",
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
  const done = tasks.map((row) =>
    row.id === 12 ? { ...row, status: "done" } : row,
  );
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
  const { service } = setup({
    stories: [story, story, draft, closed],
    requirements: [req, { ...req, id: 42, linkStories: "31" }],
  });
  expect(
    (
      await service.queryStories({ type: "requirement", unlinked: true })
    ).data.items.map(({ id }) => id),
  ).toEqual([41]);
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
