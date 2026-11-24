import { z } from "zod";
import type { Clock } from "../../core/clock.ts";
import { resolveZentaoTimeout } from "../../core/config.ts";
import { BztError } from "../../core/errors.ts";
import {
  readRetryDelaysMs,
  withInstanceWriteLock,
  withReadSlot,
} from "../../core/http-policy.ts";
import {
  httpLogIds,
  httpPathTemplate,
  writeHttpLog,
} from "../../core/logger.ts";
import type { HttpLogIds } from "../../core/logger.ts";
import { authFailed, createZentaoAuth } from "./auth.ts";
import { normalizeZentaoBaseUrl } from "./base-url.ts";
import { assertNoBusinessError } from "./business-error.ts";

const tokenPath = "/api.php/v1/tokens";
const writeMethod = z.enum(["POST", "PUT", "PATCH", "DELETE"]);
const objectId = z.int().positive();
const nonBlankCredential = z.string().refine((value) => value.trim() !== "");
const loginCredentials = z.object({
  account: nonBlankCredential,
  password: nonBlankCredential,
});

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

export interface ReadRequest extends HttpLogIds {
  readonly pathTemplate: string;
  readonly params?: Readonly<Record<string, number>>;
  readonly query?: Readonly<Record<string, string | number>>;
  readonly schemaFields?: readonly string[];
}

interface ReadCapture {
  readonly observeSession: (token: string) => void;
}

interface ReadResponse<T> {
  readonly status: number;
  readonly body: T;
}

interface WriteRequest extends ReadRequest {
  readonly method: z.infer<typeof writeMethod>;
  readonly body?: Readonly<Record<string, unknown>>;
}

interface PreparedRequest extends HttpLogIds {
  readonly method: "GET" | WriteRequest["method"];
  readonly url: string;
  readonly pathTemplate: string;
  readonly body?: string;
}

type FailedAttempt =
  | { kind: "timeout" }
  | { kind: "network" }
  | { kind: "http-error"; status: number };
type Attempt =
  { kind: "success"; text: string; status: number } | FailedAttempt;

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

function prepareRequest(
  baseUrl: string,
  method: PreparedRequest["method"],
  request: ReadRequest,
): PreparedRequest {
  const logIds = httpLogIds.safeParse(request);
  if (!logIds.success)
    throw new BztError("INVALID_INPUT", "禅道请求日志标识不合法。");
  return {
    method,
    url: requestUrl(baseUrl, request),
    pathTemplate: request.pathTemplate,
    ...logIds.data,
  };
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
    result.status === 429 ||
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
  if (status === 429)
    return new BztError("ZENTAO_UNAVAILABLE", "禅道请求受到频率限制。", {
      status,
    });
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

function decodeJson<T>(
  text: string,
  schema: z.ZodType<T>,
  schemaFields?: readonly string[],
): T {
  let payload: unknown;
  let decoded: z.ZodSafeParseResult<T> | undefined;
  try {
    payload = text === "" ? undefined : JSON.parse(text);
    decoded = schema.safeParse(payload);
  } catch (error) {
    if (error instanceof BztError) throw error;
  }
  // 即使端点解码异常，响应中明确的业务失败仍可安全识别。
  assertNoBusinessError(payload, decoded?.success === true);
  if (decoded?.success) return decoded.data;
  const fields = new Set<string>();
  for (const issue of decoded?.error?.issues ?? []) {
    const [first, second] = issue.path;
    const field =
      Array.isArray(payload) && typeof first === "number" ? second : first;
    if (typeof field === "string" && schemaFields?.includes(field))
      fields.add(field);
  }
  throw new BztError(
    "ZENTAO_SCHEMA_MISMATCH",
    "禅道响应无法按预期结构解码。",
    fields.size > 0 ? { fields: [...fields] } : undefined,
  );
}

export async function decodeReadResponse<T>(
  response: Response,
  schema: z.ZodType<T>,
  schemaFields?: readonly string[],
): Promise<T> {
  if (!response.ok) {
    void response.body?.cancel().catch(() => {});
    throw requestError({ kind: "http-error", status: response.status });
  }

  let text: string;
  try {
    text = await response.text();
  } catch {
    throw requestError({ kind: "network" });
  }
  return decodeJson(text, schema, schemaFields);
}

export function createZentaoHttp(options: ZentaoHttpOptions) {
  const credentials = loginCredentials.safeParse(options);
  if (!credentials.success)
    throw new BztError("INVALID_INPUT", "禅道账号和密码不能为空白。");
  const normalized = normalizeZentaoBaseUrl(options.baseUrl);
  if (!normalized) throw new BztError("INVALID_INPUT", "禅道基础地址不合法。");
  const baseUrl = normalized.href;
  const { env, clock, logSink } = options;
  const timeoutMs = resolveZentaoTimeout(env);
  const fetcher = options.fetch ?? fetch;
  const sleep =
    options.sleep ??
    ((ms) => new Promise<void>((resolve) => setTimeout(resolve, ms)));

  function logResult(
    request: Pick<
      PreparedRequest,
      "method" | "pathTemplate" | "opId" | "objectId"
    >,
    status: number,
    started: number,
  ): void {
    const { method, pathTemplate, opId, objectId } = request;
    try {
      writeHttpLog(
        {
          method,
          pathTemplate,
          status,
          durationMs: Math.max(0, clock() - started),
          opId,
          objectId,
        },
        logSink,
        env,
      );
    } catch {
      // 日志输出失败时仍须保留已经取得的传输回执。
    }
  }

  async function send(
    request: PreparedRequest,
    token?: string,
  ): Promise<Attempt> {
    const { url, method, body } = request;
    const headers: Record<string, string> = {};
    if (body !== undefined) headers["Content-Type"] = "application/json";
    if (token !== undefined) headers.Token = token;
    const started = clock();
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
        if (!response.ok || controller.signal.aborted) {
          // 失败正文不会参与重试、错误摘要或日志。
          void response.body?.cancel().catch(() => {});
          return { kind: "http-error", status: response.status };
        }
        return {
          kind: "success",
          text: await response.text(),
          status: response.status,
        };
      } catch {
        return { kind: "network" };
      }
    }

    const result = await Promise.race([exchange(), expired.promise]).finally(
      () => clearTimeout(timer),
    );
    logResult(request, "status" in result ? result.status : 0, started);
    return result;
  }

  const loginRequest: PreparedRequest = {
    method: "POST",
    pathTemplate: tokenPath,
    url: new URL(tokenPath.slice(1), baseUrl).href,
    body: JSON.stringify(credentials.data),
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

  async function getProbeSender(
    request: Pick<PreparedRequest, "method" | "pathTemplate" | "objectId">,
  ): Promise<{ send: typeof fetch; sessionToken: string }> {
    const session = await auth.getSession();
    const send: typeof fetch = async (input, init) => {
      if (
        !(input instanceof URL) ||
        !input.href.startsWith(baseUrl) ||
        init?.redirect !== "error" ||
        init.method !== request.method
      ) {
        throw new BztError("PERMISSION_DENIED", "探查发送地址或方法不合法。");
      }
      const started = clock();
      let status = 0;
      try {
        const response = await fetcher(input, {
          method: request.method,
          redirect: "error",
          headers: { "Content-Type": "application/json", Token: session.token },
          body: init.body,
          signal: init.signal,
        });
        status = response.status;
        if (status === 401) auth.invalidate(session);
        // 发送层的中止信号覆盖响应正文。保留服务器的状态码供探查判定。
        const body = await response.text();
        return new Response(body === "" ? null : body, { status });
      } finally {
        logResult(request, status, started);
      }
    };
    return { send, sessionToken: session.token };
  }

  function read<T>(request: ReadRequest, schema: z.ZodType<T>): Promise<T>;
  function read<T>(
    request: ReadRequest,
    schema: z.ZodType<T>,
    capture: ReadCapture,
  ): Promise<ReadResponse<T>>;
  async function read<T>(
    request: ReadRequest,
    schema: z.ZodType<T>,
    capture?: ReadCapture,
  ): Promise<T | ReadResponse<T>> {
    const prepared = prepareRequest(baseUrl, "GET", request);
    let replayed = false;
    let retries = 0;
    for (;;) {
      const session = await auth.getSession();
      capture?.observeSession(session.token);
      const result = await withReadSlot(() => send(prepared, session.token));
      if (result.kind === "success") {
        const body = decodeJson(result.text, schema, request.schemaFields);
        return capture ? { status: result.status, body } : body;
      }
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
      ...prepareRequest(baseUrl, request.method, request),
      body: encodeBody(request.body),
    };
    return withInstanceWriteLock(baseUrl, async () => {
      const session = await auth.getSession();
      const result = await send(prepared, session.token);
      if (result.kind === "success") {
        try {
          return { status: "accepted", data: decodeJson(result.text, schema) };
        } catch (error) {
          if (
            error instanceof BztError &&
            error.code === "ZENTAO_SCHEMA_MISMATCH"
          )
            return unknownWrite;
          throw error;
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

  return { read, write, getProbeSender };
}
