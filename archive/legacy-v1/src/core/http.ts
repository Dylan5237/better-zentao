import type { BetterZentaoConfig } from "./config.js";
import { type ResponseMetadata, unknownResponse, ZentaoApiError, ZentaoAuthExpiredError } from "./errors.js";
import { entityId, row, text } from "./normalizer.js";

export type ApiVersion = 1 | 2;
export type HttpMethod = "GET" | "POST" | "DELETE";
interface RequestOptions {
  query?: Record<string, string | number | undefined>;
  body?: object;
  observe?: (metadata: ResponseMetadata) => void;
  replayUnauthorized?: boolean;
}

function parseBody(source: string): { body: unknown; kind: ResponseMetadata["bodyKind"] } {
  if (!source.trim()) return { body: undefined, kind: "empty" };
  let body: unknown;
  try {
    body = JSON.parse(source);
  } catch {
    return { body: undefined, kind: "non-json" };
  }
  if (body === null) return { body, kind: "null" };
  if (Array.isArray(body)) return { body, kind: "array" };
  return { body, kind: typeof body as "object" | "number" | "boolean" | "string" };
}

function safeMediaType(raw: string | null): ResponseMetadata["mediaType"] {
  const type = raw?.split(";", 1)[0].trim().toLowerCase();
  switch (type) {
    case "application/json":
    case "application/problem+json":
    case "text/html":
    case "text/plain":
      return type;
    default:
      return "unknown";
  }
}

export class ZentaoHttp {
  private token?: string;
  private tokenFlight?: Promise<string>;
  private previousToken?: string;

  constructor(private readonly config: BetterZentaoConfig, private readonly fetchImpl: typeof fetch = fetch) {
    this.token = config.initialToken;
  }

  private async send(version: ApiVersion, method: HttpMethod, endpoint: string, options: RequestOptions, token?: string) {
    const metadata = { ...unknownResponse };
    try {
      const url = new URL(this.config.baseUrl + "/api.php/v" + version + endpoint);
      for (const [name, value] of Object.entries(options.query ?? {})) {
        if (value !== undefined) url.searchParams.set(name, String(value));
      }
      const headers = new Headers({ Accept: "application/json" });
      if (token) headers.set("Token", token);
      if (options.body) headers.set("Content-Type", "application/json");
      const response = await this.fetchImpl(url, {
        method, headers, redirect: "error",
        signal: AbortSignal.timeout(this.config.timeoutMs),
        body: options.body ? JSON.stringify(options.body) : undefined,
      });
      metadata.status = response.status;
      metadata.mediaType = safeMediaType(response.headers.get("content-type"));
      const source = await response.text();
      const parsed = parseBody(source);
      metadata.bytes = Buffer.byteLength(source);
      metadata.bodyKind = parsed.kind;
      return { ok: response.ok, status: response.status, body: parsed.body };
    } catch {
      throw new ZentaoApiError("禅道请求未取得完整响应，请检查连接或超时设置",
        typeof metadata.status === "number" ? metadata.status : undefined);
    } finally {
      options.observe?.({ ...metadata });
    }
  }

  private async getToken(): Promise<string> {
    if (this.token) return this.token;
    if (this.config.tokenOnly) throw new ZentaoAuthExpiredError();
    this.tokenFlight ??= this.send(1, "POST", "/tokens", {
      body: { account: this.config.account, password: this.config.password },
    }).then(response => {
      const token = text(row(response.body).token);
      if (!response.ok || !token.trim() || /[\r\n]/.test(token)) {
        throw new ZentaoApiError("禅道登录失败，请检查账号和授权", response.status);
      }
      this.token = token;
      return token;
    }).finally(() => { this.tokenFlight = undefined; });
    return this.tokenFlight;
  }

  private invalidate(usedToken: string) {
    if (this.token === usedToken) {
      this.previousToken = usedToken;
      this.token = undefined;
    }
  }

  async request(version: ApiVersion, method: HttpMethod, endpoint: string, options: RequestOptions = {}): Promise<unknown> {
    let token = await this.getToken();
    let response = await this.send(version, method, endpoint, options, token);
    if (response.status === 401) {
      if (this.config.tokenOnly) throw new ZentaoAuthExpiredError();
      this.invalidate(token);
      if (options.replayUnauthorized !== false) {
        token = await this.getToken();
        response = await this.send(version, method, endpoint, options, token);
        if (response.status === 401) this.invalidate(token);
      }
    }
    if (!response.ok) {
      throw new ZentaoApiError("禅道 API 请求失败（HTTP " + response.status + "）",
        response.status, entityId(row(response.body).id));
    }
    return response.body;
  }

  redactText(value: string): string {
    const secrets = [this.config.password, this.config.initialToken, this.token, this.previousToken]
      .filter((item): item is string => Boolean(item)).sort((a, b) => b.length - a.length);
    for (const secret of secrets) value = value.split(secret).join("[redacted]");
    return value;
  }
}
