import { readFile, writeFile } from "node:fs/promises";
import { basename } from "node:path";
import { expect, it } from "vitest";
import {
  assignment,
  browser,
  confirmation,
  externalOrigin,
  filesBelow,
  login,
  password,
  tokenPath,
  useServerFixture,
  viewerPath,
} from "../helpers/server-fixture.ts";

const fixture = useServerFixture();
const work = {
  role: "RD",
  tool: "get_my_work",
  input: { groups: ["raised"] },
};
const credentials = { instanceId: "instanceA", account: "alice", password };

function denied(
  response: Awaited<ReturnType<ReturnType<typeof browser>["send"]>>,
) {
  expect(response.status).toBe(403);
  expect(response.body).toMatchObject({ code: "PERMISSION_DENIED" });
}

function securityHeaders(headers: Headers) {
  expect(headers.get("cache-control")).toBe("no-store");
  expect(headers.get("content-security-policy")).toBeTruthy();
  expect(headers.get("x-content-type-options")).toBe("nosniff");
  expect(headers.get("referrer-policy")).toBe("no-referrer");
  expect(headers.get("access-control-allow-origin")).not.toBe("*");
  expect(headers.get("access-control-allow-origin")).not.toBe(
    "https://other.invalid",
  );
  expect(headers.get("access-control-allow-credentials")).not.toBe("true");
}

it("SRV-AUTH-01 两个浏览器并行登录，各自以本人 Token 执行工具", async () => {
  const server = await fixture.start();
  const alice = browser(server);
  const bob = browser(server);
  const [aliceSession, bobSession] = await Promise.all([
    login(alice, "instanceA", "alice"),
    login(bob, "instanceA", "bob"),
  ]);
  expect(aliceSession.body).toMatchObject({
    instanceId: "instanceA",
    account: "alice",
    displayName: "instanceA-alice",
    csrfToken: expect.any(String),
    readOnly: true,
    roles: expect.arrayContaining([expect.objectContaining({ id: "RD" })]),
  });
  expect(bobSession.body).toMatchObject({
    instanceId: "instanceA",
    account: "bob",
  });
  expect(aliceSession.body).not.toHaveProperty("roleSetup");
  expect(bobSession.body).not.toHaveProperty("roleSetup");
  expect(alice.cookie()).not.toBe(bob.cookie());
  expect(alice.csrf()).not.toBe(bob.csrf());

  const upstream = fixture.upstream();
  const credentialsByAccount = new Map(
    upstream.requests
      .filter(({ path }) => path === viewerPath)
      .map(({ account, token }) => [account, token]),
  );
  expect(credentialsByAccount.size).toBe(2);
  expect(credentialsByAccount.get("alice")).toMatch(/^synthetic-srv-token-/u);
  expect(credentialsByAccount.get("bob")).toMatch(/^synthetic-srv-token-/u);
  expect(credentialsByAccount.get("alice")).not.toBe(
    credentialsByAccount.get("bob"),
  );

  const before = upstream.requests.length;
  const [aliceWork, bobWork] = await Promise.all([
    alice.call(work),
    bob.call(work),
  ]);
  expect(aliceWork.status).toBe(200);
  expect(bobWork.status).toBe(200);
  expect(aliceWork.body).toMatchObject({
    scope: { filters: { account: "alice" } },
  });
  expect(bobWork.body).toMatchObject({
    scope: { filters: { account: "bob" } },
  });
  expect(upstream.requests.slice(before)).toEqual(
    expect.arrayContaining(
      (["alice", "bob"] as const).map((account) =>
        expect.objectContaining({
          account,
          token: credentialsByAccount.get(account),
          path: "/api.php/v2/my/contribute",
        }),
      ),
    ),
  );
});

it.each(["密码错误", "上游身份不一致"])(
  "SRV-AUTH-01 %s 返回 401，未签发会话或创建状态库",
  async (reason) => {
    const client = browser(await fixture.start());
    const upstream = fixture.upstream();
    if (reason === "上游身份不一致") upstream.mismatchViewer();
    const result = await client.send("/api/login", {
      ...credentials,
      password: reason === "密码错误" ? "synthetic-wrong-password" : password,
    });
    expect(result.status).toBe(401);
    expect(result.body).toMatchObject({ code: "AUTH_FAILED" });
    expect(result.headers.getSetCookie()).toEqual([]);
    expect(upstream.requests.map(({ path }) => path)).toContain(tokenPath);
    if (reason === "上游身份不一致")
      expect(upstream.requests.map(({ path }) => path)).toContain(viewerPath);
    expect(
      (await filesBelow(fixture.root())).map((path) => basename(path)),
    ).not.toContain("state.db");
    securityHeaders(result.headers);
  },
);

it("SRV-AUTH-02 重登轮换会话，客户端声明无法切换主体、实例或职责", async () => {
  const client = browser(await fixture.start());
  const forged = "__Host-bzt_session=synthetic-fixed-session";
  const initial = await client.send("/api/login", credentials, {
    Cookie: forged,
  });
  expect(initial.status).toBe(200);
  const old = client.cookie();
  expect(old).toBeTruthy();
  expect(old).not.toBe(forged);
  await login(client);
  expect(client.cookie()).not.toBe(old);
  expect(
    (await client.send("/api/session", undefined, { Cookie: old })).status,
  ).toBe(401);
  expect(
    (await client.send("/api/session", undefined, { Cookie: forged })).status,
  ).toBe(401);

  const stillAlice = await client.send("/api/session", undefined, {
    "X-Bzt-Account": "bob",
    "X-Bzt-Instance": "instanceB",
    "X-Bzt-Role": "PM",
  });
  expect(stillAlice.status).toBe(200);
  expect(stillAlice.body).toMatchObject({
    instanceId: "instanceA",
    account: "alice",
  });
  expect(stillAlice.body).toHaveProperty("roles");
  expect(stillAlice.body).not.toMatchObject({
    roles: expect.arrayContaining([expect.objectContaining({ id: "PM" })]),
  });

  const upstream = fixture.upstream();
  const before = upstream.requests.length;
  const injected = await client.call({
    ...work,
    account: "bob",
    instanceId: "instanceB",
    roles: ["PM"],
  });
  expect([400, 403]).toContain(injected.status);
  denied(await client.call({ ...work, role: "PM" }));
  expect(upstream.requests).toHaveLength(before);
});

it("SRV-AUTH-03 集中登录拒绝本机参数，启动信息只给实例选项", async () => {
  const client = browser(await fixture.start());
  const startup = await client.send("/api/startup");
  expect(startup.status).toBe(200);
  expect(startup.body).toMatchObject({
    mode: "server",
    readOnly: true,
    instances: expect.anything(),
  });
  expect(JSON.stringify(startup.body)).toContain("instanceA");
  expect(JSON.stringify(startup.body)).toContain("Fixture A");
  expect(JSON.stringify(startup.body)).not.toContain("instancea.invalid");
  expect(startup.body).not.toHaveProperty("hasSavedLogin");
  expect(startup.body).not.toHaveProperty("needsBaseUrl");
  const files = (await filesBelow(fixture.root())).sort();

  for (const extra of [
    { launch: "synthetic-launch" },
    { baseUrl: "https://unregistered.invalid" },
    { saved: true },
  ]) {
    const result = await client.send("/api/login", {
      ...credentials,
      ...extra,
    });
    expect(result.status).toBe(400);
    expect(result.headers.getSetCookie()).toEqual([]);
    securityHeaders(result.headers);
  }
  expect(fixture.upstream().fetcher).not.toHaveBeenCalled();
  expect((await filesBelow(fixture.root())).sort()).toEqual(files);
});

it("SRV-SEC-01 可信 HTTPS 反代下发安全 Cookie，并在业务前拒绝错误来源和 CSRF", async () => {
  const server = await fixture.start();
  expect(server.externalOrigin).toBe(externalOrigin);
  expect(server.port).toBeGreaterThan(0);
  const client = browser(server);
  const health = await client.send("/healthz");
  expect(health.status).toBe(200);
  expect(health.body).toEqual({ ok: true, mode: "server" });
  securityHeaders(health.headers);

  const attempts = [
    { Host: "other.invalid" },
    { Origin: "https://other.invalid" },
    { "X-Forwarded-Proto": "http" },
    { "Content-Type": "text/plain" },
  ];
  for (const headers of attempts) {
    const response = await client.send("/api/login", credentials, headers);
    expect(response.status, JSON.stringify(headers)).toBe(403);
    expect(response.headers.getSetCookie()).toEqual([]);
    securityHeaders(response.headers);
  }
  const upstream = fixture.upstream();
  expect(upstream.fetcher).not.toHaveBeenCalled();

  const authenticated = await client.login();
  expect(authenticated.status).toBe(200);
  const cookies = authenticated.headers.getSetCookie();
  expect(cookies).toHaveLength(1);
  expect(cookies[0]).toMatch(/^__Host-bzt_session=[^;\s]+;/u);
  expect(cookies[0]).toMatch(/;\s*Path=\/(?:;|$)/iu);
  expect(cookies[0]).toMatch(/;\s*HttpOnly(?:;|$)/iu);
  expect(cookies[0]).toMatch(/;\s*Secure(?:;|$)/iu);
  expect(cookies[0]).toMatch(/;\s*SameSite=Strict(?:;|$)/iu);
  expect(cookies[0]).not.toMatch(/;\s*Domain=/iu);
  expect(authenticated.headers.get("strict-transport-security")).toMatch(
    /max-age=[1-9]\d*/iu,
  );
  securityHeaders(authenticated.headers);

  await client.send("/api/session");
  const otherClient = browser(server);
  await login(otherClient, "instanceA", "bob");
  const before = upstream.requests.length;
  for (const csrf of [undefined, "synthetic-wrong-csrf", otherClient.csrf()]) {
    for (const [path, body] of [
      ["/api/call", work],
      ["/api/updates", { role: "RD" }],
      ["/api/logout", {}],
    ] as const) {
      const response = await client.send(path, body, { "X-Bzt-Csrf": csrf });
      expect(response.status, path).toBe(403);
      securityHeaders(response.headers);
    }
  }
  expect(upstream.requests).toHaveLength(before);
  expect((await client.send("/api/session")).status).toBe(200);
  const accepted = await client.call(work);
  expect(accepted.status).toBe(200);
  securityHeaders(accepted.headers);
});

it("SRV-SEC-01 未登记反代源地址无法用转发协议头通过校验", async () => {
  const client = browser(
    await fixture.start({ trustedProxies: ["192.0.2.10"] }),
  );
  const rejected = await client.send("/api/login", credentials, {
    "X-Forwarded-Proto": "https",
    "X-Forwarded-For": "192.0.2.10",
  });
  expect(rejected.status).toBe(403);
  expect(rejected.headers.getSetCookie()).toEqual([]);
  securityHeaders(rejected.headers);
  expect(fixture.upstream().fetcher).not.toHaveBeenCalled();
});

it("SRV-SEC-02 未登记实例在发出请求之前被拒绝", async () => {
  const client = browser(await fixture.start());
  const response = await client.send("/api/login", {
    ...credentials,
    instanceId: "unregistered",
  });
  expect([400, 403]).toContain(response.status);
  expect(response.headers.getSetCookie()).toEqual([]);
  securityHeaders(response.headers);
  expect(fixture.upstream().fetcher).not.toHaveBeenCalled();
});

it("SRV-SEC-02 上游重定向不能把认证请求带到未登记地址", async () => {
  const client = browser(await fixture.start());
  const upstream = fixture.upstream();
  upstream.redirectViewer();
  const response = await client.login();
  expect(response.status).toBeGreaterThanOrEqual(400);
  expect(response.headers.getSetCookie()).toEqual([]);
  expect(upstream.requests.map(({ path }) => path)).toContain(viewerPath);
  expect(upstream.unexpected).toEqual([]);
  expect((await client.send("/api/session")).status).toBe(401);
});

it("SRV-SEC-02 成功与失败链路均不泄露密码、上游 Token 或原始人员字段", async () => {
  const server = await fixture.start();
  const client = browser(server);
  const loggedIn = await client.login();
  expect(loggedIn.status).toBe(200);
  const session = await client.send("/api/session");
  expect(session.status).toBe(200);
  const read = await client.call(work);
  expect(read.status).toBe(200);
  const upstream = fixture.upstream();
  upstream.fail("instanceA", "alice", viewerPath, 401);
  const failed = await browser(server).login();
  expect(failed.status).toBe(401);
  expect(failed.headers.getSetCookie()).toEqual([]);
  expect(upstream.tokens()).toHaveLength(2);
  const captureFiles = async () =>
    Promise.all(
      (await filesBelow(fixture.root())).map((path) => readFile(path, "utf8")),
    );
  const opened = await captureFiles();
  await fixture.close(server);
  const capture = JSON.stringify([
    ...[loggedIn, session, read, failed].map(({ body, headers }) => [
      body,
      [...headers],
    ]),
    fixture.logs,
    opened,
    await captureFiles(),
  ]);
  for (const secret of [
    password,
    ...upstream.tokens(),
    "synthetic-upstream-password-hash",
    "synthetic-upstream-directory-value",
  ])
    expect(capture).not.toContain(secret);
});

it("SRV-RBAC-01 集中端禁止角色自助修改与默认只读模式下的预览和确认", async () => {
  const client = browser(await fixture.start());
  await login(client);
  expect((await client.call(work)).status).toBe(200);
  const teamFile = fixture.teamPath("instanceA");
  const team = await readFile(teamFile, "utf8");
  const upstream = fixture.upstream();
  const before = upstream.requests.length;
  denied(
    await client.send("/api/roles", { roles: ["PM"], revision: "fixture" }),
  );
  denied(await client.call(assignment));
  denied(
    await client.call({
      role: "RD",
      tool: "create_story",
      input: {
        product: 29,
        module: 3,
        title: "synthetic-story",
        spec: { background: "fixture", scope: "fixture" },
        verify: "fixture",
      },
    }),
  );
  denied(await client.call(confirmation("op_01KB0000000000000000000000")));
  expect(upstream.requests).toHaveLength(before);
  expect(await readFile(teamFile, "utf8")).toBe(team);
});

it("SRV-RBAC-02 撤销职责立即拒绝工具和旧预览，恢复职责也不能复活预览", async () => {
  const client = browser(await fixture.start({ readOnly: false }));
  await login(client);
  const prepared = await client.call(assignment);
  expect(prepared.status).toBe(200);
  const { opId } = expectOpId(prepared.body);
  fixture.advance(3001);

  const file = fixture.teamPath("instanceA");
  const original = await readFile(file, "utf8");
  await writeFile(
    file,
    JSON.stringify({ roles: { RM: ["bob"], RD: ["alice", "bob"] } }),
  );
  denied(await client.call(confirmation(opId)));
  denied(await client.call(assignment));
  const sessionAfterRevocation = await client.send("/api/session");
  expect(sessionAfterRevocation.status).toBe(200);
  expect(sessionAfterRevocation.body).toMatchObject({
    roles: expect.arrayContaining([expect.objectContaining({ id: "RD" })]),
  });
  expect(sessionAfterRevocation.body).not.toMatchObject({
    roles: expect.arrayContaining([expect.objectContaining({ id: "RM" })]),
  });

  await writeFile(file, original);
  const restored = await client.send("/api/session");
  expect(restored.body).toMatchObject({
    roles: expect.arrayContaining([expect.objectContaining({ id: "RM" })]),
  });
  denied(await client.call(confirmation(opId)));
  expect(fixture.upstream().writes()).toEqual([]);
});

function expectOpId(body: unknown) {
  expect(body).toMatchObject({ opId: expect.any(String) });
  return body as { opId: string };
}
