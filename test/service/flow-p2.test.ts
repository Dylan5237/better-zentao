import { afterEach, expect, it, vi } from "vitest";
import { createZentaoReadClient } from "../../src/api/client.ts";
import { writeStory } from "../../src/api/story-write.ts";
import { teamConfigSchema } from "../../src/core/config.ts";
import { BztError } from "../../src/core/errors.ts";
import { openLocalStore } from "../../src/core/store/index.ts";
import { DirectoryService } from "../../src/services/directory.ts";
import { FlowService } from "../../src/services/flow.ts";
import {
  OperationExecutor,
  type OperationGateway,
} from "../../src/services/operation.ts";
import { mockReadClient } from "../contract/read-fixture.ts";

const baseUrl = "https://zentao.fixture.test/zentao/";
const alice = {
  id: 1,
  account: "alice",
  realname: "设计甲",
  role: "po",
  dept: 0,
  deleted: false,
};
const bob = { ...alice, id: 2, account: "bob", realname: "研发甲" };
const cleanups: (() => void)[] = [];
afterEach(() => {
  for (const cleanup of cleanups.splice(0)) cleanup();
});

function task(
  id: number,
  story: number,
  name: string,
  status: string,
  extra = {},
) {
  return {
    id,
    story,
    name,
    status,
    execution: 7,
    product: 29,
    parent: 0,
    isParent: false,
    type: "devel",
    mode: "",
    estStarted: null,
    deadline: null,
    estimate: 0,
    consumed: 0,
    left: 0,
    openedDate: "2026-08-01 10:00:00",
    ...extra,
  };
}

function setup(
  options: {
    design?: boolean;
    closed?: boolean;
    review?: string;
    scope?: string;
    disabled?: boolean;
    version?: string;
    pm?: boolean;
    onlyOrphan?: boolean;
    taskListTruncated?: boolean;
  } = {},
) {
  let now = Date.UTC(2026, 10, 25);
  const clock = () => now;
  const config = teamConfigSchema.parse({
    roles: { RM: ["bob"], PM: options.pm ? ["alice"] : [] },
    products: { 29: { name: "产品", state: "runtime" } },
    modules: { "29:3": { name: "模块", designLead: "alice", devLead: "bob" } },
    write: { disableCapabilities: options.disabled ? ["story.activate"] : [] },
  });
  const store = openLocalStore({
    baseUrl,
    account: "alice",
    dbPath: ":memory:",
    clock,
  });
  cleanups.push(() => store.close());
  const status = options.closed
    ? "closed"
    : options.design
      ? "active"
      : "draft";
  const tasks = options.onlyOrphan
    ? [task(13, 0, "无归属", "wait")]
    : [
        task(11, 9, "【评审】核对", options.review ?? "done"),
        task(12, 9, "【传递】移交", "wait"),
        task(13, 0, "无归属", "wait"),
        task(14, 9, "【研发】父任务", "done", { isParent: true }),
        task(15, 0, "【研发】子任务", "done", { parent: 14 }),
      ];
  const plan = { product: 29, status: "wait", deleted: false };
  const { client } = mockReadClient((url) => {
    switch (url.pathname.split("api.php")[1]) {
      case "/v1/user":
        return Response.json({ profile: alice });
      case "/v2/users":
        return Response.json({ users: [alice, bob], total: 2 });
      case "/v1/products":
        return Response.json({
          products: [
            {
              id: 29,
              name: "产品",
              status: "normal",
              type: "normal",
              deleted: false,
            },
          ],
          total: 1,
        });
      case "/v1/products/29":
        return Response.json({
          id: 29,
          moduleOptionMenu: [{ id: 3, name: "/模块" }],
        });
      case "/v1/products/29/plans":
        return Response.json({
          plans: [
            {
              ...plan,
              id: 20,
              parent: 10,
              title: "原计划",
              begin: "2026-11-01",
              end: "2026-11-30",
            },
            {
              ...plan,
              id: 21,
              parent: 10,
              title: "【alice】模块-2026年12月",
              begin: "2026-12-01",
              end: "2026-12-31",
            },
          ],
          total: 2,
        });
      case "/v1/executions":
        return Response.json({
          executions: [
            {
              id: 7,
              name: "研发执行",
              project: 1,
              type: "sprint",
              status: "doing",
              begin: "2026-08-01",
              end: "2026-08-31",
            },
          ],
          total: 1,
        });
      case "/v1/executions/7/tasks":
        return Response.json({
          tasks,
          total: tasks.length + Number(options.taskListTruncated ?? false),
        });
      case "/v1/stories/9":
        return Response.json({
          id: 9,
          type: "story",
          product: 29,
          module: 3,
          title: "设计说明",
          status,
          category: options.design ? "design" : "feature",
          openedBy: "alice",
          assignedTo: "alice",
          spec:
            options.scope ??
            "<h3>本次实现范围</h3><ul><li>支持列表</li></ul><h3>设计文档</h3><p>章节：列表</p>",
          verify: "核对列表",
          plan: 20,
          executions: [{ id: 7, name: "研发执行" }],
        });
      default:
        return new Response(null, { status: 404 });
    }
  });
  const write = vi.fn<OperationGateway["write"]>(async ({ id }) => ({
    id: id ?? 99,
  }));
  const executor = new OperationExecutor({
    store,
    clock,
    baseUrl,
    config,
    instanceVersion: options.version,
    gateway: {
      write,
      readTarget: async (target) => ({
        ...target,
        status,
        maintainer: "alice",
      }),
      readback: async () => ({ verified: true }),
      reverseLookup: async () => ({ complete: true, matches: [] }),
    },
  });
  const directory = new DirectoryService({ client, config, clock });
  const service = new FlowService({
    client,
    directory,
    executor,
    config,
    store,
    clock,
    baseUrl,
    instanceVersion: options.version,
  });
  const confirm = async (opId: string) => {
    now += 3000;
    const result = await executor.confirm({ opId, previewAck: true });
    service.recordConfirmed(opId, result);
    service.recordConfirmed(opId, result);
    return result;
  };
  return { service, confirm, store, write, executor };
}

it("AC-47 从设计需求移交，保留范围和章节并提醒人工完成传递", async () => {
  const { service, confirm, store, write } = setup({ design: true });
  const preview = await service.handoffStory({
    storyId: 9,
    mode: "from_design",
  });
  expect(preview.preview.steps.map(({ action }) => action)).toEqual([
    "story.create",
    "story.linkStory",
    "story.activate",
    "story.assign",
    "story.comment",
  ]);
  expect(preview.preview.steps[0]?.fields.spec?.value).toEqual(
    expect.stringMatching(/支持列表.*章节：列表.*衍生自 #9.*bzt:v1/su),
  );
  expect(preview.warnings).toEqual(
    expect.arrayContaining([
      expect.objectContaining({
        message: expect.stringMatching(
          /传递.*task-view-12.html.*story-view-9.html/u,
        ),
      }),
    ]),
  );
  expect(write).not.toHaveBeenCalled();
  expect((await confirm(preview.opId)).status).toBe("confirmed");
  expect(write.mock.calls.slice(1).map(([request]) => request.id)).toEqual([
    99, 99, 99, 99,
  ]);
  expect(store.storyRoles.get(99)).toMatchObject({ receiver: "bob" });
  expect(store.sourceLinks.listFrom("story", "99")).toEqual(
    expect.arrayContaining([
      expect.objectContaining({ relation: "derives", toId: "9" }),
    ]),
  );
});

it("AC-47 评审未完成、AC-48 缺实现范围时拒绝", async () => {
  await expect(
    setup({ design: true, review: "doing" }).service.handoffStory({
      storyId: 9,
      mode: "from_design",
    }),
  ).rejects.toMatchObject({ code: "RULE_VIOLATION" });
  await expect(
    setup({
      scope: "<h3>本次实现范围</h3><h3>设计文档</h3><p>章节</p>",
    }).service.handoffStory({ storyId: 9, mode: "activate" }),
  ).rejects.toMatchObject({ code: "RULE_VIOLATION" });
});

it("AC-48 激活禁用时保留已验证的指派和备注", async () => {
  const { service } = setup({ disabled: true });
  const preview = await service.handoffStory({ storyId: 9, mode: "activate" });
  expect(preview.preview.steps.map(({ action }) => action)).toEqual([
    "story.assign",
    "story.comment",
  ]);
  expect(preview.warnings[0]?.message).toMatch(/手动激活.*story-view-9.html/u);
});

it("AC-48 版本漂移且全部写能力需复验时返回人工操作指引", async () => {
  const { service, write } = setup({ version: "22.7" });
  const preview = await service.handoffStory({ storyId: 9, mode: "activate" });
  expect(preview).toMatchObject({
    level: "W0",
    opId: "",
    preview: { steps: [] },
  });
  expect(
    preview.warnings.some(({ message }) =>
      /手动激活.*story-view-9.html/u.test(message),
    ),
  ).toBe(true);
  expect(write).not.toHaveBeenCalled();
});

it("AC-50 挪月使用目标 L3，确认后只追加一条规范月份记录", async () => {
  const { service, confirm, store } = setup();
  const preview = await service.rescheduleStory({
    storyIds: [9, 9],
    toMonth: "下月",
    reason: " 依赖延期 ",
    moveTasks: true,
  });
  expect(preview.preview.steps.map(({ action }) => action)).toEqual([
    "story.edit",
    "story.comment",
  ]);
  expect(preview.preview.steps[0]?.fields.plan?.value).toBe(21);
  expect(preview.warnings[0]?.message).toMatch(
    /迭代.*截止日期.*story-view-9.html/u,
  );
  expect(store.reschedules.listByStory(9)).toEqual([]);
  expect((await confirm(preview.opId)).status).toBe("confirmed");
  expect(store.reschedules.listByStory(9)).toEqual([
    expect.objectContaining({
      fromMonth: "2026-11",
      toMonth: "2026-12",
      reason: "依赖延期",
    }),
  ]);
});

it("AC-51 只随需求关闭已完成的叶子任务", async () => {
  const { service } = setup();
  const preview = await service.closeStories({ mode: "story", storyIds: [9] });
  expect(preview.preview.steps.map(({ action }) => action)).toEqual([
    "story.close",
    "task.close",
    "task.close",
  ]);
  expect(preview.preview.steps[0]?.fields.closedReason?.value).toBe("done");
  expect(preview.warnings[0]?.message).toMatch(/未完成.*task-view-12.html/u);
});

it("AC-52 默认关 A 类、B 类需原因、C 类只列出", async () => {
  const { service } = setup({ closed: true });
  const scope = { beforeMonth: "2026-10" };
  const defaults = await service.closeStories({
    mode: "cleanup",
    cleanup: { scope },
  });
  expect(defaults.preview.steps.map(({ target }) => target)).toEqual([
    "task #11",
    "task #15",
  ]);
  expect(
    defaults.warnings.some(({ message }) =>
      /C 类.*task-view-13.html/u.test(message),
    ),
  ).toBe(true);
  await expect(
    service.closeStories({
      mode: "cleanup",
      cleanup: { scope, classes: ["B"] },
    }),
  ).rejects.toMatchObject({ code: "MISSING_REQUIRED" });
  const explicit = await service.closeStories({
    mode: "cleanup",
    cleanup: { scope, classes: ["B", "C"], reason: "需求已终止" },
  });
  expect(explicit.preview.steps.map(({ target }) => target)).toEqual([
    "task #12",
  ]);
  const empty = await setup({ onlyOrphan: true }).service.closeStories({
    mode: "cleanup",
    cleanup: { scope, classes: ["C"] },
  });
  expect(empty).toMatchObject({
    level: "W0",
    opId: "",
    preview: { steps: [] },
  });
});

it("AC-63 发布例外只允许 PM，确认备注后登记元数据", async () => {
  const waiver = { rule: "release_gate", reason: "经审批延期测试" };
  await expect(
    setup().service.setStoryMeta({ storyId: 9, waiver }),
  ).rejects.toMatchObject({ code: "PERMISSION_DENIED" });
  const { service, confirm, store } = setup({ pm: true });
  const preview = await service.setStoryMeta({
    storyId: 9,
    waiver,
    roles: { receiver: "bob" },
    stageRequirements: { interface: { required: false, reason: "无接口变更" } },
  });
  expect(preview.warnings[0]?.message).toMatch(/正文.*评论.*角色缓存/u);
  expect(store.waivers.listAll()).toEqual([]);
  expect((await confirm(preview.opId)).status).toBe("confirmed");
  expect(store.waivers.listAll()).toEqual([
    expect.objectContaining({
      ruleId: "R13",
      reason: waiver.reason,
      approvedBy: "alice",
    }),
  ]);
  expect(store.stageRequirements.get(9, "interface")).toMatchObject({
    required: false,
  });
  expect(store.storyRoles.get(9)).toMatchObject({ receiver: "bob" });
});

it("仅改自有需求版本为 W1，正文范围编辑被拦截", async () => {
  const { service } = setup();
  const { level, preview } = await service.setStoryMeta({
    storyId: 9,
    version: "v1.2.3",
  });
  expect(level).toBe("W1");
  expect(preview.steps[0]?.fields).toEqual({
    keywords: { value: "版本:V1.2.3", origin: "user" },
  });
  await expect(
    service.setStoryMeta({ storyId: 9, scope: { scope: "新范围" } }),
  ).rejects.toMatchObject({
    code: "CAPABILITY_UNVERIFIED",
    message: expect.stringContaining("story-edit-9.html"),
  });
});

it("缺失目标月份计划、任务分页不完整以及额外输入字段均拦截准备", async () => {
  const { service, write, executor } = setup({ taskListTruncated: true });
  await expect(
    service.rescheduleStory({
      storyIds: [9],
      toMonth: "上月",
      reason: "变更排期",
    }),
  ).rejects.toMatchObject({
    code: "NOT_FOUND",
    message: expect.stringContaining("2026-10"),
  });
  await expect(
    service.closeStories({ mode: "story", storyIds: [9] }),
  ).rejects.toMatchObject({
    details: {
      completeness: "partial",
      gaps: [{ source: "execution:7:tasks" }],
    },
  });
  await expect(
    service.handoffStory({
      mode: "from_design",
      storyId: 9,
      feature: { previewAck: true },
    }),
  ).rejects.toMatchObject({ code: "INVALID_INPUT" });
  await expect(
    service.setStoryMeta({ storyId: 9, roles: { unknownField: "bob" } }),
  ).rejects.toMatchObject({ code: "INVALID_INPUT" });
  expect(executor.getOperation({ recent: 10 })).toEqual([]);
  expect(write).not.toHaveBeenCalled();
});

it("部分确认按持久化步骤记录挪月，未确认的元数据评论不落本地", async () => {
  const { service, confirm, store, write } = setup();
  const change = await service.rescheduleStory({
    storyIds: [9],
    toMonth: "2026-12",
    reason: "依赖延期",
  });
  write
    .mockResolvedValueOnce({ id: 9 })
    .mockRejectedValueOnce(
      new BztError("ZENTAO_BUSINESS_ERROR", "模拟备注拒绝。"),
    );
  const result = await confirm(change.opId);
  expect(result).toMatchObject({
    status: "partial",
    steps: [{ state: "done" }, { state: "failed" }],
  });
  expect(store.reschedules.listByStory(9)).toHaveLength(1);
  expect(() => service.recordConfirmed("different-operation", result)).toThrow(
    expect.objectContaining({ code: "INVALID_INPUT" }),
  );

  const meta = await service.setStoryMeta({
    storyId: 9,
    roles: { receiver: "bob" },
  });
  write.mockRejectedValueOnce(
    new BztError("ZENTAO_BUSINESS_ERROR", "模拟备注拒绝。"),
  );
  expect((await confirm(meta.opId)).status).toBe("failed");
  expect(() => store.storyRoles.get(9)).toThrow(
    expect.objectContaining({ code: "NOT_FOUND" }),
  );
});

it("扩展需求写入配方并投影互链回执", async () => {
  const calls: unknown[] = [];
  vi.stubGlobal(
    "fetch",
    vi.fn<typeof fetch>(async (request, init) => {
      const url = new URL(String(request));
      if (url.pathname.endsWith("/tokens"))
        return Response.json({ token: "fixture-session" }, { status: 201 });
      calls.push([
        init?.method,
        url.pathname + url.search,
        JSON.parse(String(init?.body)),
      ]);
      return Response.json(
        url.pathname.endsWith("linkStory")
          ? { status: "success", users: { fixture: "discard" } }
          : { id: 9 },
      );
    }),
  );
  const client = createZentaoReadClient({
    baseUrl,
    account: "alice",
    password: "offline",
    clock: () => 0,
    logSink: () => undefined,
  });
  await writeStory(client, "story.edit", 29, 9, { plan: 21 });
  await writeStory(client, "story.close", 29, 9, { closedReason: "done" });
  await expect(
    writeStory(client, "story.linkStory", 29, 9, { stories: [10] }),
  ).resolves.toEqual({ status: "accepted", data: { id: 9 } });
  await expect(
    writeStory(client, "story.edit", 29, 9, { title: "独立修改" }),
  ).rejects.toMatchObject({ code: "INVALID_INPUT" });
  await expect(
    writeStory(client, "story.edit", 29, 9, { plan: 21, spec: "禁止" }),
  ).rejects.toMatchObject({ code: "INVALID_INPUT" });
  expect(calls).toEqual([
    ["PUT", "/zentao/api.php/v1/stories/9", { plan: 21 }],
    ["POST", "/zentao/api.php/v1/stories/9/close", { closedReason: "done" }],
    ["POST", "/zentao/api.php/v2/story/linkStory?storyID=9", { stories: [10] }],
  ]);
});
