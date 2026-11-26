import { describe, it, expect, vi } from "vitest";
import { startPortal } from "../../src/adapters/web/server.ts";
import { runWebCommand } from "../../src/adapters/web/command.ts";
import { projectToolError } from "../../src/services/workbench.ts";

describe("CR-002 WEB-02/05 本地 HTTP 门户", () => {
  it("慢查询期间可以退出，只在旧操作结束后关闭其账号库", async () => {
    const started = Promise.withResolvers<void>();
    const release = Promise.withResolvers<void>();
    const close = vi.fn();
    const portal = await startPortal({
      port: 0,
      clock: () => 1000,
      login: async () => ({
        identity: { account: "reader", roles: [] },
        readRoles: async () => [],
        projectError: projectToolError,
        close,
        call: async () => {
          started.resolve();
          await release.promise;
          return { privateData: true };
        },
      }),
    });
    const send = (path: string, data: unknown, cookie = "") =>
      fetch(portal.url + path, {
        method: "POST",
        headers: {
          Origin: portal.url,
          "Content-Type": "application/json",
          Cookie: cookie,
          "X-Bzt-Account": "reader",
        },
        body: JSON.stringify(data),
      });
    try {
      const account = await send("/api/login", {
        account: "reader",
        password: "demo",
      });
      const cookie = account.headers.get("set-cookie")!.split(";")[0]!;
      const pending = send(
        "/api/call",
        { role: "RD", tool: "get_my_work", input: {} },
        cookie,
      );
      await started.promise;
      const logout = await send("/api/logout", {}, cookie);
      expect(logout.status).toBe(200);
      expect(close).not.toHaveBeenCalled();
      release.resolve();
      const old = await pending;
      expect(old.status).toBe(401);
      expect(await old.text()).not.toContain("privateData");
      expect(close).toHaveBeenCalledOnce();
    } finally {
      release.resolve();
      await portal.close();
    }
  });
  it("命令行拒绝外网监听、重复端口和空配置路径", async () => {
    const runtime = {
      env: {},
      clock: () => 0,
      stdout: vi.fn(),
      stderr: vi.fn(),
    };
    expect(await runWebCommand(["--host", "0.0.0.0"], runtime)).toBe(2);
    expect(await runWebCommand(["--port", "20", "--port", "21"], runtime)).toBe(
      2,
    );
    expect(await runWebCommand(["--port", "70000"], runtime)).toBe(2);
    expect(await runWebCommand(["--config", " "], runtime)).toBe(2);
  });
  it("登录、页面刷新、换号与退出均通过同一本机入口", async () => {
    let now = 1000;
    const close = vi.fn();
    const login = vi.fn(async (account: string, password: string) => {
      if (password !== "demo") throw new Error("private diagnostic");
      return {
        identity: { account, roles: [] },
        readRoles: async () => [],
        projectError: projectToolError,
        close,
        call: vi.fn(async () => ({ ok: true })),
      };
    });
    const portal = await startPortal({ port: 0, login, clock: () => now });
    const post = (
      path: string,
      body: unknown,
      cookie = "",
      origin = portal.url,
      account = "a",
    ) =>
      fetch(portal.url + path, {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          Origin: origin,
          Cookie: cookie,
          "X-Bzt-Account": account,
        },
        body: JSON.stringify(body),
      });
    try {
      expect(new URL(portal.url).hostname).toBe("127.0.0.1");
      expect((await fetch(portal.url + "/api/session")).status).toBe(401);
      expect(
        (
          await post(
            "/api/login",
            { account: "a", password: "demo" },
            "",
            "http://other.test",
          )
        ).status,
      ).toBe(403);
      expect(login).not.toHaveBeenCalled();
      expect(
        (
          await post("/api/login", {
            account: "a",
            password: "demo",
            role: "PM",
          })
        ).status,
      ).toBe(400);
      const failed = await post("/api/login", {
        account: "a",
        password: "wrong",
      });
      expect(failed.ok).toBe(false);
      expect(await failed.text()).not.toContain("private diagnostic");
      const success = await post("/api/login", {
        account: "a",
        password: "demo",
      });
      expect(await success.json()).toEqual({ account: "a", roles: [] });
      expect(success.headers.get("set-cookie")).toMatch(/HttpOnly/u);
      const cookie = success.headers.get("set-cookie")!.split(";")[0]!;
      expect(
        (
          await fetch(portal.url + "/api/session", {
            headers: { Cookie: cookie },
          })
        ).status,
      ).toBe(200);
      expect(
        (
          await post(
            "/api/call",
            { role: "PM", tool: "query_stories", input: {} },
            cookie,
            portal.url,
            "stale",
          )
        ).status,
      ).toBe(409);
      const swapped = await post("/api/login", {
        account: "b",
        password: "demo",
      });
      const next = swapped.headers.get("set-cookie")!.split(";")[0]!;
      expect(next).not.toEqual(cookie);
      expect((await post("/api/logout", {}, cookie)).status).toBe(401);
      expect((await post("/api/logout", {}, next, portal.url, "b")).ok).toBe(
        true,
      );
      expect(
        (
          await fetch(portal.url + "/api/session", {
            headers: { Cookie: next },
          })
        ).status,
      ).toBe(401);
      expect(close).toHaveBeenCalledTimes(2);
      const last = await post("/api/login", { account: "a", password: "demo" });
      const expired = last.headers.get("set-cookie")!.split(";")[0]!;
      now += 8 * 60 * 60 * 1000;
      expect(
        (
          await fetch(portal.url + "/api/session", {
            headers: { Cookie: expired },
          })
        ).status,
      ).toBe(401);
      expect(close).toHaveBeenCalledTimes(3);
    } finally {
      await portal.close();
    }
  });
});
