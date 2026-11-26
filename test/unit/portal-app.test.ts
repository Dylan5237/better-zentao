import { describe, expect, it, vi } from "vitest";
// @ts-expect-error The packaged portal is a native browser module.
import * as app from "../../web/app.js";

const {
  buildReadInput,
  createPortalSession,
  initialAction,
  initializePortalSession,
  navigationFor,
  takeLaunchFragment,
  watchLaunchFragment,
} = app;

const fb = {
  id: "FB",
  label: "业务反馈者",
  actions: ["get_my_work", "query_stories", "create_story"],
};
const qa = {
  id: "QA",
  label: "测试人员",
  actions: ["get_my_work", "scan_workflow_risks"],
};
const json = (data: unknown, status = 200) => Response.json(data, { status });
const unauthorized = () => json({ ok: false, code: "AUTH_FAILED" }, 401);

describe("CR-002 WEB-01 至 WEB-04 门户界面", () => {
  it("首屏使用已授予的工具，并按职责选择工作分组或管理视图", () => {
    const groups = {
      FB: ["raised"],
      DM: ["action", "waiting_ready"],
      DS: ["maintained", "can_start"],
      RM: ["action", "waiting_ready"],
      RD: ["action", "new"],
      QA: ["can_start", "action"],
    };
    for (const [id, expected] of Object.entries(groups)) {
      expect(initialAction({ id, actions: ["get_my_work"] })).toBe(
        "get_my_work",
      );
      expect(buildReadInput("get_my_work", id)).toEqual({
        groups: expected,
        markSeen: false,
      });
    }
    for (const [id, view] of [
      ["PM", "plan"],
      ["PJ", "iteration"],
    ]) {
      expect(initialAction({ id, actions: ["get_plan_progress"] })).toBe(
        "get_plan_progress",
      );
      expect(buildReadInput("get_plan_progress", id)).toEqual({ view });
    }
    expect(initialAction({ id: "RM", actions: ["query_stories"] })).toBe(
      "query_stories",
    );
    expect(initialAction({ id: "RM", actions: [] })).toBeUndefined();
    expect(
      navigationFor({
        actions: [
          "get_my_work",
          "get_my_work",
          "confirm_operation",
          "toString",
        ],
      }).map((item: { tool: string }) => item.tool),
    ).toEqual(["get_my_work"]);
  });

  it("按现有查询契约转换筛选值，分开需求和来源编号", () => {
    expect(
      buildReadInput("get_story_progress", "RD", {
        lookup: "storyId",
        storyId: "19",
        intakeId: "hidden",
      }),
    ).toEqual({ storyId: 19, view: "dev" });
    expect(
      buildReadInput("get_story_progress", "FB", {
        lookup: "intakeId",
        intakeId: " IN-42 ",
      }),
    ).toEqual({ intakeId: "IN-42", format: "card" });
    expect(
      buildReadInput("get_story_progress", "QA", {
        lookup: "requirementId",
        requirementId: "21",
      }),
    ).toEqual({ requirementId: 21 });
    expect(
      buildReadInput("get_story_progress", "QA", { storyId: "0" }),
    ).toBeNull();
    expect(
      buildReadInput("query_stories", "FB", {
        keyword: "样例",
        role: "assigned",
        who: "other",
      }),
    ).toEqual({ keyword: "样例" });
    expect(
      buildReadInput("scan_workflow_risks", "QA", {
        product: "4",
        rules: "R02、R03",
        minSeverity: "high",
      }),
    ).toEqual({
      scope: { product: "4", mine: true },
      rules: ["R02", "R03"],
      minSeverity: "high",
    });
    expect(
      buildReadInput("get_member_schedule", "RM", {
        members: "a, b",
        estimateHours: "6.5",
        deadline: "2026-12-04",
      }),
    ).toEqual({
      members: ["a", "b"],
      format: "table",
      newTask: { estimateHours: 6.5, deadline: "2026-12-04" },
    });
  });

  it("使用服务端授予的职责和显示中的账号发请求，原样返回业务回执", async () => {
    const receipt = { ok: false, status: "partial", opId: "demo" };
    const request = vi
      .fn<typeof fetch>()
      .mockResolvedValueOnce(json({ account: "demo", roles: [fb] }))
      .mockResolvedValueOnce(json(receipt));
    const portal = createPortalSession(request);
    await portal.login("demo", "test-password");
    expect(portal.selectRole("PM")).toBe(false);
    expect(portal.role.id).toBe("FB");
    const action = portal.scope();
    await expect(action.call("close_stories", {})).rejects.toMatchObject({
      code: "PERMISSION_DENIED",
    });
    await expect(
      action.call("confirm_operation", { opId: "demo", previewAck: true }),
    ).resolves.toEqual(receipt);
    expect(request).toHaveBeenCalledTimes(2);
    const call = request.mock.calls[1]?.[1];
    expect(call?.headers).toMatchObject({ "X-Bzt-Account": "demo" });
    expect(JSON.parse(String(call?.body))).toEqual({
      role: "FB",
      tool: "confirm_operation",
      input: { opId: "demo", previewAck: true },
    });
  });

  it("切换、导航和退出会拒绝旧页面请求，并保留退出账号校验", async () => {
    let respond: (response: Response) => void = () => {};
    const delayed = new Promise<Response>((resolve) => {
      respond = resolve;
    });
    const request = vi
      .fn<typeof fetch>()
      .mockResolvedValueOnce(json({ account: "demo", roles: [fb, qa] }))
      .mockReturnValueOnce(delayed)
      .mockResolvedValueOnce(json({ ok: true }));
    const portal = createPortalSession(request);
    await portal.restore();
    const oldPage = portal.scope();
    const reading = oldPage.call("get_my_work", { markSeen: false });
    expect(portal.selectRole("QA")).toBe(true);
    respond(json({ ok: true, data: [] }));
    await expect(reading).rejects.toMatchObject({ name: "StalePortalRequest" });
    await expect(oldPage.call("confirm_operation", {})).rejects.toMatchObject({
      name: "StalePortalRequest",
    });
    const navigation = new AbortController();
    const current = portal.scope(navigation.signal);
    navigation.abort();
    await expect(current.call("get_my_work", {})).rejects.toMatchObject({
      name: "StalePortalRequest",
    });
    const quitting = portal.scope();
    await portal.logout();
    expect(portal.identity).toBeNull();
    await expect(quitting.call("get_my_work", {})).rejects.toMatchObject({
      name: "StalePortalRequest",
    });
    expect(request).toHaveBeenCalledTimes(3);
    expect(request.mock.calls[2]).toEqual([
      "/api/logout",
      expect.objectContaining({
        headers: expect.objectContaining({ "X-Bzt-Account": "demo" }),
      }),
    ]);
  });

  it("回读空映射与换号时只保留最新账号，非 2xx 响应按错误处理", async () => {
    const request = vi
      .fn<typeof fetch>()
      .mockResolvedValueOnce(json({ account: "one", roles: [fb] }))
      .mockResolvedValueOnce(
        json(
          { ok: false, code: "SESSION_CHANGED", message: "会话已切换" },
          409,
        ),
      )
      .mockResolvedValueOnce(json({ account: "two", roles: [] }));
    const portal = createPortalSession(request);
    await portal.restore();
    await expect(portal.scope().call("get_my_work", {})).rejects.toMatchObject({
      status: 409,
      code: "SESSION_CHANGED",
    });
    await portal.restore();
    expect(portal.identity).toEqual({ account: "two", roles: [] });
    expect(portal.role).toBeUndefined();
  });

  it("403 保留工具错误细节，只在角色确被撤销时更新工作台权限", async () => {
    const account = "演练账号";
    const selected = { account, roles: [fb, qa] };
    const details = { fields: ["product"] };
    const request = vi
      .fn<typeof fetch>()
      .mockResolvedValueOnce(json(selected))
      .mockResolvedValueOnce(
        json(
          {
            ok: false,
            code: "PERMISSION_DENIED",
            message: "当前工具受限",
            details,
          },
          403,
        ),
      )
      .mockResolvedValueOnce(json(selected))
      .mockResolvedValueOnce(json({ account, roles: [qa] }));
    const portal = createPortalSession(request);
    await portal.restore();
    const scope = portal.scope();
    await expect(scope.call("get_my_work", {})).rejects.toMatchObject({
      status: 403,
      details,
    });
    expect(request.mock.calls[1]?.[1]?.headers).toMatchObject({
      "X-Bzt-Account": encodeURIComponent(account),
    });
    await expect(scope.refreshIfRevoked()).resolves.toBe(false);
    expect(portal.role).toEqual(fb);
    expect(scope.current()).toBe(true);
    await expect(scope.refreshIfRevoked()).resolves.toBe(true);
    expect(portal.role).toEqual(qa);
    expect(scope.current()).toBe(false);
  });

  it("在其他标签页回读时保留同帐号同职责的表单，换号则作废旧操作", async () => {
    const request = vi
      .fn<typeof fetch>()
      .mockResolvedValueOnce(json({ account: "one", roles: [fb, qa] }))
      .mockResolvedValueOnce(json({ account: "one", roles: [fb, qa] }))
      .mockResolvedValueOnce(json({ account: "one", roles: [fb] }))
      .mockResolvedValueOnce(json({ account: "two", roles: [fb] }))
      .mockResolvedValueOnce(json({ ok: false, code: "AUTH_FAILED" }, 401));
    const portal = createPortalSession(request);
    await portal.restore();
    const form = portal.scope();
    await expect(portal.sync()).resolves.toBe("unchanged");
    await expect(portal.sync()).resolves.toBe("roles");
    expect(form.current()).toBe(true);
    await expect(portal.sync()).resolves.toBe("workspace");
    expect(form.current()).toBe(false);
    expect(portal.identity?.account).toBe("two");
    await expect(portal.sync()).resolves.toBe("workspace");
    expect(portal.identity).toBeNull();
  });
});

describe("本机门户首次登录与职责设置", () => {
  it("立即从地址栏移除启动凭证，保留普通页内锚点", () => {
    const history = { state: { entry: 1 }, replaceState: vi.fn() };
    expect(
      takeLaunchFragment(
        new URL("http://127.0.0.1:17329/?demo=1#launch=opaque%2Bvalue"),
        history,
      ),
    ).toBe("opaque+value");
    expect(history.replaceState).toHaveBeenCalledWith(
      history.state,
      "",
      "http://127.0.0.1:17329/?demo=1",
    );
    history.replaceState.mockClear();
    expect(
      takeLaunchFragment(new URL("http://127.0.0.1:17329/#work-area"), history),
    ).toBeUndefined();
    expect(history.replaceState).not.toHaveBeenCalled();
  });

  it("在原标签页打开启动链接时，清除地址凭证后再执行启动", () => {
    const location = new URL("http://127.0.0.1:17329/");
    const browser = Object.assign(new EventTarget(), {
      location,
      history: {
        state: null,
        replaceState: vi.fn((_state: unknown, _title: string, url: string) => {
          location.href = url;
        }),
      },
    });
    const onLaunch = vi.fn(() => expect(location.hash).toBe(""));
    watchLaunchFragment(browser, onLaunch);
    location.hash = "work-area";
    browser.dispatchEvent(new Event("hashchange"));
    expect(location.hash).toBe("#work-area");
    expect(onLaunch).not.toHaveBeenCalled();
    location.hash = "launch=new-tabless-ticket";
    browser.dispatchEvent(new Event("hashchange"));
    expect(onLaunch).toHaveBeenCalledExactlyOnceWith("new-tabless-ticket");
  });

  it("刷新优先恢复现有会话，有旧启动链接时也不重复登录", async () => {
    const identity = { account: "demo", roles: [fb] };
    const request = vi.fn<typeof fetch>().mockResolvedValueOnce(json(identity));
    const portal = createPortalSession(request);
    await initializePortalSession(portal, "old-launch");
    expect(portal.identity).toEqual(identity);
    expect(request.mock.calls.map(([path]) => path)).toEqual(["/api/session"]);
  });

  it("仅在启动凭证及已保存登录同时存在时快速登录", async () => {
    const startup = {
      needsBaseUrl: false,
      account: "demo",
      hasSavedLogin: true,
    };
    const plainRequest = vi
      .fn<typeof fetch>()
      .mockResolvedValueOnce(unauthorized())
      .mockResolvedValueOnce(json(startup));
    const plainPortal = createPortalSession(plainRequest);
    await expect(initializePortalSession(plainPortal)).resolves.toMatchObject({
      startup,
    });
    expect(plainPortal.identity).toBeNull();
    expect(plainRequest.mock.calls.map(([path]) => path)).toEqual([
      "/api/session",
      "/api/startup",
    ]);
    expect(plainRequest.mock.calls[1]?.[1]?.headers).not.toHaveProperty(
      "X-Bzt-Launch",
    );

    const identity = { account: "demo", roles: [fb] };
    const launchRequest = vi
      .fn<typeof fetch>()
      .mockResolvedValueOnce(unauthorized())
      .mockResolvedValueOnce(json(startup))
      .mockResolvedValueOnce(json(identity));
    const launchPortal = createPortalSession(launchRequest);
    await initializePortalSession(launchPortal, "launch-ticket");
    expect(launchPortal.identity).toEqual(identity);
    expect(launchRequest.mock.calls[1]).toEqual([
      "/api/startup",
      expect.objectContaining({
        headers: expect.objectContaining({ "X-Bzt-Launch": "launch-ticket" }),
      }),
    ]);
    expect(launchRequest.mock.calls[2]).toEqual([
      "/api/login",
      expect.objectContaining({
        body: JSON.stringify({ launch: "launch-ticket", saved: true }),
      }),
    ]);
  });

  it("快速登录失败后可以用同一凭证和手工填写的信息登录", async () => {
    const startup = {
      needsBaseUrl: false,
      account: "demo",
      hasSavedLogin: true,
    };
    const request = vi
      .fn<typeof fetch>()
      .mockResolvedValueOnce(unauthorized())
      .mockResolvedValueOnce(json(startup))
      .mockResolvedValueOnce(unauthorized())
      .mockResolvedValueOnce(json({ account: "other", roles: [] }));
    const portal = createPortalSession(request);
    await expect(
      initializePortalSession(portal, "still-available"),
    ).resolves.toMatchObject({ startup, savedFailed: true });
    expect(portal.identity).toBeNull();
    await portal.login("other", "synthetic-password", {
      launch: "still-available",
    });
    expect(JSON.parse(String(request.mock.calls[3]?.[1]?.body))).toEqual({
      account: "other",
      password: "synthetic-password",
      launch: "still-available",
    });
    expect(portal.identity?.account).toBe("other");
  });

  it("首次配置地址由手工表单提交，不使用未保存的登录", async () => {
    const startup = { needsBaseUrl: true, hasSavedLogin: false };
    const request = vi
      .fn<typeof fetch>()
      .mockResolvedValueOnce(unauthorized())
      .mockResolvedValueOnce(json(startup))
      .mockResolvedValueOnce(json({ account: "demo", roles: [] }));
    const portal = createPortalSession(request);
    await expect(
      initializePortalSession(portal, "launch-ticket"),
    ).resolves.toMatchObject({ startup });
    expect(portal.identity).toBeNull();
    await portal.login("demo", "synthetic-password", {
      baseUrl: "https://zentao.example.test/",
      launch: "launch-ticket",
    });
    expect(JSON.parse(String(request.mock.calls[2]?.[1]?.body))).toEqual({
      baseUrl: "https://zentao.example.test/",
      account: "demo",
      password: "synthetic-password",
      launch: "launch-ticket",
    });
  });

  it("启动链接失效时改读普通入口，无保存登录的后备请求", async () => {
    const startup = { needsBaseUrl: true, hasSavedLogin: false };
    const request = vi
      .fn<typeof fetch>()
      .mockResolvedValueOnce(unauthorized())
      .mockResolvedValueOnce(json({ code: "PERMISSION_DENIED" }, 403))
      .mockResolvedValueOnce(json(startup));
    const portal = createPortalSession(request);
    await expect(initializePortalSession(portal, "expired")).resolves.toEqual({
      startup,
      launchRejected: true,
    });
    expect(request.mock.calls.map(([path]) => path)).toEqual([
      "/api/session",
      "/api/startup",
      "/api/startup",
    ]);
    expect(request.mock.calls[2]?.[1]?.headers).not.toHaveProperty(
      "X-Bzt-Launch",
    );
    expect(portal.identity).toBeNull();
  });

  it("没有服务端职责设置权限时不会发出修改请求", async () => {
    const request = vi
      .fn<typeof fetch>()
      .mockResolvedValueOnce(json({ account: "ordinary", roles: [] }));
    const portal = createPortalSession(request);
    await portal.restore();
    await expect(portal.saveRoles(["PM"], "stale")).rejects.toMatchObject({
      code: "PERMISSION_DENIED",
    });
    expect(request).toHaveBeenCalledTimes(1);
  });

  it("职责编辑提交当前账号和编辑版本，保持旧身份直到保存成功", async () => {
    const roleSetup = {
      choices: [
        { id: "FB", label: "业务反馈者" },
        { id: "QA", label: "测试人员" },
      ],
      selected: ["QA"],
      locked: ["QA"],
      revision: "before",
    };
    const original = { account: "演练", roles: [qa], roleSetup };
    const saved = {
      ...original,
      roles: [fb, qa],
      roleSetup: {
        ...roleSetup,
        selected: ["FB", "QA"],
        revision: "after",
      },
    };
    const request = vi
      .fn<typeof fetch>()
      .mockResolvedValueOnce(json(original))
      .mockResolvedValueOnce(
        json({ code: "PLAN_STALE", message: "职责已变更" }, 409),
      )
      .mockResolvedValueOnce(json(saved));
    const portal = createPortalSession(request);
    await portal.restore();
    await expect(portal.saveRoles(["FB", "QA"], "older")).rejects.toMatchObject(
      {
        code: "PLAN_STALE",
      },
    );
    expect(portal.identity).toEqual(original);
    const oldWork = portal.scope();
    await portal.saveRoles(["FB", "QA"], roleSetup.revision);
    expect(request.mock.calls[2]).toEqual([
      "/api/roles",
      expect.objectContaining({
        body: JSON.stringify({ roles: ["FB", "QA"], revision: "before" }),
        headers: expect.objectContaining({
          "X-Bzt-Account": encodeURIComponent("演练"),
        }),
      }),
    ]);
    expect(portal.identity).toEqual(saved);
    expect(portal.role).toEqual(qa);
    expect(oldWork.current()).toBe(false);
  });

  it("SRV-ISO-04 同名账号切换实例时携带新 CSRF、作废旧作用域并丢弃晚到响应", async () => {
    const delayed = Promise.withResolvers<Response>();
    const request = vi
      .fn<typeof fetch>()
      .mockResolvedValueOnce(
        json({
          instanceId: "instanceA",
          account: "alice",
          csrfToken: "csrf-a",
          roles: [fb, qa],
        }),
      )
      .mockImplementationOnce(() => delayed.promise)
      .mockResolvedValueOnce(
        json({
          instanceId: "instanceB",
          account: "alice",
          csrfToken: "csrf-b",
          roles: [fb],
        }),
      )
      .mockResolvedValueOnce(json({ ok: true, from: "instanceB" }));

    const portal = createPortalSession(request);
    await portal.login("alice", "pw", { instanceId: "instanceA" });
    portal.selectRole("QA");
    const scopeA = portal.scope();
    const staleCall = scopeA.call("get_my_work", {});
    expect(request.mock.calls[1]).toEqual([
      "/api/call",
      expect.objectContaining({
        headers: expect.objectContaining({ "X-Bzt-Csrf": "csrf-a" }),
      }),
    ]);

    await portal.login("alice", "pw", { instanceId: "instanceB" });
    expect(scopeA.current()).toBe(false);
    expect(portal.identity).toMatchObject({
      instanceId: "instanceB",
      account: "alice",
    });
    expect(portal.role).toEqual(fb);

    delayed.resolve(json({ ok: true, from: "instanceA" }));
    await expect(staleCall).rejects.toMatchObject({
      name: "StalePortalRequest",
    });

    const scopeB = portal.scope();
    await expect(scopeB.call("get_my_work", {})).resolves.toEqual({
      ok: true,
      from: "instanceB",
    });
    expect(request.mock.calls[3]).toEqual([
      "/api/call",
      expect.objectContaining({
        headers: expect.objectContaining({ "X-Bzt-Csrf": "csrf-b" }),
      }),
    ]);
  });
});
