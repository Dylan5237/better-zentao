import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { teamConfigSchema } from "../../src/core/config.ts";
import { BztError } from "../../src/core/errors.ts";
import { openLocalStore } from "../../src/core/store/index.ts";
import { OperationExecutor } from "../../src/services/operation.ts";
import type {
  OperationGateway,
  OperationPlan,
  OperationTargetSnapshot,
} from "../../src/services/operation.ts";

const baseUrl = "https://zentao.example.test/";
const start = Date.UTC(2026, 10, 24, 1);
const field = (value: string) => ({ value, origin: "user" as const });
const story = {
  id: 9,
  type: "story",
  product: 29,
  status: "draft",
  maintainer: "alice",
  assignedTo: "alice",
  plan: [2],
  executions: [3, 4],
  lastEditedDate: start,
  spec: "初始正文",
} satisfies OperationTargetSnapshot;

const createStep = {
  action: "story.create",
  type: "story",
  product: 29,
  fields: {
    title: field("需求"),
    assignedTo: field("alice"),
    status: field("draft"),
  },
} as const;

const assignStep = {
  action: "story.assign",
  type: "story",
  id: 9,
  product: 29,
  fields: { assignedTo: field("bob") },
} as const;

const plan = (...steps: OperationPlan["steps"]): OperationPlan => ({
  kind: "create_story",
  summary: "处理需求",
  steps,
});

const cleanups: (() => void)[] = [];
afterEach(() => {
  for (const clean of cleanups.splice(0).reverse()) clean();
});

function setup(
  options: {
    config?: unknown;
    account?: string;
    dbPath?: string;
    channel?: "mcp" | "cli";
    instanceVersion?: string;
  } = {},
) {
  let now = start;
  const clock = () => now;
  const store = openLocalStore({
    baseUrl,
    account: options.account ?? "alice",
    dbPath: options.dbPath ?? ":memory:",
    clock,
  });
  cleanups.push(() => store.close());
  const readTarget = vi
    .fn<OperationGateway["readTarget"]>()
    .mockResolvedValue(story);
  const write = vi
    .fn<OperationGateway["write"]>()
    .mockImplementation(async ({ step, id }) => ({
      id: step.action === "story.create" ? 41 : id,
    }));
  const readback = vi
    .fn<OperationGateway["readback"]>()
    .mockResolvedValue({ verified: true });
  const reverseLookup = vi
    .fn<OperationGateway["reverseLookup"]>()
    .mockResolvedValue({ complete: true, matches: [] });
  const gateway = { readTarget, write, readback, reverseLookup };
  const config = teamConfigSchema.parse(options.config ?? {});
  const executor = new OperationExecutor({
    baseUrl,
    store,
    gateway,
    config,
    clock,
    channel: options.channel,
    instanceVersion: options.instanceVersion,
  });
  const advance = (ms = 3000) => {
    now += ms;
  };
  return { store, executor, gateway, advance };
}

const timeout = () => new BztError("ZENTAO_TIMEOUT", "禅道超时。");
const denied = () => new BztError("ZENTAO_BUSINESS_ERROR", "禅道拒绝。");
const candidate = {
  id: 41,
  product: 29,
  title: "需求",
  createdBy: "alice",
  createdAt: start,
};

describe("WP-16 / OperationExecutor", () => {
  it("SV-01 指派明确失败后只补指派，需求只创建一次", async () => {
    const { executor, gateway, store, advance } = setup();
    gateway.write
      .mockResolvedValueOnce({ id: 41 })
      .mockRejectedValueOnce(denied());
    const { opId } = await executor.prepare(
      plan(createStep, { ...assignStep, id: undefined, fromStep: 1 }),
    );
    advance();
    const partial = await executor.confirm({ opId, previewAck: true });
    expect(partial).toMatchObject({ status: "partial", created: [{ id: 41 }] });
    expect(store.operationSteps.get(opId, 1)).toMatchObject({
      state: "done",
      zentaoId: 41,
    });
    expect(await executor.confirm({ opId, previewAck: true })).toEqual(partial);
    const result = await executor.resume({ opId, previewAck: true });
    expect(result.status).toBe("confirmed");
    expect(
      gateway.write.mock.calls.map(([request]) => [
        request.step.action,
        request.id,
      ]),
    ).toEqual([
      ["story.create", undefined],
      ["story.assign", 41],
      ["story.assign", 41],
    ]);
  });

  it("SV-02 创建超时后按标题、创建人、时间窗反查成功", async () => {
    const { executor, gateway, store } = setup();
    gateway.write.mockRejectedValueOnce(timeout());
    gateway.reverseLookup.mockImplementationOnce(async (query) => {
      expect(store.operationSteps.get(query.opId, 1).state).toBe("unknown");
      expect(query).toMatchObject({
        title: "需求",
        createdBy: "alice",
        product: 29,
        since: start,
      });
      return {
        complete: true,
        matches: [candidate, { ...candidate, id: 42, createdBy: "bob" }],
      };
    });
    const { opId } = await executor.prepare(plan(createStep));
    expect(await executor.confirm({ opId })).toMatchObject({
      status: "confirmed",
      created: [{ id: 41 }],
    });
    expect(gateway.write).toHaveBeenCalledTimes(1);
  });

  it("SV-03 无法反查时保持 unknown，恢复只核对", async () => {
    const { executor, gateway } = setup();
    gateway.write.mockRejectedValueOnce(timeout());
    const { opId } = await executor.prepare(plan(createStep));
    expect(await executor.confirm({ opId })).toMatchObject({
      status: "unknown",
      nextActions: [expect.stringContaining("人工")],
    });
    expect((await executor.resume({ opId })).status).toBe("unknown");
    expect(gateway.write).toHaveBeenCalledTimes(1);
    expect(gateway.reverseLookup).toHaveBeenCalledTimes(2);
  });

  it("SV-04 W2 缺少确认时拒绝写入", async () => {
    const { executor, gateway, advance } = setup();
    const { opId } = await executor.prepare(plan(assignStep));
    advance();
    await expect(executor.confirm({ opId })).rejects.toMatchObject({
      code: "PREVIEW_REQUIRED",
    });
    expect(gateway.write).not.toHaveBeenCalled();
    expect(executor.getOperation({ opId })).toMatchObject({
      status: "not_executed",
    });
  });

  it("SV-05 到期边界拒绝执行并保留回执", async () => {
    const { executor, gateway, advance } = setup();
    const { opId } = await executor.prepare(plan(createStep));
    advance(600_000);
    await expect(executor.confirm({ opId })).rejects.toMatchObject({
      code: "PLAN_EXPIRED",
    });
    expect(gateway.write).not.toHaveBeenCalled();
    expect(executor.getOperation({ opId })).toMatchObject({
      status: "not_executed",
    });
  });

  it.each([
    ["assignedTo", "bob"],
    ["status", "active"],
    ["plan", [5]],
    ["executions", [4]],
    ["lastEditedDate", start + 1000],
    ["spec", "新正文"],
  ])("SV-06 / SV-14 乐观锁检测 %s", async (key, value) => {
    const { executor, gateway, advance } = setup();
    const { opId } = await executor.prepare(plan(assignStep));
    gateway.readTarget.mockResolvedValueOnce({ ...story, [key]: value });
    advance();
    await expect(
      executor.confirm({ opId, previewAck: true }),
    ).rejects.toMatchObject({ code: "PLAN_STALE", details: { fields: [key] } });
    await expect(
      executor.confirm({ opId, previewAck: true }),
    ).rejects.toMatchObject({ code: "PLAN_STALE" });
    expect(gateway.write).not.toHaveBeenCalled();
  });

  it.each([
    ["story.linkExecution", {}, "CAPABILITY_UNVERIFIED"],
    ["bug.create", {}, "CAPABILITY_DISABLED"],
    [
      "story.create",
      { write: { disableCapabilities: ["story.create"] } },
      "CAPABILITY_DISABLED",
    ],
    ["story.delete", {}, "CAPABILITY_CLI_ONLY"],
  ])("SV-07 能力门禁 %s", async (action, config, code) => {
    const { executor, gateway } = setup({ config });
    await expect(
      executor.prepare(plan({ ...createStep, action })),
    ).rejects.toMatchObject({ code });
    expect(gateway.write).not.toHaveBeenCalled();
  });

  it("SV-08 忽略调用方级别，按影响判定 W2", async () => {
    const { executor } = setup();
    const callerPlan = { ...plan(assignStep), level: "W1" };
    expect(await executor.prepare(callerPlan)).toMatchObject({
      level: "W2",
      requiresPreviewAck: true,
    });
  });

  it("SV-09 strict-ai 将单条自建提升为 W2", async () => {
    const { executor, gateway } = setup({ config: { mode: "strict-ai" } });
    const { opId, level } = await executor.prepare(plan(createStep));
    expect(level).toBe("W2");
    await expect(executor.confirm({ opId })).rejects.toMatchObject({
      code: "PREVIEW_REQUIRED",
    });
    expect(gateway.write).not.toHaveBeenCalled();
  });

  it("SV-10 文件库重开后仍可查回执，同一数据库的其他账号不可见", async () => {
    const dir = mkdtempSync(join(tmpdir(), "bzt-executor-"));
    cleanups.push(() => rmSync(dir, { recursive: true }));
    const dbPath = join(dir, "state.db");
    const alice = setup({ dbPath });
    const { opId } = await alice.executor.prepare(plan(createStep));
    alice.store.cache.set("story:41", "alice", 60_000);
    alice.store.close();
    const reopened = setup({ dbPath });
    const bob = setup({ dbPath, account: "bob" });
    expect(reopened.executor.getOperation({ recent: 1 })).toMatchObject([
      { opId },
    ]);
    expect(bob.executor.getOperation({ recent: 1 })).toEqual([]);
    expect(() => bob.executor.getOperation({ opId })).toThrow(
      expect.objectContaining({ code: "NOT_FOUND" }),
    );
    await expect(bob.executor.confirm({ opId })).rejects.toMatchObject({
      code: "NOT_FOUND",
    });
    expect(bob.store.cache.get("story:41")).toBeUndefined();
    expect(reopened.store.cache.get("story:41")).toBe("alice");
  });

  it("SV-11 成功后失效相关缓存并读取新值", async () => {
    const { executor, gateway, store } = setup();
    store.cache.set("stories:29", "旧数据", 60000);
    store.cache.set("org", "目录", 60000);
    gateway.readback.mockImplementationOnce(async () => {
      expect(store.cache.get("stories:29")).toBeUndefined();
      return { verified: true };
    });
    const { opId } = await executor.prepare(
      plan({ ...createStep, cacheKeys: ["stories:29"] }),
    );
    await executor.confirm({ opId });
    const value = store.cache.get("stories:29") ?? "新数据";
    expect(value).toBe("新数据");
    expect(store.cache.get("org")).toBe("目录");
  });

  // SV-12 属于 docs/10 WP-37 的通知服务，操作执行器没有企微副作用。

  it("SV-13 最小确认时间使用配置，边界时允许确认", async () => {
    const { executor, gateway, advance } = setup({
      config: { write: { minConfirmDelaySeconds: 4 } },
    });
    const { opId } = await executor.prepare(plan(assignStep));
    advance(3999);
    await expect(
      executor.confirm({ opId, previewAck: true }),
    ).rejects.toMatchObject({ code: "PREVIEW_TOO_FAST" });
    expect(gateway.write).not.toHaveBeenCalled();
    advance(1);
    expect((await executor.confirm({ opId, previewAck: true })).status).toBe(
      "confirmed",
    );
  });

  it("保存创建 ID 后回读异常，恢复时只按原 ID 回读", async () => {
    const { executor, gateway, store } = setup();
    gateway.readback
      .mockRejectedValueOnce(new Error("private-response-body"))
      .mockResolvedValueOnce({ verified: false });
    const { opId } = await executor.prepare(plan(createStep));
    const result = await executor.confirm({ opId });
    expect(result).toMatchObject({
      status: "unknown",
      steps: [{ zentaoId: 41 }],
    });
    expect(JSON.stringify(store.operationSteps.get(opId, 1))).not.toContain(
      "private-response-body",
    );
    expect((await executor.resume({ opId })).status).toBe("confirmed");
    expect(gateway.write).toHaveBeenCalledTimes(1);
  });

  it("明确拒绝且没有成功步骤时返回 failed，失败创建不可重试", async () => {
    const { executor, gateway } = setup();
    gateway.write.mockRejectedValueOnce(denied());
    const { opId } = await executor.prepare(plan(createStep));
    expect((await executor.confirm({ opId })).status).toBe("failed");
    expect((await executor.resume({ opId })).status).toBe("failed");
    expect(gateway.write).toHaveBeenCalledTimes(1);
  });
});

describe("操作边界与恢复", () => {
  it("strict-ai 的只读操作仍为 W0", async () => {
    const { executor, gateway } = setup({ config: { mode: "strict-ai" } });
    const prepared = await executor.prepare(
      plan({ ...assignStep, action: "read" }),
    );
    expect(prepared).toMatchObject({
      level: "W0",
      requiresPreviewAck: false,
      expiresAt: "2026-11-24T01:10:00.000Z",
    });
    expect(prepared.opId).toMatch(/^op_[0-7][0-9A-HJKMNP-TV-Z]{25}$/u);
    expect((await executor.confirm({ opId: prepared.opId })).status).toBe(
      "confirmed",
    );
    expect(gateway.readTarget).toHaveBeenCalledTimes(1);
    expect(gateway.write).not.toHaveBeenCalled();
  });

  it("W0 读取异常返回失败回执", async () => {
    const { executor, gateway } = setup();
    gateway.readTarget.mockRejectedValueOnce(new Error("private-body"));
    const { opId } = await executor.prepare(
      plan({ ...assignStep, action: "read" }),
    );
    const result = await executor.confirm({ opId });
    expect(result.status).toBe("failed");
    expect(JSON.stringify(result)).not.toContain("private-body");
  });

  it("W3 只能由 CLI 显式确认", async () => {
    const { executor, gateway, store } = setup({ channel: "cli" });
    const { opId, level } = await executor.prepare(
      plan({ ...assignStep, action: "story.delete" }),
    );
    expect(level).toBe("W3");
    await expect(executor.confirm({ opId })).rejects.toMatchObject({
      code: "PREVIEW_REQUIRED",
    });
    const mcp = new OperationExecutor({
      baseUrl,
      store,
      gateway,
      clock: () => start,
      config: teamConfigSchema.parse({}),
    });
    await expect(mcp.confirm({ opId, previewAck: true })).rejects.toMatchObject(
      { code: "CAPABILITY_CLI_ONLY" },
    );
    expect(gateway.write).not.toHaveBeenCalled();
    expect((await executor.confirm({ opId, previewAck: true })).status).toBe(
      "confirmed",
    );
  });

  it.each(
    [
      plan({ ...assignStep, action: "invalid" }),
      plan(createStep, { ...assignStep, action: "read" }),
      plan({ ...createStep, fields: {} }),
      plan({ ...createStep, id: 9 }),
      plan({ ...assignStep, id: undefined }),
      plan({ ...assignStep, fromStep: 1 }),
      plan(createStep, {
        ...assignStep,
        id: undefined,
        fromStep: 1,
        product: 30,
      }),
      plan({ ...assignStep, product: 30 }),
      plan({ ...assignStep, cacheKeys: ["token:1"] }),
    ].map((input) => [input] as const),
  )("拒绝不合法计划 %#", async (input) => {
    const { executor, gateway } = setup();
    await expect(executor.prepare(input)).rejects.toMatchObject({
      code: "INVALID_INPUT",
    });
    expect(gateway.write).not.toHaveBeenCalled();
  });

  it("创建时直接带 plan 或实例版本不符均不能执行", async () => {
    const { executor } = setup();
    await expect(
      executor.prepare(
        plan({
          ...createStep,
          fields: { ...createStep.fields, plan: field("9") },
        }),
      ),
    ).rejects.toMatchObject({ code: "CAPABILITY_UNVERIFIED" });
    const wrong = setup({ instanceVersion: "23.0" });
    await expect(
      wrong.executor.prepare(plan(createStep)),
    ).rejects.toMatchObject({ code: "CAPABILITY_UNVERIFIED" });
  });

  it("确认时重新检查团队禁用配置和 strict-ai 模式", async () => {
    const { executor, store, gateway } = setup();
    const { opId } = await executor.prepare(plan(createStep));
    const options = { baseUrl, store, gateway, clock: () => start };
    const disabled = new OperationExecutor({
      ...options,
      config: teamConfigSchema.parse({
        write: { disableCapabilities: ["story.create"] },
      }),
    });
    await expect(disabled.confirm({ opId })).rejects.toMatchObject({
      code: "CAPABILITY_DISABLED",
    });
    const strict = new OperationExecutor({
      ...options,
      config: teamConfigSchema.parse({ mode: "strict-ai" }),
    });
    await expect(strict.confirm({ opId })).rejects.toMatchObject({
      code: "PREVIEW_REQUIRED",
    });
    expect(gateway.write).not.toHaveBeenCalled();
  });

  it("自指派和修改自己维护的关键词为 W1，多对象和影响他人为 W2", async () => {
    const { executor } = setup();
    expect(
      (
        await executor.prepare({
          ...plan({ ...assignStep, fields: { assignedTo: field("alice") } }),
          kind: "assign_story",
        })
      ).level,
    ).toBe("W1");
    expect(
      (
        await executor.prepare({
          ...plan({
            ...assignStep,
            action: "story.edit",
            fields: { keywords: field("版本:V1.0.0") },
          }),
          kind: "set_story_meta",
        })
      ).level,
    ).toBe("W1");
    expect(
      (
        await executor.prepare({
          ...plan({
            ...assignStep,
            action: "story.edit",
            fields: { spec: field("新正文") },
          }),
          kind: "set_story_meta",
        })
      ).level,
    ).toBe("W2");
    const own = {
      ...assignStep,
      id: undefined,
      fromStep: 1,
      fields: { assignedTo: field("alice") },
    };
    expect((await executor.prepare(plan(createStep, own))).level).toBe("W1");
    expect(
      (await executor.prepare(plan(createStep, { ...createStep, product: 30 })))
        .level,
    ).toBe("W2");
    expect(
      (
        await executor.prepare({
          ...plan(createStep),
          affects: ["alice 张三", "bob 李四"],
        })
      ).level,
    ).toBe("W2");
    expect(executor.getOperation({ recent: 2 })).toHaveLength(2);
    expect(executor.getOperation()).toHaveLength(6);
  });

  it("排除创建时一并跳过其后续指派", async () => {
    const { executor, gateway, advance } = setup();
    const { opId } = await executor.prepare(
      plan(createStep, { ...assignStep, id: undefined, fromStep: 1 }),
    );
    advance();
    await expect(
      executor.confirm({ opId, previewAck: true, excludeSteps: [3] }),
    ).rejects.toMatchObject({ code: "INVALID_INPUT" });
    const result = await executor.confirm({
      opId,
      previewAck: true,
      excludeSteps: [1],
    });
    expect(result).toMatchObject({
      status: "not_executed",
      steps: [{ state: "skipped" }, { state: "skipped" }],
    });
    expect(await executor.resume({ opId, previewAck: true })).toEqual(result);
    expect(gateway.write).not.toHaveBeenCalled();
  });

  it("预检读取失败可重新确认，计划和执行列表按集合比较", async () => {
    const { executor, gateway, advance } = setup();
    const { opId } = await executor.prepare(plan(assignStep));
    advance();
    gateway.readTarget
      .mockRejectedValueOnce(timeout())
      .mockResolvedValueOnce({ ...story, executions: [4, 3, 3] });
    await expect(
      executor.confirm({ opId, previewAck: true }),
    ).rejects.toMatchObject({ code: "ZENTAO_UNAVAILABLE" });
    expect(executor.getOperation({ opId }).status).toBe("not_executed");
    expect((await executor.confirm({ opId, previewAck: true })).status).toBe(
      "confirmed",
    );
  });

  it("预检对象已删除时作废计划", async () => {
    const { executor, gateway, advance } = setup();
    const { opId } = await executor.prepare(plan(assignStep));
    gateway.readTarget.mockRejectedValueOnce(
      new BztError("NOT_FOUND", "不存在。"),
    );
    advance();
    await expect(
      executor.confirm({ opId, previewAck: true }),
    ).rejects.toMatchObject({
      code: "PLAN_STALE",
      details: { fields: ["id"] },
    });
  });

  it("自身已核对的写入更新恢复基线，正文只保存哈希", async () => {
    const { executor, gateway, store, advance } = setup();
    const updated = {
      ...story,
      assignedTo: "bob",
      lastEditedDate: start + 3000,
    };
    gateway.write
      .mockResolvedValueOnce({ id: 9 })
      .mockRejectedValueOnce(denied());
    gateway.readback.mockResolvedValueOnce({
      verified: true,
      snapshot: updated,
    });
    const { opId } = await executor.prepare(
      plan(assignStep, { ...assignStep, action: "story.close", fields: {} }),
    );
    expect(store.operations.get(opId).planJson).not.toContain(story.spec);
    advance();
    expect((await executor.confirm({ opId, previewAck: true })).status).toBe(
      "partial",
    );
    expect(store.operationSteps.get(opId, 1).readbackJson).not.toContain(
      story.spec,
    );
    gateway.readTarget.mockResolvedValueOnce(updated);
    expect((await executor.resume({ opId, previewAck: true })).status).toBe(
      "confirmed",
    );
  });

  it.each([
    { complete: false, matches: [candidate] },
    { complete: true, matches: [candidate, { ...candidate, id: 42 }] },
    {
      complete: true,
      matches: [
        { ...candidate, title: "其他" },
        { ...candidate, product: 30 },
        { ...candidate, createdAt: start - 1 },
        { ...candidate, createdAt: start + 1 },
      ],
    },
  ])("反查需要完整、唯一且特征匹配的结果", async (lookup) => {
    const { executor, gateway } = setup();
    gateway.write.mockRejectedValueOnce(timeout());
    gateway.reverseLookup.mockResolvedValueOnce(lookup);
    const { opId } = await executor.prepare(plan(createStep));
    expect((await executor.confirm({ opId })).status).toBe("unknown");
    expect(gateway.readback).not.toHaveBeenCalled();
  });

  it("创建回执缺 ID、首次反查失败后可继续核对", async () => {
    const { executor, gateway } = setup();
    gateway.write.mockResolvedValueOnce({});
    gateway.reverseLookup
      .mockRejectedValueOnce(new Error("读取失败"))
      .mockResolvedValueOnce({ complete: true, matches: [candidate] });
    const { opId } = await executor.prepare(plan(createStep));
    expect((await executor.confirm({ opId })).status).toBe("unknown");
    expect((await executor.resume({ opId })).status).toBe("confirmed");
    expect(gateway.write).toHaveBeenCalledTimes(1);
  });

  it("文件库两个独立连接并发确认只派发一次", async () => {
    const dir = mkdtempSync(join(tmpdir(), "bzt-executor-"));
    cleanups.push(() => rmSync(dir, { recursive: true }));
    const dbPath = join(dir, "state.db");
    const first = setup({ dbPath });
    const other = setup({ dbPath });
    const sent = Promise.withResolvers<void>();
    const written = Promise.withResolvers<{ id: number }>();
    first.gateway.write.mockImplementationOnce(() => {
      sent.resolve();
      return written.promise;
    });
    const { opId } = await first.executor.prepare(plan(createStep));
    const confirmation = first.executor.confirm({ opId });
    await sent.promise;
    try {
      await expect(first.executor.resume({ opId })).rejects.toMatchObject({
        code: "INVALID_INPUT",
      });
      await expect(other.executor.resume({ opId })).rejects.toMatchObject({
        code: "INVALID_INPUT",
      });
      expect(other.executor.getOperation({ opId }).status).toBe("unknown");
    } finally {
      written.resolve({ id: 41 });
      await confirmation;
    }
    expect((await other.executor.resume({ opId })).status).toBe("confirmed");
    expect(other.gateway.write).not.toHaveBeenCalled();
    expect(first.gateway.write).toHaveBeenCalledTimes(1);
  });
});

it("进程重开后从发送前的持久化检查点反查，无创建重发", async () => {
  const dir = mkdtempSync(join(tmpdir(), "bzt-resume-"));
  cleanups.push(() => rmSync(dir, { recursive: true }));
  const dbPath = join(dir, "state.db");
  const first = setup({ dbPath });
  const { opId } = await first.executor.prepare(
    plan({ ...createStep, action: "story.create.feedbackBy" }),
  );
  first.store.operations.updateStatus(opId, {
    status: "not_executed",
    executedAt: start,
  });
  first.store.operationSteps.update(opId, 1, {
    state: "unknown",
    readbackJson: JSON.stringify({ attemptedAt: start }),
  });
  first.store.close();
  const reopened = setup({ dbPath });
  reopened.gateway.reverseLookup.mockResolvedValueOnce({
    complete: true,
    matches: [candidate],
  });
  expect(reopened.executor.getOperation({ opId }).status).toBe("unknown");
  expect((await reopened.executor.resume({ opId })).status).toBe("confirmed");
  expect(reopened.gateway.write).not.toHaveBeenCalled();
});

it("前序失败时仍保留用户排除的批量步骤", async () => {
  const { executor, gateway, advance } = setup();
  const { opId } = await executor.prepare(plan(assignStep, createStep));
  gateway.write.mockRejectedValueOnce(denied());
  advance();
  const result = await executor.confirm({
    opId,
    previewAck: true,
    excludeSteps: [2],
  });
  expect(result.steps[1]?.state).toBe("skipped");
  await expect(
    executor.resume({ opId, previewAck: true, excludeSteps: [1] }),
  ).rejects.toMatchObject({ code: "INVALID_INPUT" });
  expect((await executor.resume({ opId, previewAck: true })).status).toBe(
    "confirmed",
  );
  expect(
    gateway.write.mock.calls.map(([request]) => request.step.action),
  ).toEqual(["story.assign", "story.assign"]);
});

it("不接受错对象的回读，已有 ID 的恢复只核对同一对象", async () => {
  const { executor, gateway } = setup();
  gateway.readback
    .mockResolvedValueOnce({ verified: true, snapshot: { ...story, id: 99 } })
    .mockResolvedValueOnce({ verified: false });
  const { opId } = await executor.prepare(plan(createStep));
  expect((await executor.confirm({ opId })).status).toBe("unknown");
  expect((await executor.resume({ opId })).status).toBe("confirmed");
  expect(
    gateway.readback.mock.calls.map(([request]) => request.zentaoId),
  ).toEqual([41, 41, 41]);
  expect(gateway.write).toHaveBeenCalledTimes(1);
});

it("预检途中到期也禁止发送写请求", async () => {
  const { executor, gateway, advance } = setup();
  const { opId } = await executor.prepare(plan(assignStep));
  advance(599_999);
  gateway.readTarget.mockImplementationOnce(async () => {
    advance(1);
    return story;
  });
  await expect(
    executor.confirm({ opId, previewAck: true }),
  ).rejects.toMatchObject({ code: "PLAN_EXPIRED" });
  expect(gateway.write).not.toHaveBeenCalled();
});
