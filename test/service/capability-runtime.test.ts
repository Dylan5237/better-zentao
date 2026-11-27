import { writeFile } from "node:fs/promises";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  createZentaoReadClient,
  revokeZentaoReadClient,
} from "../../src/api/client.ts";
import { writeStory } from "../../src/api/story-write.ts";
import { hashText } from "../../src/services/server-runtime.ts";
import {
  createCapabilityRuntime,
  type TrustedPrincipal,
} from "../../src/services/capability-runtime.ts";
import {
  assignment,
  browser,
  confirmation,
  login,
  operation,
  storyPath,
  useServerFixture,
} from "../helpers/server-fixture.ts";

/**
 * CR-009 §9.1 CAP-01 / CAP-02 / SRV-OP-03：
 * 统一能力调度的跨渠道一致性（含角色工具白名单与参数收窄）、
 * 集中端在途撤权零写入，以及终态重放零上游调用。
 */

afterEach(() => {
  vi.restoreAllMocks();
});

function principalOf(
  overrides: Partial<TrustedPrincipal> = {},
): TrustedPrincipal {
  return {
    instanceId: "instanceA",
    instanceHash: "hash-a",
    account: "dev",
    sessionId: "session-1",
    roles: ["RM"],
    configVersion: "v1",
    readOnly: false,
    ...overrides,
  };
}

function runtimeOf(
  options: {
    principal?: TrustedPrincipal;
    channel?: "gui" | "ai" | "mcp" | "cli";
    execute?: (tool: string, input: unknown, role: string) => Promise<unknown>;
    readRoles?: () => Promise<
      readonly { id: TrustedPrincipal["roles"][number] }[]
    >;
    isRevoked?: () => boolean;
  } = {},
) {
  const principal = options.principal ?? principalOf();
  const execute =
    options.execute ??
    vi.fn(async () => ({
      ok: true,
      data: {
        ok: true,
        opId: "op_00000000000000000000000099",
        status: "not_executed",
        steps: [],
        created: [],
      },
      scope: { asOf: "2026-11-24T04:00:00.000Z", filters: {} },
      completeness: "complete",
      gaps: [],
      inferences: [],
    }));
  return {
    execute,
    runtime: createCapabilityRuntime({
      principal,
      channel: options.channel ?? "gui",
      execute,
      ...(options.readRoles ? { readRoles: options.readRoles } : {}),
      ...(options.isRevoked ? { isRevoked: options.isRevoked } : {}),
    }),
  };
}

// ---------------------------------------------------------------------------
// CAP-01：跨渠道一致性与单一角色/范围收窄策略
// ---------------------------------------------------------------------------

describe("CAP-01 CapabilityRuntime 跨渠道一致性", () => {
  it("AI 渠道无条件拒绝 confirm_operation（即便 previewAck=true）", async () => {
    const { execute, runtime } = runtimeOf({ channel: "ai" });
    await expect(
      runtime.invoke("RM", "confirm_operation", {
        opId: "op_00000000000000000000000001",
        previewAck: true,
      }),
    ).rejects.toMatchObject({
      code: "PERMISSION_DENIED",
      message: "AI 助手不能代为确认或执行写入，请交由用户人工确认预览。",
    });
    expect(execute).not.toHaveBeenCalled();
  });

  it("AI 渠道 W1 级别同样拒绝（携带 opId 与 previewAck）", async () => {
    const { execute, runtime } = runtimeOf({ channel: "ai" });
    await expect(
      runtime.invoke("RM", "confirm_operation", {
        opId: "op_00000000000000000000000002",
        previewAck: true,
        resume: true,
      }),
    ).rejects.toMatchObject({ code: "PERMISSION_DENIED" });
    expect(execute).not.toHaveBeenCalled();
  });

  it("AI 渠道仍可执行只读工具（get_operation）", async () => {
    const { runtime } = runtimeOf({ channel: "ai" });
    const value = await runtime.invoke("RM", "get_operation", {
      opId: "op_00000000000000000000000003",
    });
    expect(value).toMatchObject({ ok: true });
  });

  it("readOnly 主体拒绝全部写入工具", async () => {
    const { execute, runtime } = runtimeOf({
      principal: principalOf({ readOnly: true }),
    });
    await expect(
      runtime.invoke("RM", "assign_story", {
        storyIds: [31],
        to: "other",
        notify: false,
      }),
    ).rejects.toMatchObject({
      code: "PERMISSION_DENIED",
      message: "当前服务处于只读模式。",
    });
    expect(execute).not.toHaveBeenCalled();
  });

  it("未授权职责（角色不在 principal.roles）拒绝", async () => {
    const { execute, runtime } = runtimeOf({
      principal: principalOf({ roles: ["FB"] }),
    });
    await expect(
      runtime.invoke("RM", "query_stories", { product: "29" }),
    ).rejects.toMatchObject({ code: "PERMISSION_DENIED" });
    expect(execute).not.toHaveBeenCalled();
  });

  it.each(["gui", "ai"] as const)(
    "%s 渠道统一执行 rolePages 白名单与 FB/RD 范围收窄",
    async (channel) => {
      const seen: Array<{ tool: string; input: unknown; role: string }> = [];
      const fbRuntime = createCapabilityRuntime({
        principal: principalOf({ roles: ["FB"], account: "fb-user" }),
        channel,
        execute: async (tool, input, role) => {
          seen.push({ tool, input, role });
          if (tool === "get_my_work") {
            return {
              ok: true,
              data: {
                new: [],
                action: {
                  overdue: [],
                  dueToday: [],
                  dueSoon: [],
                  unscheduled: [],
                  toReceive: [],
                  toReview: [],
                },
                waiting_ready: [],
                maintained: [],
                raised: [],
                can_start: {
                  tests: [],
                  upcomingTests: [],
                  acceptDeliver: [],
                },
              },
              scope: { asOf: "2026-11-24T04:00:00.000Z", filters: {} },
              completeness: "complete",
              gaps: [],
              inferences: [],
            };
          }
          return {
            ok: true,
            data: { items: [], countsByProgress: {} },
            scope: { asOf: "2026-11-24T04:00:00.000Z", filters: {} },
            completeness: "complete",
            gaps: [],
            inferences: [],
          };
        },
      });
      // FB 调用未授权工具（assign_story）必须被拒。
      await expect(
        fbRuntime.invoke("FB", "assign_story", {
          storyIds: [31],
          to: "other",
          notify: false,
        }),
      ).rejects.toMatchObject({ code: "PERMISSION_DENIED" });

      // FB 调用 get_my_work 强制收窄 markSeen=false、groups=["raised"]。
      await fbRuntime.invoke("FB", "get_my_work", {
        markSeen: true,
        groups: ["new", "raised"],
      });
      expect(seen.at(-1)).toMatchObject({
        tool: "get_my_work",
        role: "FB",
        input: { markSeen: false, groups: ["raised"] },
      });

      // FB 调用 query_stories 强制收窄 role="raised", who=account。
      await fbRuntime.invoke("FB", "query_stories", {
        role: "assigned",
        who: "someone-else",
      });
      expect(seen.at(-1)).toMatchObject({
        tool: "query_stories",
        role: "FB",
        input: { role: "raised", who: "fb-user" },
      });

      // RD 调用 get_team_work：非 all_open 拒绝；all_open 强制收窄为本人并清除 team。
      const rdCalls: unknown[] = [];
      const rdRuntime = createCapabilityRuntime({
        principal: principalOf({ roles: ["RD"], account: "rd-user" }),
        channel,
        execute: async (_tool, input) => {
          rdCalls.push(input);
          return {
            ok: true,
            data: {
              groups: [],
              totals: { overdue: 0, dueSoon: 0, open: 0 },
            },
            scope: { asOf: "2026-11-24T04:00:00.000Z", filters: {} },
            completeness: "complete",
            gaps: [],
            inferences: [],
          };
        },
      });
      await expect(
        rdRuntime.invoke("RD", "get_team_work", {
          team: "dev",
          view: "overdue",
        }),
      ).rejects.toMatchObject({ code: "PERMISSION_DENIED" });
      await rdRuntime.invoke("RD", "get_team_work", {
        team: "dev",
        members: ["other"],
        view: "all_open",
      });
      expect(rdCalls.at(-1)).toEqual({
        view: "all_open",
        members: ["rd-user"],
      });
    },
  );

  it("未知工具与参数不合法分别拒绝", async () => {
    const { runtime } = runtimeOf();
    await expect(
      runtime.invoke("RM", "no_such_tool", {}),
    ).rejects.toMatchObject({ code: "INVALID_INPUT" });
    await expect(
      runtime.invoke("RM", "query_stories", { nonsense: true }),
    ).rejects.toMatchObject({ code: "INVALID_INPUT" });
  });

  it("会话撤销后拒绝调用（授权先于缓存）", async () => {
    const { execute, runtime } = runtimeOf({
      isRevoked: () => true,
    });
    await expect(
      runtime.invoke("RM", "query_stories", { product: "29" }),
    ).rejects.toMatchObject({ code: "AUTH_FAILED" });
    expect(execute).not.toHaveBeenCalled();
  });

  it("readRoles 动态重读使在途撤销即时生效", async () => {
    let roles: readonly { id: "RM" }[] = [{ id: "RM" }];
    const { execute, runtime } = runtimeOf({
      readRoles: () => Promise.resolve(roles),
    });
    await expect(
      runtime.invoke("RM", "get_operation", {
        opId: "op_00000000000000000000000004",
      }),
    ).resolves.toMatchObject({ ok: true });
    roles = [];
    await expect(
      runtime.invoke("RM", "query_stories", { product: "29" }),
    ).rejects.toMatchObject({ code: "PERMISSION_DENIED" });
    expect(execute).toHaveBeenCalledTimes(1);
  });
});

// ---------------------------------------------------------------------------
// CAP-02 & SRV-OP-03：真实集中端（startServer + fake-zentao）端到端集成验证
// ---------------------------------------------------------------------------

describe("CAP-02 / SRV-OP-03 集中端在途撤权与终态零上游重放", () => {
  const fixture = useServerFixture();

  it("配置版本变化（hashText 口径）可被在途重验识别", () => {
    const v1 = hashText("team-doc-v1");
    const v2 = hashText("team-doc-v2");
    expect(v1).not.toBe(v2);
    expect(v1).toMatch(/^[0-9a-f]{64}$/u);
  });

  it("CAP-02：进入网关目标回读之后撤销团队职责，HTTP 最终发送前阻断且零上游写入", async () => {
    const server = await fixture.start({ readOnly: false });
    const alice = browser(server);
    await login(alice, "instanceA", "alice");

    const prepared = await alice.call(assignment);
    expect(prepared.status).toBe(200);
    const opId = (prepared.body as { opId: string }).opId;
    expect(opId).toMatch(/^op_/u);
    fixture.advance(3_100);

    // 第一次 GET /stories/101 属于 checkTargets；放行后立即挂起第二次
    // （位于 zentao-gateway.ts readStory 之后、writeStory/HTTP 发送之前）。
    const checkTargetsPause = fixture.upstream().pauseNextDetail();
    const confirmPromise = alice.call(confirmation(opId));
    await checkTargetsPause.started;

    const gatewayReadPause = fixture.upstream().pauseNextDetail();
    checkTargetsPause.release();
    await gatewayReadPause.started;

    // 此时 OperationExecutor.assertBeforeDispatch 已通过，正在网关内等待回读；
    // 管理员在此窗口中撤销 alice 的 RM 职责。
    await writeFile(
      fixture.teamPath("instanceA"),
      JSON.stringify({ roles: { RM: ["bob"], RD: ["alice", "bob"] } }),
    );
    gatewayReadPause.release();

    const result = await confirmPromise;
    expect(result.status).toBe(403);
    expect(result.body).toMatchObject({
      ok: false,
      code: "PERMISSION_DENIED",
    });
    // 关键硬断言：假禅道收到的指派写入数为 0，且目标需求归属未变化。
    expect(fixture.upstream().writes()).toHaveLength(0);
    expect(fixture.upstream().instances.instanceA.story.assignedTo).toBe(
      "alice",
    );
  });

  it("CAP-02：并发第二次确认返回 409 且不清除首请求的在途撤权守卫", async () => {
    const server = await fixture.start({ readOnly: false });
    const alice = browser(server);
    await login(alice, "instanceA", "alice");

    const prepared = await alice.call(assignment);
    expect(prepared.status).toBe(200);
    const opId = (prepared.body as { opId: string }).opId;
    fixture.advance(3_100);

    const checkTargetsPause = fixture.upstream().pauseNextDetail();
    const firstConfirm = alice.call(confirmation(opId));
    await checkTargetsPause.started;

    const gatewayReadPause = fixture.upstream().pauseNextDetail();
    checkTargetsPause.release();
    await gatewayReadPause.started;

    // 同一会话发起并发第二次确认：必须 409 拒绝，且不删除首请求的 writeGuards。
    const duplicate = await alice.call(confirmation(opId));
    expect(duplicate.status).toBe(409);

    // 随后撤销 alice 的 RM 职责并放行首请求：首请求仍必须在 HTTP 发送前被阻断。
    await writeFile(
      fixture.teamPath("instanceA"),
      JSON.stringify({ roles: { RM: ["bob"], RD: ["alice", "bob"] } }),
    );
    gatewayReadPause.release();

    const firstResult = await firstConfirm;
    expect(firstResult.status).toBe(403);
    expect(firstResult.body).toMatchObject({
      ok: false,
      code: "PERMISSION_DENIED",
    });
    expect(fixture.upstream().writes()).toHaveLength(0);
    expect(fixture.upstream().instances.instanceA.story.assignedTo).toBe(
      "alice",
    );
  });

  it("CAP-02：网关回读等待期间计划过期，HTTP 最终发送前阻断且零上游写入", async () => {
    const server = await fixture.start({ readOnly: false });
    const alice = browser(server);
    await login(alice, "instanceA", "alice");

    const prepared = await alice.call(assignment);
    expect(prepared.status).toBe(200);
    const opId = (prepared.body as { opId: string }).opId;
    fixture.advance(3_100);

    const checkTargetsPause = fixture.upstream().pauseNextDetail();
    const confirmPromise = alice.call(confirmation(opId));
    await checkTargetsPause.started;

    const gatewayReadPause = fixture.upstream().pauseNextDetail();
    checkTargetsPause.release();
    await gatewayReadPause.started;

    // 在网关等待回读期间推进时钟超过 30 分钟有效期。
    fixture.advance(31 * 60_000);
    gatewayReadPause.release();

    const result = await confirmPromise;
    expect(result.status).toBe(400);
    expect(result.body).toMatchObject({
      ok: false,
      code: "PLAN_EXPIRED",
    });
    // 再次确认同一已过期未派发计划：仍必须返回 400 PLAN_EXPIRED，而非误入 200 not_executed。
    const repeat = await alice.call(confirmation(opId));
    expect(repeat.status).toBe(400);
    expect(repeat.body).toMatchObject({
      ok: false,
      code: "PLAN_EXPIRED",
    });
    expect(fixture.upstream().writes()).toHaveLength(0);
    expect(fixture.upstream().instances.instanceA.story.assignedTo).toBe(
      "alice",
    );
  });

  it("CAP-02：最终异步守卫读取配置期间登出，HTTP 发送前同步复核阻断（401 且 0 写入）", async () => {
    const writes: string[] = [];
    const stubFetch = vi.fn<typeof globalThis.fetch>(async (input) => {
      const url = new URL(input instanceof Request ? input.url : String(input));
      if (url.pathname.endsWith("/api.php/v1/tokens")) {
        return Response.json(
          { token: "synthetic-logout-race-token" },
          { status: 201 },
        );
      }
      if (url.pathname.includes("/assign")) {
        writes.push(url.pathname);
        return Response.json({ id: 101 }, { status: 200 });
      }
      return Response.json({}, { status: 404 });
    });
    vi.stubGlobal("fetch", stubFetch);
    let revoked = false;
    const client = createZentaoReadClient({
      baseUrl: "https://instancea.invalid",
      account: "alice",
      token: "synthetic-logout-race-token",
      clock: () => Date.UTC(2026, 10, 26, 1),
      isRevoked: () => revoked,
      assertBeforeWrite: async () => {
        // 模拟在异步读取团队配置期间用户登出撤销会话。
        await Promise.resolve();
        revoked = true;
        revokeZentaoReadClient(client);
      },
    });
    await expect(
      writeStory(
        client,
        "story.assign",
        29,
        101,
        { assignedTo: "bob" },
        { opId: "op_00000000000000000000000055", instanceVersion: "22.6" },
      ),
    ).rejects.toMatchObject({
      code: "AUTH_FAILED",
      details: { phase: "pre_send" },
    });
    expect(writes).toHaveLength(0);

    // 端到端集中服务：在网关等待期间调用 /api/logout，确认请求返回 401 且假禅道零写入。
    vi.stubGlobal("fetch", fixture.upstream().fetcher);
    const server = await fixture.start({ readOnly: false });
    const alice = browser(server);
    await login(alice, "instanceA", "alice");
    const prepared = await alice.call(assignment);
    expect(prepared.status).toBe(200);
    const opId = (prepared.body as { opId: string }).opId;
    fixture.advance(3_100);

    const checkTargetsPause = fixture.upstream().pauseNextDetail();
    const confirmPromise = alice.call(confirmation(opId));
    await checkTargetsPause.started;
    const gatewayReadPause = fixture.upstream().pauseNextDetail();
    checkTargetsPause.release();
    await gatewayReadPause.started;

    const loggedOut = await alice.send("/api/logout", {});
    expect(loggedOut.status).toBe(200);
    gatewayReadPause.release();

    const afterLogout = await confirmPromise;
    expect(afterLogout.status).toBe(401);
    expect(fixture.upstream().writes()).toHaveLength(0);
    expect(fixture.upstream().instances.instanceA.story.assignedTo).toBe(
      "alice",
    );
  });

  it("SRV-OP-03：全部步骤排除（skipped）的已完成回执允许原主体幂等重放", async () => {
    const server = await fixture.start({ readOnly: false });
    const alice = browser(server);
    await login(alice, "instanceA", "alice");

    const prepared = await alice.call(assignment);
    expect(prepared.status).toBe(200);
    const opId = (prepared.body as { opId: string }).opId;
    fixture.advance(3_100);

    const first = await alice.call({
      role: "RM",
      tool: "confirm_operation",
      input: { opId, previewAck: true, excludeSteps: [1] },
    });
    expect(first.status).toBe(200);
    expect(first.body).toMatchObject({
      opId,
      status: "not_executed",
      steps: [{ seq: 1, state: "skipped" }],
    });

    const fetchCallsBefore = fixture.upstream().fetcher.mock.calls.length;
    const replay = await alice.call(confirmation(opId));
    expect(replay.status).toBe(200);
    expect(replay.body).toMatchObject({
      opId,
      status: "not_executed",
      steps: [{ seq: 1, state: "skipped" }],
    });
    expect(fixture.upstream().fetcher.mock.calls.length).toBe(fetchCallsBefore);
    expect(fixture.upstream().writes()).toHaveLength(0);
  });

  it("SRV-OP-03：终态操作顺序重放（含重登与路由缓存过期）零上游传输调用，越权与撤权一律拒绝", async () => {
    const server = await fixture.start({ readOnly: false });
    const alice = browser(server);
    await login(alice, "instanceA", "alice");

    const prepared = await alice.call(assignment);
    expect(prepared.status).toBe(200);
    const opId = (prepared.body as { opId: string }).opId;
    fixture.advance(3_100);

    const first = await alice.call(confirmation(opId));
    expect(first.status).toBe(200);
    expect(first.body).toMatchObject({ opId, status: "confirmed" });
    expect(fixture.upstream().writes()).toHaveLength(1);

    // 1. 同会话上游故障时顺序重放：完整 fetch 调用数（含 /index.php）零增长。
    fixture.upstream().fail("instanceA", "alice", storyPath, 503);
    fixture.upstream().fail("instanceA", "alice", "/api.php/v1/user", 503);
    const fetchCallsBeforeSameSession =
      fixture.upstream().fetcher.mock.calls.length;

    const replayed = await alice.call(confirmation(opId));
    expect(replayed.status).toBe(200);
    expect(replayed.body).toMatchObject({ opId, status: "confirmed" });
    expect(fixture.upstream().fetcher.mock.calls.length).toBe(
      fetchCallsBeforeSameSession,
    );
    expect(fixture.upstream().writes()).toHaveLength(1);

    // 2. 推进 8 天令 portal-link-route-v1 缓存过期，并以原账号重新登录后重放：
    // 同样零上游传输调用（不请求 /index.php）。
    fixture.upstream().fail("instanceA", "alice", "/api.php/v1/user");
    fixture.advance(8 * 24 * 60 * 60_000);
    const aliceRelogin = browser(server);
    await login(aliceRelogin, "instanceA", "alice");
    const fetchCallsBeforeReloginReplay =
      fixture.upstream().fetcher.mock.calls.length;

    const reloginReplay = await aliceRelogin.call(confirmation(opId));
    expect(reloginReplay.status).toBe(200);
    expect(reloginReplay.body).toMatchObject({ opId, status: "confirmed" });
    expect(fixture.upstream().fetcher.mock.calls.length).toBe(
      fetchCallsBeforeReloginReplay,
    );
    expect(fixture.upstream().writes()).toHaveLength(1);

    // 跨账号重放必须被拒绝。
    const bob = browser(server);
    await login(bob, "instanceA", "bob");
    const crossAccount = await bob.call(confirmation(opId));
    expect(crossAccount.status).toBe(403);
    expect(crossAccount.body).toMatchObject({
      ok: false,
      code: "PERMISSION_DENIED",
    });

    // 同账号切换无权职责（RD 不含 assign_story）重放必须被拒绝。
    const wrongRole = await aliceRelogin.call({
      role: "RD",
      tool: "confirm_operation",
      input: { opId, previewAck: true },
    });
    expect(wrongRole.status).toBe(403);

    // 撤销 alice 的 RM 职责后，重放与查询均被拒绝。
    await writeFile(
      fixture.teamPath("instanceA"),
      JSON.stringify({ roles: { RM: ["bob"], RD: ["alice", "bob"] } }),
    );
    const afterRevoke = await aliceRelogin.call(confirmation(opId));
    expect(afterRevoke.status).toBe(403);
    const receiptAfterRevoke = await aliceRelogin.call(operation(opId));
    expect(receiptAfterRevoke.status).toBe(403);
    expect(fixture.upstream().writes()).toHaveLength(1);
  });
});
