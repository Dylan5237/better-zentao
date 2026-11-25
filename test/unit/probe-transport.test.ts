import { afterEach, describe, expect, it, vi } from "vitest";
import { createZentaoReadClient } from "../../src/api/client.ts";
import {
  decodeProbeOwnership,
  parseProbeBaseUrl,
} from "../../src/api/internal/probe-scope.ts";
import {
  createProbeWriteApproval,
  createProbeWriteSender,
  getProbeWriteRoute,
  readProbeWriteResponse,
  sendAuthenticatedProbeWrite,
} from "../../src/api/internal/probe-transport.ts";
import type { ProbeWriteOptions } from "../../src/api/internal/probe-transport.ts";
import { PROBE_APPROVAL_MAX_TTL_MS } from "../../src/core/config.ts";
import { assertNoSensitiveData } from "../helpers/assert-no-sensitive-data.ts";

const origin = "https://fixture.example.test/zentao";
const confirmation = {
  baseUrl: origin,
  route: "POST /api.php/v2/stories?productID=29",
  expiresAt: 10,
  clock: () => 1,
};
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

const modules = [{ id: 3, product: 29 }];
const plans = [{ id: 4, product: 29 }];
const defaultOwnership = await decodeProbeOwnership(
  origin,
  Response.json({ modules, plans }),
);
const liveOwnership = await decodeProbeOwnership(
  origin,
  Response.json({
    modules,
    plans: [{ id: 4, product: 29, status: "wait", deleted: false }],
  }),
);

function setup(
  overrides: Partial<ProbeWriteOptions> = {},
  approved: unknown = candidate,
) {
  const send = vi
    .fn<typeof fetch>()
    .mockResolvedValue(new Response(null, { status: 201 }));
  const options: ProbeWriteOptions = {
    baseUrl: origin,
    approval: createProbeWriteApproval(confirmation, approved),
    ownership: defaultOwnership,
    preflight: { isPlanOpen: () => true, isAssigneeActive: () => true },
    clock: () => 1,
    send,
    ...overrides,
  };
  return {
    send,
    approval: options.approval,
    run: (input: unknown) => createProbeWriteSender(options)(input),
  };
}

describe("WP-05 / ADR-19 #29 发送层熔断", () => {
  it.each([
    "https:fixture.test",
    "https://fixture.test\\evil",
    "https://fixture.test/zentao/api.php",
    "https://fixture.test/%61pi.PHP%2Fv2",
    "https://fixture.test/zentao%ZZ",
  ])("拒绝畸形探查基础地址 %j", (input) => {
    expect(() => parseProbeBaseUrl(input)).toThrow(
      expect.objectContaining({ code: "PERMISSION_DENIED" }),
    );
  });

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
    const draft = { ...candidate, body };
    const ownership = await decodeProbeOwnership(
      origin,
      Response.json({ modules, plans: [] }),
    );
    const { run, send } = setup(
      { settings: { productId: 29 }, ownership },
      draft,
    );
    await expect(run(draft)).resolves.toHaveProperty("status", 201);
    expect(send).toHaveBeenCalledOnce();
  });

  it.each([
    ["feature", "user"],
    ["design", "customer"],
    ["feature", "ai"],
  ])(
    "WP-05 发送 06 §6.1 完整配方：category=%s source=%s",
    async (category, source) => {
      const body = {
        ...candidate.body,
        category,
        source,
        sourceNote: "合成来源",
        feedbackBy: "人员A",
        pri: 3,
        estimate: 0,
        keywords: "版本:V7.1.0",
      };
      const draft = { ...candidate, body };
      const { run, send } = setup({}, draft);
      await expect(run(draft)).resolves.toHaveProperty("status", 201);
      expect(send).toHaveBeenCalledTimes(1);
      expect(JSON.parse(String(send.mock.calls[0]?.[1]?.body))).toEqual(body);
    },
  );

  it.each([
    ["空白标题", { title: "   " }],
    ["空白指派人", { assignedTo: " \t " }],
    ["空正文", { spec: "" }],
    ["空白正文", { spec: " \r\n " }],
    ["空验收标准", { verify: "" }],
    ["空白验收标准", { verify: "\n\t" }],
    ["优先级低于 1", { pri: 0 }],
    ["优先级高于 4", { pri: 5 }],
    ["优先级异常大", { pri: 999999 }],
    ["优先级不是整数", { pri: 1.5 }],
  ] as const)("WP-05 拒绝批准%s且发送次数为 0", async (_name, fields) => {
    const invalid = { ...candidate, body: { ...candidate.body, ...fields } };
    const send = vi
      .fn<typeof fetch>()
      .mockResolvedValue(new Response(null, { status: 201 }));
    const approveAndSend = async () => {
      const { run } = setup({ send }, invalid);
      return run(invalid);
    };
    await expect(approveAndSend()).rejects.toHaveProperty(
      "code",
      "PERMISSION_DENIED",
    );
    expect(send).not.toHaveBeenCalled();
  });

  it.each([1, 4])(
    "WP-05 接受优先级边界 %i 和含首尾空白的非空正文",
    async (pri) => {
      const body = { ...candidate.body, pri, spec: "\n<p>合成正文</p>\n" };
      const draft = { ...candidate, body };
      const { run, send } = setup({}, draft);
      await expect(run(draft)).resolves.toHaveProperty("status", 201);
      expect(send).toHaveBeenCalledOnce();
      expect(JSON.parse(String(send.mock.calls[0]?.[1]?.body))).toEqual(body);
    },
  );

  it.each([
    ["计划已关闭", false, true],
    ["指派人不在活动目录中", true, false],
  ] as const)(
    "WP-05 预检拦截%s，发送次数为 0",
    async (_name, planOpen, assigneeActive) => {
      const preflight = {
        isPlanOpen: vi.fn(() => planOpen),
        isAssigneeActive: vi.fn(() => assigneeActive),
      };
      const { run, send } = setup({ preflight });
      await expect(run(candidate)).rejects.toHaveProperty(
        "code",
        "PERMISSION_DENIED",
      );
      expect(preflight.isPlanOpen).toHaveBeenCalledExactlyOnceWith(
        origin + "/",
        4,
      );
      if (planOpen)
        expect(preflight.isAssigneeActive).toHaveBeenCalledExactlyOnceWith(
          origin + "/",
          "acct_a",
        );
      expect(send).toHaveBeenCalledTimes(0);
    },
  );

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

  it.each(["0", "-1", "abc", "2147483648"])(
    "WP-02 / WP-05 非法 ZENTAO_TIMEOUT_MS=%s 报 INVALID_INPUT 且发送次数为 0",
    async (value) => {
      const { run, send } = setup({ env: { ZENTAO_TIMEOUT_MS: value } });
      await expect(run(candidate)).rejects.toHaveProperty(
        "code",
        "INVALID_INPUT",
      );
      expect(send).not.toHaveBeenCalled();
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

  it("ADR-19 调用方手写模块归属不能放行模块 999", async () => {
    const forged = {
      ...candidate,
      body: { ...candidate.body, module: 999, modules: [999] },
    };
    const overrides: Partial<ProbeWriteOptions> = {};
    // 模拟绕过 TypeScript 的旧调用方。
    Object.assign(overrides, {
      ownership: new Map([[999, 29]]),
      modules: new Map([[999, 29]]),
    });
    const { run, send } = setup(overrides, forged);
    await expect(run(forged)).rejects.toHaveProperty(
      "code",
      "PERMISSION_DENIED",
    );
    expect(send).toHaveBeenCalledTimes(0);
  });

  it("ADR-19 批准后更换请求体不会发送", async () => {
    const { run, send } = setup();
    const modified = {
      ...candidate,
      body: { ...candidate.body, title: "未经批准的标题" },
    };
    await expect(run(modified)).rejects.toHaveProperty(
      "code",
      "PERMISSION_DENIED",
    );
    expect(send).toHaveBeenCalledTimes(0);
    await expect(run(candidate)).resolves.toHaveProperty("status", 201);
    expect(send).toHaveBeenCalledTimes(1);
  });

  it("ADR-19 超过批准有效期上限不会发送", async () => {
    const { send } = setup();
    expect(() =>
      createProbeWriteApproval(
        { ...confirmation, expiresAt: Number.MAX_SAFE_INTEGER },
        candidate,
      ),
    ).toThrow(expect.objectContaining({ code: "PLAN_EXPIRED" }));
    expect(send).toHaveBeenCalledTimes(0);
  });

  it("ADR-19 允许有效期上限及等价的请求体键序", async () => {
    const approval = createProbeWriteApproval(
      { ...confirmation, expiresAt: 1 + PROBE_APPROVAL_MAX_TTL_MS },
      candidate,
    );
    const { title, ...rest } = candidate.body;
    const { run, send } = setup({ approval });
    await expect(
      run({ ...candidate, body: { title, ...rest } }),
    ).resolves.toHaveProperty("status", 201);
    expect(send).toHaveBeenCalledTimes(1);
  });

  it("ADR-19 复制批准 nonce 无法发送", async () => {
    const { approval } = setup();
    const { run, send } = setup({ approval: { ...approval } });
    await expect(run(candidate)).rejects.toHaveProperty(
      "code",
      "PERMISSION_DENIED",
    );
    expect(send).toHaveBeenCalledTimes(0);
  });

  it("ADR-19 批准在预检期间过期，发送次数为 0", async () => {
    let now = 1;
    const { run, send } = setup({
      clock: () => now,
      preflight: {
        isPlanOpen: () => true,
        isAssigneeActive: () => {
          now = confirmation.expiresAt;
          return true;
        },
      },
    });
    await expect(run(candidate)).rejects.toHaveProperty("code", "PLAN_EXPIRED");
    expect(send).toHaveBeenCalledTimes(0);
  });

  it("拦截路由未获确认的批准", () => {
    expect(() =>
      createProbeWriteApproval(
        { ...confirmation, route: "DELETE /api.php/v2/stories/11" },
        candidate,
      ),
    ).toThrow(expect.objectContaining({ code: "PERMISSION_DENIED" }));
  });

  it.each([
    ["无模块归属", [], plans, origin],
    ["跨产品模块", [{ id: 3, product: 42 }], plans, origin],
    ["无计划归属", modules, [], origin],
    ["跨产品计划", modules, [{ id: 4, product: 42 }], origin],
    ["来自其他实例的归属", modules, plans, origin + "-other"],
  ] as const)(
    "拦截%s，发送次数为 0",
    async (_name, modules, plans, instance) => {
      const ownership = await decodeProbeOwnership(
        instance,
        Response.json({ modules, plans }),
      );
      const { run, send } = setup({ ownership });
      await expect(run(candidate)).rejects.toHaveProperty(
        "code",
        "PERMISSION_DENIED",
      );
      expect(send).toHaveBeenCalledTimes(0);
    },
  );

  it.each([
    [
      "重复归属",
      Response.json({ modules: [{ id: 3, product: 42 }, ...modules], plans }),
      "ZENTAO_SCHEMA_MISMATCH",
    ],
    ["非法 JSON", new Response("invalid"), "ZENTAO_SCHEMA_MISMATCH"],
    ["回读失败", new Response(null, { status: 503 }), "ZENTAO_UNAVAILABLE"],
  ])("拒绝生成无效回读证据：%s", async (_name, response, code) => {
    await expect(decodeProbeOwnership(origin, response)).rejects.toHaveProperty(
      "code",
      code,
    );
  });

  it.each([
    ["产品编号不符", { ...candidate, productId: 42 }],
    [
      "请求体产品不符",
      { ...candidate, body: { ...candidate.body, product: 42 } },
    ],
    ["字符串产品号", { ...candidate, productId: "29" }],
    [
      "未验证的 category",
      { ...candidate, body: { ...candidate.body, category: "interface" } },
    ],
    [
      "未验证的 source",
      { ...candidate, body: { ...candidate.body, source: "unknown" } },
    ],
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
    ["路由未获确认", { approval: { nonce: "unsigned" } }],
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

describe("WP-05 / ADR-19 需求 ID 路由", () => {
  const assign = {
    action: "story.assign",
    productId: 29,
    id: 11,
    body: { assignedTo: "acct_a", comment: "离线指派" },
  };
  const close = {
    action: "story.close",
    productId: 29,
    id: 11,
    body: { closedReason: "cancel" },
  };
  const comment = {
    action: "story.comment",
    productId: 29,
    id: 11,
    body: { comment: "离线备注" },
  };
  const edit = {
    action: "story.edit",
    productId: 29,
    id: 11,
    body: { title: "离线编辑" },
  };
  const activate = {
    action: "story.activate",
    productId: 29,
    id: 11,
    body: {},
  };
  const basePlan = { ...confirmation, expiresAt: 100 };

  function mockProbeClient({
    product = 29,
    storyId = 11,
    deleted = false,
    title = candidate.body.title,
    openedBy = "acct_a",
    afterRead = () => {},
    writeResponse = () =>
      Response.json(
        {
          result: "success",
          changes: { objectID: 11 },
          secret: "fixture-probe-secret",
        },
        { status: 201 },
      ),
  } = {}) {
    const fetch = vi.fn<typeof globalThis.fetch>(async (request, init) => {
      const url = new URL(String(request));
      expect(url.origin).toBe(new URL(origin).origin);
      expect(init?.redirect).toBe("error");
      if (url.pathname.endsWith("/tokens")) {
        expect(init?.method).toBe("POST");
        return Response.json({ token: "fixture-probe-secret" });
      }
      expect(new Headers(init?.headers).get("Token")).toBe(
        "fixture-probe-secret",
      );
      if (init?.method === "GET") {
        expect(url.pathname).toBe("/zentao/api.php/v1/stories/11");
        afterRead();
        return Response.json({
          type: "story",
          id: storyId,
          product,
          title,
          openedBy,
          status: "draft",
          deleted,
        });
      }
      return writeResponse();
    });
    vi.stubGlobal("fetch", fetch);
    const log: string[] = [];
    const client = createZentaoReadClient({
      baseUrl: origin,
      account: "acct_a",
      password: "fixture-probe-password",
      clock: () => 1,
      env: { BZT_LOG_LEVEL: "debug" },
      logSink: (line) => log.push(line),
    });
    const requests = () =>
      fetch.mock.calls.map(
        ([url, init]) =>
          `${init?.method} ${new URL(String(url)).pathname}${new URL(String(url)).search}`,
      );
    return { client, log, requests };
  }

  function options(
    client: ReturnType<typeof createZentaoReadClient>,
    input: unknown,
    clock = () => 1,
  ) {
    return {
      baseUrl: origin,
      client,
      ownership: liveOwnership,
      preflight: { isPlanOpen: () => true, isAssigneeActive: () => true },
      approval: createProbeWriteApproval(
        { ...basePlan, route: getProbeWriteRoute(input), clock },
        input,
      ),
      clock,
    };
  }

  afterEach(() => vi.unstubAllGlobals());

  it.each([
    [assign, "POST /api.php/v1/stories/11/assign"],
    [close, "POST /api.php/v1/stories/11/close"],
    [comment, "POST /api.php/v1/stories/11/comment"],
    [
      { ...comment, candidate: "v2" },
      "POST /api.php/v2/action/comment?objectType=story&objectID=11",
    ],
    [edit, "PUT /api.php/v1/stories/11"],
    [activate, "POST /api.php/v1/stories/11/activate"],
    [
      { ...activate, candidate: "put", body: { status: "active" } },
      "PUT /api.php/v1/stories/11",
    ],
  ])("从严格配方导出固定端点 %#", (input, route) => {
    expect(getProbeWriteRoute(input)).toBe(route);
  });

  it.each([
    { ...assign, productId: 42 },
    { ...assign, id: "11" },
    { ...assign, id: -1 },
    { ...assign, body: { ...assign.body, product: 42 } },
    { ...close, body: { ...close.body, delete: true } },
    { ...comment, candidate: "v2", body: { ...comment.body, objectID: 42 } },
    { ...comment, candidate: "https://outside.fixture.test" },
    { ...activate, candidate: "put", body: { status: "closed" } },
    { ...edit, body: {} },
  ])("拒绝申请不在配方内的对象变更 %#", (input) => {
    expect(() => getProbeWriteRoute(input)).toThrow(
      expect.objectContaining({ code: "PERMISSION_DENIED" }),
    );
  });

  it.each([assign, close])(
    "先用同一认证客户端回读 #29 需求，再发送 $action",
    async (input) => {
      const { client, log, requests } = mockProbeClient();
      const result = await sendAuthenticatedProbeWrite(
        options(client, input),
        input,
      );
      expect(result).toHaveProperty("status", 201);
      expect(requests()).toEqual([
        "POST /zentao/api.php/v1/tokens",
        "GET /zentao/api.php/v1/stories/11",
        `POST /zentao/api.php/v1/stories/11/${input.action.split(".")[1]}`,
      ]);
      assertNoSensitiveData(log, [
        "fixture-probe-secret",
        "fixture-probe-password",
        "离线指派",
      ]);
    },
  );

  it.each([{ product: 42 }, { storyId: 42 }, { deleted: true }])(
    "需求归属不符时仅回读，写入次数为 0 %#",
    async (invalid) => {
      const { client, requests } = mockProbeClient(invalid);
      await expect(
        sendAuthenticatedProbeWrite(options(client, close), close),
      ).rejects.toHaveProperty("code", "PERMISSION_DENIED");
      expect(requests()).toEqual([
        "POST /zentao/api.php/v1/tokens",
        "GET /zentao/api.php/v1/stories/11",
      ]);
    },
  );

  it("ID 校验期间批准过期，写入次数为 0", async () => {
    let now = 1;
    const { client, requests } = mockProbeClient({
      afterRead: () => {
        now = basePlan.expiresAt;
      },
    });
    await expect(
      sendAuthenticatedProbeWrite(
        options(client, close, () => now),
        close,
      ),
    ).rejects.toHaveProperty("code", "PLAN_EXPIRED");
    expect(requests()).toEqual([
      "POST /zentao/api.php/v1/tokens",
      "GET /zentao/api.php/v1/stories/11",
    ]);
  });

  it("并发重放 ID 路由的批准时只发送一次", async () => {
    const { client, requests } = mockProbeClient();
    const approved = options(client, close);
    const first = sendAuthenticatedProbeWrite(approved, close);
    const second = sendAuthenticatedProbeWrite(approved, close);
    await expect(first).resolves.toHaveProperty("status", 201);
    await expect(second).rejects.toHaveProperty("code", "PERMISSION_DENIED");
    expect(requests()).toEqual([
      "POST /zentao/api.php/v1/tokens",
      "GET /zentao/api.php/v1/stories/11",
      "POST /zentao/api.php/v1/stories/11/close",
    ]);
  });

  it.each([comment, edit, activate])(
    "没有本次创建凭据时不能探查 $action",
    async (input) => {
      const { client, requests } = mockProbeClient();
      await expect(
        sendAuthenticatedProbeWrite(options(client, input), input),
      ).rejects.toHaveProperty("code", "PERMISSION_DENIED");
      expect(
        requests().filter(
          (route) => !route.endsWith("/tokens") && !route.startsWith("GET"),
        ),
      ).toEqual([]);
    },
  );

  it("仅允许同一客户端修改本次创建回读到的需求", async () => {
    const { client, requests } = mockProbeClient();
    const created = await sendAuthenticatedProbeWrite(
      options(client, candidate),
      candidate,
    );
    expect(created).toBeInstanceOf(Response);
    if (!(created instanceof Response)) throw new Error("创建需要返回响应");
    await expect(readProbeWriteResponse(created)).resolves.toMatchObject({
      createdStoryId: 11,
    });
    for (const input of [comment, edit, activate]) {
      await expect(
        sendAuthenticatedProbeWrite(options(client, input), input),
      ).resolves.toHaveProperty("status", 201);
    }
    expect(requests()).toEqual([
      "POST /zentao/api.php/v1/tokens",
      "POST /zentao/api.php/v2/stories?productID=29",
      "GET /zentao/api.php/v1/stories/11",
      "POST /zentao/api.php/v1/stories/11/comment",
      "GET /zentao/api.php/v1/stories/11",
      "PUT /zentao/api.php/v1/stories/11",
      "GET /zentao/api.php/v1/stories/11",
      "POST /zentao/api.php/v1/stories/11/activate",
    ]);
    const { client: second, requests: secondRequests } = mockProbeClient();
    await expect(
      sendAuthenticatedProbeWrite(options(second, comment), comment),
    ).rejects.toHaveProperty("code", "PERMISSION_DENIED");
    expect(
      secondRequests().filter(
        (route) => !route.endsWith("/tokens") && !route.startsWith("GET"),
      ),
    ).toEqual([]);
  });

  it.each([
    { title: "另一个已经存在的 #29 需求" },
    { openedBy: "acct_b" },
    { openedBy: "" },
  ])("产品正确但需求身份不符时阻断候选写入 %#", async (readback) => {
    const { client, requests } = mockProbeClient(readback);
    const response = await sendAuthenticatedProbeWrite(
      options(client, candidate),
      candidate,
    );
    if (!(response instanceof Response)) throw new Error("创建需要返回响应");
    await expect(readProbeWriteResponse(response)).resolves.toMatchObject({
      createdStoryId: 11,
    });
    await expect(
      sendAuthenticatedProbeWrite(options(client, comment), comment),
    ).rejects.toHaveProperty("code", "PERMISSION_DENIED");
    expect(requests()).toEqual([
      "POST /zentao/api.php/v1/tokens",
      "POST /zentao/api.php/v2/stories?productID=29",
      "GET /zentao/api.php/v1/stories/11",
    ]);
  });

  it.each([
    [{ status: "success", id: "11", message: "已创建" }, 201, 11, false],
    [{ status: "success", id: 11, error: "夹具业务失败" }, 201, 11, true],
    [{ status: "error", id: 11 }, 400, 11, true],
    [{ result: "success", id: 11, story: { id: 42 } }, 201, undefined, false],
  ] as const)(
    "保留创建 ID、HTTP 状态及业务失败边界 %#",
    async (body, status, createdStoryId, recognizedFailure) => {
      const { client, requests } = mockProbeClient({
        writeResponse: () => Response.json(body, { status }),
      });
      const response = await sendAuthenticatedProbeWrite(
        options(client, candidate),
        candidate,
      );
      expect(response).toHaveProperty("status", status);
      if (!(response instanceof Response)) throw new Error("创建需要返回响应");
      await expect(readProbeWriteResponse(response)).resolves.toMatchObject({
        createdStoryId,
        recognizedFailure,
        sessionToken: "fixture-probe-secret",
      });
      if (createdStoryId === undefined || recognizedFailure) {
        await expect(
          sendAuthenticatedProbeWrite(options(client, comment), comment),
        ).rejects.toHaveProperty("code", "PERMISSION_DENIED");
        expect(requests()).toEqual([
          "POST /zentao/api.php/v1/tokens",
          "POST /zentao/api.php/v2/stories?productID=29",
        ]);
      }
    },
  );

  it("响应头成功但正文读取超时，回执为 unknown 且只写一次", async () => {
    vi.useFakeTimers();
    try {
      const { client, requests } = mockProbeClient({
        writeResponse: () =>
          new Response(new ReadableStream(), { status: 201 }),
      });
      const approved = {
        ...options(client, close),
        env: { ZENTAO_TIMEOUT_MS: "20" },
      };
      const pending = sendAuthenticatedProbeWrite(approved, close);
      await vi.advanceTimersByTimeAsync(20);
      await expect(pending).resolves.toMatchObject({
        status: "unknown",
        retryable: false,
      });
      await expect(
        sendAuthenticatedProbeWrite(approved, close),
      ).rejects.toHaveProperty("code", "PERMISSION_DENIED");
      expect(requests()).toEqual([
        "POST /zentao/api.php/v1/tokens",
        "GET /zentao/api.php/v1/stories/11",
        "POST /zentao/api.php/v1/stories/11/close",
      ]);
    } finally {
      vi.useRealTimers();
    }
  });
});

describe("WP-30 / ADR-19 任务关闭", () => {
  const request = { action: "task.close", id: 71, productId: 29, body: {} };

  function setupTaskClose(execution: number) {
    const send = vi.fn<typeof fetch>(async (input, init) => {
      const path = new URL(String(input)).pathname.replace("/zentao", "");
      expect(init?.redirect).toBe("error");
      switch (path) {
        case "/api.php/v1/tokens":
          return Response.json({ token: "synthetic-probe-token" });
        case "/api.php/v1/tasks/71":
          return Response.json({
            id: 71,
            execution,
            story: null,
            parent: 0,
            isParent: false,
            name: "Synthetic task",
            type: "devel",
            mode: "",
            status: "wait",
            estStarted: "2027-01-15",
            deadline: "2027-01-15",
            estimate: 0,
            consumed: 0,
            left: 0,
          });
        case "/api.php/v1/products/29/projects":
          return Response.json({
            projects: [
              { id: 50, multiple: true, status: "doing", products: [29] },
            ],
          });
        case "/api.php/v1/projects/50/executions":
          return Response.json({
            executions: [{ id: 60, project: 50, status: "doing" }],
          });
        case "/api.php/v1/executions/60":
          return Response.json({
            id: 60,
            project: 50,
            status: "doing",
            products: [{ id: 29 }],
          });
        case "/api.php/v1/tasks/71/close":
          return Response.json({ id: 71 });
        default:
          throw new Error("Unexpected fake HTTP path");
      }
    });
    vi.stubGlobal("fetch", send);
    const client = createZentaoReadClient({
      baseUrl: origin,
      account: "acct_a",
      password: "synthetic-probe-password",
      clock: () => 1,
    });
    const approval = createProbeWriteApproval(
      { ...confirmation, route: getProbeWriteRoute(request) },
      request,
    );
    const options = { baseUrl: origin, client, approval, clock: () => 1 };
    return {
      run: () => sendAuthenticatedProbeWrite(options, request),
      writes: () =>
        send.mock.calls.filter(
          ([input, init]) =>
            init?.method === "POST" && !String(input).endsWith("/tokens"),
        ),
    };
  }

  afterEach(() => vi.unstubAllGlobals());

  it("任务属于未获 #29 归属证明的执行时，业务写请求为 0", async () => {
    const { run, writes } = setupTaskClose(42);
    await expect(run()).rejects.toHaveProperty("code", "PERMISSION_DENIED");
    expect(writes()).toHaveLength(0);
  });

  it("并发重放一次性关闭批准只会消费一次，拒绝方新增写请求为 0", async () => {
    const { run, writes } = setupTaskClose(60);
    const first = run();
    const second = run();
    await expect(first).resolves.toHaveProperty("status", 200);
    await expect(second).rejects.toHaveProperty("code", "PERMISSION_DENIED");
    expect(writes()).toHaveLength(1);
    await expect(run()).rejects.toHaveProperty("code", "PERMISSION_DENIED");
    expect(writes()).toHaveLength(1);
  });
});
