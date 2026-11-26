import { expect, it } from "vitest";
import { getMemberScheduleInputSchema } from "../../src/contracts/tools/get_member_schedule.ts";
import { teamConfigSchema } from "../../src/core/config.ts";
import { ScheduleService } from "../../src/services/schedule.ts";
import { mockReadClient } from "../contract/read-fixture.ts";

function task(id: number, overrides: Record<string, unknown> = {}) {
  return {
    id,
    execution: 7,
    story: null,
    parent: null,
    isParent: false,
    name: `任务 ${id}`,
    type: "devel",
    mode: "single",
    status: "doing",
    assignedTo: "a",
    estStarted: null,
    deadline: "2026-11-25",
    estimate: 4,
    consumed: 0,
    left: 4,
    ...overrides,
  };
}

function setup(
  tasks: ReturnType<typeof task>[],
  overrides: Record<string, () => Response> = {},
  settings: Record<string, unknown> = {},
) {
  const config = teamConfigSchema.parse({
    teams: { fe: { name: "前端", lead: "a", members: ["e", "d", "c", "b"] } },
    calendar: { holidays: ["2026-11-26"], extraWorkdays: ["2026-11-28"] },
    ...settings,
  });
  const user = (account: string, index: number) => ({
    id: index + 1,
    account,
    realname: `成员 ${account}`,
    pinyin: `member ${account}`,
    dept: 0,
    role: null,
    deleted: false,
  });
  const execution = (id: number) => ({
    id,
    project: 42,
    name: `迭代 ${id}`,
    type: "sprint",
    status: "doing",
    begin: null,
    end: null,
  });
  const { client, fetch } = mockReadClient((url) => {
    const path = url.pathname.replace(/^\/zentao/u, "");
    const override = overrides[path];
    if (override) return override();
    if (path === "/api.php/v1/user")
      return Response.json({ profile: user("a", 0) });
    if (path === "/api.php/v2/users")
      return Response.json({ users: ["a", "b", "c", "d", "e"].map(user) });
    if (path === "/api.php/v1/executions")
      return Response.json({ executions: [execution(7), execution(8)] });
    if (path === "/api.php/v1/executions/7/tasks")
      return Response.json({ tasks });
    if (path === "/api.php/v1/executions/8/tasks")
      return Response.json({ tasks: [] });
    throw new Error(`测试未定义此接口 ${path}`);
  });
  return {
    service: new ScheduleService({
      client,
      config,
      clock: () => 1_795_450_500_123,
      baseUrl: "https://zentao.fixture.test/zentao/",
    }),
    fetch,
  };
}

it.each([
  { weeks: 0 },
  { weeks: 1.5 },
  { members: [" "] },
  { members: [] },
  { format: "json" },
  { limit: 5 },
  { newTask: { estimateHours: 0 } },
  { newTask: { estimateHours: 1, deadline: "2026-02-30" } },
  {
    newTask: {
      estimateHours: 1,
      earliestStart: "2026-12-02",
      deadline: "2026-12-01",
    },
  },
  { newTask: { estimateHours: 1, previewAck: true } },
])("严格拒绝不符合契约的参数 %j", (input) => {
  expect(getMemberScheduleInputSchema.safeParse(input).success).toBe(false);
});

it("AC-40 默认前端团队四周矩阵，只计未完成叶子，逾期和未排期单列", async () => {
  const { service } = setup([
    task(1, { left: 60, deadline: "2026-11-23" }),
    task(2, { parent: 1, left: 2.5 }),
    task(2, { parent: 1, left: 2.5 }),
    task(3, { left: null, deadline: "2026-11-28" }),
    task(4, { deadline: "2026-11-23", status: "pause" }),
    task(5, { deadline: null, left: null }),
    task(6, { status: "done" }),
    task(7, { deadline: "2026-12-22" }),
    task(8, { deleted: true }),
    task(9, {
      mode: "linear",
      assignedTo: "b",
      left: 0,
      deadline: "2026-12-01",
    }),
  ]);
  const result = await service.getMemberSchedule({});
  expect(result.completeness).toBe("complete");
  expect(result.scope).toMatchObject({
    asOf: "2026-11-23T16:15:00.123Z",
    filters: { team: "fe", weeks: 4, bucket: "week", format: "table" },
  });
  expect(result.scope.timeBasis).toContain("禅道可见投入");
  expect(result.data.members).toHaveLength(5);
  const a = result.data.members.find(({ account }) => account === "a");
  expect(a?.capacityHours).toBe(117.5);
  expect(a?.buckets).toHaveLength(4);
  expect(a?.buckets[0]).toEqual({
    start: "2026-11-24",
    end: "2026-11-30",
    leftHours: 2.5,
    taskCount: 2,
    missingEstimate: 1,
  });
  expect(a?.overdue).toMatchObject([
    { id: 4, timeState: "overdue", overdueDays: 1 },
  ]);
  expect(a?.unscheduled).toMatchObject([{ id: 5, timeState: "unscheduled" }]);
  expect(result.hints?.join(" ")).toContain("父级风险");
  expect(result.hints?.join(" ")).toContain("缺工时");
  expect(
    result.data.members.find(({ account }) => account === "b")?.buckets[1],
  ).toMatchObject({
    taskCount: 1,
    missingEstimate: 0,
    leftHours: 0,
  });
});

it("CR-007 所选自然月限定排期区间，末周封顶且不计月外任务", async () => {
  const { service } = setup([
    task(1, { deadline: "2026-10-31" }),
    task(2, { deadline: "2026-11-23" }),
    task(3, { deadline: "2026-11-30" }),
    task(4, { deadline: "2026-12-01" }),
  ]);
  const result = await service.getMemberSchedule({ members: ["a"] }, "2026-11");
  expect(result.scope.filters).toMatchObject({
    month: "2026-11",
    start: "2026-11-01",
    end: "2026-11-30",
  });
  const member = result.data.members[0];
  expect(member?.overdue.map(({ id }) => id)).toEqual([2]);
  expect(member?.buckets.at(-1)).toMatchObject({
    start: "2026-11-29",
    end: "2026-11-30",
    taskCount: 1,
  });
  expect(
    member?.buckets.reduce((sum, bucket) => sum + bucket.taskCount, 0),
  ).toBe(1);
});

it("AC-41 下周三前的一天任务按容量、逾期数和账号稳定选出前三", async () => {
  const tasks = [
    task(1, { assignedTo: "a", deadline: "2026-11-23", left: 0 }),
    task(2, { assignedTo: "b", deadline: "2026-12-02", left: 5 }),
    task(3, { assignedTo: "c", deadline: "2026-12-04", left: 100 }),
    task(4, { assignedTo: "d", deadline: "2026-12-02", left: 0 }),
  ];
  const first = setup(tasks);
  const newTask = {
    estimateHours: 6,
    earliestStart: "2026-11-26",
    deadline: "2026-12-02",
  };
  const input = {
    members: ["e", "d", "c", "b", "a"],
    weeks: 1,
    bucket: "day",
    newTask,
  };
  const result = await first.service.getMemberSchedule(input);
  const suggestions = result.data.suggestions;
  expect(suggestions?.map(({ account }) => account)).toEqual(["c", "d", "e"]);
  expect(
    suggestions?.map(({ suggestedDeadline }) => suggestedDeadline),
  ).toEqual(Array(3).fill("2026-11-27"));
  expect(suggestions?.[1]?.reason).toContain("#4");
  expect(suggestions?.[0]?.reason).toContain("30 小时");
  expect(result.data.members[0]?.buckets).toHaveLength(7);
  expect(
    first.fetch.mock.calls.every(
      ([, init]) => init?.method === "GET" || init?.method === "POST",
    ),
  ).toBe(true);
  expect(
    first.fetch.mock.calls
      .filter(([, init]) => init?.method === "POST")
      .map(([url]) => String(url)),
  ).toEqual(["https://zentao.fixture.test/zentao/api.php/v1/tokens"]);
  const second = setup([...tasks].reverse());
  expect(
    (
      await second.service.getMemberSchedule({
        ...input,
        members: [...input.members].reverse(),
      })
    ).data.suggestions,
  ).toEqual(suggestions);
});

it("按多人成员剩余工时统计，忽略已完成成员，未知状态及读取缺口向上传播", async () => {
  const multi = task(1, { mode: "multi", left: 90 });
  const { service } = setup(
    [multi, task(2, { isParent: true }), task(3, { mode: "multi" })],
    {
      "/api.php/v1/executions/8/tasks": () =>
        Response.json({}, { status: 403 }),
      "/api.php/v1/tasks/1": () =>
        Response.json({
          ...multi,
          team: [
            { account: "a", status: "doing", left: 2 },
            { account: "b", status: "done", left: 8 },
            { account: "c", status: "doing" },
            { account: "e", left: 9 },
          ],
        }),
      "/api.php/v1/tasks/3": () => Response.json({}, { status: 403 }),
    },
  );
  const result = await service.getMemberSchedule({
    newTask: { estimateHours: 1 },
  });
  expect(result.completeness).toBe("partial");
  expect(result.gaps.map(({ source }) => source)).toEqual(
    expect.arrayContaining([
      "tasks:8",
      "task:2:children",
      "task:1:team",
      "task:3:team",
    ]),
  );
  expect(
    result.data.members.find(({ account }) => account === "a")?.buckets[0],
  ).toMatchObject({
    leftHours: 2,
    taskCount: 1,
    missingEstimate: 0,
  });
  expect(
    result.data.members.find(({ account }) => account === "b")?.buckets[0]
      ?.taskCount,
  ).toBe(0);
  expect(
    result.data.members.find(({ account }) => account === "c")?.buckets[0]
      ?.missingEstimate,
  ).toBe(1);
  expect(
    result.data.members.find(({ account }) => account === "e")?.buckets[0]
      ?.taskCount,
  ).toBe(0);
  expect(result.hints?.join(" ")).toContain("已读取");
  expect(result.hints?.join(" ")).toContain("多人任务 #1：e 的参与状态待确认");
  expect(result.data.suggestions).toBeUndefined();
});

it("保留目录和任务分页已确认的数据，并统一标记截断", async () => {
  const { service } = setup([], {
    "/api.php/v2/users": () =>
      Response.json({
        users: [
          {
            id: 1,
            account: "a",
            realname: "甲",
            role: null,
            dept: 0,
            deleted: false,
          },
        ],
        total: 2,
      }),
    "/api.php/v1/executions/7/tasks": () =>
      Response.json({ tasks: [task(1)], total: 2 }),
  });
  const result = await service.getMemberSchedule({
    members: ["a", "未知成员"],
  });
  expect(result).toMatchObject({ completeness: "partial", truncated: true });
  expect(result.gaps.map(({ source }) => source)).toEqual(["tasks:7", "users"]);
  expect(result.data.members.map(({ account }) => account)).toEqual(["a"]);
  expect(result.data.members[0]?.buckets[0]?.taskCount).toBe(1);
});

it("解析人员别名、拼音和重复账号，契约错误以 BztError 返回", async () => {
  const { service } = setup([], {}, { aliases: { 主管: "a" } });
  const result = await service.getMemberSchedule({
    members: ["主管", "member b", "a"],
    format: "html",
  });
  expect(result.data.members.map(({ account }) => account)).toEqual(["a", "b"]);
  await expect(service.getMemberSchedule({ weeks: 0 })).rejects.toMatchObject({
    code: "INVALID_INPUT",
  });
  await expect(
    service.getMemberSchedule({ members: ["未知成员"] }),
  ).rejects.toMatchObject({ code: "NOT_FOUND" });
});

it("按配置计算容量，工时不足时顺延且计入顺延范围内的任务", async () => {
  const { service } = setup(
    [
      task(1, { deadline: "2026-11-24", left: 3 }),
      task(2, { deadline: "2026-11-25", left: 4 }),
      task(3, { deadline: null, left: 2 }),
    ],
    {},
    { schedule: { dailyHours: 4, weeks: 1, suggestTop: 1 } },
  );
  const result = await service.getMemberSchedule({
    members: ["a"],
    newTask: { estimateHours: 4, deadline: "2026-11-24", skills: ["前端"] },
  });
  expect(result.data.suggestions).toMatchObject([
    {
      account: "a",
      suggestedDeadline: "2026-11-27",
      reason: expect.stringContaining("期望截止日前容量不足"),
    },
  ]);
  expect(result.data.members[0]?.capacityHours).toBe(13);
  expect(result.hints?.join(" ")).toContain("核对技能");
  expect(result.inferences).toMatchObject([
    { field: "suggestions", level: "inferred" },
  ]);
});

it("当前用户或执行列表不可读时仍返回缺口，不生成候选", async () => {
  const forbidden = () => Response.json({}, { status: 403 });
  const accountFailure = setup([], { "/api.php/v1/user": forbidden });
  for (const input of [{}, { members: ["a"] }]) {
    await expect(
      accountFailure.service.getMemberSchedule(input),
    ).resolves.toMatchObject({
      data: { members: [] },
      completeness: "partial",
      gaps: [{ source: "me" }],
    });
  }
  const executionFailure = setup([], { "/api.php/v1/executions": forbidden });
  const result = await executionFailure.service.getMemberSchedule({
    newTask: { estimateHours: 6 },
  });
  expect(result).toMatchObject({
    completeness: "partial",
    gaps: [{ source: "executions" }],
  });
  expect(result.data.suggestions).toBeUndefined();
});

it("无法唯一确定默认团队时返回团队候选", async () => {
  const { service } = setup(
    [],
    {},
    {
      teams: {
        fe: { name: "前端", lead: "a", members: [] },
        ui: { name: "设计", lead: "b", members: ["a"] },
      },
    },
  );
  await expect(service.getMemberSchedule({})).rejects.toMatchObject({
    code: "AMBIGUOUS_ENTITY",
    details: { candidates: [{ id: "fe" }, { id: "ui" }] },
  });
});
