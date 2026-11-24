import { createHash, randomUUID } from "node:crypto";
import { z } from "zod";
import type { Clock } from "../../core/clock.ts";
import {
  PROBE_APPROVAL_MAX_TTL_MS,
  PROBE_PRODUCT_ID,
  probeSettings,
  resolveZentaoTimeout,
} from "../../core/config.ts";
import { zId } from "../../core/dto/common.ts";
import { BztError } from "../../core/errors.ts";
import { withInstanceWriteLock } from "../../core/http-policy.ts";
import type { ZentaoReadClient } from "../client.ts";
import { assertNoBusinessError } from "./business-error.ts";
import {
  assertProbeStoryOwnership,
  hasOpenProbePlan,
  hasProbeOwnership,
  parseProbeBaseUrl,
  probeDenied,
} from "./probe-scope.ts";
import type { ProbeStoryIdentity, VerifiedOwnership } from "./probe-scope.ts";
import { getReadClient } from "./read-client.ts";

const draftPath = "/api.php/v2/stories?productID=" + PROBE_PRODUCT_ID;
const productId = z.literal(PROBE_PRODUCT_ID);
const id = z.int().positive();
// 校验必填文本，同时保留批准所绑定的原始请求体。
const requiredText = z.string().refine((value) => value.trim() !== "");
// docs/06 §6.1 的表单枚举，兼容 strict-ai 使用的来源。
const storySource = z.enum([
  "customer",
  "user",
  "po",
  "market",
  "service",
  "operation",
  "support",
  "competitor",
  "partner",
  "dev",
  "tester",
  "bug",
  "forum",
  "other",
  "ai",
]);

const draftRequest = z.strictObject({
  action: z.literal("story.create"),
  productId,
  body: z.strictObject({
    product: productId,
    type: z.literal("story").optional(),
    module: id,
    modules: z.tuple([id]),
    plan: id.optional(),
    title: requiredText,
    category: z.enum(["feature", "design"]).optional(),
    source: storySource.optional(),
    sourceNote: z.string().optional(),
    feedbackBy: z.string().optional(),
    pri: z.int().min(1).max(4).optional(),
    estimate: z.number().nonnegative().optional(),
    spec: requiredText,
    verify: requiredText,
    keywords: z.string().optional(),
    assignedTo: requiredText,
    reviewer: z.tuple([]),
    status: z.literal("draft"),
  }),
});

const storyRef = { productId, id };
const comment = requiredText.optional();
const editBody = z
  .strictObject({
    title: requiredText.optional(),
    spec: requiredText.optional(),
    keywords: z.string().optional(),
    plan: id.optional(),
  })
  .refine((body) => Object.values(body).some((value) => value !== undefined));
const writeRequest = z.union([
  draftRequest,
  z.strictObject({
    action: z.literal("story.assign"),
    ...storyRef,
    body: z.strictObject({ assignedTo: requiredText, comment }),
  }),
  z.strictObject({
    action: z.literal("story.close"),
    ...storyRef,
    body: z.strictObject({ closedReason: z.literal("cancel"), comment }),
  }),
  z.strictObject({
    action: z.literal("story.comment"),
    ...storyRef,
    candidate: z.literal("v2").optional(),
    body: z.strictObject({ comment: requiredText }),
  }),
  z.strictObject({
    action: z.literal("story.edit"),
    ...storyRef,
    body: editBody,
  }),
  z.strictObject({
    action: z.literal("story.activate"),
    ...storyRef,
    body: z.strictObject({ comment }),
  }),
  z.strictObject({
    action: z.literal("story.activate"),
    ...storyRef,
    candidate: z.literal("put"),
    body: z.strictObject({ status: z.literal("active") }),
  }),
]);
type ProbeRequest = z.infer<typeof writeRequest>;

interface ProbeRoute {
  method: "POST" | "PUT";
  path: string;
  pathTemplate: string;
  objectId?: number;
}

function routeFor(request: ProbeRequest): ProbeRoute {
  if (request.action === "story.create") {
    return {
      method: "POST",
      path: draftPath,
      pathTemplate: "/api.php/v2/stories",
    };
  }
  if (request.action === "story.comment" && request.candidate === "v2") {
    return {
      method: "POST",
      path: `/api.php/v2/action/comment?objectType=story&objectID=${request.id}`,
      pathTemplate: "/api.php/v2/action/comment",
      objectId: request.id,
    };
  }

  const put =
    request.action === "story.edit" ||
    (request.action === "story.activate" && "candidate" in request);
  const suffix = put ? "" : request.action.slice("story".length + 1);
  const actionPath = suffix ? `/${suffix}` : "";
  return {
    method: put ? "PUT" : "POST",
    path: `/api.php/v1/stories/${request.id}${actionPath}`,
    pathTemplate: `/api.php/v1/stories/{id}${actionPath}`,
    objectId: request.id,
  };
}

function parseWriteRequest(input: unknown): ProbeRequest {
  const parsed = writeRequest.safeParse(input);
  if (!parsed.success) throw probeDenied();
  return parsed.data;
}

export function getProbeWriteRoute(input: unknown): string {
  const { method, path } = routeFor(parseWriteRequest(input));
  return `${method} ${path}`;
}

interface ProbePreflight {
  isPlanOpen(instance: string, planId: number): boolean;
  isAssigneeActive(instance: string, account: string): boolean;
}

interface ProbeWriteContext {
  readonly baseUrl: string;
  readonly settings?: unknown;
  readonly env?: Readonly<{ ZENTAO_TIMEOUT_MS?: string }>;
  readonly approval: ProbeWriteApproval;
  readonly ownership?: VerifiedOwnership;
  readonly preflight?: ProbePreflight;
  readonly clock: Clock;
  readonly client?: ZentaoReadClient;
}

interface ProbeSender {
  readonly send: typeof fetch;
  readonly sessionToken?: string;
}

export interface ProbeWriteOptions extends ProbeWriteContext {
  readonly send: typeof fetch;
}

interface ProbeWriteApproval {
  readonly nonce: string;
}

const approvals = new WeakMap<
  ProbeWriteApproval,
  {
    baseUrl: string;
    route: string;
    action: ProbeRequest["action"];
    bodyHash: string;
    expiresAt: number;
  }
>();
const receipts = new WeakMap<
  Response,
  {
    client: ZentaoReadClient;
    created?: ProbeStoryIdentity;
    sessionToken: string;
  }
>();
const currentProbeStories = new WeakMap<
  ZentaoReadClient,
  Map<number, ProbeStoryIdentity>
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

function encodeBody(body: ProbeRequest["body"]): string {
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
  const request = parseWriteRequest(input);
  const { method, path } = routeFor(request);
  if (confirmed.route !== `${method} ${path}`) throw probeDenied();
  ensureApprovalLifetime(confirmed.expiresAt, confirmed.clock());

  const approval = Object.freeze({ nonce: randomUUID() });
  approvals.set(approval, {
    baseUrl: baseUrl.href,
    route: confirmed.route,
    action: request.action,
    bodyHash: hashBody(encodeBody(request.body)),
    expiresAt: confirmed.expiresAt,
  });
  return approval;
}

function assertDraftPreflight(
  options: ProbeWriteContext,
  baseUrl: URL,
  body: z.infer<typeof draftRequest>["body"],
  live: boolean,
): void {
  if (
    body.module !== body.modules[0] ||
    !hasProbeOwnership(options.ownership, baseUrl, body.module, body.plan)
  ) {
    throw probeDenied();
  }
  if (
    (body.plan !== undefined &&
      ((live && !hasOpenProbePlan(options.ownership, baseUrl, body.plan)) ||
        options.preflight?.isPlanOpen(baseUrl.href, body.plan) !== true)) ||
    options.preflight?.isAssigneeActive(baseUrl.href, body.assignedTo) !== true
  ) {
    throw probeDenied();
  }
}

async function assertIdPreflight(
  options: ProbeWriteContext,
  baseUrl: URL,
  request: Exclude<ProbeRequest, z.infer<typeof draftRequest>>,
): Promise<void> {
  const { client } = options;
  let expected: ProbeStoryIdentity | undefined;
  if (request.action === "story.assign") {
    if (
      options.preflight?.isAssigneeActive(
        baseUrl.href,
        request.body.assignedTo,
      ) !== true
    ) {
      throw probeDenied();
    }
  } else if (request.action !== "story.close") {
    expected = client && currentProbeStories.get(client)?.get(request.id);
    if (!expected) throw probeDenied();
    if (
      request.action === "story.edit" &&
      request.body.plan !== undefined &&
      !hasOpenProbePlan(options.ownership, baseUrl, request.body.plan)
    ) {
      throw probeDenied();
    }
  }
  await assertProbeStoryOwnership(client, baseUrl, request.id, expected);
}

async function sendApprovedProbeWrite(
  options: ProbeWriteContext,
  input: unknown,
  source: ProbeSender | ((route: ProbeRoute) => Promise<ProbeSender>),
): Promise<Response | typeof unknownWrite> {
  const { approval, client } = options;
  const binding = approvals.get(approval);
  const baseUrl = parseProbeBaseUrl(options.baseUrl);
  if (
    !binding ||
    baseUrl.href !== binding.baseUrl ||
    !probeSettings.safeParse(options.settings).success
  ) {
    throw probeDenied();
  }
  const request = parseWriteRequest(input);
  const route = routeFor(request);
  const encodedBody = encodeBody(request.body);
  if (
    request.action !== binding.action ||
    `${route.method} ${route.path}` !== binding.route ||
    hashBody(encodedBody) !== binding.bodyHash
  ) {
    throw probeDenied();
  }

  const timeoutMs = resolveZentaoTimeout(options.env);
  ensureApprovalLifetime(binding.expiresAt, options.clock());
  const live = typeof source === "function";
  if (request.action === "story.create") {
    assertDraftPreflight(options, baseUrl, request.body, live);
  } else {
    await assertIdPreflight(options, baseUrl, request);
  }

  // 从严格配方构造 URL。认证只作用于收到本次批准的实际请求。
  const url = new URL(route.path.slice(1), baseUrl);
  const { send, sessionToken } = live ? await source(route) : source;
  ensureApprovalLifetime(binding.expiresAt, options.clock());
  // 同步消耗批准，覆盖并发和发送后的不确定结果。
  if (!approvals.delete(approval)) throw probeDenied();
  const controller = new AbortController();
  const expired = Promise.withResolvers<typeof unknownWrite>();
  const timer = setTimeout(() => {
    expired.resolve(unknownWrite);
    controller.abort();
  }, timeoutMs);

  try {
    const response = await Promise.race([
      send(url, {
        method: route.method,
        redirect: "error",
        headers: { "Content-Type": "application/json" },
        body: encodedBody,
        signal: controller.signal,
      }),
      expired.promise,
    ]);
    if (response instanceof Response && client && sessionToken !== undefined) {
      receipts.set(response, {
        client,
        // 候选写入必须匹配批准中的标题与实际登录身份，避免误用响应中的旧 ID。
        created:
          request.action === "story.create"
            ? {
                title: request.body.title,
                openedBy: getReadClient(client).account,
              }
            : undefined,
        sessionToken,
      });
    }
    return response;
  } catch {
    return unknownWrite;
  } finally {
    clearTimeout(timer);
  }
}

export function createProbeWriteSender(options: ProbeWriteOptions) {
  return (input: unknown) =>
    sendApprovedProbeWrite(options, input, { send: options.send });
}

export async function sendAuthenticatedProbeWrite(
  options: ProbeWriteContext & { client: ZentaoReadClient },
  input: unknown,
): Promise<Response | typeof unknownWrite> {
  const { baseUrl, getProbeSender } = getReadClient(options.client);
  if (parseProbeBaseUrl(options.baseUrl).href !== baseUrl) throw probeDenied();
  return withInstanceWriteLock(baseUrl, () =>
    sendApprovedProbeWrite(options, input, getProbeSender),
  );
}

const envelope = z.object({
  id: z.unknown().optional(),
  status: z.unknown().optional(),
  result: z.unknown().optional(),
  success: z.unknown().optional(),
  error: z.unknown().optional(),
  message: z.unknown().optional(),
  story: z.object({ id: z.unknown().optional() }).optional().catch(undefined),
  data: z.object({ id: z.unknown().optional() }).optional().catch(undefined),
  changes: z
    .object({ objectID: z.unknown().optional() })
    .optional()
    .catch(undefined),
});

function reportedStoryId(body: z.infer<typeof envelope>): number | undefined {
  const ids = new Set<number>();
  for (const input of [
    body.id,
    body.story?.id,
    body.data?.id,
    body.changes?.objectID,
  ]) {
    const parsed = zId.safeParse(input);
    if (parsed.success) ids.add(parsed.data);
  }
  if (ids.size === 1) return ids.values().next().value;
}

function hasRecognizedFailure(body: z.infer<typeof envelope>): boolean {
  if (
    body.success === false ||
    body.status === "fail" ||
    body.status === "failed" ||
    body.status === "error" ||
    body.result === "error" ||
    body.result === "failure"
  ) {
    return true;
  }
  try {
    // v2 写入采用 status=success，通用解码同时兼容 result=success。
    const { result, status, error, message } = body;
    assertNoBusinessError(
      {
        result: result ?? (status === "success" ? "success" : undefined),
        error,
        message,
      },
      true,
    );
    return false;
  } catch {
    return true;
  }
}

export async function readProbeWriteResponse(response: Response): Promise<{
  body: unknown;
  createdStoryId?: number;
  recognizedFailure: boolean;
  sessionToken?: string;
}> {
  const receipt = receipts.get(response);
  receipts.delete(response);
  let body: unknown;
  try {
    const text = await response.text();
    body = text === "" ? null : JSON.parse(text);
  } catch {
    // 响应并非 JSON 时交由调用方回读确认。
  }
  const parsed = envelope.safeParse(body);
  const recognizedFailure = parsed.success && hasRecognizedFailure(parsed.data);
  const created = receipt?.created;
  const createdStoryId =
    created && parsed.success ? reportedStoryId(parsed.data) : undefined;
  if (
    receipt &&
    created &&
    createdStoryId !== undefined &&
    response.ok &&
    !recognizedFailure
  ) {
    const stories =
      currentProbeStories.get(receipt.client) ??
      new Map<number, ProbeStoryIdentity>();
    stories.set(createdStoryId, created);
    currentProbeStories.set(receipt.client, stories);
  }
  return {
    body,
    createdStoryId,
    recognizedFailure,
    sessionToken: receipt?.sessionToken,
  };
}
