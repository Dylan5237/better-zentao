import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { publishPortalLaunch } from "../../src/adapters/web/portal-launch.ts";
import { preparePortalStartup } from "../../src/services/portal-startup.ts";
import { fakeZentao } from "../eval/fake-zentao.ts";

const fixtureUrl = "https://eval.fixture.test/";
const profileName = "portal-identity.json";
const homes: string[] = [];

async function fixture() {
  const home = await mkdtemp(join(tmpdir(), "bzt-portal-startup-"));
  homes.push(home);
  const zentao = fakeZentao();
  const request = vi.fn(zentao.fake);
  vi.stubGlobal("fetch", request);
  return {
    home,
    request,
    runtime: {
      env: { BZT_HOME: home, BZT_CONFIG: join(home, "team.json") },
      homeDir: home,
      clock: () => 0,
      logSink: () => undefined,
    },
  };
}

afterEach(async () => {
  vi.unstubAllGlobals();
  for (const home of homes.splice(0)) {
    await rm(home, { recursive: true, force: true });
  }
});

describe("CR-002 WEB-01/05 门户启动与初次设置", () => {
  it("允许缺少默认团队配置，显式配置路径错误正常提示", async () => {
    const { runtime } = await fixture();
    await expect(preparePortalStartup(runtime, true)).resolves.toBeDefined();
    await expect(preparePortalStartup(runtime, false)).rejects.toMatchObject({
      code: "INVALID_INPUT",
    });
  });

  it("仅在本机入口验证身份成功后记住实例和账号，重启后仍可使用", async () => {
    const { home, request, runtime } = await fixture();
    const file = join(home, profileName);
    const portal = await preparePortalStartup(runtime, true);
    expect(portal.startup()).toEqual({
      needsBaseUrl: true,
      hasSavedLogin: false,
    });
    await expect(
      portal.login("alice", "demo", { baseUrl: fixtureUrl }),
    ).rejects.toMatchObject({ code: "PERMISSION_DENIED" });
    expect(request).not.toHaveBeenCalled();
    await expect(
      portal.login("other", "demo", { baseUrl: fixtureUrl, localOwner: true }),
    ).rejects.toMatchObject({ code: "AUTH_FAILED" });
    await expect(readFile(file)).rejects.toMatchObject({ code: "ENOENT" });

    const login = await portal.login("alice", "demo", {
      baseUrl: fixtureUrl,
      localOwner: true,
    });
    login.close();
    expect(JSON.parse(await readFile(file, "utf8"))).toEqual({
      baseUrl: fixtureUrl,
      account: "alice",
    });
    expect(portal.startup()).toEqual({
      needsBaseUrl: false,
      account: "alice",
      hasSavedLogin: false,
    });
    const restarted = await preparePortalStartup(runtime, true);
    expect(restarted.startup()).toEqual(portal.startup());
    const regularLogin = await restarted.login("alice", "demo");
    try {
      expect(regularLogin.readRoleSetup).toBeTypeOf("function");
    } finally {
      regularLogin.close();
    }
  });

  it("只允许本机入口把既有保存凭据发送给它绑定的环境实例", async () => {
    const { home, request, runtime } = await fixture();
    const portal = await preparePortalStartup(
      {
        ...runtime,
        env: {
          ...runtime.env,
          ZENTAO_BASE_URL: fixtureUrl,
          ZENTAO_ACCOUNT: "alice",
          ZENTAO_PASSWORD: "demo",
        },
      },
      true,
    );
    expect(portal.startup()).toEqual({
      needsBaseUrl: false,
      account: "alice",
      hasSavedLogin: true,
    });
    await expect(portal.login("", "", { saved: true })).rejects.toMatchObject({
      code: "PERMISSION_DENIED",
    });
    await expect(
      portal.login("", "", {
        saved: true,
        localOwner: true,
        baseUrl: "https://wrong.example.test",
      }),
    ).rejects.toMatchObject({ code: "PERMISSION_DENIED" });
    await expect(
      portal.login("alice", "demo", {
        localOwner: true,
        baseUrl: "https://wrong.example.test",
      }),
    ).rejects.toMatchObject({ code: "PERMISSION_DENIED" });
    expect(request).not.toHaveBeenCalled();
    const login = await portal.login("", "", { saved: true, localOwner: true });
    expect(login.identity.account).toBe("alice");
    login.close();
    expect(
      request.mock.calls.every(([url]) => String(url).startsWith(fixtureUrl)),
    ).toBe(true);
    await expect(readFile(join(home, profileName))).rejects.toMatchObject({
      code: "ENOENT",
    });
  });

  it("仅有环境账号和密码时先手工登录，曾手工输入的实例也不自动获得旧密码", async () => {
    const { request, runtime } = await fixture();
    const config = {
      ...runtime,
      env: { ...runtime.env, ZENTAO_ACCOUNT: "alice", ZENTAO_PASSWORD: "demo" },
    };
    const portal = await preparePortalStartup(config, true);
    expect(portal.startup()).toEqual({
      needsBaseUrl: true,
      account: "alice",
      hasSavedLogin: false,
    });
    await expect(
      portal.login("", "", { saved: true, localOwner: true }),
    ).rejects.toMatchObject({ code: "PERMISSION_DENIED" });
    expect(request).not.toHaveBeenCalled();
    const login = await portal.login("alice", "demo", {
      localOwner: true,
      baseUrl: fixtureUrl,
    });
    login.close();
    const restarted = await preparePortalStartup(config, true);
    expect(restarted.startup().hasSavedLogin).toBe(false);
    request.mockClear();
    await expect(
      restarted.login("", "", { saved: true, localOwner: true }),
    ).rejects.toMatchObject({ code: "PERMISSION_DENIED" });
    expect(request).not.toHaveBeenCalled();
  });

  it("已知启动者时，即使用本机链接验证其他账号也只按团队配置授予角色", async () => {
    const { home, runtime } = await fixture();
    const portal = await preparePortalStartup(
      {
        ...runtime,
        env: {
          ...runtime.env,
          ZENTAO_BASE_URL: fixtureUrl,
          ZENTAO_ACCOUNT: "bob",
        },
      },
      true,
    );
    const login = await portal.login("alice", "demo", { localOwner: true });
    try {
      expect(login.identity.account).toBe("alice");
      expect(login.readRoleSetup).toBeUndefined();
      expect(portal.startup().account).toBe("bob");
      await expect(readFile(join(home, profileName))).rejects.toMatchObject({
        code: "ENOENT",
      });
    } finally {
      login.close();
    }
  });
});

describe("CR-002 WEB-05 双击启动交接", () => {
  it("只发布带本机实例标记的回环链接，轮换后移除原令牌", async () => {
    const { home } = await fixture();
    const handoff = join(home, ".better-zentao", "portal-launch", "17329.html");
    const instance = "a".repeat(32);
    const first = "b".repeat(64);
    const second = "c".repeat(64);
    await expect(
      publishPortalLaunch(
        home,
        instance,
        `https://other.test/#launch=${first}`,
      ),
    ).rejects.toThrow();
    await expect(readFile(handoff)).rejects.toMatchObject({ code: "ENOENT" });
    await publishPortalLaunch(
      home,
      instance,
      `http://127.0.0.1:17329/#launch=${first}`,
    );
    expect(await readFile(handoff, "utf8")).toContain(
      `<meta name="bzt-portal-instance" content="${instance}">`,
    );
    await publishPortalLaunch(
      home,
      instance,
      `http://127.0.0.1:17329/#launch=${second}`,
    );
    const current = await readFile(handoff, "utf8");
    expect(current).toContain(`http://127.0.0.1:17329/#launch=${second}`);
    expect(current).not.toContain(first);
  });
});
