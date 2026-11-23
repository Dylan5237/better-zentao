import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { z } from "zod";
import { createZentaoHttp } from "../../src/api/internal/http.ts";
import type { ZentaoHttpOptions } from "../../src/api/internal/http.ts";
import { paginate } from "../../src/api/internal/paginate.ts";
import { BztError } from "../../src/core/errors.ts";
import { configureReadConcurrency } from "../../src/core/http-policy.ts";
import { assertNoSensitiveData } from "../helpers/assert-no-sensitive-data.ts";

const baseUrl = "https://fixture.example.test/zentao";
const password = "offline-password-example";
const token = "offline-opaque-credential-alpha";
const replacement = "offline-opaque-credential-beta";
const secrets = [password, token, replacement];
const fakeGlobalFetch = vi.fn<typeof fetch>(() => {
  throw new Error("离线套件误用了全局 fetch");
});
const story = { pathTemplate: "/api.php/v1/stories/{id}", params: { id: 29 } };
const writeStory = {
  method: "POST" as const,
  pathTemplate: "/api.php/v2/stories",
};
const storyDto = z.object({ id: z.int().positive() });
const pageDto = z.object({
  items: z.array(storyDto),
  total: z.int().nonnegative().optional(),
});

function setup(overrides: Partial<ZentaoHttpOptions> = {}) {
  const send = vi.fn<typeof fetch>();
  const sleep = vi
    .fn<(ms: number) => Promise<void>>()
    .mockResolvedValue(undefined);
  const logSink = vi.fn<(line: string) => void>();
  const http = createZentaoHttp({
    baseUrl,
    account: "acct_fixture",
    password,
    fetch: send,
    clock: () => 1,
    sleep,
    logSink,
    ...overrides,
  });
  return { http, send, sleep, logSink };
}

function login(value = token) {
  return Response.json(
    { token: value, users: { fixture: { password } } },
    { status: 201 },
  );
}

function row(id = 29, status = 200) {
  return Response.json({ id, token, password }, { status });
}

function refused(status: number) {
  return Response.json(
    { message: `${password} ${token}`, users: { fixture: {} } },
    { status },
  );
}

function headers(init: RequestInit | undefined) {
  return new Headers(init?.headers);
}

function logEvents(sink: ReturnType<typeof setup>["logSink"]): unknown[] {
  return sink.mock.calls.map(([line]): unknown => JSON.parse(line));
}

async function assertSafeFailure(
  pending: Promise<unknown>,
  code: string,
  retryable: boolean,
) {
  await expect(pending).rejects.toMatchObject({
    name: "BztError",
    code,
    retryable,
  });
  await pending.catch((error: unknown) =>
    assertNoSensitiveData(error, secrets),
  );
}

beforeEach(() => {
  fakeGlobalFetch.mockClear();
  vi.stubGlobal("fetch", fakeGlobalFetch);
});

afterEach(() => {
  try {
    expect(fakeGlobalFetch).not.toHaveBeenCalled();
    configureReadConcurrency(8);
  } finally {
    vi.unstubAllGlobals();
    vi.useRealTimers();
  }
});

describe("WP-01 HTTP 认证与 S01 脱敏（06 §2.1）", () => {
  it("登录和业务请求均接受 201，v1/v2 共用 Token 请求头", async () => {
    let tick = 0;
    const { http, send, logSink } = setup({
      env: { BZT_LOG_LEVEL: "debug" },
      clock: () => ++tick,
    });
    send.mockResolvedValueOnce(login()).mockResolvedValueOnce(row(29, 201));
    send.mockResolvedValueOnce(row(30));

    const output = await http.read(
      { ...story, query: { key: password } },
      storyDto,
    );
    const v2 = await http.read(
      { pathTemplate: "/api.php/v2/story/view" },
      storyDto,
    );

    expect([output, v2]).toEqual([{ id: 29 }, { id: 30 }]);
    const [auth, v1Call, v2Call] = send.mock.calls;
    expect(String(auth?.[0])).toBe(`${baseUrl}/api.php/v1/tokens`);
    expect(auth?.[1]).toMatchObject({ method: "POST", redirect: "error" });
    expect(headers(auth?.[1]).get("Content-Type")).toBe("application/json");
    expect(headers(auth?.[1]).has("Token")).toBe(false);
    expect(JSON.parse(String(auth?.[1]?.body))).toEqual({
      account: "acct_fixture",
      password,
    });
    expect(String(v1Call?.[0])).toBe(
      `${baseUrl}/api.php/v1/stories/29?key=${password}`,
    );
    for (const call of [v1Call, v2Call]) {
      expect(headers(call?.[1]).get("Token")).toBe(token);
      expect(headers(call?.[1]).has("Authorization")).toBe(false);
      expect(call?.[1]?.redirect).toBe("error");
    }
    expect(logEvents(logSink)).toEqual([
      {
        method: "POST",
        pathTemplate: "/api.php/v1/tokens",
        status: 201,
        durationMs: 1,
      },
      {
        method: "GET",
        pathTemplate: story.pathTemplate,
        status: 201,
        durationMs: 1,
      },
      {
        method: "GET",
        pathTemplate: "/api.php/v2/story/view",
        status: 200,
        durationMs: 1,
      },
    ]);
    assertNoSensitiveData([output, v2, logSink.mock.calls], secrets);
  });

  it("并发首次登录只发一次，失败清除进行中状态并允许下次登录", async () => {
    const { http, send, logSink } = setup();
    const pendingLogin = Promise.withResolvers<Response>();
    send.mockReturnValueOnce(pendingLogin.promise);
    const reads = Array.from({ length: 6 }, () => http.read(story, storyDto));
    const results = Promise.allSettled(reads);
    await vi.waitFor(() => expect(send).toHaveBeenCalledTimes(1));
    pendingLogin.resolve(refused(401));
    for (const result of await results) {
      expect(result).toMatchObject({
        status: "rejected",
        reason: { code: "AUTH_FAILED", retryable: false },
      });
      assertNoSensitiveData(result, secrets);
    }
    expect(send).toHaveBeenCalledTimes(1);
    send.mockResolvedValueOnce(login()).mockResolvedValueOnce(row());
    await expect(http.read(story, storyDto)).resolves.toEqual({ id: 29 });
    expect(send).toHaveBeenCalledTimes(3);
    assertNoSensitiveData(logSink.mock.calls, secrets);
  });

  it("并发 401 合并刷新，晚到的旧 401 不使新一代登录失效", async () => {
    const { http, send, logSink } = setup();
    const first = Promise.withResolvers<Response>();
    const second = Promise.withResolvers<Response>();
    const late = Promise.withResolvers<Response>();
    const refreshing = Promise.withResolvers<Response>();
    send
      .mockResolvedValueOnce(login())
      .mockReturnValueOnce(first.promise)
      .mockReturnValueOnce(second.promise)
      .mockReturnValueOnce(late.promise)
      .mockReturnValueOnce(refreshing.promise)
      .mockImplementation(async () => row());
    const reads = [
      http.read(story, storyDto),
      http.read(story, storyDto),
      http.read(story, storyDto),
    ];
    await vi.waitFor(() => expect(send).toHaveBeenCalledTimes(4));
    first.resolve(refused(401));
    second.resolve(refused(401));
    await vi.waitFor(() =>
      expect(
        logEvents(logSink).filter(
          (event) =>
            z.object({ status: z.literal(401) }).safeParse(event).success,
        ),
      ).toHaveLength(2),
    );
    expect(send).toHaveBeenCalledTimes(5);
    // 服务端可重用令牌文本，缓存仍需要辨认新旧登录批次。
    refreshing.resolve(login());
    await Promise.all(reads.slice(0, 2));
    late.resolve(refused(401));
    await expect(Promise.all(reads)).resolves.toEqual([
      { id: 29 },
      { id: 29 },
      { id: 29 },
    ]);
    expect(send).toHaveBeenCalledTimes(8);
    expect(
      send.mock.calls.filter(([url]) => String(url).endsWith("/tokens")),
    ).toHaveLength(2);
    assertNoSensitiveData(logSink.mock.calls, secrets);
  });

  it("首个 401 使用新 Token 重放，二次 401 立即报 AUTH_FAILED", async () => {
    const { http, send, sleep, logSink } = setup();
    send
      .mockResolvedValueOnce(login())
      .mockResolvedValueOnce(refused(401))
      .mockResolvedValueOnce(login(replacement))
      .mockResolvedValueOnce(refused(401));
    await assertSafeFailure(http.read(story, storyDto), "AUTH_FAILED", false);
    expect(send).toHaveBeenCalledTimes(4);
    expect(headers(send.mock.calls[1]?.[1]).get("Token")).toBe(token);
    expect(headers(send.mock.calls[3]?.[1]).get("Token")).toBe(replacement);
    expect(sleep).not.toHaveBeenCalled();
    expect(logSink).toHaveBeenCalledTimes(4);
    assertNoSensitiveData(logSink.mock.calls, secrets);
  });

  it.each([
    ["凭据拒绝", () => refused(403)],
    ["空 Token", () => login("")],
    ["非法头值", () => login(`\n${token}`)],
    ["损坏 JSON", () => new Response(password, { status: 201 })],
  ])(
    "%s 的登录错误为 AUTH_FAILED，且未发出业务请求",
    async (_name, response) => {
      const { http, send, logSink } = setup();
      send.mockResolvedValueOnce(response());
      await assertSafeFailure(http.read(story, storyDto), "AUTH_FAILED", false);
      expect(send).toHaveBeenCalledTimes(1);
      assertNoSensitiveData(logSink.mock.calls, secrets);
    },
  );

  it("登录服务不可用时按传输错误报告，期间不发业务写入", async () => {
    const { http, send, sleep, logSink } = setup();
    send.mockResolvedValueOnce(refused(503));
    await assertSafeFailure(
      http.write(writeStory, storyDto),
      "ZENTAO_UNAVAILABLE",
      true,
    );
    expect(send).toHaveBeenCalledTimes(1);
    expect(sleep).not.toHaveBeenCalled();
    assertNoSensitiveData(logSink.mock.calls, secrets);
  });

  it.each([
    ["account", ""],
    ["account", " \t \r\n "],
    ["password", ""],
    ["password", " \t \r\n "],
  ] as const)(
    "P2-4 拒绝空串或纯空白凭据 %s（%j），发送次数为 0",
    (field, value) => {
      const send = vi.fn<typeof fetch>();
      let error: unknown;
      try {
        setup({ fetch: send, [field]: value });
      } catch (caught) {
        error = caught;
      }
      expect(error).toMatchObject({
        name: "BztError",
        code: "INVALID_INPUT",
        retryable: false,
      });
      expect(send).not.toHaveBeenCalled();
      assertNoSensitiveData(error, [...secrets, value]);
    },
  );

  it("P2-4 非空凭据保留原值登录", async () => {
    const account = " acct_fixture ";
    const spacedPassword = ` ${password} `;
    const { http, send, logSink } = setup({
      account,
      password: spacedPassword,
    });
    send.mockResolvedValueOnce(login()).mockResolvedValueOnce(row());
    await expect(http.read(story, storyDto)).resolves.toEqual({ id: 29 });
    expect(send.mock.calls[0]?.[1]?.body).toBe(
      JSON.stringify({ account, password: spacedPassword }),
    );
    assertNoSensitiveData(logSink.mock.calls, [...secrets, account]);
  });
});

describe.each(["read", "write"] as const)("P1-1 业务响应 %s", (method) => {
  function request<T>(
    http: ReturnType<typeof createZentaoHttp>,
    schema: z.ZodType<T>,
  ) {
    return method === "read"
      ? http.read(story, schema)
      : http.write(writeStory, schema);
  }

  it.each([
    [
      "明确失败信封",
      { id: 29, result: "fail", message: `标题已存在。Token: ${token}` },
      "标题已存在",
    ],
    [
      "非空错误文本",
      { id: 29, result: "success", error: `标题不能为空。${password}` },
      "标题不能为空",
    ],
    [
      "普通失败消息",
      { id: 29, message: `参数不合法。${password}` },
      "参数不合法",
    ],
    [
      "无实体的结构化校验",
      {
        result: "success",
        message: [`缺少必填字段。${password}`],
        error: { [token]: ["标题不能为空"] },
      },
      "缺少必填字段。标题不能为空",
    ],
  ] as const)("2xx %s抛脱敏业务错误", async (_name, payload, message) => {
    const { http, send, sleep, logSink } = setup();
    send
      .mockResolvedValueOnce(login())
      .mockResolvedValueOnce(Response.json(payload, { status: 200 }));
    const result = request(http, storyDto);
    await assertSafeFailure(result, "ZENTAO_BUSINESS_ERROR", false);
    await expect(result).rejects.toHaveProperty("message", message);
    expect(send).toHaveBeenCalledTimes(2);
    expect(sleep).not.toHaveBeenCalled();
    assertNoSensitiveData(logSink.mock.calls, secrets);
  });

  it("2xx 白名单摘要按 message、error 提取，最长 120 字", async () => {
    const { http, send } = setup();
    send.mockResolvedValueOnce(login()).mockResolvedValueOnce(
      Response.json({
        result: "fail",
        message: `缺少必填字段。${password}`,
        error: { title: [`${"标题已存在。".repeat(30)}Token: ${token}`] },
      }),
    );
    const result = request(http, storyDto);
    await assertSafeFailure(result, "ZENTAO_BUSINESS_ERROR", false);
    await expect(result).rejects.toHaveProperty(
      "message",
      expect.stringMatching(/^缺少必填字段。标题已存在.*…$/u),
    );
    await result.catch((error: unknown) => {
      if (error instanceof BztError) expect(error.message).toHaveLength(120);
    });
  });

  it.each(["ZENTAO_BUSINESS_ERROR", "RULE_VIOLATION"] as const)(
    "原样抛出 schema 给出的 %s",
    async (code) => {
      const { http, send, logSink } = setup();
      const expected = new BztError(code, "标题已存在", { fields: ["title"] });
      const schema = storyDto.transform(() => {
        throw expected;
      });
      send.mockResolvedValueOnce(login()).mockResolvedValueOnce(row());
      const result = request(http, schema);
      await assertSafeFailure(result, code, false);
      await expect(result).rejects.toBe(expected);
      assertNoSensitiveData(logSink.mock.calls, secrets);
    },
  );

  it("普通 schema 异常仍保留响应中的明确业务失败", async () => {
    const { http, send, logSink } = setup();
    const schema = storyDto.transform(() => {
      throw new Error(`解码私有上下文 ${password} ${token}`);
    });
    send
      .mockResolvedValueOnce(login())
      .mockResolvedValueOnce(
        Response.json({ id: 29, result: "fail", message: "标题已存在" }),
      );
    const result = request(http, schema);
    await assertSafeFailure(result, "ZENTAO_BUSINESS_ERROR", false);
    await expect(result).rejects.toHaveProperty("message", "标题已存在");
    assertNoSensitiveData(logSink.mock.calls, secrets);
  });

  it("合法实体附加成功提示与 204 空正文正常投影", async () => {
    const { http, send, logSink } = setup();
    send
      .mockResolvedValueOnce(login())
      .mockResolvedValueOnce(
        Response.json(
          {
            id: 29,
            result: "success",
            message: "保存成功",
            error: { code: 0 },
            token,
            password,
          },
          { status: 201 },
        ),
      )
      .mockResolvedValueOnce(new Response(null, { status: 204 }));
    const entity = await request(http, storyDto);
    const empty = await request(http, z.undefined());
    expect(entity).toEqual(
      method === "read" ? { id: 29 } : { status: "accepted", data: { id: 29 } },
    );
    expect(empty).toEqual(
      method === "read" ? undefined : { status: "accepted", data: undefined },
    );
    assertNoSensitiveData([entity, empty, logSink.mock.calls], secrets);
  });
});

describe("WP-01 HTTP 请求策略（06 §2.2）", () => {
  it.each([
    [400, "ZENTAO_BUSINESS_ERROR"],
    [403, "PERMISSION_DENIED"],
    [404, "NOT_FOUND"],
    [422, "ZENTAO_BUSINESS_ERROR"],
  ] as const)(
    "读取 HTTP %i 映射为 %s，错误不透传正文",
    async (status, code) => {
      const { http, send, sleep, logSink } = setup();
      send
        .mockResolvedValueOnce(login())
        .mockResolvedValueOnce(refused(status));
      await assertSafeFailure(http.read(story, storyDto), code, false);
      expect(send).toHaveBeenCalledTimes(2);
      expect(sleep).not.toHaveBeenCalled();
      assertNoSensitiveData(logSink.mock.calls, secrets);
    },
  );

  it("204 支持无正文，损坏 JSON 和未通过 DTO 校验均报结构错误", async () => {
    const { http, send, logSink } = setup();
    send
      .mockResolvedValueOnce(login())
      .mockResolvedValueOnce(new Response(null, { status: 204 }))
      .mockResolvedValueOnce(new Response(password))
      .mockResolvedValueOnce(Response.json({ id: token }));
    await expect(http.read(story, z.undefined())).resolves.toBeUndefined();
    await assertSafeFailure(
      http.read(story, storyDto),
      "ZENTAO_SCHEMA_MISMATCH",
      false,
    );
    await assertSafeFailure(
      http.read(story, storyDto),
      "ZENTAO_SCHEMA_MISMATCH",
      false,
    );
    expect(send).toHaveBeenCalledTimes(4);
    assertNoSensitiveData(logSink.mock.calls, secrets);
  });

  it.each([
    ["network", 0, "ZENTAO_UNAVAILABLE"],
    ["503", 503, "ZENTAO_UNAVAILABLE"],
    ["408", 408, "ZENTAO_TIMEOUT"],
    ["429", 429, "ZENTAO_UNAVAILABLE"],
  ] as const)(
    "读 %s 故障按 300/900ms 重试并封顶",
    async (_failure, status, code) => {
      const { http, send, sleep, logSink } = setup();
      send.mockResolvedValueOnce(login()).mockImplementation(async () => {
        if (status !== 0) return refused(status);
        throw new Error(`请求失败 ${token} ${password}`);
      });
      await assertSafeFailure(http.read(story, storyDto), code, true);
      expect(sleep.mock.calls).toEqual([[300], [900]]);
      expect(send).toHaveBeenCalledTimes(4);
      expect(logEvents(logSink).slice(1)).toEqual(
        Array.from({ length: 3 }, () => ({
          method: "GET",
          pathTemplate: story.pathTemplate,
          status,
          durationMs: 0,
        })),
      );
      assertNoSensitiveData(logSink.mock.calls, secrets);
    },
  );

  it("401 重放和传输重试独立计次，刷新不清空已用的退避次数", async () => {
    configureReadConcurrency(1);
    const { http, send, sleep, logSink } = setup();
    send
      .mockResolvedValueOnce(login())
      .mockRejectedValueOnce(new Error(password))
      .mockResolvedValueOnce(refused(401))
      .mockResolvedValueOnce(login(replacement))
      .mockResolvedValueOnce(refused(503))
      .mockResolvedValueOnce(refused(503));
    await assertSafeFailure(
      http.read(story, storyDto),
      "ZENTAO_UNAVAILABLE",
      true,
    );
    expect(sleep.mock.calls).toEqual([[300], [900]]);
    expect(send).toHaveBeenCalledTimes(6);
    expect(logSink).toHaveBeenCalledTimes(6);
    assertNoSensitiveData(logSink.mock.calls, secrets);
  });

  it("默认 15000ms 真正中止每次读取，超时至多重试两次并清理计时器", async () => {
    vi.useFakeTimers();
    const { http, send, sleep, logSink } = setup();
    const aborts = vi.fn();
    send
      .mockResolvedValueOnce(login())
      .mockImplementation(async (_url, init) => {
        await new Promise<void>((_resolve, reject) => {
          init?.signal?.addEventListener(
            "abort",
            () => {
              aborts();
              reject(new Error(token));
            },
            { once: true },
          );
        });
        return row();
      });
    const assertion = assertSafeFailure(
      http.read(story, storyDto),
      "ZENTAO_TIMEOUT",
      true,
    );
    await vi.advanceTimersByTimeAsync(14_999);
    expect(aborts).not.toHaveBeenCalled();
    await vi.advanceTimersByTimeAsync(1);
    expect(aborts).toHaveBeenCalledTimes(1);
    await vi.advanceTimersByTimeAsync(30_000);
    await assertion;
    expect(aborts).toHaveBeenCalledTimes(3);
    expect(sleep.mock.calls).toEqual([[300], [900]]);
    expect(vi.getTimerCount()).toBe(0);
    expect(logSink).toHaveBeenCalledTimes(4);
    assertNoSensitiveData(logSink.mock.calls, secrets);
  });

  it("读重试可恢复，等待退避期间不占用读并发名额", async () => {
    configureReadConcurrency(1);
    const backoff = Promise.withResolvers<void>();
    const sleep = vi.fn(() => backoff.promise);
    const { http, send } = setup({ sleep });
    send
      .mockResolvedValueOnce(login())
      .mockRejectedValueOnce(new Error(token))
      .mockResolvedValueOnce(row(30))
      .mockResolvedValueOnce(row());
    const retrying = http.read(story, storyDto);
    await vi.waitFor(() => expect(sleep).toHaveBeenCalledExactlyOnceWith(300));
    await expect(http.read(story, storyDto)).resolves.toEqual({ id: 30 });
    backoff.resolve();
    await expect(retrying).resolves.toEqual({ id: 29 });
  });

  it("重定向使用 error，绝不访问 Location 或转发 Token", async () => {
    const { http, send, sleep, logSink } = setup();
    send.mockResolvedValueOnce(login()).mockResolvedValueOnce(
      new Response(null, {
        status: 302,
        headers: { Location: "https://outside.example.test/redirect" },
      }),
    );
    await assertSafeFailure(
      http.read(story, storyDto),
      "ZENTAO_UNAVAILABLE",
      true,
    );
    expect(send).toHaveBeenCalledTimes(2);
    expect(sleep).not.toHaveBeenCalled();
    expect(
      send.mock.calls.every(
        ([url, init]) =>
          String(url).startsWith(baseUrl) && init?.redirect === "error",
      ),
    ).toBe(true);
    assertNoSensitiveData(logSink.mock.calls, secrets);
  });

  it.each([
    "file:///zentao",
    "not a URL",
    `https://acct:${password}@fixture.example.test/zentao`,
    `${baseUrl}?`,
    `${baseUrl}#quiet`,
  ])("拒绝无效 baseUrl 且不在异常里复述地址", (url) => {
    try {
      setup({ baseUrl: url });
      expect.unreachable();
    } catch (error) {
      expect(error).toMatchObject({ code: "INVALID_INPUT" });
      assertNoSensitiveData(error, secrets);
    }
  });

  it("拒绝非法超时配置、非声明路径和不匹配的 ID 参数", async () => {
    expect(() => setup({ env: { ZENTAO_TIMEOUT_MS: "0" } })).toThrow(
      expect.objectContaining({ code: "INVALID_INPUT" }),
    );
    const { http, send } = setup();
    for (const request of [
      { pathTemplate: "//other.example.test/api.php/v1/stories" },
      { pathTemplate: "/api.php/v1/tokens" },
      { pathTemplate: "/api.php/v1/stories/29" },
      { pathTemplate: story.pathTemplate },
      { ...story, params: { id: 0 } },
      { ...story, params: { ...story.params, extra: 1 } },
    ]) {
      await assertSafeFailure(
        http.read(request, storyDto),
        "INVALID_INPUT",
        false,
      );
    }
    await assertSafeFailure(
      http.write({ ...writeStory, body: { bad: 1n } }, storyDto),
      "INVALID_INPUT",
      false,
    );
    const forgedWrite = { ...writeStory };
    Object.assign(forgedWrite, { method: "GET" });
    await assertSafeFailure(
      http.write(forgedWrite, storyDto),
      "INVALID_INPUT",
      false,
    );
    expect(send).not.toHaveBeenCalled();
  });

  it("P1-3 读写及 401 重放日志透传合法标识，登录日志不带业务标识", async () => {
    const { http, send, logSink } = setup();
    const opId = "e86bc265-68db-46e9-8fe8-73282bfd181c";
    const read = { ...story, opId, objectId: 29 };
    const write = { ...writeStory, opId, objectId: 30 };
    send
      .mockResolvedValueOnce(login())
      .mockResolvedValueOnce(refused(401))
      .mockResolvedValueOnce(login(replacement))
      .mockResolvedValueOnce(row())
      .mockResolvedValueOnce(row(30, 201));
    await expect(http.read(read, storyDto)).resolves.toEqual({ id: 29 });
    await expect(http.write(write, storyDto)).resolves.toMatchObject({
      status: "accepted",
    });
    const authLog = {
      method: "POST",
      pathTemplate: "/api.php/v1/tokens",
      status: 201,
      durationMs: 0,
    };
    const readLog = {
      method: "GET",
      pathTemplate: story.pathTemplate,
      durationMs: 0,
      opId,
      objectId: 29,
    };
    expect(logEvents(logSink)).toEqual([
      authLog,
      { ...readLog, status: 401 },
      authLog,
      { ...readLog, status: 200 },
      {
        method: "POST",
        pathTemplate: writeStory.pathTemplate,
        status: 201,
        durationMs: 0,
        opId,
        objectId: 30,
      },
    ]);
    assertNoSensitiveData(logSink.mock.calls, secrets);
  });

  it.each([
    ["opId", password],
    ["objectId", 0],
    ["objectId", 1.5],
    ["objectId", "29"],
  ] as const)(
    "P1-3 非法日志标识 %s 在登录和业务发送前拦截（%j）",
    async (field, value) => {
      const { http, send, logSink } = setup();
      send.mockResolvedValueOnce(login()).mockImplementation(async () => row());
      const read = { ...story, opId: undefined, objectId: 29 };
      const write = { ...writeStory, opId: undefined, objectId: 29 };
      Object.assign(read, { [field]: value });
      Object.assign(write, { [field]: value });
      await assertSafeFailure(
        http.read(read, storyDto),
        "INVALID_INPUT",
        false,
      );
      await assertSafeFailure(
        http.write(write, storyDto),
        "INVALID_INPUT",
        false,
      );
      expect(send).not.toHaveBeenCalled();
      expect(logSink).not.toHaveBeenCalled();
    },
  );

  it("日志 sink 异常不覆盖已经收到的写入回执", async () => {
    const { http, send } = setup({
      logSink: () => {
        throw new Error(password);
      },
    });
    send.mockResolvedValueOnce(login()).mockResolvedValueOnce(row(29, 201));
    const result = await http.write(
      { ...writeStory, body: { title: password } },
      storyDto,
    );
    expect(result).toEqual({ status: "accepted", data: { id: 29 } });
    expect(send.mock.calls[1]?.[1]).toMatchObject({
      method: "POST",
      body: JSON.stringify({ title: password }),
    });
    expect(headers(send.mock.calls[1]?.[1]).get("Content-Type")).toBe(
      "application/json",
    );
    assertNoSensitiveData(result, secrets);
  });
});

describe("WP-01 并发限制与写入回执（05 §5.3、06 §2.2）", () => {
  it.each([0, -1, 1.5, Infinity, Number.MAX_SAFE_INTEGER + 1])(
    "拒绝非法全局读并发 %s",
    (value) => {
      expect(() => configureReadConcurrency(value)).toThrow(
        expect.objectContaining({ code: "INVALID_INPUT" }),
      );
    },
  );

  it("不同客户端的读取共同遵守默认全局上限 8", async () => {
    const left = setup();
    const right = setup({ baseUrl: `${baseUrl}-other` });
    let started = 0;
    const pending = Promise.withResolvers<void>();
    const wait = async () => {
      started++;
      await pending.promise;
      return row();
    };
    left.send.mockResolvedValueOnce(login()).mockImplementation(wait);
    right.send.mockResolvedValueOnce(login()).mockImplementation(wait);
    const work = Promise.all(
      Array.from({ length: 12 }, (_, index) =>
        (index % 2 === 0 ? left : right).http.read(story, storyDto),
      ),
    );
    try {
      await vi.waitFor(() => expect(started).toBe(8));
      expect(left.send.mock.calls.length + right.send.mock.calls.length).toBe(
        10,
      );
    } finally {
      pending.resolve();
      await work;
    }
    expect(started).toBe(12);
  });

  it.each(["network", "abort", "408", "429", "503", "302", "unreadable"])(
    "写入 %s 只发一次并返回 unknown",
    async (failure) => {
      const { http, send, sleep, logSink } = setup();
      send.mockResolvedValueOnce(login()).mockImplementation(async () => {
        if (/^\d+$/u.test(failure)) return refused(Number(failure));
        if (failure === "unreadable")
          return new Response(password, { status: 201 });
        if (failure === "abort") throw new DOMException(token, "AbortError");
        throw new Error(password);
      });
      const result = await http.write(writeStory, storyDto);
      expect(result).toMatchObject({ status: "unknown", retryable: false });
      expect(send).toHaveBeenCalledTimes(2);
      expect(sleep).not.toHaveBeenCalled();
      assertNoSensitiveData([result, logSink.mock.calls], secrets);
    },
  );

  it("业务写 401 不重放，下一笔独立写入重新登录", async () => {
    const { http, send, sleep, logSink } = setup();
    send
      .mockResolvedValueOnce(login())
      .mockResolvedValueOnce(refused(401))
      .mockResolvedValueOnce(login(replacement))
      .mockResolvedValueOnce(row(30));
    await assertSafeFailure(
      http.write(writeStory, storyDto),
      "AUTH_FAILED",
      false,
    );
    expect(send).toHaveBeenCalledTimes(2);
    await expect(http.write(writeStory, storyDto)).resolves.toEqual({
      status: "accepted",
      data: { id: 30 },
    });
    expect(headers(send.mock.calls[3]?.[1]).get("Token")).toBe(replacement);
    expect(sleep).not.toHaveBeenCalled();
    assertNoSensitiveData(logSink.mock.calls, secrets);
  });

  it("归一化同实例的写请求按 FIFO 排队，明确失败后释放，其他实例可独立写", async () => {
    const first = setup({
      baseUrl: "HTTPS://FIXTURE.EXAMPLE.TEST:443/zentao///",
    });
    const same = setup();
    const other = setup({ baseUrl: `${baseUrl}-other` });
    const pending = Promise.withResolvers<Response>();
    first.send
      .mockResolvedValueOnce(login())
      .mockReturnValueOnce(pending.promise)
      .mockResolvedValueOnce(row(32));
    same.send.mockResolvedValueOnce(login()).mockResolvedValueOnce(row(31));
    other.send.mockResolvedValueOnce(login()).mockResolvedValueOnce(row(30));
    const failed = assertSafeFailure(
      first.http.write(writeStory, storyDto),
      "ZENTAO_BUSINESS_ERROR",
      false,
    );
    const second = same.http.write(writeStory, storyDto);
    const third = first.http.write(writeStory, storyDto);
    try {
      await expect(
        other.http.write(writeStory, storyDto),
      ).resolves.toMatchObject({ data: { id: 30 } });
      expect(first.send).toHaveBeenCalledTimes(2);
      expect(same.send).not.toHaveBeenCalled();
    } finally {
      pending.resolve(refused(400));
      await failed;
    }
    await expect(second).resolves.toMatchObject({ data: { id: 31 } });
    await expect(third).resolves.toMatchObject({ data: { id: 32 } });
    expect(same.send.mock.invocationCallOrder[1]).toBeLessThan(
      Number(first.send.mock.invocationCallOrder[2]),
    );
  });

  it("写入收到头部后正文仍受超时约束，abort 后释放队列且不重发", async () => {
    vi.useFakeTimers();
    const { http, send, sleep, logSink } = setup({
      env: { ZENTAO_TIMEOUT_MS: "20", BZT_LOG_LEVEL: "debug" },
    });
    const hanging = new Response(null, { status: 201 });
    const late = Promise.withResolvers<string>();
    vi.spyOn(hanging, "text").mockReturnValueOnce(late.promise);
    send
      .mockResolvedValueOnce(login())
      .mockResolvedValueOnce(hanging)
      .mockResolvedValueOnce(row(30));
    const first = http.write(writeStory, storyDto);
    const next = http.write(writeStory, storyDto);
    await vi.advanceTimersByTimeAsync(19);
    const signal = send.mock.calls[1]?.[1]?.signal;
    expect(signal?.aborted).toBe(false);
    expect(send).toHaveBeenCalledTimes(2);
    await vi.advanceTimersByTimeAsync(1);
    const result = await first;
    expect(result).toMatchObject({ status: "unknown", retryable: false });
    await expect(next).resolves.toMatchObject({
      status: "accepted",
      data: { id: 30 },
    });
    expect(signal?.aborted).toBe(true);
    late.reject(new Error(token));
    await vi.advanceTimersByTimeAsync(0);
    expect(send).toHaveBeenCalledTimes(3);
    expect(sleep).not.toHaveBeenCalled();
    expect(vi.getTimerCount()).toBe(0);
    expect(logEvents(logSink)[1]).toMatchObject({
      status: 0,
      pathTemplate: writeStory.pathTemplate,
    });
    assertNoSensitiveData([result, logSink.mock.calls], secrets);
  });

  it.each([
    ["warn", "超时"],
    ["warn", "断连"],
    ["error", "超时"],
    ["error", "断连"],
  ] as const)(
    "P1-2 %s 级别记录成功响应头后的正文%s为 status 0",
    async (level, failure) => {
      vi.useFakeTimers();
      const { http, send, logSink } = setup({
        env: { ZENTAO_TIMEOUT_MS: "20", BZT_LOG_LEVEL: level },
      });
      const response = row(29, 201);
      const readBody = vi.spyOn(response, "text");
      if (failure === "超时")
        readBody.mockReturnValueOnce(new Promise(() => {}));
      else
        readBody.mockRejectedValueOnce(
          new Error(`正文断连 ${password} ${token}`),
        );
      send.mockResolvedValueOnce(login()).mockResolvedValueOnce(response);
      const pending = http.write(writeStory, storyDto);
      await vi.advanceTimersByTimeAsync(20);
      const receipt = await pending;
      expect(receipt).toMatchObject({ status: "unknown", retryable: false });
      expect(logEvents(logSink)).toEqual([
        {
          method: "POST",
          pathTemplate: writeStory.pathTemplate,
          status: 0,
          durationMs: 0,
        },
      ]);
      expect(send).toHaveBeenCalledTimes(2);
      expect(vi.getTimerCount()).toBe(0);
      assertNoSensitiveData([receipt, logSink.mock.calls], secrets);
    },
  );
});

describe("WP-01 禅道分页（06 §2.2）", () => {
  it.each([
    ["v1", "/api.php/v1/products/{id}/stories", "limit", "page"],
    ["v2", "/api.php/v2/story/view", "recPerPage", "pageID"],
  ] as const)(
    "%s 使用正确分页参数，达到 total 后停止并逐页投影",
    async (mode, pathTemplate, sizeKey, pageKey) => {
      const { http, send, logSink } = setup();
      send
        .mockResolvedValueOnce(login())
        .mockResolvedValueOnce(
          Response.json({
            items: [{ id: 1, password }],
            total: 2,
            users: { account: {} },
          }),
        )
        .mockResolvedValueOnce(Response.json({ items: [{ id: 2, token }] }));
      const request = {
        pathTemplate,
        params: mode === "v1" ? { id: 29 } : undefined,
        query: { extra: 3 },
      };
      const result = await paginate(http, request, {
        mode,
        pageSize: 1,
        schema: pageDto,
      });
      expect(result).toEqual({
        items: [{ id: 1 }, { id: 2 }],
        truncated: false,
      });
      expect(send).toHaveBeenCalledTimes(3);
      for (const [index, [url]] of send.mock.calls.slice(1).entries()) {
        expect(Object.fromEntries(new URL(String(url)).searchParams)).toEqual({
          extra: "3",
          [sizeKey]: "1",
          [pageKey]: String(index + 1),
        });
      }
      assertNoSensitiveData([result, logSink.mock.calls], secrets);
    },
  );

  it.each([
    [[], undefined, false],
    [[{ id: 2 }], undefined, false],
    [[], 4, true],
  ] as const)(
    "空页或短页停止，已知总数不符时标记截断",
    async (items, total, truncated) => {
      const { http, send } = setup();
      send
        .mockResolvedValueOnce(login())
        .mockResolvedValueOnce(Response.json({ items, total }));
      await expect(
        paginate(http, story, { mode: "v1", pageSize: 2, schema: pageDto }),
      ).resolves.toEqual({ items, truncated });
      expect(send).toHaveBeenCalledTimes(2);
    },
  );

  it.each([
    [undefined, true],
    [51, true],
    [50, false],
  ] as const)(
    "50 页硬上限（total=%s）标记 truncated=%s",
    async (total, truncated) => {
      const { http, send } = setup();
      send.mockResolvedValueOnce(login()).mockImplementation(async (url) => {
        const page = Number(new URL(String(url)).searchParams.get("pageID"));
        return Response.json({
          items: [{ id: page, password }],
          total: page === 1 ? total : undefined,
        });
      });
      const result = await paginate(
        http,
        { pathTemplate: "/api.php/v2/story/view" },
        { mode: "v2", pageSize: 1, schema: pageDto },
      );
      expect(result.truncated).toBe(truncated);
      expect(result.items).toHaveLength(50);
      expect(result.items[49]).toEqual({ id: 50 });
      expect(send).toHaveBeenCalledTimes(51);
      assertNoSensitiveData(result, secrets);
    },
  );

  it("拒绝非法分页参数和未能投影的页，不吞掉解码错误", async () => {
    const { http, send, logSink } = setup();
    await assertSafeFailure(
      paginate(http, story, { mode: "v1", pageSize: 0, schema: pageDto }),
      "INVALID_INPUT",
      false,
    );
    const badMode = { mode: "v1" as const, pageSize: 1, schema: pageDto };
    Object.assign(badMode, { mode: "v3" });
    await assertSafeFailure(
      paginate(http, story, badMode),
      "INVALID_INPUT",
      false,
    );
    expect(send).not.toHaveBeenCalled();
    send
      .mockResolvedValueOnce(login())
      .mockResolvedValueOnce(Response.json({ items: [{ id: 1 }] }))
      .mockResolvedValueOnce(
        Response.json({ items: [{ id: token }], password }),
      );
    await assertSafeFailure(
      paginate(http, story, { mode: "v1", pageSize: 1, schema: pageDto }),
      "ZENTAO_SCHEMA_MISMATCH",
      false,
    );
    expect(send).toHaveBeenCalledTimes(3);
    assertNoSensitiveData(logSink.mock.calls, secrets);
  });
});
