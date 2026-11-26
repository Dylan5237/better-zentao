import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { z } from "zod";
import {
  createZentaoHttp,
  exchangeZentaoToken,
} from "../../src/api/internal/http.ts";
import { createPartitionedReadPool } from "../../src/core/http-policy.ts";
import { assertNoSensitiveData } from "../helpers/assert-no-sensitive-data.ts";

const baseUrl = "https://instance-a.example.test/zentao";
const account = "acct_fixture";
const password = "synthetic-login-example";
const token = "synthetic-opaque-token-example";
const clock = () => 1_700_000_000_000;
const tokenUrl = `${baseUrl}/api.php/v1/tokens`;
const story = {
  pathTemplate: "/api.php/v1/stories/{id}",
  params: { id: 101 },
};
const writeStory = {
  method: "POST" as const,
  pathTemplate: "/api.php/v2/stories",
  body: { title: "离线测试需求" },
};
const storyDto = z.object({ id: z.int().positive() });
const unexpectedFetch = vi.fn<typeof fetch>(() => {
  throw new Error("离线测试误用了全局 fetch");
});

beforeEach(() => {
  unexpectedFetch.mockClear();
  vi.stubGlobal("fetch", unexpectedFetch);
});

afterEach(() => {
  try {
    expect(unexpectedFetch).not.toHaveBeenCalled();
  } finally {
    vi.unstubAllGlobals();
  }
});

function exchange(fetch: typeof globalThis.fetch) {
  return exchangeZentaoToken({ baseUrl, account, password, clock, fetch });
}

function tokenClient(fetch: typeof globalThis.fetch) {
  return createZentaoHttp({ baseUrl, account, token, clock, fetch });
}

function unauthorized() {
  return new Response(null, { status: 401 });
}

describe("SRV-SEC-02 一次性登录换取禅道 Token", () => {
  it("只发送一次登录 POST，仅返回 Token", async () => {
    const send = vi
      .fn<typeof fetch>()
      .mockResolvedValue(
        Response.json({ token, extra: "fixture" }, { status: 201 }),
      );
    await expect(exchange(send)).resolves.toEqual({ token });
    expect(send).toHaveBeenCalledTimes(1);
    const request = send.mock.calls[0]?.[1];
    expect(String(send.mock.calls[0]?.[0])).toBe(tokenUrl);
    expect(request).toMatchObject({ method: "POST", redirect: "error" });
    expect(new Headers(request?.headers).has("Token")).toBe(false);
    expect(JSON.parse(String(request?.body))).toEqual({ account, password });
  });

  it.each([
    ["401", unauthorized],
    ["空 Token", () => Response.json({ token: "" }, { status: 201 })],
    [
      "非法 Token",
      () => Response.json({ token: `\n${token}` }, { status: 201 }),
    ],
  ])("%s 立即以 AUTH_FAILED 拒绝", async (_name, response) => {
    const send = vi.fn<typeof fetch>().mockResolvedValue(response());
    const pending = exchange(send);
    await expect(pending).rejects.toMatchObject({
      name: "BztError",
      code: "AUTH_FAILED",
    });
    await pending.catch((error: unknown) =>
      assertNoSensitiveData(error, [password, token]),
    );
    expect(send).toHaveBeenCalledTimes(1);
  });

  it("拒绝上游重定向，不向 Location 发送登录凭据", async () => {
    const redirectUrl = "https://redirect.example.test/api.php/v1/tokens";
    const send = vi
      .fn<typeof fetch>()
      .mockResolvedValue(
        new Response(null, { status: 302, headers: { Location: redirectUrl } }),
      );
    await expect(exchange(send)).rejects.toMatchObject({ name: "BztError" });
    expect(send).toHaveBeenCalledTimes(1);
    expect(String(send.mock.calls[0]?.[0])).toBe(tokenUrl);
    expect(send.mock.calls[0]?.[1]?.redirect).toBe("error");
  });
});

describe("SRV-LIFE-02 / SRV-OP-04 Token-only HTTP", () => {
  it("直接携带 Token 读写业务，不发登录请求", async () => {
    const send = vi
      .fn<typeof fetch>()
      .mockResolvedValueOnce(Response.json({ id: 101 }))
      .mockResolvedValueOnce(Response.json({ id: 102 }, { status: 201 }));
    const http = tokenClient(send);

    await expect(http.read(story, storyDto)).resolves.toEqual({ id: 101 });
    await expect(http.write(writeStory, storyDto)).resolves.toEqual({
      status: "accepted",
      data: { id: 102 },
    });
    expect(
      send.mock.calls.map(([url, init]) => [
        String(url),
        init?.method,
        new Headers(init?.headers).get("Token"),
      ]),
    ).toEqual([
      [`${baseUrl}/api.php/v1/stories/101`, "GET", token],
      [`${baseUrl}/api.php/v2/stories`, "POST", token],
    ]);
  });

  it("读请求的 401 立即撤销 Token，不重登或再次使用该 Token", async () => {
    const send = vi
      .fn<typeof fetch>()
      .mockImplementation(async () => unauthorized());
    const http = tokenClient(send);

    await expect(http.read(story, storyDto)).rejects.toMatchObject({
      code: "AUTH_FAILED",
    });
    await expect(http.read(story, storyDto)).rejects.toMatchObject({
      code: "AUTH_FAILED",
    });
    expect(send).toHaveBeenCalledTimes(1);
    expect(String(send.mock.calls[0]?.[0])).toBe(
      `${baseUrl}/api.php/v1/stories/101`,
    );
  });

  it("已失效 Token 的写请求在派发前返回 pre_send", async () => {
    const send = vi
      .fn<typeof fetch>()
      .mockImplementation(async () => unauthorized());
    const http = tokenClient(send);
    await expect(http.read(story, storyDto)).rejects.toMatchObject({
      code: "AUTH_FAILED",
    });

    await expect(http.write(writeStory, storyDto)).rejects.toMatchObject({
      name: "BztError",
      code: "AUTH_FAILED",
      details: { phase: "pre_send" },
    });
    expect(send).toHaveBeenCalledTimes(1);
    expect(send.mock.calls[0]?.[1]?.method).toBe("GET");
  });

  it("业务写请求收到 401 返回 post_send，且只派发一次", async () => {
    const send = vi
      .fn<typeof fetch>()
      .mockImplementation(async () => unauthorized());
    const http = tokenClient(send);

    await expect(http.write(writeStory, storyDto)).rejects.toMatchObject({
      name: "BztError",
      code: "AUTH_FAILED",
      details: { phase: "post_send" },
    });
    expect(send).toHaveBeenCalledTimes(1);
    expect(String(send.mock.calls[0]?.[0])).toBe(
      `${baseUrl}/api.php/v2/stories`,
    );
    expect(new Headers(send.mock.calls[0]?.[1]?.headers).get("Token")).toBe(
      token,
    );
  });

  it("原密码模式换 Token 时失败也标记为 pre_send", async () => {
    const send = vi.fn<typeof fetch>().mockResolvedValue(unauthorized());
    const http = createZentaoHttp({
      baseUrl,
      account,
      password,
      clock,
      fetch: send,
    });

    await expect(http.write(writeStory, storyDto)).rejects.toMatchObject({
      name: "BztError",
      code: "AUTH_FAILED",
      details: { phase: "pre_send" },
    });
    expect(send).toHaveBeenCalledTimes(1);
    expect(String(send.mock.calls[0]?.[0])).toBe(tokenUrl);
  });
});

const poolOptions = { perInstanceLimit: 2, perUserLimit: 1, authReserve: 1 };

describe("SRV-CONC-02 分区读取并发池", () => {
  it("各实例和账号有独立额度，A 饱和时 B 的普通读和认证仍能完成", async () => {
    const pool = createPartitionedReadPool(poolOptions);
    const blocked = Promise.withResolvers<void>();
    const slow = vi.fn(() => blocked.promise);
    const queuedUser = vi.fn(async () => "same-user");
    const queuedInstance = vi.fn(async () => "same-instance");
    const a1 = { instanceHash: "instance-a", account: "acct_a" };
    const a2 = { instanceHash: "instance-a", account: "acct_b" };
    const a3 = { instanceHash: "instance-a", account: "acct_c" };
    const b1 = { instanceHash: "instance-b", account: "acct_a" };
    const work: Promise<unknown>[] = [pool.withReadSlot(a1, slow)];
    try {
      await vi.waitFor(() => expect(slow).toHaveBeenCalledTimes(1));
      work.push(pool.withReadSlot(a1, queuedUser), pool.withReadSlot(a2, slow));
      await vi.waitFor(() => expect(slow).toHaveBeenCalledTimes(2));
      const instanceWork = pool.withReadSlot(a3, queuedInstance);
      const otherRead = vi.fn(async () => "read");
      const otherAuth = vi.fn(async () => "auth");
      work.push(
        instanceWork,
        pool.withReadSlot(b1, otherRead),
        pool.withReadSlot({ ...b1, priority: "auth" }, otherAuth),
      );
      await vi.waitFor(() => {
        expect(otherRead).toHaveBeenCalledOnce();
        expect(otherAuth).toHaveBeenCalledOnce();
      });
      expect(queuedUser).not.toHaveBeenCalled();
      expect(queuedInstance).not.toHaveBeenCalled();
    } finally {
      blocked.resolve();
      await Promise.allSettled(work);
    }
    expect(await Promise.all(work)).toEqual([
      undefined,
      "same-user",
      undefined,
      "same-instance",
      "read",
      "auth",
    ]);
  });

  it("同实例的普通读取用满两个槽位时仍保留认证槽位", async () => {
    const pool = createPartitionedReadPool(poolOptions);
    const blocked = Promise.withResolvers<void>();
    const slow = vi.fn(() => blocked.promise);
    const auth = vi.fn(async () => "token");
    const a1 = { instanceHash: "instance-a", account: "acct_a" };
    const a2 = { instanceHash: "instance-a", account: "acct_b" };
    const work: Promise<unknown>[] = [
      pool.withReadSlot(a1, slow),
      pool.withReadSlot(a2, slow),
    ];
    try {
      await vi.waitFor(() => expect(slow).toHaveBeenCalledTimes(2));
      work.push(pool.withReadSlot({ ...a1, priority: "auth" }, auth));
      await vi.waitFor(() => expect(auth).toHaveBeenCalledOnce());
    } finally {
      blocked.resolve();
      await Promise.allSettled(work);
    }
    expect(await Promise.all(work)).toEqual([undefined, undefined, "token"]);
  });

  it("Gate C P1-5 换 Token 超时及时中止，读池等待队列超限立即拒绝", async () => {
    const hanging = vi.fn<typeof fetch>(() => new Promise(() => {}));
    await expect(
      exchangeZentaoToken({
        baseUrl: "https://zentao.example.test/",
        account: "acct_a",
        password: "synthetic-password",
        clock,
        env: { ZENTAO_TIMEOUT_MS: "50" },
        fetch: hanging,
      }),
    ).rejects.toMatchObject({ code: "ZENTAO_TIMEOUT" });

    const pool = createPartitionedReadPool({
      ...poolOptions,
      perInstanceLimit: 1,
      perUserLimit: 1,
      maxQueueSize: 1,
    });
    const blocked = Promise.withResolvers<void>();
    const active = pool.withReadSlot(
      { instanceHash: "instance-a", account: "acct_a" },
      () => blocked.promise,
    );
    const queued = pool.withReadSlot(
      { instanceHash: "instance-a", account: "acct_a" },
      async () => "ok",
    );
    try {
      await expect(
        pool.withReadSlot(
          { instanceHash: "instance-a", account: "acct_a" },
          async () => "overflow",
        ),
      ).rejects.toMatchObject({ code: "ZENTAO_UNAVAILABLE" });
    } finally {
      blocked.resolve();
      await Promise.allSettled([active, queued]);
    }
  });

  it("Gate C P1-1 等待实例写锁期间撤销会话后不发送写入，且后续读写均失败", async () => {
    const holder = Promise.withResolvers<Response>();
    const fetchA = vi.fn<typeof fetch>(() => holder.promise);
    const fetchB = vi.fn<typeof fetch>(async () =>
      Response.json({ id: 202 }, { status: 201 }),
    );
    let revoked = false;
    const httpA = createZentaoHttp({
      baseUrl,
      account: "acct_a",
      token,
      clock,
      fetch: fetchA,
    });
    const httpB = createZentaoHttp({
      baseUrl,
      account: "acct_b",
      token,
      clock,
      fetch: fetchB,
      isRevoked: () => revoked,
    });

    const firstWrite = httpA.write(writeStory, storyDto);
    await vi.waitFor(() => expect(fetchA).toHaveBeenCalledOnce());
    const secondWrite = httpB.write(writeStory, storyDto).catch((err) => err);
    revoked = true;
    httpB.revoke();
    holder.resolve(Response.json({ id: 101 }, { status: 201 }));

    await expect(firstWrite).resolves.toEqual({
      status: "accepted",
      data: { id: 101 },
    });
    expect(await secondWrite).toMatchObject({
      code: "AUTH_FAILED",
      details: { phase: "pre_send" },
    });
    await expect(httpB.read(story, storyDto)).rejects.toMatchObject({
      code: "AUTH_FAILED",
    });
    expect(fetchB).not.toHaveBeenCalled();

    // 独立验证 revoke() 自身已清除客户端持有的 Token（即使未提供 isRevoked 回调）
    const fetchC = vi.fn<typeof fetch>(async () =>
      Response.json({ id: 303 }, { status: 201 }),
    );
    const httpC = createZentaoHttp({
      baseUrl,
      account: "acct_c",
      token,
      clock,
      fetch: fetchC,
    });
    httpC.revoke();
    await expect(httpC.read(story, storyDto)).rejects.toMatchObject({
      code: "AUTH_FAILED",
    });
    await expect(httpC.write(writeStory, storyDto)).rejects.toMatchObject({
      code: "AUTH_FAILED",
      details: { phase: "pre_send" },
    });
    expect(fetchC).not.toHaveBeenCalled();
  });
});
