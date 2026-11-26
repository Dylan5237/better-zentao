import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { setImmediate as nextTurn } from "node:timers/promises";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { z } from "zod";
import { teamConfigSchema } from "../../src/core/config.ts";
import { BztError } from "../../src/core/errors.ts";
import { LocalStore, openLocalStore } from "../../src/core/store/index.ts";
import { NotifyService } from "../../src/services/notify.ts";
import { OperationExecutor } from "../../src/services/operation.ts";
import type {
  OperationGateway,
  OperationPlan,
  OperationTargetSnapshot,
} from "../../src/services/operation.ts";
import { createWorkbench } from "../../src/services/workbench.ts";

const instanceA = "https://instance-a.example.test/";
const instanceB = "https://instance-b.example.test/";
const accountA = "acct_a";
const accountB = "acct_b";
const initialTime = Date.UTC(2026, 10, 24, 1);
const storyId = 101;
const cacheKey = "story:101";
const story = {
  id: storyId,
  type: "story",
  product: 29,
  status: "draft",
  assignedTo: accountA,
  lastEditedDate: initialTime,
} satisfies OperationTargetSnapshot;

let folder: string;
let now: number;
const clock = () => now;
const stores: LocalStore[] = [];
const unexpectedFetch = vi.fn<typeof fetch>(() => {
  throw new Error("离线测试误用了全局 fetch");
});

beforeEach(() => {
  folder = mkdtempSync(join(tmpdir(), "bzt-server-write-"));
  now = initialTime;
  unexpectedFetch.mockClear();
  vi.stubGlobal("fetch", unexpectedFetch);
});

afterEach(() => {
  try {
    expect(unexpectedFetch).not.toHaveBeenCalled();
  } finally {
    vi.restoreAllMocks();
    vi.unstubAllGlobals();
    for (const store of stores.splice(0).reverse()) store.close();
    rmSync(folder, { recursive: true, force: true });
  }
});

function assignment(to: string): OperationPlan["steps"][number] {
  return {
    action: "story.assign",
    type: "story",
    id: storyId,
    product: story.product,
    fields: { assignedTo: { value: to, origin: "user" } },
    cacheKeys: [cacheKey],
  };
}

function plan(...steps: OperationPlan["steps"]): OperationPlan {
  return { kind: "assign_story", summary: "指派测试需求", steps };
}

function open(baseUrl: string, account: string, filename: string) {
  const store = openLocalStore({
    dbPath: join(folder, filename),
    baseUrl,
    account,
    clock,
  });
  stores.push(store);
  return store;
}

function fakeGateway() {
  let snapshot = { ...story };
  const readTarget = vi.fn<OperationGateway["readTarget"]>(
    async () => snapshot,
  );
  const apply = async ({
    step,
    id,
  }: Parameters<OperationGateway["write"]>[0]) => {
    const assignedTo = z.string().parse(step.fields.assignedTo?.value);
    snapshot = { ...snapshot, assignedTo, lastEditedDate: now };
    return { id };
  };
  const write = vi.fn<OperationGateway["write"]>(apply);
  const verify = async () => ({ verified: true, snapshot });
  const readback = vi.fn<OperationGateway["readback"]>(verify);
  const reverseLookup = vi
    .fn<OperationGateway["reverseLookup"]>()
    .mockResolvedValue({ complete: true, matches: [] });
  return {
    gateway: { readTarget, write, readback, reverseLookup },
    apply,
    verify,
    snapshot: () => snapshot,
  };
}

// 其余写入用例在协调器文件尚未落地时也能独立进入断言。
async function newCoordinator() {
  const { createTargetWriteCoordinator } =
    await import("../../src/services/write-coordinator.ts");
  return createTargetWriteCoordinator();
}

function executor(
  baseUrl: string,
  store: LocalStore,
  gateway: OperationGateway,
  writeCoordinator?: Awaited<ReturnType<typeof newCoordinator>>,
) {
  const options = {
    baseUrl,
    store,
    gateway,
    clock,
    config: teamConfigSchema.parse({}),
    ...(writeCoordinator === undefined ? {} : { writeCoordinator }),
  };
  return new OperationExecutor(options);
}

describe("SRV-CONC-01 跨账号目标写协调", () => {
  it("并发提交相反顺序的目标集合时不会形成死锁", async () => {
    const coordinator = await newCoordinator();
    const firstTarget = { type: "story", id: 1 } as const;
    const secondTarget = { type: "story", id: 2 } as const;
    const blocked = Promise.withResolvers<void>();
    const first = vi.fn(async () => {
      await blocked.promise;
      return "first";
    });
    const second = vi.fn(async () => "second");
    const work = Promise.all([
      coordinator.withTargets("instance-a", [firstTarget, secondTarget], first),
      coordinator.withTargets(
        "instance-a",
        [secondTarget, firstTarget],
        second,
      ),
    ]);
    const settled = Promise.allSettled([work]);
    try {
      await vi.waitFor(() => expect(first).toHaveBeenCalledOnce());
      expect(second).not.toHaveBeenCalled();
    } finally {
      blocked.resolve();
    }
    await expect(work).resolves.toEqual(["first", "second"]);
    await settled;
  });

  it("两个账号同时确认 #101 时只派发首笔，第二笔在锁内重检后返回 PLAN_STALE", async () => {
    const coordinator = await newCoordinator();
    const upstream = fakeGateway();
    const a = open(instanceA, accountA, "a.db");
    const b = open(instanceA, accountB, "b.db");
    const secondRead = vi.fn(upstream.gateway.readTarget);
    const first = executor(instanceA, a, upstream.gateway, coordinator);
    const second = executor(
      instanceA,
      b,
      {
        ...upstream.gateway,
        readTarget: secondRead,
      },
      coordinator,
    );
    const firstPlan = await first.prepare(plan(assignment(accountB)));
    const secondPlan = await second.prepare(plan(assignment("acct_other")));
    secondRead.mockClear();
    now += 3001;

    const releaseWrite = Promise.withResolvers<void>();
    const releaseReadback = Promise.withResolvers<void>();
    upstream.gateway.write.mockImplementationOnce(async (request) => {
      await releaseWrite.promise;
      return upstream.apply(request);
    });
    upstream.gateway.readback.mockImplementationOnce(async () => {
      await releaseReadback.promise;
      return upstream.verify();
    });

    const work = [first.confirm({ opId: firstPlan.opId, previewAck: true })];
    let outcomes: PromiseSettledResult<Awaited<(typeof work)[number]>>[];
    try {
      await vi.waitFor(() =>
        expect(upstream.gateway.write).toHaveBeenCalledOnce(),
      );
      work.push(second.confirm({ opId: secondPlan.opId, previewAck: true }));
      // 预检只有已解析的假网关 Promise，给第二笔机会运行至锁边界。
      void work[1]?.catch(() => undefined);
      await nextTurn();
      expect.soft(secondRead).not.toHaveBeenCalled();
      releaseWrite.resolve();
      await vi.waitFor(() =>
        expect(upstream.gateway.readback).toHaveBeenCalledOnce(),
      );
      expect.soft(secondRead).not.toHaveBeenCalled();
    } finally {
      releaseWrite.resolve();
      releaseReadback.resolve();
      outcomes = await Promise.allSettled(work);
    }
    expect(outcomes).toMatchObject([
      { status: "fulfilled", value: { status: "confirmed" } },
      { status: "rejected", reason: { code: "PLAN_STALE" } },
    ]);
    expect(secondRead).toHaveBeenCalledOnce();
    expect(upstream.gateway.write).toHaveBeenCalledTimes(1);
    expect(upstream.snapshot().assignedTo).toBe(accountB);
  });

  it("两个实例上同号需求的确认可独立完成", async () => {
    const coordinator = await newCoordinator();
    const a = fakeGateway();
    const b = fakeGateway();
    const first = executor(
      instanceA,
      open(instanceA, accountA, "a.db"),
      a.gateway,
      coordinator,
    );
    const second = executor(
      instanceB,
      open(instanceB, accountA, "b.db"),
      b.gateway,
      coordinator,
    );
    const firstPlan = await first.prepare(plan(assignment(accountB)));
    const secondPlan = await second.prepare(plan(assignment("acct_other")));
    now += 3001;

    const blocked = Promise.withResolvers<void>();
    a.gateway.write.mockImplementationOnce(async (request) => {
      await blocked.promise;
      return a.apply(request);
    });
    const pending = first.confirm({ opId: firstPlan.opId, previewAck: true });
    const work = [pending];
    let independentResult: unknown;
    try {
      await vi.waitFor(() => expect(a.gateway.write).toHaveBeenCalledOnce());
      work.push(
        second
          .confirm({ opId: secondPlan.opId, previewAck: true })
          .then((receipt) => {
            independentResult = receipt;
            return receipt;
          }),
      );
      await vi.waitFor(() =>
        expect(independentResult).toMatchObject({ status: "confirmed" }),
      );
    } finally {
      blocked.resolve();
      await Promise.allSettled(work);
    }
    await expect(pending).resolves.toMatchObject({ status: "confirmed" });
    expect(a.gateway.write).toHaveBeenCalledTimes(1);
    expect(b.gateway.write).toHaveBeenCalledTimes(1);
    expect(a.snapshot().assignedTo).toBe(accountB);
    expect(b.snapshot().assignedTo).toBe("acct_other");
  });
});

describe("SRV-OP-04 写入阶段与持久化检查点", () => {
  it("发送前的 AUTH_FAILED 明确标记为 failed", async () => {
    const { gateway } = fakeGateway();
    const store = open(instanceA, accountA, "state.db");
    const service = executor(instanceA, store, gateway);
    const { opId } = await service.prepare(plan(assignment(accountB)));
    now += 3001;
    gateway.write.mockRejectedValueOnce(
      new BztError("AUTH_FAILED", "合成认证失败", { phase: "pre_send" }),
    );

    expect(await service.confirm({ opId, previewAck: true })).toMatchObject({
      status: "failed",
      steps: [{ state: "failed" }],
    });
    expect(store.operationSteps.get(opId, 1).state).toBe("failed");
    expect(gateway.readback).not.toHaveBeenCalled();
  });

  it.each(["post_send", undefined] as const)(
    "派发后或发送阶段不明的 AUTH_FAILED（%s）保留 unknown，不会重发",
    async (phase) => {
      const { gateway } = fakeGateway();
      const store = open(instanceA, accountA, "state.db");
      const service = executor(instanceA, store, gateway);
      const { opId } = await service.prepare(plan(assignment(accountB)));
      now += 3001;
      store.cache.set(cacheKey, "stale-value", 60_000);
      gateway.write.mockRejectedValueOnce(
        new BztError(
          "AUTH_FAILED",
          "合成认证失败",
          phase ? { phase } : undefined,
        ),
      );
      gateway.readback.mockResolvedValue({ verified: false });

      const receipt = await service.confirm({ opId, previewAck: true });
      expect.soft(receipt).toMatchObject({
        status: "unknown",
        steps: [{ state: "unknown" }],
      });
      const step = store.operationSteps.get(opId, 1);
      expect.soft(step.state).toBe("unknown");
      expect(JSON.parse(step.readbackJson ?? "{}")).toMatchObject({
        attemptedAt: now,
      });
      expect.soft(store.cache.get(cacheKey)).toBeUndefined();
      expect
        .soft(await service.resume({ opId, previewAck: true }))
        .toMatchObject({
          status: "unknown",
          steps: [{ state: "unknown" }],
        });
      expect(gateway.write).toHaveBeenCalledTimes(1);
    },
  );

  it("prepare 插入第二步失败时，中间记录从未对外可见且全部回滚", async () => {
    const { gateway } = fakeGateway();
    const initialized = open(instanceA, accountA, "state.db");
    initialized.close();
    const { location } = initialized;
    using observer = new DatabaseSync(location.dbPath, { readOnly: true });
    const operations = observer.prepare(
      "SELECT COUNT(*) AS count FROM operations",
    );
    const steps = observer.prepare(
      "SELECT COUNT(*) AS count FROM operation_steps",
    );
    const readCounts = () => [operations.get()?.count, steps.get()?.count];
    using connection = new DatabaseSync(location.dbPath);
    const store = new LocalStore(connection, location, clock);
    const visibleDuringPrepare: ReturnType<typeof readCounts>[] = [];
    connection.function("observe_partial_prepare", () => {
      visibleDuringPrepare.push(readCounts());
      return 0;
    });
    connection.exec(`
      CREATE TRIGGER reject_second_step BEFORE INSERT ON operation_steps
      WHEN NEW.seq = 2 BEGIN
        SELECT observe_partial_prepare();
        SELECT RAISE(ABORT, 'synthetic step insert failure');
      END
    `);

    const service = executor(instanceA, store, gateway);
    await expect(
      service.prepare(plan(assignment(accountB), assignment("acct_other"))),
    ).rejects.toMatchObject({ name: "BztError" });
    expect(readCounts()).toEqual([0, 0]);
    expect(visibleDuringPrepare).toEqual([[0, 0]]);
    expect(gateway.write).not.toHaveBeenCalled();
  });
});

it("SRV-OP-03 Workbench 重放已确认操作时保持回执且不再通知", async () => {
  const configPath = join(folder, "team.json");
  writeFileSync(
    configPath,
    JSON.stringify({
      products: { 29: { name: "离线测试产品", state: "runtime" } },
      notify: { events: ["assign_other"], quietHours: ["00:00", "00:00"] },
    }),
  );
  const webhookUrl =
    "https://wecom.example.test/cgi-bin/webhook/send?key=synthetic-webhook";
  const users = [
    {
      id: 1,
      account: accountA,
      realname: "测试设计",
      role: "design",
      dept: 0,
      deleted: false,
    },
    {
      id: 2,
      account: accountB,
      realname: "测试开发",
      role: "dev",
      dept: 0,
      deleted: false,
    },
  ];
  const responseStory = {
    ...story,
    lastEditedDate: "2026-11-24 09:00:00",
    title: "测试需求",
    module: 3,
    category: "feature",
    openedBy: accountA,
    openedDate: "2026-11-24 08:00:00",
  };
  const sendNotification = vi.fn(() =>
    Response.json({ errcode: 0, errmsg: "ok" }),
  );
  const sendAssignment = vi.fn(() => {
    responseStory.assignedTo = accountB;
    return Response.json(responseStory);
  });
  const fetcher = vi.fn<typeof fetch>(async (request, init) => {
    const url = new URL(String(request));
    if (url.href === webhookUrl && init?.method === "POST")
      return sendNotification();
    if (url.origin !== new URL(instanceA).origin)
      throw new Error("离线测试收到预期外地址");
    switch (url.pathname) {
      case "/api.php/v1/tokens":
        return Response.json(
          { token: "synthetic-workbench-token" },
          { status: 201 },
        );
      case "/index.php":
        return Response.json({ version: "22.6", URAndSR: true });
      case "/api.php/v1/user":
        return Response.json({ profile: users[0] });
      case "/api.php/v2/users":
        return Response.json({ users });
      case "/api.php/v1/stories/101":
        return Response.json(responseStory);
      case "/api.php/v1/stories/101/assign":
        return sendAssignment();
      default:
        throw new Error("离线测试收到预期外禅道请求");
    }
  });
  vi.stubGlobal("fetch", fetcher);
  const notify = vi.spyOn(NotifyService.prototype, "notifyEvent");
  const workbench = await createWorkbench({
    homeDir: folder,
    clock,
    logSink: () => undefined,
    env: {
      BZT_HOME: folder,
      BZT_CONFIG: configPath,
      ZENTAO_BASE_URL: instanceA,
      ZENTAO_ACCOUNT: accountA,
      ZENTAO_PASSWORD: "synthetic-workbench-password",
      BZT_WECOM_WEBHOOK: webhookUrl,
    },
  }).get();
  try {
    const { opId } = await workbench.assignStory({
      storyIds: [storyId],
      to: accountB,
      notify: true,
    });
    now += 3001;
    const input = { opId, previewAck: true };
    const receipt = await workbench.confirmOperation(input);
    expect(receipt).toMatchObject({
      opId,
      status: "confirmed",
      notified: [{ target: accountB, channel: "wecom", state: "sent" }],
    });
    expect(sendNotification).toHaveBeenCalledTimes(1);

    // 通知层按天去重。跨日重放验证 Workbench 自身守住同一操作的边界。
    now += 86_400_000;
    expect(await workbench.confirmOperation(input)).toMatchObject({
      opId,
      status: receipt.status,
      steps: receipt.steps,
    });
    expect(sendAssignment).toHaveBeenCalledTimes(1);
    expect.soft(sendNotification).toHaveBeenCalledTimes(1);
    expect(notify).toHaveBeenCalledTimes(1);
  } finally {
    workbench.close();
  }
});
