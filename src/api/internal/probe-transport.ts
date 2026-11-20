import { z } from "zod";
import type { Clock } from "../../core/clock.ts";
import {
  PROBE_PRODUCT_ID,
  probeSettings,
  resolveZentaoTimeout,
} from "../../core/config.ts";
import { BztError } from "../../core/errors.ts";

const storyPath = "api.php/v2/stories";
const storyRoute = "POST /" + storyPath;
const productId = z.literal(PROBE_PRODUCT_ID);
const id = z.int().positive();

// 阶段 2 只开放这一条离线配方，ID 路由需单独提供归属保证。
const draftRequest = z.strictObject({
  action: z.literal("story.create"),
  productId,
  body: z.strictObject({
    product: productId,
    module: id,
    modules: z.tuple([id]),
    plan: id.optional(),
    title: z.string().min(1),
    spec: z.string(),
    verify: z.string(),
    assignedTo: z.string().min(1),
    reviewer: z.tuple([]),
    status: z.literal("draft"),
  }),
});

export interface ProbeWriteOptions {
  readonly baseUrl: string;
  readonly settings?: unknown;
  readonly env?: Readonly<{ ZENTAO_TIMEOUT_MS?: string }>;
  readonly approval: {
    readonly baseUrl: string;
    readonly routes: readonly string[];
    readonly expiresAt: number;
  };
  // 归属信息由已确认实例的回读提供。阶段 2 只注入离线数据。
  readonly modules: ReadonlyMap<number, number>;
  readonly plans: ReadonlyMap<number, number>;
  readonly clock: Clock;
  readonly send: typeof fetch;
}

const usedApprovals = new WeakSet<ProbeWriteOptions["approval"]>();
const unknownWrite = Object.freeze({
  status: "unknown",
  retryable: false,
  message: "探查写入结果不明，需要回读确认，禁止重新创建。",
} as const);

function denied(): BztError {
  return new BztError("PERMISSION_DENIED", "探查请求超出已确认的 #29 范围。");
}

function parseBaseUrl(input: string): URL {
  const url = URL.parse(input);
  if (
    !url ||
    (url.protocol !== "http:" && url.protocol !== "https:") ||
    url.username ||
    url.password ||
    url.search ||
    url.hash
  ) {
    throw denied();
  }
  url.pathname = url.pathname.replace(/\/+$/u, "") + "/";
  return url;
}

export function createProbeWriteSender(options: ProbeWriteOptions) {
  return async (input: unknown): Promise<Response | typeof unknownWrite> => {
    if (usedApprovals.has(options.approval)) throw denied();
    const baseUrl = parseBaseUrl(options.baseUrl);
    const approvedBaseUrl = parseBaseUrl(options.approval.baseUrl);
    if (
      baseUrl.href !== approvedBaseUrl.href ||
      !options.approval.routes.includes(storyRoute) ||
      !probeSettings.safeParse(options.settings).success
    ) {
      throw denied();
    }

    const now = options.clock();
    if (
      !Number.isFinite(now) ||
      !Number.isFinite(options.approval.expiresAt) ||
      now >= options.approval.expiresAt
    ) {
      throw new BztError("PLAN_EXPIRED", "探查预览已过期或无法校验时间。");
    }

    const request = draftRequest.safeParse(input);
    if (!request.success) {
      throw denied();
    }

    const body = request.data.body;
    if (
      body.module !== body.modules[0] ||
      options.modules.get(body.module) !== PROBE_PRODUCT_ID ||
      (body.plan !== undefined &&
        options.plans.get(body.plan) !== PROBE_PRODUCT_ID)
    ) {
      throw denied();
    }

    // 从严格配方构造实际 URL，调用方无法覆盖路径、查询参数或方法。
    const url = new URL(storyPath, baseUrl);
    url.searchParams.set("productID", String(PROBE_PRODUCT_ID));
    const timeoutMs = resolveZentaoTimeout(options.env);
    const controller = new AbortController();
    const expired = Promise.withResolvers<typeof unknownWrite>();
    const timer = setTimeout(() => {
      expired.resolve(unknownWrite);
      controller.abort();
    }, timeoutMs);

    // 同步消耗批准，覆盖并发和发送后的不确定结果。
    usedApprovals.add(options.approval);
    try {
      return await Promise.race([
        options.send(url, {
          method: "POST",
          redirect: "error",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify(body),
          signal: controller.signal,
        }),
        expired.promise,
      ]);
    } catch {
      return unknownWrite;
    } finally {
      clearTimeout(timer);
    }
  };
}
