import { expect, it } from "vitest";
import {
  scanWorkflowRisksInputSchema,
  scanWorkflowRisksOutputSchema,
} from "../../src/contracts/tools/scan_workflow_risks.ts";
import { teamConfigSchema } from "../../src/core/config.ts";
import { openLocalStore } from "../../src/core/store/index.ts";
import { RiskService } from "../../src/services/risk.ts";
import { mockReadClient } from "../contract/read-fixture.ts";

const baseUrl = "https://zentao.fixture.test/zentao/";
const clock = () => Date.UTC(2026, 10, 24, 4);
const config = teamConfigSchema.parse({
  products: { 29: { name: "示例产品", state: "runtime", projects: [8] } },
  teams: {
    dev: { name: "研发", lead: "acct_dev", members: [] },
    qa: { name: "测试", lead: "acct_qa", members: [] },
  },
  roles: { RM: ["acct_dev"], PM: ["acct_lead"] },
});
const dev = {
  id: 1,
  account: "acct_dev",
  realname: "研发人员",
  role: "dev",
  dept: 0,
};
const qa = {
  id: 2,
  account: "acct_qa",
  realname: "测试人员",
  role: "qa",
  dept: 0,
};
const execution = {
  id: 7,
  project: 8,
  name: "研发迭代",
  type: "sprint",
  status: "doing",
  begin: "2026-11-01",
  end: "2026-11-30",
};
const story = {
  id: 31,
  title: "外部标题",
  spec: "本次实现范围：查询",
  type: "story",
  category: "feature",
  product: 29,
  module: 2,
  status: "active",
  assignedTo: "acct_dev",
  openedBy: "acct_pm",
  executions: [execution],
  actions: [],
};
const task = {
  id: 11,
  name: "【研发】查询",
  type: "devel",
  execution: 7,
  story: 31,
  parent: 0,
  isParent: false,
  mode: "",
  status: "done",
  assignedTo: "acct_dev",
  estStarted: "2026-11-17",
  deadline: "2026-11-19",
  finishedDate: "2026-11-23 12:00:00",
  estimate: 1,
  consumed: 1,
  left: 0,
};
const overdue = {
  ...task,
  id: 12,
  story: 0,
  product: 29,
  module: 2,
  name: "独立任务",
  status: "doing",
  assignedTo: "acct_qa",
};
function setup(
  overrides: Record<string, unknown> = {},
  options: Partial<ConstructorParameters<typeof RiskService>[0]> = {},
) {
  const bodies: Record<string, unknown> = {
    "/api.php/v1/user": { profile: dev },
    "/api.php/v2/users": {
      users: [dev, qa].map((person) => ({ ...person, deleted: false })),
    },
    "/api.php/v1/products": {
      products: [
        { id: 29, name: "示例产品", status: "normal", deleted: false },
        { id: 30, name: "其他产品", status: "normal", deleted: false },
      ],
    },
    "/api.php/v1/products/29": {
      id: 29,
      moduleOptionMenu: [{ id: 2, name: "/查询" }],
    },
    "/api.php/v1/products/29/stories": { stories: [story] },
    "/api.php/v1/products/30/stories": { stories: [] },
    "/api.php/v1/stories/31": { ...story, tasks: [task] },
    "/api.php/v1/executions": { executions: [execution] },
    "/api.php/v1/executions/7/tasks": { tasks: [task, overdue] },
    ...overrides,
  };
  const { client, fetch } = mockReadClient((url) => {
    const body = bodies[url.pathname.replace(/^\/zentao/u, "")];
    if (body instanceof Response) return body;
    return body === undefined
      ? new Response(null, { status: 404 })
      : Response.json(body);
  });
  return {
    service: new RiskService({ client, config, clock, baseUrl, ...options }),
    fetch,
  };
}

it("严格校验巡检参数和嵌套范围，接受未注册规则及相对月份", async () => {
  expect(scanWorkflowRisksInputSchema.safeParse({ scope: {} }).success).toBe(
    true,
  );
  for (const input of [
    {},
    { scope: {}, limit: 1 },
    { scope: { execution: "7" } },
    { scope: { month: "2026-13" } },
    { scope: { product: 29 } },
    { scope: {}, groupBy: "team" },
  ]) {
    expect(scanWorkflowRisksInputSchema.safeParse(input).success).toBe(false);
  }
  const { service, fetch } = setup();
  await expect(service.scanWorkflowRisks({})).rejects.toMatchObject({
    code: "INVALID_INPUT",
  });
  const empty = await service.scanWorkflowRisks({
    scope: { month: "本月" },
    rules: ["R06"],
  });
  expect(empty).toMatchObject({
    completeness: "complete",
    data: { hits: [], summary: [] },
    scope: { filters: { month: "2026-11" } },
  });
  expect(empty.hints?.join()).toContain("配置中未启用：R06");
  expect(fetch).not.toHaveBeenCalled();
});

it("AC-53 研发完成后提示测试缺口，超过阈值升级为滞留并注明来源", async () => {
  const { service } = setup();
  const input = { scope: {}, rules: ["R02"] };
  const gap = await service.scanWorkflowRisks(input);
  expect(scanWorkflowRisksOutputSchema.parse(gap)).toEqual(gap);
  expect(gap.scope.asOf).toBe("2026-11-24T04:00:00.000Z");
  expect(gap.gaps).toEqual([]);
  expect(gap.completeness).toBe("complete");
  expect(gap.data.hits).toEqual([
    expect.objectContaining({
      rule: "R02",
      reason: expect.stringMatching(/缺口.*缺少测试任务.*默认.*1/u),
      since: "2026-11-23",
      object: {
        type: "story",
        id: 31,
        title: "外部标题",
        untrusted: true,
        url: baseUrl + "story-view-31.html",
      },
      owner: { account: "acct_dev", realname: "研发人员" },
    }),
  ]);
  const finishedEarlier = { ...task, finishedDate: "2026-11-17 12:00:00" };
  const stalled = setup({
    "/api.php/v1/executions/7/tasks": { tasks: [finishedEarlier] },
  }).service;
  expect((await stalled.scanWorkflowRisks(input)).data.hits[0]?.reason).toMatch(
    /滞留.*默认.*1/u,
  );

  const configured = setup(
    {},
    {
      config: teamConfigSchema.parse({ rules: { R02: { missingAfter: 0 } } }),
    },
  ).service;
  expect(
    (await configured.scanWorkflowRisks(input)).data.hits[0]?.reason,
  ).toMatch(/滞留.*已确认配置.*0/u);
});

it("AC-69 默认执行 P1 规则，分组并按产品、团队、模块、月份和本人过滤", async () => {
  const draft = { ...story, id: 32, status: "draft", spec: "正文不可回传" };
  const active = {
    ...story,
    id: 33,
    actions: [
      {
        id: 1,
        action: "Activated",
        actor: "acct_pm",
        date: "2026-11-12 09:00:00",
      },
    ],
  };
  const { service } = setup({
    "/api.php/v1/products/29/stories": { stories: [story, draft, active] },
    "/api.php/v1/stories/32": draft,
    "/api.php/v1/stories/33": active,
  });
  const all = await service.scanWorkflowRisks({ scope: {}, groupBy: "owner" });
  expect(all.gaps).toEqual([]);
  expect(all.completeness).toBe("complete");
  expect(all.data.hits.map(({ rule }) => rule)).toEqual([
    "R02",
    "R03",
    "R04",
    "R05",
    "R01",
  ]);
  expect(all.data.summary.map(({ rule, count }) => [rule, count])).toEqual(
    ["R01", "R02", "R03", "R04", "R05"].map((rule) => [rule, 1]),
  );
  expect(JSON.stringify(all)).not.toContain(draft.spec);
  const scoped = await service.scanWorkflowRisks({
    scope: {
      product: "示例产品",
      team: "研发",
      module: "查询",
      month: "本月",
      mine: true,
    },
    minSeverity: "medium",
    groupBy: "story",
    rules: ["R01", "R02", "R03", "R04", "R05", "R06"],
  });
  expect(scoped.data.hits.map(({ rule }) => rule)).toEqual([
    "R02",
    "R04",
    "R03",
  ]);
  expect(scoped.hints?.join()).toContain("R06");
  const none = await service.scanWorkflowRisks({ scope: { product: "30" } });
  expect(none.data).toEqual({ hits: [], summary: [] });
  expect(none.completeness).toBe("complete");
});

it("按规则和对象应用 LocalStore 豁免，并优先采用共享评论", async () => {
  const store = openLocalStore({
    baseUrl,
    account: dev.account,
    clock,
    dbPath: ":memory:",
  });
  try {
    store.cache.set(
      "risk:waivers:story:31",
      JSON.stringify([
        { ruleId: "R02", by: "acct_lead", reason: "本地记录" },
        { ruleId: "R05", by: "acct_lead", reason: "只豁免相应规则" },
      ]),
      60_000,
    );
    const cached = await setup({}, { store }).service.scanWorkflowRisks({
      scope: {},
    });
    expect(
      cached.data.hits.find(({ rule }) => rule === "R02")?.waived,
    ).toMatchObject({ by: "acct_lead", reason: "本地记录" });
    expect(cached.data.summary.map(({ rule }) => rule)).toEqual(["R01"]);
    const comment = {
      id: 1,
      actor: "acct_lead",
      action: "commented",
      date: "2026-11-20 09:00:00",
      comment:
        "[bzt:waiver v1] rule=R02 | approvedBy=acct_lead | reason=共享记录",
    };
    const unauthorized = {
      ...comment,
      id: 2,
      date: "2026-11-23 09:00:00",
      actor: "acct_dev",
      comment:
        "[bzt:waiver v1] rule=R02 | approvedBy=acct_dev | reason=未授权评论",
    };
    const shared = await setup(
      {
        "/api.php/v1/stories/31": {
          ...story,
          actions: [comment, unauthorized],
        },
      },
      { store },
    ).service.scanWorkflowRisks({ scope: {}, rules: ["R02"] });
    expect(shared.data.hits[0]?.waived).toMatchObject({
      by: "acct_lead",
      reason: "共享记录",
      untrusted: true,
    });
  } finally {
    store.close();
  }
});

it("任务读取失败或分页截断时标注缺口，保留独立规则结果", async () => {
  const overrides = {
    "/api.php/v1/stories/31": { ...story, spec: "背景：查询", tasks: [task] },
  };
  for (const response of [
    new Response(null, { status: 503 }),
    { tasks: [task], total: 2 },
  ]) {
    const { service } = setup({
      ...overrides,
      "/api.php/v1/executions/7/tasks": response,
    });
    const result = await service.scanWorkflowRisks({
      scope: {},
      rules: ["R02", "R05"],
    });
    expect(result).toMatchObject({
      completeness: "partial",
      gaps: expect.arrayContaining([
        expect.objectContaining({ source: "tasks:7" }),
      ]),
      data: { hits: [expect.objectContaining({ rule: "R05" })] },
    });
  }
});

it("WP-38 巡检连接 R06–R14 的数据源、豁免与必需阶段", async () => {
  const devTask = {
    ...task,
    realStarted: "2026-11-03 09:00:00",
    finishedDate: "2026-11-05 10:00:00",
  };
  const testTask = {
    ...devTask,
    id: 13,
    name: "【测试】查询",
    type: "test",
    realStarted: "2026-11-06 09:00:00",
    finishedDate: "2026-11-10 10:00:00",
  };
  const rows = [
    {
      ...story,
      openedDate: "2026-11-01 09:00:00",
      plan: "",
      keywords: "版本:V1.2.3",
    },
    { ...story, id: 33, plan: "22", executions: [] },
    { ...story, id: 34, plan: "22" },
    { ...story, id: 35, category: "design" },
  ];
  const tasks = [
    devTask,
    testTask,
    overdue,
    { ...devTask, id: 14, story: 34 },
    { ...testTask, id: 15, story: 34 },
    { ...testTask, id: 16, story: 34, name: "【验收】查询" },
    { ...testTask, id: 17, story: 35, name: "【评审】查询" },
    { ...testTask, id: 18, story: 35, name: "【传递】查询" },
  ];
  const requirements = {
    ...story,
    id: 41,
    type: "requirement",
    openedDate: "2026-11-02 09:00:00",
  };
  const bug = {
    id: 81,
    product: 29,
    title: "示例问题",
    status: "active",
    severity: 2,
    story: 31,
    execution: 0,
    openedDate: "2026-11-09 10:00:00",
  };
  const store = openLocalStore({
    baseUrl,
    account: "acct_fixture",
    dbPath: ":memory:",
    clock,
  });
  try {
    store.waivers.upsert({
      ruleId: "R06",
      objectType: "story",
      objectId: "31",
      reason: "迁移例外",
      approvedBy: "acct_lead",
      at: clock(),
    });
    store.stageRequirements.upsert({
      storyId: 31,
      stage: "acceptance",
      required: false,
      waiverReason: "无需验收",
      decidedBy: "acct_lead",
      decidedAt: clock(),
    });
    store.stageRequirements.upsert({
      storyId: 31,
      stage: "delivery",
      required: true,
      waiverReason: null,
      decidedBy: "acct_lead",
      decidedAt: clock(),
    });
    const rules = [
      "R06",
      "R07",
      "R08",
      "R09",
      "R10",
      "R11",
      "R12",
      "R13",
      "R14",
    ];
    const { service, fetch } = setup(
      {
        "/api.php/v1/products/29/stories": { stories: rows },
        ...Object.fromEntries(
          rows.map((row) => ["/api.php/v1/stories/" + row.id, row]),
        ),
        "/api.php/v1/products/29/plans": {
          plans: [
            {
              id: 22,
              product: 29,
              parent: 21,
              title: "查询计划",
              status: "wait",
              deleted: false,
              begin: "2026-11-01",
              end: "2026-11-30",
            },
          ],
        },
        "/api.php/v1/executions/7/tasks": { tasks },
        "/api.php/v1/products/29/bugs": { bugs: [bug] },
        "/api.php/v2/product/browse": { stories: [requirements] },
        "/api.php/v2/requirement/view": { story: requirements, relations: [] },
        "/api.php/v2/story/view": { story: rows[3], relations: [] },
      },
      {
        store,
        config: teamConfigSchema.parse({
          ...config,
          rules: {
            ...Object.fromEntries(rules.map((id) => [id, { enabled: true }])),
            R06: { enabled: true, systemStartDate: "2026-11-01" },
            R14: { enabled: true, olderThanDays: 1 },
          },
          releaseCalendar: [
            {
              product: 29,
              version: "V1.2.3",
              date: "2026-11-25",
              owner: "acct_lead",
            },
          ],
        }),
      },
    );
    const result = scanWorkflowRisksOutputSchema.parse(
      await service.scanWorkflowRisks({
        scope: { product: "29" },
        rules: [...rules, "R15"],
      }),
    );
    expect(result.completeness, JSON.stringify(result.gaps)).toBe("complete");
    expect(result.hints?.join()).toContain("尚未注册");
    expect(new Set(result.data.hits.map(({ rule }) => rule))).toEqual(
      new Set(rules),
    );
    expect(result.data.hits).toContainEqual(
      expect.objectContaining({
        rule: "R06",
        object: expect.objectContaining({ id: 31 }),
        waived: expect.objectContaining({ by: "acct_lead" }),
      }),
    );
    expect(result.data.hits).toContainEqual(
      expect.objectContaining({
        rule: "R11",
        reason: expect.stringContaining("必需的交付任务"),
      }),
    );
    expect(result.data.hits).toContainEqual(
      expect.objectContaining({
        rule: "R12",
        reason: expect.stringContaining("测试期间创建"),
      }),
    );
    expect(
      fetch.mock.calls.some(([url]) => String(url).includes("/releases")),
    ).toBe(false);
  } finally {
    store.close();
  }
});
