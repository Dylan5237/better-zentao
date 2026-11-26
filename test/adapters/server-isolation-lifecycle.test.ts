import { writeFile } from "node:fs/promises";
import { basename } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { expect, it } from "vitest";
import { instanceHashOf } from "../../src/core/store/location.ts";
import {
  assignment,
  assignmentPath,
  browser,
  confirmation,
  detail,
  filesBelow,
  login,
  operation,
  report,
  reportPath,
  storyPath,
  tokenPath,
  useServerFixture,
} from "../helpers/server-fixture.ts";

const fixture = useServerFixture();
const hour = 60 * 60 * 1000;
type Browser = ReturnType<typeof browser>;
type Reply = Awaited<ReturnType<Browser["send"]>>;

function expectReport(response: Reply, title: string) {
  expect(response.status).toBe(200);
  expect(response.body).toMatchObject({
    completeness: "complete",
    data: {
      items: expect.arrayContaining([
        expect.objectContaining({ id: 101, title }),
      ]),
    },
  });
}

function expectPermissionDenied(response: Reply) {
  expect(response.status).toBe(403);
  expect(response.body).toMatchObject({ code: "PERMISSION_DENIED" });
}

async function prepare(client: Browser) {
  const response = await client.call(assignment);
  expect(response.status).toBe(200);
  expect(response.body).toMatchObject({ opId: expect.any(String) });
  return (response.body as { opId: string }).opId;
}

it("SRV-ISO-01 两实例同账号、同编号需求在 HTTP 和 SQLite 两侧都隔离", async () => {
  const server = await fixture.start();
  const a = browser(server);
  const b = browser(server);
  const [sessionA, sessionB] = await Promise.all([
    login(a, "instanceA"),
    login(b, "instanceB"),
  ]);
  expect(sessionA.body).toMatchObject({
    instanceId: "instanceA",
    account: "alice",
  });
  expect(sessionB.body).toMatchObject({
    instanceId: "instanceB",
    account: "alice",
  });
  const { instanceA, instanceB } = fixture.upstream().instances;

  const [reportA, reportB, detailA, detailB] = await Promise.all([
    a.call(report),
    b.call(report),
    a.call(detail),
    b.call(detail),
  ]);
  expectReport(reportA, instanceA.initialTitle);
  expectReport(reportB, instanceB.initialTitle);
  expect(detailA.status).toBe(200);
  expect(detailB.status).toBe(200);
  expect(JSON.stringify(detailA.body)).toContain(instanceA.initialTitle);
  expect(JSON.stringify(detailB.body)).toContain(instanceB.initialTitle);
  expect(JSON.stringify([reportA.body, detailA.body])).not.toContain(
    instanceB.initialTitle,
  );
  expect(JSON.stringify([reportB.body, detailB.body])).not.toContain(
    instanceA.initialTitle,
  );

  const paths = (await filesBelow(fixture.root())).filter(
    (path) => basename(path) === "state.db",
  );
  expect(paths).toHaveLength(2);
  const owners = paths.map((path) => {
    const db = new DatabaseSync(path, { readOnly: true });
    try {
      const owner = db
        .prepare("SELECT instance_hash, account FROM store_meta")
        .get();
      const cache = db
        .prepare("SELECT instance_hash, account, value FROM cache_kv")
        .all();
      expect(owner).toMatchObject({ account: "alice" });
      const storedA =
        owner?.instance_hash === instanceHashOf(instanceA.baseUrl);
      expect(cache).not.toHaveLength(0);
      expect(
        cache.every(
          ({ instance_hash, account }) =>
            instance_hash === owner?.instance_hash && account === "alice",
        ),
      ).toBe(true);
      const cached = JSON.stringify(cache);
      expect(cached).toContain(
        storedA ? instanceA.initialTitle : instanceB.initialTitle,
      );
      expect(cached).not.toContain(
        storedA ? instanceB.initialTitle : instanceA.initialTitle,
      );
      return owner;
    } finally {
      db.close();
    }
  });
  expect(owners).toEqual(
    expect.arrayContaining(
      [instanceA, instanceB].map(({ baseUrl }) => ({
        instance_hash: instanceHashOf(baseUrl),
        account: "alice",
      })),
    ),
  );
});

it("SRV-ISO-03 角色撤销优先于读取未过期报表缓存", async () => {
  const client = browser(await fixture.start());
  await login(client);
  const upstream = fixture.upstream();
  expectReport(
    await client.call(report),
    upstream.instances.instanceA.initialTitle,
  );
  const before = upstream.requests.length;
  // 同一账号和同一缓存键，管理员撤销该工具所选职责。
  await writeFile(
    fixture.teamPath("instanceA"),
    JSON.stringify({
      roles: { RM: ["bob"], RD: ["alice", "bob"] },
    }),
  );
  expectPermissionDenied(await client.call({ ...report, readMode: "cached" }));
  expectPermissionDenied(await client.call(report));
  expect(upstream.requests).toHaveLength(before);
});

it("SRV-ISO-03 同账号第二会话提交写入后，迟到报表不恢复旧缓存", async () => {
  const server = await fixture.start({ readOnly: false });
  const reader = browser(server);
  const writer = browser(server);
  await Promise.all([login(reader), login(writer)]);
  const upstream = fixture.upstream();
  const { initialTitle, story } = upstream.instances.instanceA;
  expectReport(await reader.call(report), initialTitle);
  const opId = await prepare(writer);
  fixture.advance(3001);
  const slow = upstream.pauseNextDetail();
  const pending = reader.call({ ...report, readMode: "sync" });
  try {
    await Promise.race([
      slow.started,
      pending.then(() => {
        throw new Error("慢报表提前结束，未进入假禅道暂停点。");
      }),
    ]);
    const result = await writer.call(confirmation(opId));
    expect(result.status).toBe(200);
    expect(result.body).toMatchObject({ opId, status: "confirmed" });
    expect(upstream.writes()).toEqual([
      expect.objectContaining({ account: "alice", path: assignmentPath }),
    ]);
    expect(story.assignedTo).toBe("bob");
    // 模拟写入完成后禅道的下一版对象。暂停中的响应仍持有旧副本。
    story.title = "fixture-story-after-write";
  } finally {
    slow.release();
    await pending;
  }
  const cached = await reader.call({ ...report, readMode: "cached" });
  expect(JSON.stringify(cached.body)).not.toContain(initialTitle);
  expectReport(await writer.call(report), story.title);
});

it("SRV-ISO-03 报表到短 TTL 后重新读取，直接详情在 TTL 内也向上游验证", async () => {
  const client = browser(
    await fixture.start({ cache: { reportTtlSeconds: 2 } }),
  );
  await login(client);
  const upstream = fixture.upstream();
  const { initialTitle, story } = upstream.instances.instanceA;
  expectReport(await client.call(report), initialTitle);
  const initialDetail = await client.call(detail);
  expect(initialDetail.status).toBe(200);
  expect(JSON.stringify(initialDetail.body)).toContain(initialTitle);

  story.title = "fixture-upstream-changed-title";
  story.spec = `<h3>本次实现范围</h3><p>${story.title}</p>`;
  fixture.advance(1000);
  const reportReads = upstream.requests.filter(
    ({ path }) => path === reportPath,
  ).length;
  expectReport(await client.call(report), initialTitle);
  expect(
    upstream.requests.filter(({ path }) => path === reportPath),
  ).toHaveLength(reportReads);
  const detailReads = upstream.requests.filter(
    ({ path }) => path === storyPath,
  ).length;
  const latest = await client.call(detail);
  expect(latest.status).toBe(200);
  expect(JSON.stringify(latest.body)).toContain(story.title);
  expect(
    upstream.requests.filter(({ path }) => path === storyPath),
  ).toHaveLength(detailReads + 1);

  fixture.advance(1001);
  expectReport(await client.call(report), story.title);
  expect(
    upstream.requests.filter(({ path }) => path === reportPath).length,
  ).toBeGreaterThan(reportReads);
});

it("SRV-ISO-03 缓存已预热时上游 403 也淘汰旧报表，并阻止直接详情回退", async () => {
  const client = browser(await fixture.start());
  await login(client);
  const upstream = fixture.upstream();
  const { initialTitle } = upstream.instances.instanceA;
  expectReport(await client.call(report), initialTitle);
  expect((await client.call(detail)).status).toBe(200);
  upstream.fail("instanceA", "alice", reportPath, 403);
  upstream.fail("instanceA", "alice", storyPath, 403);
  const denied = await client.call({ ...report, readMode: "sync" });
  if (denied.status === 200) {
    // 聚合读取允许带权限缺口的部分结果。
    expect(denied.body).toMatchObject({
      completeness: "partial",
      gaps: expect.arrayContaining([expect.anything()]),
    });
  } else {
    expectPermissionDenied(denied);
  }
  expect(JSON.stringify(denied.body)).not.toContain(initialTitle);
  expect(
    JSON.stringify((await client.call({ ...report, readMode: "cached" })).body),
  ).not.toContain(initialTitle);
  const deniedDetail = await client.call(detail);
  expectPermissionDenied(deniedDetail);
  expect(JSON.stringify(deniedDetail.body)).not.toContain(initialTitle);
  expect((await client.send("/api/session")).status).toBe(200);
});

it("SRV-OP-01 未执行预览绑定会话，已派发回执只对原主体跨重启可读", async () => {
  const server = await fixture.start({ readOnly: false });
  const owner = browser(server);
  const other = browser(server);
  const otherInstance = browser(server);
  const secondSession = browser(server);
  await Promise.all([
    login(owner),
    login(other, "instanceA", "bob"),
    login(otherInstance, "instanceB"),
    login(secondSession),
  ]);
  const opId = await prepare(owner);
  fixture.advance(3001);
  for (const client of [other, otherInstance]) {
    expectPermissionDenied(await client.call(operation(opId)));
    expectPermissionDenied(await client.call(confirmation(opId)));
  }
  expectPermissionDenied(await secondSession.call(confirmation(opId)));
  const upstream = fixture.upstream();
  expect(upstream.writes()).toEqual([]);

  const result = await owner.call(confirmation(opId));
  expect(result.status).toBe(200);
  expect(result.body).toMatchObject({ opId, status: "confirmed" });
  expect(upstream.writes()).toHaveLength(1);
  for (const client of [other, otherInstance]) {
    expectPermissionDenied(await client.call(operation(opId)));
    expectPermissionDenied(await client.call(confirmation(opId)));
  }

  await fixture.close(server);
  const restarted = await fixture.start({ readOnly: false });
  const originalOwner = browser(restarted);
  await login(originalOwner);
  const receipt = await originalOwner.call(operation(opId));
  expect(receipt.status).toBe(200);
  expect(receipt.body).toMatchObject({ data: { opId, status: "confirmed" } });
  expect(upstream.writes()).toHaveLength(1);
});

it("Gate A 禅道外部编辑能发生，确认时重新核对预览目标", async () => {
  const client = browser(await fixture.start({ readOnly: false }));
  await login(client);
  const opId = await prepare(client);
  const upstream = fixture.upstream();
  upstream.instances.instanceA.story.spec = "<p>假禅道原生页面提交的新正文</p>";
  fixture.advance(3001);

  const stale = await client.call(confirmation(opId));
  expect(stale.status).toBe(409);
  expect(stale.body).toMatchObject({ code: "PLAN_STALE" });
  expect(upstream.writes()).toEqual([]);
});

it("SRV-LIFE-01 8 小时空闲期限不被后台更新探测延长", async () => {
  const client = browser(await fixture.start());
  await login(client);
  fixture.advance(8 * hour - 1);
  const update = await client.send("/api/updates", { role: "RM" });
  expect(update.status).toBe(200);
  fixture.advance(1);
  const session = await client.send("/api/session");
  expect(session.status).toBe(401);
  expect(session.body).toMatchObject({ code: "AUTH_FAILED" });
});

it("SRV-LIFE-01 活跃会话到 24 小时绝对期限仍被撤销", async () => {
  const client = browser(await fixture.start());
  await login(client);
  for (const interval of [7 * hour, 7 * hour, 7 * hour, 3 * hour - 1]) {
    fixture.advance(interval);
    expect((await client.send("/api/session")).status).toBe(200);
  }
  fixture.advance(1);
  const expired = await client.send("/api/session");
  expect(expired.status).toBe(401);
  expect(expired.body).toMatchObject({ code: "AUTH_FAILED" });
});

it("SRV-LIFE-01 主动登出清 Cookie、丢弃在途旧结果，另一会话可继续", async () => {
  const server = await fixture.start();
  const alice = browser(server);
  const bob = browser(server);
  await Promise.all([login(alice), login(bob, "instanceA", "bob")]);
  const old = alice.cookie();
  const upstream = fixture.upstream();
  const slow = upstream.pauseNextDetail();
  const pending = alice.call(detail);
  try {
    await Promise.race([
      slow.started,
      pending.then(() => {
        throw new Error("需求详情提前结束，未进入假禅道暂停点。");
      }),
    ]);
    const logout = await alice.send("/api/logout", {});
    expect(logout.status).toBe(200);
    const cleared = logout.headers.getSetCookie()[0];
    expect(cleared).toMatch(/^__Host-bzt_session=;/u);
    const expiry = cleared?.match(/;\s*Expires=([^;]+)/iu)?.[1];
    expect(
      /;\s*Max-Age=0(?:;|$)/iu.test(cleared ?? "") ||
        (expiry !== undefined && Date.parse(expiry) < Date.UTC(2026, 10, 26)),
    ).toBe(true);
    expect(alice.cookie()).toBeUndefined();
    expect(
      (await alice.send("/api/session", undefined, { Cookie: old })).status,
    ).toBe(401);
    const stillBob = await bob.send("/api/session");
    expect(stillBob.status).toBe(200);
    expect(stillBob.body).toMatchObject({ account: "bob" });
  } finally {
    slow.release();
    await pending;
  }
  const revoked = await pending;
  expect(revoked.status).toBe(401);
  expect(JSON.stringify(revoked.body)).not.toContain(
    upstream.instances.instanceA.initialTitle,
  );
});

it("SRV-ISO-03 / SRV-LIFE-02 上游 401 撤销受影响会话，不回退报表或重新换 Token", async () => {
  const server = await fixture.start();
  const alice = browser(server);
  const bob = browser(server);
  await Promise.all([login(alice), login(bob, "instanceA", "bob")]);
  const upstream = fixture.upstream();
  const { initialTitle, story } = upstream.instances.instanceA;
  expectReport(await alice.call(report), initialTitle);
  upstream.fail("instanceA", "alice", reportPath, 401);
  const expired = await alice.call({ ...report, readMode: "sync" });
  expect(expired.status).toBe(401);
  expect(expired.body).toMatchObject({ code: "AUTH_FAILED" });
  expect(JSON.stringify(expired.body)).not.toContain(initialTitle);
  expect((await alice.send("/api/session")).status).toBe(401);
  expect((await alice.call(report)).status).toBe(401);
  const stillBob = await bob.send("/api/session");
  expect(stillBob.status).toBe(200);
  expect(stillBob.body).toMatchObject({ account: "bob" });
  expect(
    upstream.requests.filter(({ path }) => path === tokenPath),
  ).toHaveLength(2);

  upstream.fail("instanceA", "alice", reportPath);
  story.title = "fixture-story-after-reauth";
  await login(alice);
  expectReport(await alice.call(report), story.title);
  expect(
    upstream.requests.filter(({ path }) => path === tokenPath),
  ).toHaveLength(3);
});

it("SRV-LIFE-03 重启释放数据目录锁，旧 Cookie 一律失效", async () => {
  const first = await fixture.start();
  const clients = [browser(first), browser(first)];
  await Promise.all([
    login(clients[0]!),
    login(clients[1]!, "instanceA", "bob"),
  ]);
  const oldCookies = clients.map((client) => client.cookie());
  expect(oldCookies.every(Boolean)).toBe(true);
  await expect(fixture.start()).rejects.toThrow();
  await fixture.close(first);

  const fresh = browser(await fixture.start());
  for (const Cookie of oldCookies) {
    const session = await fresh.send("/api/session", undefined, { Cookie });
    expect(session.status).toBe(401);
    expect(session.body).toMatchObject({ code: "AUTH_FAILED" });
  }
  const session = await login(fresh);
  expect(session.body).toMatchObject({
    account: "alice",
    instanceId: "instanceA",
  });
});

it("Gate C P1-1 退出发生在确认预检期间时中止派发，不向禅道发送写入", async () => {
  const client = browser(await fixture.start({ readOnly: false }));
  await login(client);
  const opId = await prepare(client);
  fixture.advance(3001);
  const upstream = fixture.upstream();
  const slow = upstream.pauseNextDetail();
  const pending = client.call(confirmation(opId));
  try {
    await Promise.race([
      slow.started,
      pending.then(() => {
        throw new Error("确认预检未命中暂停点。");
      }),
    ]);
    const loggedOut = await client.send("/api/logout", {});
    expect(loggedOut.status).toBe(200);
  } finally {
    slow.release();
  }
  const result = await pending;
  expect(result.status).toBe(401);
  expect(upstream.writes()).toEqual([]);
});

it("Gate C P1-3 详情返回 403/404 时失效缓存，且缩短 TTL 后旧快照立即失效", async () => {
  const first = await fixture.start();
  const client = browser(first);
  await login(client);
  const upstream = fixture.upstream();
  const { initialTitle } = upstream.instances.instanceA;
  expectReport(await client.call(report), initialTitle);
  upstream.fail("instanceA", "alice", storyPath, 403);
  expectPermissionDenied(await client.call(detail));
  const cachedAfter403 = await client.call({ ...report, readMode: "cached" });
  expect(JSON.stringify(cachedAfter403.body)).not.toContain(initialTitle);

  upstream.fail("instanceA", "alice", storyPath);
  expectReport(await client.call(report), initialTitle);
  upstream.fail("instanceA", "alice", storyPath, 404);
  const notFound = await client.call(detail);
  expect(notFound.status).toBe(400);
  expect(notFound.body).toMatchObject({
    ok: false,
    code: "NOT_FOUND",
  });
  const cachedAfter404 = await client.call({ ...report, readMode: "cached" });
  expect(JSON.stringify(cachedAfter404.body)).not.toContain(initialTitle);

  upstream.fail("instanceA", "alice", storyPath);
  expectReport(await client.call(report), initialTitle);
  await fixture.close(first);

  fixture.advance(61_000);
  const tightened = browser(
    await fixture.start({
      cache: { reportTtlSeconds: 60 },
    }),
  );
  await login(tightened);
  upstream.fail("instanceA", "alice", reportPath, 403);
  const stale = await tightened.call({ ...report, readMode: "cached" });
  expect(JSON.stringify(stale.body)).not.toContain(initialTitle);
});

it("Gate C P1-4 配置版本变更作废旧预览，撤权后即使新角色共享同一工具也不可读原回执", async () => {
  const file = fixture.teamPath("instanceA");
  await writeFile(
    file,
    JSON.stringify({
      roles: {
        RM: ["alice", "bob"],
        DM: ["alice", "bob"],
        RD: ["alice", "bob"],
      },
    }),
  );
  const client = browser(await fixture.start({ readOnly: false }));
  await login(client);
  const opId = await prepare(client);
  fixture.advance(3001);

  await writeFile(
    file,
    JSON.stringify({
      roles: {
        RM: ["alice", "bob"],
        DM: ["alice", "bob"],
        RD: ["alice", "bob"],
      },
      timeState: { dueSoonWorkdays: 4 },
    }),
  );
  expectPermissionDenied(await client.call(confirmation(opId)));
  expect(fixture.upstream().writes()).toEqual([]);

  const opId2 = await prepare(client);
  fixture.advance(3001);
  expect((await client.call(confirmation(opId2))).status).toBe(200);

  await writeFile(
    file,
    JSON.stringify({
      roles: { RM: ["bob"], DM: ["alice", "bob"], RD: ["alice", "bob"] },
    }),
  );
  expectPermissionDenied(await client.call(operation(opId2)));
  expectPermissionDenied(
    await client.call({
      role: "DM",
      tool: "get_operation",
      input: { opId: opId2 },
    }),
  );
  expectPermissionDenied(
    await client.call({
      role: "RD",
      tool: "get_operation",
      input: { opId: opId2 },
    }),
  );
});
