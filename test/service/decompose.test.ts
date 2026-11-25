import { readFileSync } from "node:fs";
import { afterEach, expect, it, vi } from "vitest";
import { z } from "zod";
import { createZentaoReadClient } from "../../src/api/client.ts";
import { linkStoryToExecution, createTask } from "../../src/api/task-write.ts";
import { getTaskDetail } from "../../src/api/task.ts";
import {
  decomposeStoriesInputSchema,
  decomposeStoriesOutputSchema,
} from "../../src/contracts/tools/decompose_stories.ts";
import { teamConfigSchema } from "../../src/core/config.ts";
import { openLocalStore } from "../../src/core/store/index.ts";
import {
  DecomposeService,
  buildDecomposeNotifications,
} from "../../src/services/decompose.ts";
import { DirectoryService } from "../../src/services/directory.ts";
import {
  OperationExecutor,
  type OperationGateway,
} from "../../src/services/operation.ts";

const baseUrl = "https://decompose.fixture.test/zentao/";
const sample = (name: string) =>
  z
    .object({ body: z.record(z.string(), z.json()) })
    .parse(
      JSON.parse(
        readFileSync(
          new URL(`../fixtures/zentao-22.6/${name}.json`, import.meta.url),
          "utf8",
        ),
      ),
    ).body;
const sampleStory = sample("story-detail");
const sampleTask = sample("task-detail");
const cleanups: (() => void)[] = [];
afterEach(() => {
  vi.unstubAllGlobals();
  for (const cleanup of cleanups.splice(0)) cleanup();
});

const assignees = { dev: "alice", test: "qa", acceptance: "owner" };
function setup(
  options: {
    category?: "feature" | "design";
    draft?: boolean;
    unlinked?: boolean;
    existing?: boolean;
    existingSubtask?: boolean;
    historicalStage?: boolean;
    spec?: string;
    storedMaintainer?: string;
    executionTeam?: "unavailable" | "invalid";
    failOnce?: boolean;
    loseCreateReceipt?: boolean;
    projectProducts?: number[];
    truncatedTasks?: boolean;
    stageRequirements?: { stage: string; required: boolean }[];
  } = {},
) {
  let now = Date.UTC(2026, 11, 9, 1);
  const clock = () => now;
  const kind = options.category === "design" ? "设计" : "研发";
  const executionId = 315;
  const name = `【示例产品】【${kind}】2026年12月迭代`;
  const previous = {
    ...sampleTask,
    id: 82,
    story: 11,
    execution: executionId,
    name: options.historicalStage ? "已有阶段任务" : "【研发】已有实现",
    desc: options.historicalStage ? "" : "<p>[bzt:stage=dev]</p>",
    type: options.historicalStage ? "design" : "devel",
    assignedTo: options.historicalStage ? "owner" : "alice",
    isParent: options.existingSubtask === true,
    status: "done",
    deleted: false,
    deadline: "2026-12-10",
  };
  const cancelled = {
    ...previous,
    id: 83,
    name: "【测试】旧任务",
    desc: "",
    status: "closed",
    closedReason: "cancel",
  };
  const tasks = new Map<number, Record<string, z.infer<z.ZodJSONSchema>>>();
  if (options.existing) {
    tasks.set(82, previous);
    tasks.set(83, cancelled);
  }
  if (options.existingSubtask)
    tasks.set(84, {
      ...previous,
      id: 84,
      parent: 82,
      isParent: false,
      name: "测试用例准备",
      desc: "",
    });
  const linked = new Set<number>(options.unlinked ? [] : [11, 12, 13, 14, 15]);
  const status = options.draft ? "draft" : "active";
  const config = teamConfigSchema.parse({
    products: { 7: { name: "示例产品", state: "runtime" } },
    modules: {
      "7:564": { name: "示例模块", testLead: "qa", designLead: "owner" },
    },
    wecomMap: { alice: "wx-alice" },
  });
  const writes: {
    path: string;
    body: Record<string, z.infer<z.ZodJSONSchema>>;
  }[] = [];
  let rejected = false;
  let lostId: number | undefined;
  let lookups = 0;
  const fetcher = vi.fn<typeof fetch>(async (request, init) => {
    const url = new URL(String(request));
    expect(url.origin).toBe("https://decompose.fixture.test");
    const path = url.pathname.replace("/zentao/api.php/", "");
    if (path === "v1/tokens")
      return Response.json({ token: "session" }, { status: 201 });
    if (init?.method === "POST") {
      const body = z
        .record(z.string(), z.json())
        .parse(JSON.parse(String(init.body)));
      writes.push({ path, body });
      if (path === "v2/execution/linkStory") {
        linked.add(z.tuple([z.number()]).parse(body.stories)[0]);
        return Response.json({ status: "success" });
      }
      expect(path).toBe("v1/executions/315/tasks");
      if (options.failOnce && body.assignedTo === "qa" && !rejected) {
        rejected = true;
        return Response.json({ status: "fail" });
      }
      const id = 100 + tasks.size;
      const created = {
        ...sampleTask,
        ...body,
        id,
        parent: 0,
        deleted: false,
        status: "wait",
      };
      tasks.set(id, created);
      if (options.loseCreateReceipt && lostId === undefined) {
        lostId = id;
        return Response.json({ message: "保存成功" }, { status: 201 });
      }
      return Response.json(created, { status: 201 });
    }
    if (path === "v1/executions")
      return Response.json({
        total: 1,
        executions: [
          {
            id: executionId,
            project: 314,
            name,
            type: "sprint",
            status: "doing",
            begin: "2026-12-01",
            end: "2026-12-31",
          },
        ],
      });
    if (path === "v2/project/view")
      return Response.json({
        project: { id: 314, multiple: true, status: "doing" },
        products: options.projectProducts ?? [7],
      });
    if (path === "v1/executions/315") {
      if (options.executionTeam === "unavailable")
        return Response.json({}, { status: 403 });
      if (options.executionTeam === "invalid")
        return Response.json({ id: executionId });
      return Response.json({
        id: executionId,
        teamMembers: ["alice", "owner"],
      });
    }
    if (path === "v1/executions/315/tasks")
      return Response.json({
        total: options.truncatedTasks ? 100000 : tasks.size,
        tasks: [...tasks.values()],
      });
    if (path.startsWith("v1/tasks/")) {
      const id = Number(path.split("/").at(-1));
      return Response.json(
        tasks.get(id) ?? {
          ...sampleTask,
          id,
          execution: executionId,
          story: 11,
          mode: "",
          deleted: false,
        },
      );
    }
    if (path.startsWith("v1/stories/")) {
      const id = Number(path.split("/").at(-1));
      return Response.json({
        ...sampleStory,
        id,
        product: 7,
        module: 564,
        title: `需求${id}`,
        category: options.category ?? "feature",
        status,
        deleted: false,
        assignedTo: "alice",
        openedBy: "owner",
        spec: options.spec ?? "",
        executions: linked.has(id) ? [{ id: executionId, name }] : [],
        tasks: [...tasks.values()].filter((task) => task.story === id),
      });
    }
    throw new Error(`意外请求 ${path}`);
  });
  vi.stubGlobal("fetch", fetcher);
  const client = createZentaoReadClient({
    baseUrl,
    account: "alice",
    password: "offline",
    clock,
    logSink: () => undefined,
  });
  const resolveContext = vi.fn<DirectoryService["resolveContext"]>(
    async (raw) => {
      const { people = [] } = z
        .object({ people: z.array(z.string()).optional() })
        .parse(raw);
      const identities = new Map([
        ["alice", "研发人员"],
        ["qa", "测试人员"],
        ["owner", "状态维护人"],
      ]);
      return {
        ok: true,
        data: {
          people: people.map((input) => ({
            input,
            account: input,
            realname: identities.get(input) ?? "",
            roles: [],
          })),
          me: { account: "alice", realname: "研发人员", roles: [] },
        },
        scope: { asOf: "2026-12-09T01:00:00.000Z", filters: {} },
        completeness: "complete",
        gaps: [],
        inferences: [],
      };
    },
  );
  const store = openLocalStore({
    baseUrl,
    account: "alice",
    dbPath: ":memory:",
    clock,
  });
  cleanups.push(() => store.close());
  const gateway: OperationGateway = {
    async readTarget({ id, product, type }) {
      return {
        id,
        product,
        type,
        status,
        executions: linked.has(id) ? [executionId] : [],
      };
    },
    async write({ step, id, opId }) {
      const {
        title: _title,
        notify: _notify,
        ...fields
      } = Object.fromEntries(
        Object.entries(step.fields).map(([key, field]) => [key, field.value]),
      );
      const receipt =
        step.action === "task.create"
          ? await createTask(client, executionId, fields, { opId })
          : await linkStoryToExecution(
              client,
              executionId,
              step.product,
              z.number().parse(id),
              { opId },
            );
      return receipt.status === "accepted" ? { id: receipt.data.id } : {};
    },
    async readback({ step, zentaoId }) {
      if (step.action === "story.linkExecution")
        return { verified: linked.has(zentaoId ?? 0) };
      const task = await getTaskDetail(client, z.number().parse(zentaoId));
      return {
        verified:
          task.story === step.fields.story?.value &&
          task.execution === step.fields.execution?.value &&
          task.assignedTo === step.fields.assignedTo?.value &&
          task.deadline === step.fields.deadline?.value &&
          task.parent === null &&
          task.desc === step.fields.desc?.value,
      };
    },
    async reverseLookup() {
      const id = lostId;
      const title = id === undefined ? undefined : tasks.get(id)?.name;
      return {
        complete: true,
        matches:
          id !== undefined && typeof title === "string" && ++lookups > 1
            ? [
                {
                  id,
                  product: 7,
                  title,
                  createdBy: "alice",
                  createdAt: clock(),
                },
              ]
            : [],
      };
    },
  };
  const executor = new OperationExecutor({
    baseUrl,
    store,
    gateway,
    clock,
    config,
    instanceVersion: "22.6",
  });
  const service = new DecomposeService({
    client,
    directory: { resolveContext },
    executor,
    config,
    clock,
    baseUrl,
    instanceVersion: "22.6",
    stageRequirements: { listByStory: () => options.stageRequirements ?? [] },
    storyRoles:
      options.storedMaintainer === undefined
        ? undefined
        : {
            get: () => ({ maintainer: options.storedMaintainer }),
          },
  });
  return {
    service,
    executor,
    writes,
    fetcher,
    config,
    advance: () => {
      now += 3000;
    },
  };
}

it("AC-42 / SV-02 缺失创建回执时续跑先反查，已落库任务不重建", async () => {
  const { service, executor, writes, advance } = setup({
    loseCreateReceipt: true,
  });
  const { opId } = await service.decomposeStories({
    storyIds: [11],
    template: "feature",
    assignees,
  });
  advance();
  const initial = await executor.confirm({ opId, previewAck: true });
  expect(initial.status).toBe("unknown");
  expect(writes).toHaveLength(1);
  const result = await executor.resume({ opId, previewAck: true });
  expect(result).toMatchObject({ status: "confirmed" });
  expect(result.created).toHaveLength(3);
  expect(writes.map(({ body }) => body.name)).toEqual([
    "【研发】需求11",
    "【测试】需求11",
    "【验收】需求11",
  ]);
});

it("AC-42 / SV-04 五条需求去重，失败后恢复待执行步骤且不重复创建", async () => {
  const { service, executor, writes, advance } = setup({ failOnce: true });
  const plan = await service.decomposeStories({
    storyIds: [11, 12, 13, 14, 15, 11],
    template: "feature",
    assignees,
  });
  expect(decomposeStoriesOutputSchema.parse(plan)).toMatchObject({
    level: "W2",
    requiresPreviewAck: true,
  });
  expect(plan.preview.steps).toHaveLength(15);
  expect(plan.preview.steps[0]?.fields.title).toEqual({
    value: "【研发】需求11",
    origin: "derived",
  });
  expect(writes).toEqual([]);
  advance();
  await expect(executor.confirm({ opId: plan.opId })).rejects.toMatchObject({
    code: "PREVIEW_REQUIRED",
  });
  expect(writes).toEqual([]);
  const partial = await executor.confirm({ opId: plan.opId, previewAck: true });
  expect(partial.status).toBe("partial");
  const resumed = await executor.resume({ opId: plan.opId, previewAck: true });
  // The baseline executor resumes pending steps. An explicitly rejected
  // create needs a fresh preview, and a create with an unknown outcome is
  // reconciled before any further writes.
  expect(resumed).toMatchObject({ status: "partial" });
  expect(resumed.created).toHaveLength(14);
  expect(resumed.steps[1]).toMatchObject({ state: "failed" });
  expect(resumed.steps[2]).toMatchObject({ state: "done" });
  const repair = await service.decomposeStories({
    storyIds: [11],
    template: "next_stage",
    assignees,
  });
  expect(repair.preview.steps.map(({ fields }) => fields.name?.value)).toEqual([
    "【测试】需求11",
  ]);
  advance();
  const result = await executor.confirm({
    opId: repair.opId,
    previewAck: true,
  });
  expect(result).toMatchObject({
    status: "confirmed",
    created: [{ type: "task" }],
  });
  const names = writes.map(({ body }) => body.name);
  expect(names.filter((name) => name === "【研发】需求11")).toHaveLength(1);
  expect(names.filter((name) => name === "【测试】需求11")).toHaveLength(2);
});

it("AC-43 工作日依赖按用户截止日重算，用户日期不覆盖", async () => {
  const { service } = setup();
  const { preview } = await service.decomposeStories({
    storyIds: [11],
    template: "feature",
    assignees,
    execution: "315",
    dates: {
      dev: { deadline: "2026-12-11" },
      acceptance: { estStarted: "2026-12-18" },
    },
  });
  expect(
    preview.steps.map(({ fields }) => [fields.estStarted, fields.deadline]),
  ).toEqual([
    [
      { value: "2026-12-09", origin: "default" },
      { value: "2026-12-11", origin: "user" },
    ],
    [
      { value: "2026-12-14", origin: "default" },
      { value: "2026-12-16", origin: "default" },
    ],
    [
      { value: "2026-12-18", origin: "user" },
      { value: "2026-12-21", origin: "default" },
    ],
  ]);
});

it("AC-44 / AC-45 先关联、提醒团队外指派，只给已回读的任务生成通知", async () => {
  const { service, writes, executor, advance } = setup({
    unlinked: true,
    failOnce: true,
  });
  const plan = await service.decomposeStories({
    storyIds: [11],
    template: "feature",
    assignees,
  });
  expect(plan.preview.steps[0]).toMatchObject({
    action: "story.linkExecution",
    fields: { execution: { value: 315 }, story: { value: 11 } },
  });
  expect(plan.preview.affects).toEqual([
    "alice 研发人员",
    "qa 测试人员",
    "owner 状态维护人",
  ]);
  expect(plan.warnings).toEqual(
    expect.arrayContaining([
      expect.objectContaining({
        code: "OUTSIDE_EXECUTION_TEAM",
        message: expect.stringContaining("qa"),
      }),
    ]),
  );
  advance();
  const result = await executor.confirm({ opId: plan.opId, previewAck: true });
  expect(writes[0]?.path).toBe("v2/execution/linkStory");
  const events = buildDecomposeNotifications(plan, result);
  expect(events).toContainEqual(
    expect.objectContaining({
      account: "alice",
      realname: "研发人员",
      storyId: 11,
      taskId: expect.any(Number),
    }),
  );
  expect(events.some(({ account }) => account === "qa")).toBe(false);
});

it("AC-46 设计模板创建三阶段和可见微标签，支持关闭通知", async () => {
  const { service, executor, advance } = setup({ category: "design" });
  const plan = await service.decomposeStories({
    storyIds: [11],
    template: "design",
    assignees: { design: "alice" },
    notify: false,
  });
  expect(plan.preview.steps.map(({ fields }) => fields.name?.value)).toEqual([
    "【设计】需求11",
    "【评审】需求11",
    "【传递】需求11",
  ]);
  expect(plan.preview.steps.map(({ fields }) => fields.desc?.value)).toEqual(
    ["design", "review", "handoff"].map(
      (stage) =>
        `<p style="color:#999;font-size:12px">[bzt:stage=${stage}]</p>`,
    ),
  );
  advance();
  expect(
    buildDecomposeNotifications(
      plan,
      await executor.confirm({ opId: plan.opId, previewAck: true }),
    ),
  ).toEqual([]);
});

it("next_stage 跳过已有未取消阶段，按实际截止日排期并应用本地阶段要求", async () => {
  const { service } = setup({
    existing: true,
    stageRequirements: [
      { stage: "delivery", required: true },
      { stage: "acceptance", required: false },
    ],
  });
  const { preview } = await service.decomposeStories({
    storyIds: [11],
    template: "next_stage",
  });
  expect(preview.steps.map(({ fields }) => fields.name?.value)).toEqual([
    "【测试】需求11",
    "【交付】需求11",
  ]);
  expect(preview.steps[0]?.fields.estStarted).toEqual({
    value: "2026-12-11",
    origin: "default",
  });
});

it.each(["next_stage", "feature"])(
  "%s 不把研发父任务下的测试用例准备识别成测试阶段",
  async (template) => {
    const { service } = setup({ existing: true, existingSubtask: true });
    const { preview } = await service.decomposeStories({
      storyIds: [11],
      template,
    });
    expect(preview.steps.map(({ fields }) => fields.name?.value)).toEqual([
      "【测试】需求11",
      "【验收】需求11",
    ]);
    expect(preview.steps[0]?.fields.estStarted?.value).toBe("2026-12-11");
  },
);

it("存量顶层任务按设计执行、模块设计组与任务类型识别阶段", async () => {
  const { service } = setup({
    category: "design",
    existing: true,
    historicalStage: true,
  });
  const { preview } = await service.decomposeStories({
    storyIds: [11],
    template: "next_stage",
  });
  expect(preview.steps.map(({ fields }) => fields.name?.value)).toEqual([
    "【评审】需求11",
    "【传递】需求11",
  ]);
});

it.each([
  { template: "feature", category: "feature", stageName: "【验收】需求11" },
  { template: "design", category: "design", stageName: "【传递】需求11" },
] satisfies {
  template: string;
  category: "feature" | "design";
  stageName: string;
}[])(
  "$template 的 $stageName 默认用正文维护人并提示核对",
  async ({ template, category, stageName }) => {
    const { service } = setup({
      category,
      spec: "<p>[bzt:v1 maintainer=qa;receiver=alice]</p>",
    });
    const result = await service.decomposeStories({
      storyIds: [11],
      template,
      assignees: { dev: "alice", design: "alice" },
    });
    expect(
      result.preview.steps.find(
        ({ fields }) => fields.name?.value === stageName,
      )?.fields.assignedTo,
    ).toEqual({ value: "qa", origin: "default" });
    expect(result.warnings).toContainEqual({
      code: "UNTRUSTED_ROLE_TAG",
      message: expect.stringMatching(/正文角色标签.*不可信.*核对/u),
    });
  },
);

it("显式指派优先于标签，缺少正文维护人时使用本地维护人", async () => {
  const { service } = setup({
    storedMaintainer: "alice",
    spec: "<p>[bzt:v1 receiver=qa]</p>",
  });
  const { preview, warnings } = await service.decomposeStories({
    storyIds: [11],
    template: "feature",
    assignees: { dev: "alice" },
  });
  expect(preview.steps[2]?.fields.assignedTo).toEqual({
    value: "alice",
    origin: "default",
  });
  expect(warnings.some(({ code }) => code === "UNTRUSTED_ROLE_TAG")).toBe(
    false,
  );
  const explicit = setup({ spec: "<p>[bzt:v1 maintainer=qa]</p>" });
  const overridden = await explicit.service.decomposeStories({
    storyIds: [11],
    template: "feature",
    assignees,
  });
  expect(overridden.preview.steps[2]?.fields.assignedTo).toEqual({
    value: "owner",
    origin: "user",
  });
  expect(
    overridden.warnings.some(({ code }) => code === "UNTRUSTED_ROLE_TAG"),
  ).toBe(false);
});

it.each(["unavailable", "invalid"] satisfies ("unavailable" | "invalid")[])(
  "执行团队读取 %s 时预览只标记一次核验缺口",
  async (executionTeam) => {
    const { service, writes } = setup({ executionTeam });
    const plan = await service.decomposeStories({
      storyIds: [11, 12],
      template: "feature",
      assignees,
    });
    expect(writes).toEqual([]);
    expect(plan.preview.steps).toHaveLength(6);
    expect(plan.warnings).toEqual([
      {
        code: "EXECUTION_TEAM_UNVERIFIED",
        message: expect.stringContaining("无法核验"),
      },
    ]);
    expect(decomposeStoriesOutputSchema.parse(plan)).toMatchObject({
      completeness: "partial",
      gaps: [
        {
          source: "execution:315:team",
          reason: expect.stringContaining("无法核验"),
        },
      ],
    });
  },
);

it.each(["#315", "【示例产品】【研发】2026年12月迭代"])(
  "执行显式指定为 %s 时，关联和创建步骤均标记 user",
  async (execution) => {
    const { service } = setup({ unlinked: true });
    const { preview } = await service.decomposeStories({
      storyIds: [11],
      template: "feature",
      execution,
      assignees,
    });
    expect(preview.steps).toHaveLength(4);
    for (const { fields } of preview.steps)
      expect(fields.execution).toEqual({ value: 315, origin: "user" });
  },
);

it("通知摘要跳过 done 但缺失禅道任务 ID 或链接的回执", async () => {
  const { service, executor, advance } = setup();
  const plan = await service.decomposeStories({
    storyIds: [11],
    template: "feature",
    assignees,
  });
  advance();
  const result = await executor.confirm({ opId: plan.opId, previewAck: true });
  const steps = result.steps.map((step) => {
    if (step.seq === 1) {
      const { zentaoId: _id, ...remaining } = step;
      return remaining;
    }
    if (step.seq === 2) {
      const { url: _url, ...remaining } = step;
      return remaining;
    }
    return step;
  });
  expect(buildDecomposeNotifications(plan, { ...result, steps })).toEqual([
    expect.objectContaining({
      account: "owner",
      taskId: result.steps[2]?.zentaoId,
    }),
  ]);
});

it("草稿、项目产品不匹配和非法排期均无写入", async () => {
  const input = { storyIds: [11], template: "feature", assignees };
  const draft = setup({ draft: true });
  await expect(draft.service.decomposeStories(input)).rejects.toMatchObject({
    code: "RULE_VIOLATION",
    message: expect.stringContaining("handoff_story"),
  });
  const wrong = setup({ projectProducts: [8] });
  await expect(wrong.service.decomposeStories(input)).rejects.toMatchObject({
    code: "RULE_VIOLATION",
  });
  const dates = setup();
  await expect(
    dates.service.decomposeStories({
      ...input,
      dates: { dev: { deadline: "2027-01-05" } },
    }),
  ).rejects.toMatchObject({ code: "RULE_VIOLATION" });
  expect([...draft.writes, ...wrong.writes, ...dates.writes]).toEqual([]);
});

it("任务列表截断时声明预检读取不完整", async () => {
  const { service, writes } = setup({ truncatedTasks: true });
  await expect(
    service.decomposeStories({
      storyIds: [11],
      template: "feature",
      assignees,
    }),
  ).rejects.toMatchObject({
    details: { completeness: "partial", gaps: expect.any(Array) },
  });
  expect(writes).toEqual([]);
});

it("AC-49 禁用多人任务，未验证的 L4 降级到禅道手动创建", async () => {
  const { service, writes } = setup();
  const input = { taskId: 82, template: "subtasks" };
  await expect(
    service.decomposeStories({
      storyIds: [11],
      template: "feature",
      assignees: { dev: "alice,qa" },
    }),
  ).rejects.toMatchObject({
    code: "RULE_VIOLATION",
    message: expect.stringContaining("阶段任务只允许一名负责人"),
  });
  await expect(
    service.decomposeStories({
      ...input,
      subtasks: [{ name: "子任务", assignTo: "alice,qa" }],
    }),
  ).rejects.toMatchObject({
    code: "RULE_VIOLATION",
    message: expect.stringContaining("每条子任务只允许一名负责人"),
  });
  await expect(
    service.decomposeStories({
      ...input,
      subtasks: [{ name: "子任务", assignTo: "alice" }],
    }),
  ).rejects.toMatchObject({
    code: "CAPABILITY_UNVERIFIED",
    details: { links: [{ url: expect.stringContaining("taskID=82") }] },
  });
  expect(writes).toEqual([]);
  expect(
    decomposeStoriesInputSchema.safeParse({ ...input, team: ["alice", "qa"] })
      .success,
  ).toBe(false);
});
