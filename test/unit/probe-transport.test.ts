import { describe, expect, it, vi } from "vitest";
import { createProbeWriteSender } from "../../src/api/internal/probe-transport.ts";
import type { ProbeWriteOptions } from "../../src/api/internal/probe-transport.ts";
import { assertNoSensitiveData } from "../helpers/assert-no-sensitive-data.ts";

const origin = "https://fixture.example.test/zentao";
const candidate = {
  action: "story.create",
  productId: 29,
  body: {
    product: 29,
    module: 3,
    modules: [3],
    plan: 4,
    title: "离线演练",
    spec: "<p>测试</p>",
    verify: "测试验收",
    assignedTo: "acct_a",
    reviewer: [],
    status: "draft",
  },
};

function setup(overrides: Partial<ProbeWriteOptions> = {}) {
  const send = vi
    .fn<typeof fetch>()
    .mockResolvedValue(new Response(null, { status: 201 }));
  const options: ProbeWriteOptions = {
    baseUrl: origin,
    approval: {
      baseUrl: origin,
      routes: ["POST /api.php/v2/stories"],
      expiresAt: 10,
    },
    modules: new Map([[3, 29]]),
    plans: new Map([[4, 29]]),
    clock: () => 1,
    send,
    ...overrides,
  };
  return {
    send,
    run: (input: unknown) => createProbeWriteSender(options)(input),
  };
}

describe("WP-05 / ADR-19 #29 发送层熔断", () => {
  it("仅在端点已批准且所有归属已确认时，将固定 #29 请求交给模拟发送器", async () => {
    const { run, send } = setup();
    await expect(run(candidate)).resolves.toHaveProperty("status", 201);
    expect(send).toHaveBeenCalledOnce();
    const [url, init] = send.mock.calls[0] ?? [];
    expect(String(url)).toBe(origin + "/api.php/v2/stories?productID=29");
    expect(init).toMatchObject({
      method: "POST",
      redirect: "error",
      headers: { "Content-Type": "application/json" },
    });
    expect(JSON.parse(String(init?.body))).toEqual(candidate.body);
  });

  it("接受明确配置的数字 29，以及未关联计划的草稿", async () => {
    const { plan: _plan, ...body } = candidate.body;
    const { run, send } = setup({
      settings: { productId: 29 },
      plans: new Map(),
    });
    await expect(run({ ...candidate, body })).resolves.toHaveProperty(
      "status",
      201,
    );
    expect(send).toHaveBeenCalledOnce();
  });

  it("ADR-19 重放使用中的批准，五次调用只发送一次", async () => {
    const pending = Promise.withResolvers<Response>();
    const send = vi.fn<typeof fetch>().mockReturnValue(pending.promise);
    const { run } = setup({ send });
    const first = run(candidate);
    expect(send).toHaveBeenCalledTimes(1);
    const retries = [
      run(candidate),
      run(candidate),
      run(candidate),
      run(candidate),
    ];
    const attempts = Promise.allSettled(retries);
    pending.resolve(new Response(null, { status: 201 }));
    await expect(first).resolves.toHaveProperty("status", 201);
    expect(send).toHaveBeenCalledTimes(1);
    for (const retry of await attempts) {
      expect(retry).toMatchObject({
        status: "rejected",
        reason: { code: "PERMISSION_DENIED" },
      });
    }
    expect(send).toHaveBeenCalledTimes(1);
  });

  it("ADR-19 失败后重试三次均不发送，回执为 unknown 且不含下游异常", async () => {
    const send = vi
      .fn<typeof fetch>()
      .mockRejectedValue(new Error("Token: synthetic-token"));
    const { run } = setup({ send });
    const result = await run(candidate);
    expect(result).toMatchObject({ status: "unknown", retryable: false });
    expect(result).toHaveProperty(
      "message",
      expect.stringContaining("禁止重新创建"),
    );
    assertNoSensitiveData(result, ["synthetic-token"]);
    expect(send).toHaveBeenCalledTimes(1);
    for (let attempt = 0; attempt < 3; attempt++) {
      await expect(run(candidate)).rejects.toHaveProperty(
        "code",
        "PERMISSION_DENIED",
      );
      expect(send).toHaveBeenCalledTimes(1);
    }
  });

  it.each([
    ["默认 15000ms", undefined, 15000],
    ["ZENTAO_TIMEOUT_MS=20", { ZENTAO_TIMEOUT_MS: "20" }, 20],
  ] as const)(
    "ADR-19 %s 中止发送，超时后重试不发送",
    async (_name, env, timeout) => {
      vi.useFakeTimers();
      try {
        const send = vi
          .fn<typeof fetch>()
          .mockImplementation(() => new Promise(() => {}));
        const { run } = setup({ send, env });
        const result = run(candidate);
        expect(send).toHaveBeenCalledTimes(1);
        const signal = send.mock.calls[0]?.[1]?.signal;
        expect(signal).toBeInstanceOf(AbortSignal);
        await vi.advanceTimersByTimeAsync(timeout - 1);
        expect(signal?.aborted).toBe(false);
        await vi.advanceTimersByTimeAsync(1);
        expect(signal?.aborted).toBe(true);
        await expect(result).resolves.toMatchObject({
          status: "unknown",
          retryable: false,
        });
        await expect(run(candidate)).rejects.toHaveProperty(
          "code",
          "PERMISSION_DENIED",
        );
        expect(send).toHaveBeenCalledTimes(1);
      } finally {
        vi.useRealTimers();
      }
    },
  );

  it("ADR-19 成功后重试不发送", async () => {
    const { run, send } = setup();
    await expect(run(candidate)).resolves.toHaveProperty("status", 201);
    expect(send).toHaveBeenCalledTimes(1);
    await expect(run(candidate)).rejects.toHaveProperty(
      "code",
      "PERMISSION_DENIED",
    );
    expect(send).toHaveBeenCalledTimes(1);
  });

  it.each([
    ["产品编号不符", { ...candidate, productId: 42 }],
    [
      "请求体产品不符",
      { ...candidate, body: { ...candidate.body, product: 42 } },
    ],
    ["字符串产品号", { ...candidate, productId: "29" }],
    [
      "模块参数不一致",
      { ...candidate, body: { ...candidate.body, modules: [9] } },
    ],
    ["删除", { ...candidate, method: "DELETE" }],
    ["试图覆盖查询参数", { ...candidate, query: { productID: 42 } }],
    [
      "试图传入外部路径",
      { ...candidate, path: "https://outside.example.test/api.php" },
    ],
    ["试图跟随重定向", { ...candidate, redirect: "follow" }],
    [
      "额外产品字段",
      { ...candidate, body: { ...candidate.body, productID: 42 } },
    ],
    ["未验证归属的 ID 端点", { action: "story.assign", productId: 29, id: 11 }],
    [
      "试图覆盖 HTTP 方法",
      { ...candidate, headers: { "X-HTTP-Method-Override": "DELETE" } },
    ],
  ])("拦截%s且发送次数为 0", async (_name, input) => {
    const { run, send } = setup();
    await expect(run(input)).rejects.toHaveProperty(
      "code",
      "PERMISSION_DENIED",
    );
    expect(send).not.toHaveBeenCalled();
  });

  const blockedContexts: [string, Partial<ProbeWriteOptions>][] = [
    ["非 #29 配置", { settings: { productId: 42 } }],
    ["字符串产品号配置", { settings: { productId: "29" } }],
    ["非法配置对象", { settings: null }],
    ["无模块归属", { modules: new Map() }],
    ["跨产品模块", { modules: new Map([[3, 42]]) }],
    ["无计划归属", { plans: new Map() }],
    ["跨产品计划", { plans: new Map([[4, 42]]) }],
    ["同主机但不同实例前缀", { baseUrl: origin + "-other" }],
    ["不同主机", { baseUrl: "https://outside.example.test/zentao" }],
    [
      "地址包含凭据",
      { baseUrl: "https://acct:testSecret@fixture.example.test/zentao" },
    ],
    ["地址自带查询参数", { baseUrl: origin + "?productID=42" }],
    ["地址自带片段", { baseUrl: origin + "#other" }],
    ["地址协议不支持", { baseUrl: "file:///zentao" }],
    ["地址无法解析", { baseUrl: "not a URL" }],
    [
      "路由未获确认",
      { approval: { baseUrl: origin, routes: [], expiresAt: 10 } },
    ],
    ["计划过期", { clock: () => 10 }],
    ["时间无效", { clock: () => NaN }],
  ];

  it.each(blockedContexts)(
    "拦截%s，回执也不含敏感数据",
    async (_name, context) => {
      const { run, send } = setup(context);
      const result = run(candidate);
      await expect(result).rejects.toHaveProperty("name", "BztError");
      await result.catch((error: unknown) =>
        assertNoSensitiveData(String(error), ["testSecret"]),
      );
      expect(send).not.toHaveBeenCalled();
    },
  );
});
