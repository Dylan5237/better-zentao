import { expect, it, vi } from "vitest";
import { startPortal } from "../../src/adapters/web/server.ts";
import { projectToolError } from "../../src/services/workbench.ts";
import { BztError } from "../../src/core/errors.ts";

it("INIT-04 保存期间的其他操作可重试，避免业务请求跨过职责变更", async () => {
  const started = Promise.withResolvers<void>();
  const finish = Promise.withResolvers<void>();
  const identity = { account: "owner", roles: [] };
  const call = vi.fn(async () => ({}));
  const portal = await startPortal({
    port: 0,
    clock: () => 0,
    login: async () => ({
      identity,
      readRoles: async () => [],
      projectError: projectToolError,
      close: vi.fn(),
      call,
      saveRoles: async () => {
        started.resolve();
        await finish.promise;
        return identity;
      },
    }),
  });
  const post = (path: string, body: unknown, cookie = "") =>
    fetch(portal.url + path, {
      method: "POST",
      headers: {
        Origin: portal.url,
        "Content-Type": "application/json",
        Cookie: cookie,
        "X-Bzt-Account": "owner",
      },
      body: JSON.stringify(body),
    });
  try {
    const authenticated = await post("/api/login", {
      account: "owner",
      password: "test-password",
    });
    const cookie = authenticated.headers.get("set-cookie")!.split(";")[0]!;
    const pending = post(
      "/api/roles",
      { roles: ["RD"], revision: "first" },
      cookie,
    );
    await started.promise;
    const query = { role: "RD", tool: "get_my_work", input: {} };
    expect((await post("/api/call", query, cookie)).status).toBe(409);
    expect((await post("/api/logout", {}, cookie)).status).toBe(409);
    expect(call).not.toHaveBeenCalled();
    finish.resolve();
    expect((await pending).ok).toBe(true);
    expect((await post("/api/call", query, cookie)).ok).toBe(true);
    expect(call).toHaveBeenCalledOnce();
  } finally {
    finish.resolve();
    await portal.close();
  }
});

it("INIT-01/04 本地启动凭证不能从公共入口取得，一次成功登录后失效", async () => {
  const roleSetup = {
    choices: [{ id: "RD", label: "研发人员" }],
    selected: [],
    revision: "first",
  };
  const saveRoles = vi.fn(async (roles: string[]) => ({
    account: "owner",
    roles: [],
    roleSetup: { ...roleSetup, selected: roles, revision: "second" },
  }));
  const login = vi.fn(async () => ({
    identity: { account: "owner", roles: [], roleSetup },
    readRoles: async () => [],
    readRoleSetup: async () => roleSetup,
    saveRoles,
    call: vi.fn(),
    projectError: projectToolError,
    close: vi.fn(),
  }));
  const startup = {
    needsBaseUrl: false,
    account: "owner",
    hasSavedLogin: true,
  };
  const portal = await startPortal({
    port: 0,
    clock: () => 0,
    startup: () => startup,
    login,
  });
  const post = (
    path: string,
    data: unknown,
    cookie = "",
    origin = portal.url,
    account = "owner",
  ) =>
    fetch(portal.url + path, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Origin: origin,
        Cookie: cookie,
        "X-Bzt-Account": account,
      },
      body: JSON.stringify(data),
    });
  try {
    const launch = new URLSearchParams(
      new URL(portal.launchUrl).hash.slice(1),
    ).get("launch");
    expect(launch).toMatch(/^[a-zA-Z0-9_-]{40,}$/u);
    const publicState = await fetch(portal.url + "/api/startup");
    expect(publicState.headers.get("X-Bzt-Portal-Instance")).toBe(
      portal.instanceId,
    );
    expect(await publicState.json()).toEqual({
      needsBaseUrl: false,
      hasSavedLogin: false,
    });
    expect(
      await (
        await fetch(portal.url + "/api/startup", {
          headers: { "X-Bzt-Launch": launch! },
        })
      ).json(),
    ).toEqual(startup);
    expect((await post("/api/login", { saved: true })).ok).toBe(false);
    expect(
      (await post("/api/login", { saved: true, launch: "forged" })).ok,
    ).toBe(false);
    expect(
      (
        await post(
          "/api/login",
          { saved: true, launch },
          "",
          "http://elsewhere.test",
        )
      ).status,
    ).toBe(403);
    expect(
      (
        await post("/api/login", {
          saved: true,
          launch,
          baseUrl: "https://elsewhere.test",
        })
      ).ok,
    ).toBe(false);
    expect(login).not.toHaveBeenCalled();
    login.mockRejectedValueOnce(new Error("private"));
    expect((await post("/api/login", { saved: true, launch })).ok).toBe(false);
    const success = await post("/api/login", { saved: true, launch });
    expect(success.ok).toBe(true);
    expect(login).toHaveBeenLastCalledWith("", "", {
      saved: true,
      localOwner: true,
    });
    expect(portal.launchUrl).not.toContain(launch!);
    expect((await post("/api/login", { saved: true, launch })).ok).toBe(false);
    const cookie = success.headers.get("set-cookie")!.split(";")[0]!;
    expect(
      await (
        await fetch(portal.url + "/api/session", {
          headers: { Cookie: cookie },
        })
      ).json(),
    ).toMatchObject({ roleSetup });
    const fields = { roles: ["RD"], revision: "first" };
    expect((await post("/api/roles", fields)).status).toBe(401);
    expect(
      (await post("/api/roles", fields, cookie, portal.url, "other")).status,
    ).toBe(409);
    expect(
      (await post("/api/roles", { ...fields, account: "other" }, cookie))
        .status,
    ).toBe(400);
    expect(saveRoles).not.toHaveBeenCalled();
    expect(
      await (await post("/api/roles", fields, cookie)).json(),
    ).toMatchObject({ roleSetup: { selected: ["RD"] } });
    expect(saveRoles).toHaveBeenCalledWith(["RD"], "first");
    saveRoles.mockRejectedValueOnce(new BztError("PLAN_STALE", "过期"));
    const stale = await post("/api/roles", fields, cookie);
    expect(stale.status).toBe(409);
    expect(await stale.json()).toMatchObject({
      code: "PLAN_STALE",
      message: expect.stringContaining("职责"),
    });
    expect(
      (
        await fetch(portal.url + "/api/startup", {
          headers: { "X-Bzt-Launch": launch! },
        })
      ).status,
    ).toBe(403);
  } finally {
    await portal.close();
  }
});
