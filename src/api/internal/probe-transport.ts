import { createHash, randomUUID } from "node:crypto";
import { z } from "zod";
import type { Clock } from "../../core/clock.ts";
import {
  PROBE_APPROVAL_MAX_TTL_MS,
  PROBE_PRODUCT_ID,
  probeSettings,
  resolveZentaoTimeout,
} from "../../core/config.ts";
import { BztError } from "../../core/errors.ts";
import {
  hasProbeOwnership,
  parseProbeBaseUrl,
  probeDenied,
} from "./probe-scope.ts";
import type { VerifiedOwnership } from "./probe-scope.ts";

const storyPath = "api.php/v2/stories?productID=" + PROBE_PRODUCT_ID;
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
  readonly approval: ProbeWriteApproval;
  readonly ownership: VerifiedOwnership;
  readonly clock: Clock;
  readonly send: typeof fetch;
}

interface ProbeWriteApproval {
  readonly nonce: string;
}

const approvals = new WeakMap<
  ProbeWriteApproval,
  { baseUrl: string; route: string; bodyHash: string; expiresAt: number }
>();
const unknownWrite = Object.freeze({
  status: "unknown",
  retryable: false,
  message: "探查写入结果不明，需要回读确认，禁止重新创建。",
} as const);

function ensureApprovalLifetime(expiresAt: number, now: number): void {
  if (
    !Number.isSafeInteger(now) ||
    !Number.isSafeInteger(expiresAt) ||
    expiresAt <= now ||
    expiresAt - now > PROBE_APPROVAL_MAX_TTL_MS
  ) {
    throw new BztError("PLAN_EXPIRED", "探查批准已过期或有效期超出允许范围。");
  }
}

function encodeBody(body: z.infer<typeof draftRequest>["body"]): string {
  // 配方只有一层对象及定长数组。数组保留顺序，对象键按字典序写入。
  return JSON.stringify(body, Object.keys(body).sort());
}

function hashBody(body: string): string {
  return createHash("sha256").update(body).digest("hex");
}

export function createProbeWriteApproval(
  confirmed: {
    baseUrl: string;
    route: string;
    expiresAt: number;
    clock: Clock;
  },
  input: unknown,
): ProbeWriteApproval {
  const baseUrl = parseProbeBaseUrl(confirmed.baseUrl);
  const request = draftRequest.safeParse(input);
  if (!request.success || confirmed.route !== storyRoute) throw probeDenied();
  ensureApprovalLifetime(confirmed.expiresAt, confirmed.clock());

  const approval = Object.freeze({ nonce: randomUUID() });
  approvals.set(approval, {
    baseUrl: baseUrl.href,
    route: confirmed.route,
    bodyHash: hashBody(encodeBody(request.data.body)),
    expiresAt: confirmed.expiresAt,
  });
  return approval;
}

export function createProbeWriteSender(options: ProbeWriteOptions) {
  return async (input: unknown): Promise<Response | typeof unknownWrite> => {
    const approval = options.approval;
    const binding = approvals.get(approval);
    const baseUrl = parseProbeBaseUrl(options.baseUrl);
    if (
      !binding ||
      baseUrl.href !== binding.baseUrl ||
      binding.route !== storyRoute ||
      !probeSettings.safeParse(options.settings).success
    ) {
      throw probeDenied();
    }
    ensureApprovalLifetime(binding.expiresAt, options.clock());

    const request = draftRequest.safeParse(input);
    if (!request.success) {
      throw probeDenied();
    }

    const body = request.data.body;
    const encodedBody = encodeBody(body);
    if (
      body.module !== body.modules[0] ||
      hashBody(encodedBody) !== binding.bodyHash ||
      !hasProbeOwnership(options.ownership, baseUrl, body.module, body.plan)
    ) {
      throw probeDenied();
    }

    // 从严格配方构造实际 URL，调用方无法覆盖路径、查询参数或方法。
    const url = new URL(storyPath, baseUrl);
    const timeoutMs = resolveZentaoTimeout(options.env);
    // 同步消耗批准，覆盖并发和发送后的不确定结果。
    if (!approvals.delete(approval)) throw probeDenied();
    const controller = new AbortController();
    const expired = Promise.withResolvers<typeof unknownWrite>();
    const timer = setTimeout(() => {
      expired.resolve(unknownWrite);
      controller.abort();
    }, timeoutMs);

    try {
      return await Promise.race([
        options.send(url, {
          method: "POST",
          redirect: "error",
          headers: { "Content-Type": "application/json" },
          body: encodedBody,
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
