import { expect, it } from "vitest";
import { getPlanProgressOutputSchema } from "../../src/contracts/tools/get_plan_progress.ts";
import { getMonthlyDevQueueOutputSchema } from "../../src/contracts/tools/get_monthly_dev_queue.ts";
import { parseZentaoDateTime } from "../../src/core/calendar.ts";
import { teamConfigSchema } from "../../src/core/config.ts";
import { openLocalStore } from "../../src/core/store/index.ts";
import { ManagementService } from "../../src/services/management.ts";
import { mockReadClient } from "../contract/read-fixture.ts";
import { assertNoSensitiveData } from "../helpers/assert-no-sensitive-data.ts";

const baseUrl = "https://zentao.fixture.test/zentao/";
const clock = () =>
  parseZentaoDateTime("2026-11-26 12:00:00", "Asia/Shanghai") ?? 0;
const config = teamConfigSchema.parse({
  products: {
    29: { name: "产品甲", state: "runtime", projects: [8] },
    30: { name: "产品乙", state: "runtime", projects: [8] },
  },
  teams: { dev: { name: "研发团队", lead: "dev", members: [] } },
  roles: { PM: ["pm"] },
  rules: { R06: { enabled: true }, R13: { enabled: true } },
  releaseCalendar: [
    { product: 29, version: "V7.0.3", date: "2026-11-30", owner: "pm" },
  ],
});
const execution = {
  id: 7,
  project: 8,
  name: "【产品甲】【研发】2026年11月迭代",
  type: "sprint",
  status: "doing",
  begin: "2026-11-01",
  end: "2026-11-30",
};
const plan = {
  id: 22,
  product: 29,
  parent: 21,
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
  openedBy: "pm",
  assignedTo: "dev",
  assignedDate: "2026-11-20 10:00:00",
  plan: "22",
  executions: [execution],
  keywords: "版本:V7.0.3",
  spec: "<p>正文私有示例</p>",
  password: "omit",
};
const testTask = {
  id: 11,
  name: "【测试】查询",
  type: "devel",
  execution: 7,
  story: 31,
  parent: 0,
  isParent: false,
  mode: "",
  status: "wait",
  assignedTo: "dev",
  estStarted: "2026-11-24",
  deadline: "2026-12-01",
  openedDate: "2026-11-23 10:00:00",
  estimate: 2,
  consumed: 1,
  left: 1,
};
const bug = {
  id: 81,
  product: 29,
  story: 31,
  severity: 2,
  status: "active",
  title: "质量问题",
};

function setup({
  stories = [story],
  planned = stories.filter(({ plan }) => plan === "22"),
  tasks = [testTask],
  executions = [execution],
  bugs = [bug],
  failure,
  store,
}: {
  stories?: (typeof story & {
    actions?: unknown[];
    closedReason?: string;
    linkStories?: string;
    lastEditedDate?: string;
  })[];
  planned?: (typeof story)[];
  tasks?: (typeof testTask & { finishedDate?: string; realStarted?: string })[];
  executions?: (typeof execution)[];
  bugs?: (typeof bug)[];
  failure?: "tasks" | "truncated";
  store?: ReturnType<typeof openLocalStore>;
} = {}) {
  const { client, fetch: requests } = mockReadClient((url) => {
    const path = url.pathname.replace("/zentao", "");
    if (path.startsWith("/api.php/v1/stories/")) {
      const row = stories.find(
        ({ id }) => id === Number(path.split("/").at(-1)),
      );
      return Response.json(row ?? {}, { status: row ? 200 : 404 });
    }
    if (failure === "tasks" && path.endsWith("/tasks"))
      return Response.json({}, { status: 403 });
    const rows: Record<string, unknown> = {
      "/api.php/v1/user": {
        profile: {
          id: 1,
          account: "dev",
          realname: "研发",
          role: "dev",
          dept: 0,
        },
      },
      "/api.php/v1/executions": { executions },
      "/api.php/v1/products/29/plans": { plans: [plan] },
      "/api.php/v1/products/30/plans": { plans: [] },
      "/api.php/v2/productplan/view": {
        plan,
        planStories: planned,
        modulePairs: [],
      },
      "/api.php/v1/products/29/stories": {
        stories: stories.filter(({ product }) => product === 29),
      },
      "/api.php/v1/products/30/stories": {
        stories: stories.filter(({ product }) => product === 30),
      },
      "/api.php/v1/products/29/bugs": { bugs },
      "/api.php/v1/products/30/bugs": { bugs: [] },
      ...Object.fromEntries(
        executions.map(({ id }) => {
          const rows = tasks.filter(({ execution }) => execution === id);
          return [
            `/api.php/v1/executions/${id}/tasks`,
            failure === "truncated"
              ? { tasks: rows, total: rows.length + 1 }
              : { tasks: rows },
          ];
        }),
      ),
    };
    return Response.json(rows[path] ?? {}, { status: rows[path] ? 200 : 404 });
  });
  return {
    service: new ManagementService({
      client,
      config,
      clock,
      baseUrl,
      ...(store ? { store } : {}),
    }),
    requests,
  };
}

it("AC-60/61 按负责人汇总，父任务和重复需求不进入分母，零有效任务没有完成率", async () => {
  const parent = { ...testTask, id: 12, isParent: true, status: "done" };
  const { service, requests } = setup({
    planned: [story, story],
    tasks: [parent, { ...testTask, parent: 12 }],
  });
  const output = getPlanProgressOutputSchema.parse(
    await service.getPlanProgress({
      view: "plan",
      month: "本月",
      product: "29",
    }),
  );
  expect(output.data).toMatchObject({
    view: "plan",
    total: 1,
    groups: [{ key: "dev" }],
    storyDeliveryRate: { numerator: 0, denominator: 1 },
    taskCompletionRate: { numerator: 0, denominator: 1 },
  });
  expect(
    requests.mock.calls.filter(([url]) => String(url).includes("/tasks")),
  ).toHaveLength(1);
  for (const tasks of [[], [{ ...testTask, status: "cancel" }]]) {
    const next = setup({ stories: [{ ...story, status: "closed" }], tasks });
    expect(
      (
        await next.service.getPlanProgress({
          view: "plan",
          plan: "22",
          product: "产品甲",
        })
      ).data,
    ).toMatchObject({
      storyDeliveryRate: { rate: 0 },
      taskCompletionRate: { rate: null },
    });
  }
});

it("AC-62/64 产品 Bug 无执行仍阻塞发布，未验证发布读取按日历降级", async () => {
  const { service, requests } = setup({
    bugs: [bug, { ...bug, id: 82, story: 0 }],
  });
  const output = getPlanProgressOutputSchema.parse(
    await service.getPlanProgress({
      view: "release",
      product: "29",
      version: "V7.0.3",
    }),
  );
  expect(output.data).toMatchObject({
    gate: "blocked",
    dateSource: "calendar",
    testIncompleteStoryIds: [31],
    openSeriousBugs: [{ id: 81 }],
    unlinkedSeriousBugs: [{ id: 82 }],
    unlinkedBugIds: [82],
    lateLeafTasks: [{ taskId: 11 }],
    releaseWarningStoryIds: [31],
  });
  expect(
    requests.mock.calls.some(([url]) => String(url).includes("/releases")),
  ).toBe(false);
  expect(JSON.stringify(output)).not.toMatch(/正文私有示例|password/);
  assertNoSensitiveData(output);
});

it("AC-63 只有产品管理本人留痕的版本例外可以放行", async () => {
  for (const [actor, gate] of [
    ["pm", "waiver"],
    ["dev", "blocked"],
  ]) {
    const { service } = setup({
      stories: [
        {
          ...story,
          actions: [
            {
              id: 1,
              actor,
              action: "commented",
              date: "2026-11-25 10:00:00",
              comment: `[bzt:waiver v1] rule=R13 | version=V7.0.3 | approvedBy=${actor} | reason=紧急上线审批`,
            },
          ],
        },
      ],
    });
    expect(
      (
        await service.getPlanProgress({
          view: "release",
          product: "29",
          version: "V7.0.3",
        })
      ).data,
    ).toMatchObject({ gate });
  }
});

it("AC-65 对比导入快照、保留挪月理由，并提示无快照", async () => {
  const store = openLocalStore({
    dbPath: ":memory:",
    baseUrl,
    account: "dev",
    clock,
  });
  try {
    const { service } = setup({ store });
    expect(
      await service.getPlanProgress({
        view: "commitment",
        month: "上月",
        product: "29",
      }),
    ).toMatchObject({
      data: { snapshotAvailable: false },
      hints: expect.any(Array),
    });
    store.snapshots.createSnapshotWithItems(
      {
        snapId: "snap",
        month: "2026-11",
        productId: 29,
        source: "imported",
        takenAt: clock(),
        takenBy: "pm",
      },
      [
        {
          storyId: 35,
          planId: 22,
          executionId: null,
          progressAtSnap: "待接收",
        },
      ],
    );
    store.reschedules.append({
      storyId: 35,
      fromMonth: "2026-11",
      toMonth: "2026-12",
      reason: "依赖延期",
      by: "dev",
      at: clock(),
    });
    expect(
      (
        await service.getPlanProgress({
          view: "commitment",
          month: "本月",
          product: "29",
        })
      ).data,
    ).toMatchObject({
      snapshotAvailable: true,
      snapshots: [{ source: "imported" }],
      inserted: [31],
      carriedOver: [{ id: 35, reason: "依赖延期" }],
    });
  } finally {
    store.close();
  }
});

it("AC-66/67/68 迭代给出指标口径、负责人巡检和已关联的跨产品进展", async () => {
  const { service } = setup({
    stories: [
      { ...story, linkStories: "42" },
      {
        ...story,
        id: 42,
        product: 30,
        plan: "",
        executions: [],
        status: "draft",
      },
    ],
  });
  const output = await service.getPlanProgress({
    view: "iteration",
    product: "29",
    execution: "7",
  });
  expect(output.scope.timeBasis).toContain("禅道可见投入");
  expect(output.data).toMatchObject({
    snapshotAvailable: false,
    decompositionTimeliness: { numerator: 1, denominator: 1 },
    visibleHours: { consumed: 1 },
    complianceByOwner: [{ owner: "dev", counts: { R05: 1 } }],
    crossProduct: [{ stories: [{ id: 31 }, { id: 42 }] }],
  });
});

it("AC-54 五桶互斥、未就绪单列，月底提示未开始的需求", async () => {
  const { service } = setup({
    stories: [
      story,
      { ...story, id: 32, status: "draft" },
      { ...story, id: 33, plan: "" },
    ],
  });
  const output = getMonthlyDevQueueOutputSchema.parse(
    await service.getMonthlyDevQueue({
      team: "研发团队",
      includeNotReady: true,
    }),
  );
  const ids = Object.values(output.data.buckets)
    .flat()
    .map(({ id }) => id);
  expect(ids.sort()).toEqual([31, 33]);
  expect(output.data.notReady?.map(({ id }) => id)).toEqual([32]);
  expect(output.data.monthEndWarnings?.map(({ id }) => id).sort()).toEqual([
    31, 33,
  ]);
});

it.each(["tasks", "truncated"])(
  "执行任务读取 %s 时保留缺口与部分结果",
  async (failure) => {
    if (failure !== "tasks" && failure !== "truncated")
      throw new Error("测试参数无效");
    const { service } = setup({ failure });
    expect(
      await service.getPlanProgress({ view: "plan", product: "29" }),
    ).toMatchObject({
      completeness: "partial",
      gaps: expect.arrayContaining([
        expect.objectContaining({ source: "tasks:7" }),
      ]),
    });
  },
);

it("AC-62 完成测试且无严重 Bug 可以发布，执行证据缺失时门禁未知", async () => {
  const tasks = [{ ...testTask, status: "done" }];
  for (const [failure, gate] of [
    [undefined, "ready"],
    ["tasks", "unknown"],
  ]) {
    if (failure !== undefined && failure !== "tasks")
      throw new Error("测试参数无效");
    const { service } = setup({
      tasks,
      bugs: [],
      ...(failure ? { failure } : {}),
    });
    expect(
      await service.getPlanProgress({
        view: "release",
        product: "29",
        version: "V7.0.3",
      }),
    ).toMatchObject({
      data: { gate },
      completeness: failure ? "partial" : "complete",
    });
  }
});

it("AC-63 版本更换前的本地例外不能用于新版本", async () => {
  const store = openLocalStore({
    dbPath: ":memory:",
    baseUrl,
    account: "dev",
    clock,
  });
  try {
    const { service } = setup({
      stories: [{ ...story, lastEditedDate: "2026-11-25 12:00:00" }],
      store,
    });
    const query = { view: "release", product: "29", version: "V7.0.3" };
    store.waivers.upsert({
      ruleId: "R13",
      objectId: "31",
      approvedBy: "pm",
      reason: "旧版例外",
      at: clock() - 2 * 86_400_000,
    });
    expect((await service.getPlanProgress(query)).data).toMatchObject({
      gate: "blocked",
      waivers: [],
    });
    store.waivers.upsert({
      ruleId: "R13",
      objectId: "31",
      approvedBy: "pm",
      reason: "本版例外",
      at: clock(),
    });
    expect((await service.getPlanProgress(query)).data).toMatchObject({
      gate: "waiver",
      waivers: [{ reason: "本版例外" }],
    });
  } finally {
    store.close();
  }
});

it("AC-54 无快照时由共享挪月评论还原，遗留标记不造成重复计数", async () => {
  const actions = [
    {
      id: 1,
      actor: "dev",
      action: "commented",
      date: "2026-10-29 12:00:00",
      comment:
        '[bzt:reschedule v1 {"fromMonth":"2026-10","toMonth":"2026-11","reason":"上月依赖未完成"}]',
    },
  ];
  const { service } = setup({ stories: [{ ...story, actions }], bugs: [] });
  const output = await service.getMonthlyDevQueue({});
  expect(output).toMatchObject({
    scope: { filters: { teamIds: ["dev"] } },
    data: {
      carryOverSource: "history",
      buckets: { inDev: [{ id: 31, carriedOver: true }], carriedOver: [] },
      counts: { mainPool: 1, inDev: 1, carriedOver: 0 },
    },
  });
  expect(output.data).not.toHaveProperty("notReady");
});

it("AC-66 用实际开始和完成日期计算测试周期，统计历史逾期", async () => {
  const { service } = setup({
    tasks: [
      {
        ...testTask,
        status: "done",
        realStarted: "2026-11-23 10:00:00",
        finishedDate: "2026-11-25 18:00:00",
        deadline: "2026-11-24",
      },
    ],
  });
  const output = getPlanProgressOutputSchema.parse(
    await service.getPlanProgress({
      view: "iteration",
      product: "29",
      execution: "7",
    }),
  );
  expect(output.data).toMatchObject({
    overdueRate: { numerator: 1, denominator: 1 },
    testCycleMedianWorkdays: 2,
    testCycleSampleSize: 1,
  });
  assertNoSensitiveData(output);
});

it("AC-54 五个主桶各有独立归属，上月遗留不计作本月主池", async () => {
  const store = openLocalStore({
    dbPath: ":memory:",
    baseUrl,
    account: "dev",
    clock,
  });
  const otherExecution = {
    ...execution,
    id: 9,
    name: "【产品甲】【设计】2026年11月迭代",
  };
  const stories = [
    story,
    { ...story, id: 32, status: "draft" },
    { ...story, id: 33, plan: "" },
    { ...story, id: 35, plan: "", executions: [] },
    { ...story, id: 36, executions: [otherExecution] },
    { ...story, id: 37, plan: "" },
  ];
  const tasks = [
    testTask,
    { ...testTask, id: 12, story: 36, execution: 9, status: "done" },
    { ...testTask, id: 13, story: 37, status: "done" },
  ];
  try {
    store.snapshots.createSnapshotWithItems(
      {
        snapId: "previous",
        month: "2026-10",
        productId: 29,
        source: "local",
        takenAt: clock(),
        takenBy: "pm",
      },
      [
        {
          storyId: 35,
          planId: null,
          executionId: null,
          progressAtSnap: "待接收",
        },
      ],
    );
    const { service } = setup({
      stories,
      tasks,
      store,
      executions: [execution, otherExecution],
    });
    const output = getMonthlyDevQueueOutputSchema.parse(
      await service.getMonthlyDevQueue({ includeNotReady: true }),
    );
    expect(output.data).toMatchObject({
      buckets: {
        inDev: [{ id: 31 }],
        toReceive: [{ id: 33 }],
        carriedOver: [{ id: 35 }],
        planNoIteration: [{ id: 36 }],
        iterationNoPlan: [{ id: 37 }],
      },
      mainPoolIds: [31, 32, 36, 33, 37],
      counts: { mainPool: 5, notReady: 1, unbucketed: 0 },
      notReady: [{ id: 32 }],
    });
  } finally {
    store.close();
  }
});

it("AC-54 测试任务完成后，未关闭的严重 Bug 仍需要继续测试", async () => {
  const { service } = setup({ tasks: [{ ...testTask, status: "done" }] });
  expect(
    (await service.getMonthlyDevQueue({})).data.buckets.inDev,
  ).toMatchObject([{ id: 31, progress: { value: "测试中" } }]);
});
