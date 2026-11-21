import { z } from "zod";
import type { Clock } from "../../core/clock.ts";
import { resolveZentaoTimeout } from "../../core/config.ts";
import { BztError } from "../../core/errors.ts";
import {
  readRetryDelaysMs,
  withInstanceWriteLock,
  withReadSlot,
} from "../../core/http-policy.ts";
import { httpPathTemplate, writeHttpLog } from "../../core/logger.ts";
import { authFailed, createZentaoAuth } from "./auth.ts";
import { normalizeZentaoBaseUrl } from "./base-url.ts";

const tokenPath = "/api.php/v1/tokens";
const writeMethod = z.enum(["POST", "PUT", "PATCH", "DELETE"]);
const objectId = z.int().positive();

export interface ZentaoHttpOptions {
  readonly baseUrl: string;
  readonly account: string;
  readonly password: string;
  readonly clock: Clock;
  readonly env?: Readonly<{
    ZENTAO_TIMEOUT_MS?: string;
    BZT_LOG_LEVEL?: string;
  }>;
  readonly fetch?: typeof fetch;
  readonly sleep?: (ms: number) => Promise<void>;
  readonly logSink?: (line: string) => void;
}

export interface ReadRequest {
  readonly pathTemplate: string;
  readonly params?: Readonly<Record<string, number>>;
  readonly query?: Readonly<Record<string, string | number>>;
}

interface WriteRequest extends ReadRequest {
  readonly method: z.infer<typeof writeMethod>;
  readonly body?: Readonly<Record<string, unknown>>;
}

interface PreparedRequest {
  readonly method: "GET" | WriteRequest["method"];
  readonly url: string;
  readonly pathTemplate: string;
  readonly body?: string;
}

type FailedAttempt =
  | { kind: "timeout" }
  | { kind: "network" }
  | { kind: "http-error"; status: number };
type Attempt = { kind: "success"; text: string } | FailedAttempt;

const unknownWrite = Object.freeze({
  status: "unknown",
  retryable: false,
  message: "禅道写入结果无法确认，请回读或反查，禁止重新创建。",
} as const);
type WriteReceipt<T> = { status: "accepted"; data: T } | typeof unknownWrite;

function requestUrl(baseUrl: string, request: ReadRequest): string {
  const { pathTemplate, params = {}, query = {} } = request;
  if (
    !httpPathTemplate.safeParse(pathTemplate).success ||
    pathTemplate === tokenPath
  ) {
    throw new BztError("INVALID_INPUT", "禅道业务请求路径模板不合法。");
  }
  const placeholders = new Set<string>();
  const path = pathTemplate
    .slice(1)
    .replace(/\{([A-Za-z][A-Za-z0-9_]*)\}/gu, (_match, key: string) => {
      const id = objectId.safeParse(params[key]);
      if (!Object.hasOwn(params, key) || !id.success) {
        throw new BztError("INVALID_INPUT", "禅道路径参数必须为正整数。");
      }
      placeholders.add(key);
      return String(id.data);
    });
  if (Object.keys(params).some((key) => !placeholders.has(key))) {
    throw new BztError("INVALID_INPUT", "禅道路径参数与模板不匹配。");
  }
  const url = new URL(path, baseUrl);
  for (const [key, value] of Object.entries(query))
    url.searchParams.set(key, String(value));
  return url.href;
}

function encodeBody(body: WriteRequest["body"]): string | undefined {
  if (body === undefined) return undefined;
  try {
    const encoded = JSON.stringify(body);
    if (encoded !== undefined) return encoded;
  } catch {
    // 序列化错误不应带出写入正文。
  }
  throw new BztError("INVALID_INPUT", "禅道写入正文无法编码为 JSON。");
}

function isTransient(result: FailedAttempt): boolean {
  return (
    result.kind !== "http-error" ||
    result.status === 408 ||
    result.status >= 500
  );
}

function requestError(result: FailedAttempt): BztError {
  if (result.kind === "timeout")
    return new BztError("ZENTAO_TIMEOUT", "禅道请求超时。");
  if (result.kind === "network")
    return new BztError("ZENTAO_UNAVAILABLE", "无法连接禅道。");
  const { status } = result;
  if (status === 408) return new BztError("ZENTAO_TIMEOUT", "禅道请求超时。");
  if (status === 401) return authFailed();
  if (status === 403)
    return new BztError("PERMISSION_DENIED", "禅道拒绝访问该资源。");
  if (status === 404)
    return new BztError("NOT_FOUND", "禅道对象不存在或不可见。");
  if (status >= 400 && status < 500) {
    return new BztError("ZENTAO_BUSINESS_ERROR", "禅道返回业务错误。", {
      status,
    });
  }
  return new BztError("ZENTAO_UNAVAILABLE", "禅道返回异常状态。", { status });
}

function decodeJson<T>(text: string, schema: z.ZodType<T>): T {
  try {
    const payload: unknown = text === "" ? undefined : JSON.parse(text);
    return schema.parse(payload);
  } catch {
    throw new BztError(
      "ZENTAO_SCHEMA_MISMATCH",
      "禅道响应无法按预期结构解码。",
    );
  }
}

export function createZentaoHttp(options: ZentaoHttpOptions) {
  const normalized = normalizeZentaoBaseUrl(options.baseUrl);
  if (!normalized) throw new BztError("INVALID_INPUT", "禅道基础地址不合法。");
  const baseUrl = normalized.href;
  const { env, clock, logSink } = options;
  const timeoutMs = resolveZentaoTimeout(env);
  const fetcher = options.fetch ?? fetch;
  const sleep =
    options.sleep ??
    ((ms) => new Promise<void>((resolve) => setTimeout(resolve, ms)));

  async function send(
    request: PreparedRequest,
    token?: string,
  ): Promise<Attempt> {
    const { url, method, pathTemplate, body } = request;
    const headers: Record<string, string> = {};
    if (body !== undefined) headers["Content-Type"] = "application/json";
    if (token !== undefined) headers.Token = token;
    const started = clock();
    let status = 0;
    const controller = new AbortController();
    const expired = Promise.withResolvers<Attempt>();
    const timer = setTimeout(() => {
      expired.resolve({ kind: "timeout" });
      controller.abort();
    }, timeoutMs);

    async function exchange(): Promise<Attempt> {
      try {
        const response = await fetcher(url, {
          method,
          headers,
          body,
          redirect: "error",
          signal: controller.signal,
        });
        status = response.status;
        if (!response.ok || controller.signal.aborted) {
          // 失败正文不会参与重试、错误摘要或日志。
          void response.body?.cancel().catch(() => {});
          return { kind: "http-error", status };
        }
        return { kind: "success", text: await response.text() };
      } catch {
        return { kind: "network" };
      }
    }

    try {
      return await Promise.race([exchange(), expired.promise]);
    } finally {
      clearTimeout(timer);
      try {
        writeHttpLog(
          {
            method,
            pathTemplate,
            status,
            durationMs: Math.max(0, clock() - started),
          },
          logSink,
          env,
        );
      } catch {
        // 日志输出失败时仍须保留已经取得的传输回执。
      }
    }
  }

  const loginRequest: PreparedRequest = {
    method: "POST",
    pathTemplate: tokenPath,
    url: new URL(tokenPath.slice(1), baseUrl).href,
    body: JSON.stringify({
      account: options.account,
      password: options.password,
    }),
  };
  const auth = createZentaoAuth(async () => {
    const result = await withReadSlot(() => send(loginRequest));
    if (result.kind === "success") return result.text;
    if (
      result.kind === "http-error" &&
      result.status >= 400 &&
      !isTransient(result)
    )
      throw authFailed();
    throw requestError(result);
  });

  async function read<T>(
    request: ReadRequest,
    schema: z.ZodType<T>,
  ): Promise<T> {
    const prepared: PreparedRequest = {
      method: "GET",
      url: requestUrl(baseUrl, request),
      pathTemplate: request.pathTemplate,
    };
    let replayed = false;
    let retries = 0;
    for (;;) {
      const session = await auth.getSession();
      const result = await withReadSlot(() => send(prepared, session.token));
      if (result.kind === "success") return decodeJson(result.text, schema);
      if (result.kind === "http-error" && result.status === 401) {
        auth.invalidate(session);
        if (replayed) throw authFailed();
        replayed = true;
        continue;
      }
      const delay = readRetryDelaysMs[retries];
      if (!isTransient(result) || delay === undefined)
        throw requestError(result);
      retries++;
      await sleep(delay);
    }
  }

  async function write<T>(
    request: WriteRequest,
    schema: z.ZodType<T>,
  ): Promise<WriteReceipt<T>> {
    if (!writeMethod.safeParse(request.method).success) {
      throw new BztError("INVALID_INPUT", "禅道写入方法不合法。");
    }
    const prepared: PreparedRequest = {
      method: request.method,
      url: requestUrl(baseUrl, request),
      pathTemplate: request.pathTemplate,
      body: encodeBody(request.body),
    };
    return withInstanceWriteLock(baseUrl, async () => {
      const session = await auth.getSession();
      const result = await send(prepared, session.token);
      if (result.kind === "success") {
        try {
          return { status: "accepted", data: decodeJson(result.text, schema) };
        } catch {
          return unknownWrite;
        }
      }
      if (
        result.kind === "http-error" &&
        result.status >= 400 &&
        !isTransient(result)
      ) {
        // docs/06 §2.2 无法证明 401 的写请求未进入业务处理。
        if (result.status === 401) auth.invalidate(session);
        throw requestError(result);
      }
      return unknownWrite;
    });
  }

  return { read, write };
}
