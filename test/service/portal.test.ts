import { describe, expect, it, vi } from "vitest";
import { teamConfigSchema } from "../../src/core/config.ts";
import { BztError } from "../../src/core/errors.ts";
import {
  loginPortal,
  portalRoles,
  runPortalAction,
} from "../../src/services/portal.ts";
import { mkdtemp, writeFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { draft, fakeZentao } from "../eval/fake-zentao.ts";
import { assertNoSensitiveData } from "../helpers/assert-no-sensitive-data.ts";
import { z } from "zod";

describe("CR-002 WEB-01 至 WEB-04", () => {
  it("CR-007 月份加入快照筛选，同时保持风险巡检只读本人的职责范围", async () => {
    const execute = vi.fn(async () => {
      throw new Error("scope verified");
    });
    const read = vi.fn(
      async (_role, _tool, _input, _mode, load: () => Promise<unknown>) =>
        load(),
    );
    const run = runPortalAction(
      execute,
      "alice",
      async () => portalRoles({ QA: ["alice"] }, "alice"),
      undefined,
      { read, invalidate: vi.fn() },
    );
    const query = { scope: { month: "2026-09", mine: false } };
    await expect(
      run("QA", "scan_workflow_risks", query, "sync", "2026-11"),
    ).rejects.toThrow("scope verified");
    expect(read).toHaveBeenCalledWith(
      "QA",
      "scan_workflow_risks",
      {
        scope: { month: "2026-11", mine: true },
        reportMonth: "2026-11",
      },
      "sync",
      expect.any(Function),
    );
    expect(execute).toHaveBeenCalledWith(
      "scan_workflow_risks",
      {
        scope: { month: "2026-11", mine: true },
      },
      "QA",
      true,
      "2026-11",
    );
  });
  it("设计人员（DS）查询用户需求时服务端强制限定指派给本人", async () => {
    const execute = vi.fn(async () => {
      throw new Error("scope verified");
    });
    const run = runPortalAction(execute, "alice", async () =>
      portalRoles({ DS: ["alice"] }, "alice"),
    );
    await expect(
      run("DS", "query_stories", {
        type: "requirement",
        unlinked: true,
        who: "bob",
      }),
    ).rejects.toThrow("scope verified");
    expect(execute).toHaveBeenLastCalledWith(
      "query_stories",
      {
        type: "requirement",
        unlinked: true,
        role: "assigned",
        who: "alice",
      },
      "DS",
    );
    await expect(
      run("DS", "query_stories", { type: "story", status: ["all"] }),
    ).rejects.toThrow("scope verified");
    expect(execute).toHaveBeenLastCalledWith(
      "query_stories",
      { type: "story", status: ["all"] },
      "DS",
    );
  });
  it("个人排期强制限定本人、拒绝临时指派，设计主管可读队列和版本", async () => {
    const execute = vi.fn(async () => {
      throw new Error("scope verified");
    });
    const run = runPortalAction(execute, "alice", async () =>
      portalRoles({ RD: ["alice"], DM: ["alice"] }, "alice"),
    );
    await expect(
      run("RD", "get_member_schedule", { members: ["bob"] }),
    ).rejects.toThrow("scope verified");
    expect(execute).toHaveBeenLastCalledWith(
      "get_member_schedule",
      { members: ["alice"] },
      "RD",
    );
    await expect(
      run("RD", "get_team_work", {
        team: "someone-else",
        members: ["bob"],
        view: "all_open",
      }),
    ).rejects.toThrow("scope verified");
    expect(execute).toHaveBeenLastCalledWith(
      "get_team_work",
      { members: ["alice"], view: "all_open" },
      "RD",
    );
    await expect(
      run("RD", "get_member_schedule", {
        newTask: { estimateHours: 2, deadline: "2026-12-01" },
      }),
    ).rejects.toMatchObject({ code: "PERMISSION_DENIED" });
    await expect(run("DM", "get_monthly_dev_queue", {})).rejects.toThrow(
      "scope verified",
    );
    await expect(
      run("DM", "get_plan_progress", { view: "plan" }),
    ).rejects.toMatchObject({ code: "PERMISSION_DENIED" });
  });
  it("US-QA-03 开放版本门禁的只读查询，其他管理视图和例外登记仍由对应职责访问", async () => {
    const read = vi.fn(async () => {
      throw new Error("authorized release query");
    });
    const run = runPortalAction(read, "reader", async () =>
      portalRoles({ QA: ["reader"] }, "reader"),
    );
    for (const view of ["plan", "iteration", "commitment"]) {
      await expect(
        run("QA", "get_plan_progress", { view }),
      ).rejects.toMatchObject({ code: "PERMISSION_DENIED" });
    }
    await expect(
      run("QA", "set_story_meta", {
        storyId: 2,
        waiver: { rule: "R13", reason: "test" },
      }),
    ).rejects.toMatchObject({ code: "PERMISSION_DENIED" });
    expect(read).not.toHaveBeenCalled();
    await expect(
      run("QA", "get_plan_progress", {
        view: "release",
        product: "29",
        version: "v1",
      }),
    ).rejects.toThrow("authorized release query");
    expect(read).toHaveBeenCalledOnce();
  });
  it("同一业务内核完成登录、查询、预览、确认及回读，并即时执行角色撤销", async () => {
    const home = await mkdtemp(join(tmpdir(), "bzt-portal-"));
    const file = join(home, "team.json");
    let now = Date.UTC(2026, 10, 24);
    const runtime = {
      env: {
        ZENTAO_BASE_URL: "https://eval.fixture.test",
        BZT_CONFIG: file,
        BZT_HOME: home,
      },
      clock: () => now,
      logSink: () => undefined,
    };
    const fake = fakeZentao();
    const fixtureFetch: typeof fetch = async (url, init) => {
      if (String(url).endsWith("/api.php/v1/stories/40")) {
        const page = await fake.fake(
          "https://eval.fixture.test/api.php/v1/products/30/stories",
        );
        const data = z
          .object({ stories: z.array(z.record(z.string(), z.unknown())) })
          .parse(await page.json());
        return Response.json(data.stories[0]);
      }
      return fake.fake(url, init);
    };
    vi.stubGlobal("fetch", fixtureFetch);
    const config = {
      mode: "strict-ai",
      roles: { DM: ["alice"], FB: ["alice"] },
      products: { 29: { name: "产品甲", state: "runtime" } },
      moduleDefaults: { 29: { designLead: "alice", devLead: "bob" } },
    };
    let session;
    try {
      await writeFile(file, JSON.stringify(config));
      await expect(loginPortal(runtime, "other", "demo")).rejects.toMatchObject(
        { code: "AUTH_FAILED" },
      );
      session = await loginPortal(runtime, "alice", "demo");
      expect(session.identity.roles.map((row) => row.id)).toEqual(["FB", "DM"]);
      expect(
        await session.call("FB", "query_stories", {
          role: "assigned",
          who: "bob",
          product: "29",
        }),
      ).toMatchObject({
        scope: { filters: { role: "raised", who: "alice" } },
        data: {
          items: expect.arrayContaining([expect.objectContaining({ id: 31 })]),
        },
      });
      await expect(
        session.call("FB", "get_story_progress", { storyId: 40, view: "dev" }),
      ).rejects.toMatchObject({ code: "NOT_FOUND" });
      expect(
        await session.call("DM", "get_story_progress", { storyId: 40 }),
      ).toMatchObject({ data: { story: { id: 40 } } });
      const query = await session.call("DM", "get_story_progress", {
        storyId: 31,
      });
      expect(query).toMatchObject({ ok: true, data: { story: { id: 31 } } });
      assertNoSensitiveData(query);
      const prepared = await session.call("DM", "create_story", {
        ...draft,
        assignTo: "alice",
      });
      expect(prepared).toMatchObject({ ok: true, level: "W2" });
      const { opId } = z.object({ opId: z.string() }).parse(prepared);
      const ack = { opId, previewAck: true };
      await expect(
        session.call("DM", "confirm_operation", ack),
      ).rejects.toMatchObject({ code: "PREVIEW_TOO_FAST" });
      expect(fake.writes()).toBe(0);
      now += 3100;
      const result = await session.call("DM", "confirm_operation", ack);
      expect(result).toMatchObject({ opId, status: "confirmed" });
      expect(await session.call("DM", "get_operation", { opId })).toMatchObject(
        { data: { opId, status: "confirmed" } },
      );
      expect(fake.writes()).toBe(1);
      await writeFile(file, JSON.stringify({ ...config, roles: {} }));
      expect(await session.readRoles()).toEqual([]);
      expect(
        session.projectError(
          new BztError("CAPABILITY_UNVERIFIED", "需人工处理", {
            manual: { kind: "subtasks", id: 12 },
          }),
        ),
      ).toMatchObject({
        details: {
          links: [
            { url: expect.stringContaining("https://eval.fixture.test/") },
          ],
        },
      });
      await expect(
        session.call("DM", "confirm_operation", ack),
      ).rejects.toMatchObject({ code: "PERMISSION_DENIED" });
      expect(fake.unexpected()).toBe(false);
    } finally {
      session?.close();
      vi.unstubAllGlobals();
      await rm(home, { recursive: true, force: true });
    }
  });
  it("按精确账号列出八种职责，合并旧测试主管，同时保留兼任", () => {
    const keys = ["FB", "DS", "RD", "QA", "QA_LEAD", "PM", "PJ", "DM", "RM"];
    const config = teamConfigSchema.parse({
      roles: Object.fromEntries(keys.map((k) => [k, ["user"]])),
    });
    expect(
      portalRoles(config.roles, "user")
        .map((r) => r.id)
        .sort(),
    ).toEqual(keys.filter((k) => k !== "QA_LEAD").sort());
    expect(portalRoles(config.roles, "User")).toEqual([]);
    expect(portalRoles({ QA_LEAD: ["user"] }, "user")[0]?.id).toBe("QA");
  });

  it("角色、工具和预览编号须匹配，拒绝伪造的确认并保留原回执", async () => {
    const preview = {
      ok: true,
      opId: "p-test",
      kind: "create_story",
      level: "W2",
      expiresAt: "2026-11-25T12:00:00Z",
      preview: { summary: "预览", steps: [], affects: [] },
      warnings: [],
      requiresPreviewAck: true,
      intakes: [],
    };
    const result = {
      ok: true,
      status: "confirmed",
      opId: "p-test",
      steps: [],
      created: [],
    };
    const execute = vi.fn(async (tool: string) =>
      tool === "create_story" ? preview : result,
    );
    const run = runPortalAction(execute, "user", () =>
      Promise.resolve(portalRoles({ FB: ["user"], RD: ["user"] }, "user")),
    );
    const confirm = { opId: "p-test", previewAck: true };
    await expect(run("PM", "set_story_meta", {})).rejects.toMatchObject({
      code: "PERMISSION_DENIED",
    });
    await expect(run("FB", "assign_story", {})).rejects.toMatchObject({
      code: "PERMISSION_DENIED",
    });
    await expect(run("FB", "confirm_operation", confirm)).rejects.toMatchObject(
      { code: "PERMISSION_DENIED" },
    );
    expect(execute).not.toHaveBeenCalled();
    await run("FB", "create_story", {
      product: "1",
      module: "2",
      title: "查询体验",
    });
    await expect(run("RD", "confirm_operation", confirm)).rejects.toMatchObject(
      { code: "PERMISSION_DENIED" },
    );
    expect(await run("FB", "confirm_operation", confirm)).toEqual(result);
    expect(execute).toHaveBeenCalledTimes(2);
  });
});
