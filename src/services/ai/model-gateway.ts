import { BztError } from "../../core/errors.ts";
import type { Clock } from "../../core/clock.ts";
import type {
  MaskedModelConfig,
  ModelCompletionRequest,
  ModelCompletionResponse,
  ModelGatewayPolicy,
} from "./contracts.ts";
import { createHttpModelTransport } from "./internal/http-transport.ts";
import type {
  ModelPrincipal,
  PersonalModelStore,
} from "./personal-model-store.ts";

/**
 * CR-009 §5.3：个人企业大模型网关（出站策略校验 + 受控传输）。
 * 真实 HTTP 出站仅封装在最窄例外目录 src/services/ai/internal/ 中，
 * 本模块负责规范化 URL/IPv4/IPv6 SSRF 校验、凭据回显拦截、超时取消与脱敏日志。
 */

export interface ModelTransport {
  send(request: {
    readonly url: string;
    readonly token: string;
    readonly modelId: string;
    readonly protocol: string;
    readonly body: unknown;
    readonly abortSignal?: AbortSignal | undefined;
  }): Promise<
    | { readonly kind: "ok"; readonly text: string }
    | { readonly kind: "http-error"; readonly status: number }
    | { readonly kind: "redirect" }
    | { readonly kind: "timeout" }
    | { readonly kind: "network" }
  >;
}

export interface ModelGatewayOptions {
  readonly policy: ModelGatewayPolicy;
  readonly credentialStore: PersonalModelStore;
  /** 可选注入传输层（离线测试用）；默认使用受控 HTTP 传输层。 */
  readonly transport?: ModelTransport | undefined;
  readonly clock: Clock;
  /** 结构化脱敏日志：只记方法、协议、状态与耗时，不记正文、模型自由文本或 Token。 */
  readonly logSink?: (line: string) => void;
}

const loopbackHosts = new Set(["localhost", "ip6-localhost", "ip6-loopback"]);

function parseIpv4(
  input: string,
): readonly [number, number, number, number] | undefined {
  const parts = input.split(".");
  if (parts.length !== 4) return undefined;
  const nums: number[] = [];
  for (const part of parts) {
    if (!/^(?:0|[1-9]\d{0,2})$/u.test(part)) return undefined;
    const n = Number(part);
    if (!Number.isInteger(n) || n < 0 || n > 255) return undefined;
    nums.push(n);
  }
  const [a, b, c, d] = nums;
  if (a === undefined || b === undefined || c === undefined || d === undefined)
    return undefined;
  return [a, b, c, d];
}

function isPrivateIpv4Octets(
  octets: readonly [number, number, number, number],
): boolean {
  const [a, b, c] = octets;
  if (a === 0) return true; // 0.0.0.0/8
  if (a === 10) return true; // 10.0.0.0/8
  if (a === 100 && b >= 64 && b <= 127) return true; // 100.64.0.0/10 (CGNAT)
  if (a === 127) return true; // 127.0.0.0/8 (loopback)
  if (a === 169 && b === 254) return true; // 169.254.0.0/16 (link-local & cloud metadata)
  if (a === 172 && b >= 16 && b <= 31) return true; // 172.16.0.0/12
  if (a === 192 && b === 0 && c === 0) return true; // 192.0.0.0/24
  if (a === 192 && b === 168) return true; // 192.168.0.0/16
  if (a === 198 && (b === 18 || b === 19)) return true; // 198.18.0.0/15
  if (a >= 224) return true; // multicast & reserved (224.0.0.0/3+)
  return false;
}

function parseIpv6Hextets(input: string): readonly number[] | undefined {
  // 去掉可选区域标识（如 fe80::1%eth0）
  const zoneIdx = input.indexOf("%");
  const clean = (
    zoneIdx === -1 ? input : input.slice(0, zoneIdx)
  ).toLowerCase();
  if (!clean.includes(":")) return undefined;

  // 若尾部包含嵌入式 IPv4（如 ::ffff:127.0.0.1），转换为两个 16-bit 十六进制段。
  let normalized = clean;
  const lastColon = normalized.lastIndexOf(":");
  const tail = normalized.slice(lastColon + 1);
  if (tail.includes(".")) {
    const v4 = parseIpv4(tail);
    if (!v4) return undefined;
    const hi = ((v4[0] << 8) | v4[1]).toString(16);
    const lo = ((v4[2] << 8) | v4[3]).toString(16);
    normalized = `${normalized.slice(0, lastColon + 1)}${hi}:${lo}`;
  }

  const halves = normalized.split("::");
  if (halves.length > 2) return undefined;
  const parsePart = (segment: string): number[] | undefined => {
    if (!segment) return [];
    const groups = segment.split(":");
    const out: number[] = [];
    for (const g of groups) {
      if (!/^[0-9a-f]{1,4}$/u.test(g)) return undefined;
      out.push(Number.parseInt(g, 16));
    }
    return out;
  };
  const left = parsePart(halves[0] ?? "");
  if (!left) return undefined;
  if (halves.length === 1) {
    return left.length === 8 ? left : undefined;
  }
  const right = parsePart(halves[1] ?? "");
  if (!right) return undefined;
  const missing = 8 - (left.length + right.length);
  if (missing < 1) return undefined;
  return [...left, ...new Array<number>(missing).fill(0), ...right];
}

function isPrivateIpv6Hextets(h: readonly number[]): boolean {
  const [h0, h1, h2, h3, h4, h5, h6, h7] = h;
  if (
    h0 === undefined ||
    h1 === undefined ||
    h2 === undefined ||
    h3 === undefined ||
    h4 === undefined ||
    h5 === undefined ||
    h6 === undefined ||
    h7 === undefined
  )
    return true;
  // :: (unspecified) 与 ::1 (loopback)
  if (h0 === 0 && h1 === 0 && h2 === 0 && h3 === 0 && h4 === 0 && h5 === 0) {
    if (h6 === 0 && (h7 === 0 || h7 === 1)) return true;
    // IPv4-compatible ::/96
    const mappedV4: [number, number, number, number] = [
      (h6 >> 8) & 0xff,
      h6 & 0xff,
      (h7 >> 8) & 0xff,
      h7 & 0xff,
    ];
    if (isPrivateIpv4Octets(mappedV4)) return true;
  }
  // ::ffff:0:0/96 (IPv4-mapped IPv6，含十进制与十六进制写法)
  if (
    h0 === 0 &&
    h1 === 0 &&
    h2 === 0 &&
    h3 === 0 &&
    h4 === 0 &&
    h5 === 0xffff
  ) {
    return isPrivateIpv4Octets([
      (h6 >> 8) & 0xff,
      h6 & 0xff,
      (h7 >> 8) & 0xff,
      h7 & 0xff,
    ]);
  }
  // 64:ff9b::/96 (NAT64 well-known prefix) & 64:ff9b:1::/48 (local-use NAT64)
  if (h0 === 0x0064 && h1 === 0xff9b) {
    if (h2 === 0x0001) return true;
    if (h2 === 0 && h3 === 0 && h4 === 0 && h5 === 0) {
      return isPrivateIpv4Octets([
        (h6 >> 8) & 0xff,
        h6 & 0xff,
        (h7 >> 8) & 0xff,
        h7 & 0xff,
      ]);
    }
  }
  // fc00::/7 (Unique Local Address: fc00..fdff)
  if ((h0 & 0xfe00) === 0xfc00) return true;
  // fe80::/10 (Link-Local: fe80..febf)
  if ((h0 & 0xffc0) === 0xfe80) return true;
  // fec0::/10 (Deprecated Site-Local)
  if ((h0 & 0xffc0) === 0xfec0) return true;
  // ff00::/8 (Multicast)
  if ((h0 & 0xff00) === 0xff00) return true;
  // 100::/64 (Discard-Only)
  if (h0 === 0x0100 && h1 === 0 && h2 === 0 && h3 === 0) return true;
  return false;
}

/**
 * 规范化判定主机名或 IP 字面量是否为回环/私网/链路本地/元数据地址。
 * 严格区分 IPv4/IPv6 字面量与普通域名，避免如 `fc-gateway.example.com` 被误判，
 * 并完整覆盖 `fe80::/10`、`fc00::/7`、`::ffff:0:0/96`（含十六进制形式）与 NAT64。
 */
export function isPrivateAddress(hostname: string): boolean {
  const bare = hostname
    .trim()
    .replace(/^\[|\]$/gu, "")
    .replace(/\.+$/u, "")
    .toLowerCase();
  if (!bare) return true;
  if (loopbackHosts.has(bare) || bare.endsWith(".localhost")) return true;
  const v4 = parseIpv4(bare);
  if (v4) return isPrivateIpv4Octets(v4);
  const v6 = parseIpv6Hextets(bare);
  if (v6) return isPrivateIpv6Hextets(v6);
  return false;
}

export function normalizePathPrefix(prefix: string | undefined): string {
  if (!prefix) return "/";
  const trimmed = prefix.trim();
  if (!trimmed || trimmed === "/") return "/";
  const withLead = trimmed.startsWith("/") ? trimmed : `/${trimmed}`;
  const stripped = withLead.replace(/\/+$/u, "");
  return stripped || "/";
}

export function matchesPathPrefix(pathname: string, prefix: string): boolean {
  const normalized = normalizePathPrefix(prefix);
  if (normalized === "/") return true;
  const cleanPath =
    pathname.length > 1 ? pathname.replace(/\/+$/u, "") : pathname;
  return cleanPath === normalized || cleanPath.startsWith(`${normalized}/`);
}

function originOf(url: URL): string {
  return `${url.protocol}//${url.host}`;
}

export function assertSupportedProtocol(
  protocol: string,
): "openai-compatible" | "anthropic-compatible" {
  if (protocol === "openai-compatible" || protocol === "anthropic-compatible") {
    return protocol;
  }
  throw new BztError(
    "INVALID_INPUT",
    "当前版本仅支持 OpenAI 兼容或 Anthropic 兼容协议，暂未开放企业定制协议。",
    { fields: ["protocol"] },
  );
}

/**
 * CR-009 MG-02：网关 URL 校验。
 * 拒绝内嵌凭据、查询参数/片段、非 HTTPS（除非管理员规则显式允许）、非白名单来源、
 * 私网/环回/链路本地/元数据地址（除非规则显式允许）。
 */
export function validateGatewayUrl(
  rawUrl: string,
  policy: ModelGatewayPolicy,
): URL {
  const trimmed = rawUrl.trim();
  if (!trimmed) throw new BztError("INVALID_INPUT", "网关地址不能为空。");
  let url: URL;
  try {
    url = new URL(trimmed);
  } catch {
    throw new BztError("INVALID_INPUT", "网关地址不合法。");
  }
  if (url.protocol !== "https:" && url.protocol !== "http:")
    throw new BztError("INVALID_INPUT", "网关地址仅支持 HTTP(S) 协议。");
  if (url.username || url.password)
    throw new BztError("INVALID_INPUT", "网关地址不能内嵌凭据。");
  if (url.search || url.hash || trimmed.includes("?") || trimmed.includes("#"))
    throw new BztError("INVALID_INPUT", "网关地址不能包含查询参数或片段。");
  const rule = policy.allowedGateways.find(
    (entry) =>
      originOf(url) === entry.origin &&
      (entry.pathPrefix === undefined ||
        matchesPathPrefix(url.pathname, entry.pathPrefix)),
  );
  if (!rule)
    throw new BztError("PERMISSION_DENIED", "该网关不在管理员允许列表内。");
  if (url.protocol !== "https:" && !rule.allowInsecure)
    throw new BztError("PERMISSION_DENIED", "网关必须使用 HTTPS。");
  if (isPrivateAddress(url.hostname) && !rule.allowPrivateNetwork)
    throw new BztError("PERMISSION_DENIED", "禁止访问内网或本机地址。");
  return url;
}

function textMatchesSecret(
  candidate: string,
  variants: readonly string[],
): boolean {
  for (const needle of variants) {
    if (needle && candidate.includes(needle)) return true;
  }
  return false;
}

function walkJsonStrings(
  value: unknown,
  visit: (s: string) => boolean,
): boolean {
  if (typeof value === "string") return visit(value);
  if (Array.isArray(value)) {
    for (const item of value) {
      if (walkJsonStrings(item, visit)) return true;
    }
    return false;
  }
  if (typeof value === "object" && value !== null) {
    for (const entry of Object.values(value)) {
      if (walkJsonStrings(entry, visit)) return true;
    }
  }
  return false;
}

/**
 * 检查模型成功响应文本（含原文以及 JSON 解码/去转义后的全部字符串叶子值）
 * 是否回显当前个人凭据（原文、URL 编码、标准 Base64、Base64URL）。
 */
export function containsCredentialLeak(text: string, secret: string): boolean {
  const trimmedSecret = secret.trim();
  if (!text || !trimmedSecret) return false;
  const variants = new Set<string>([trimmedSecret]);
  if (secret !== trimmedSecret) variants.add(secret);
  const encoded = encodeURIComponent(trimmedSecret);
  if (encoded !== trimmedSecret) variants.add(encoded);
  const b64 = Buffer.from(trimmedSecret, "utf8").toString("base64");
  if (b64) {
    variants.add(b64);
    const b64url = b64
      .replace(/\+/gu, "-")
      .replace(/\//gu, "_")
      .replace(/=+$/u, "");
    if (b64url) variants.add(b64url);
  }
  const list = [...variants];
  if (textMatchesSecret(text, list)) return true;

  // 对 JSON 或 Markdown ```json``` 块内的转义文本（如 \u0073ecret）执行解码后再核查（P1-6）。
  const fenced = /```(?:json)?\s*([\s\S]*?)```/iu.exec(text)?.[1] ?? text;
  const startIdx = fenced.indexOf("{");
  const endIdx = fenced.lastIndexOf("}");
  if (startIdx !== -1 && endIdx > startIdx) {
    try {
      const parsed: unknown = JSON.parse(fenced.slice(startIdx, endIdx + 1));
      if (walkJsonStrings(parsed, (s) => textMatchesSecret(s, list))) {
        return true;
      }
    } catch {
      // 非 JSON 文本仅检查原文即可。
    }
  }
  return false;
}

function notConfigured(): BztError {
  return new BztError("CONFIG_MISSING", "请先配置个人模型网关。");
}

function notVerified(): BztError {
  return new BztError("AUTH_FAILED", "个人模型网关尚未通过连接验证。");
}

export function createModelGateway(options: ModelGatewayOptions) {
  const { policy, credentialStore, clock, logSink } = options;
  const transport = options.transport ?? createHttpModelTransport({ policy });

  const log = (fields: Record<string, unknown>) => {
    if (logSink) logSink(JSON.stringify(fields) + "\n");
  };

  const resolve = (principal: ModelPrincipal) => {
    const masked = credentialStore.getMasked(principal);
    if (!masked.configured) throw notConfigured();
    const { secret, revision } =
      credentialStore.resolveSecretWithRevision(principal);
    return { masked, secret, revision };
  };

  /**
   * 统一超时、取消与异常脱敏护栏（CR-009 MG-02）：
   * 消费 policy.timeoutMs 与外部 abortSignal，任何传输异常均不向调用方或日志透出原始文本/Token。
   */
  const sendWithGuard = async (
    request: Parameters<ModelTransport["send"]>[0],
  ): Promise<
    Awaited<ReturnType<ModelTransport["send"]>> | { readonly kind: "aborted" }
  > => {
    const external = request.abortSignal;
    if (external?.aborted) return { kind: "aborted" };
    const controller = new AbortController();
    let timedOut = false;
    let timer: ReturnType<typeof setTimeout> | undefined;
    const onExternalAbort = () => controller.abort();
    external?.addEventListener("abort", onExternalAbort, { once: true });
    const raceSignal = new Promise<
      { readonly kind: "timeout" } | { readonly kind: "aborted" }
    >((resolveSignal) => {
      controller.signal.addEventListener(
        "abort",
        () => resolveSignal({ kind: timedOut ? "timeout" : "aborted" }),
        { once: true },
      );
      timer = setTimeout(() => {
        timedOut = true;
        controller.abort();
      }, policy.timeoutMs);
    });
    const sent = Promise.resolve()
      .then(() =>
        transport.send({ ...request, abortSignal: controller.signal }),
      )
      .catch(
        ():
          | { readonly kind: "network" }
          | { readonly kind: "timeout" }
          | { readonly kind: "aborted" } =>
          timedOut
            ? { kind: "timeout" }
            : external?.aborted
              ? { kind: "aborted" }
              : { kind: "network" },
      );
    try {
      return await Promise.race([sent, raceSignal]);
    } finally {
      if (timer !== undefined) clearTimeout(timer);
      external?.removeEventListener("abort", onExternalAbort);
    }
  };

  return {
    /** 脱敏读取当前配置（代理到凭据存储）。 */
    getMasked(principal: ModelPrincipal): MaskedModelConfig {
      return credentialStore.getMasked(principal);
    },

    /**
     * CR-009 §5.3：最小非业务连接测试。
     * 仅发送固定短探活文本（零禅道业务数据、零工具调用），
     * 按配置 revision 与可选会话守卫绑定结果，防止登出或轮换竞态写入验证状态。
     */
    async testConnection(
      principal: ModelPrincipal,
      abortSignal?: AbortSignal,
      canCommit?: () => boolean,
    ): Promise<Readonly<{ ok: boolean; masked: MaskedModelConfig }>> {
      const started = clock();
      const { masked, secret, revision } = resolve(principal);
      const protocol = assertSupportedProtocol(
        masked.protocol ?? "openai-compatible",
      );
      const url = validateGatewayUrl(masked.baseUrl ?? "", policy);
      const outcome = await sendWithGuard({
        url: url.href,
        token: secret,
        modelId: masked.modelId ?? "",
        protocol,
        body: {
          messages: [{ role: "user", content: "连接测试（非业务探活）。" }],
          max_tokens: 8,
        },
        abortSignal,
      });
      const durationMs = clock() - started;
      log({
        method: "test-connection",
        protocol,
        outcome: outcome.kind,
        durationMs,
      });
      if (canCommit && !canCommit()) {
        throw new BztError("AUTH_FAILED", "本次会话已结束，未更新验证状态。");
      }
      if (outcome.kind === "ok") {
        if (containsCredentialLeak(outcome.text, secret)) {
          credentialStore.markError(
            principal,
            "CREDENTIAL_ECHO_BLOCKED",
            revision,
          );
          return { ok: false, masked: credentialStore.getMasked(principal) };
        }
        const applied = credentialStore.markVerified(
          principal,
          clock(),
          revision,
        );
        return { ok: applied, masked: credentialStore.getMasked(principal) };
      }
      const code =
        outcome.kind === "timeout"
          ? "GATEWAY_TIMEOUT"
          : outcome.kind === "aborted"
            ? "GATEWAY_ABORTED"
            : outcome.kind === "network"
              ? "GATEWAY_UNREACHABLE"
              : outcome.kind === "redirect"
                ? "GATEWAY_REDIRECT_BLOCKED"
                : outcome.status === 429
                  ? "QUOTA_EXHAUSTED"
                  : outcome.status === 401 || outcome.status === 403
                    ? "AUTH_FAILED"
                    : `GATEWAY_HTTP_${outcome.status}`;
      credentialStore.markError(principal, code, revision);
      return { ok: false, masked: credentialStore.getMasked(principal) };
    },

    /**
     * CR-009 §5.1：模型补全。要求 configured && verified；
     * 只解析本人 Token（零回退），执行超时、取消、凭据回显拦截、异常脱敏与 maxTokens 预算。
     */
    async complete(
      principal: ModelPrincipal,
      request: ModelCompletionRequest,
    ): Promise<ModelCompletionResponse> {
      const started = clock();
      const { masked, secret, revision } = resolve(principal);
      if (!masked.verified) throw notVerified();
      const protocol = assertSupportedProtocol(
        masked.protocol ?? "openai-compatible",
      );
      const url = validateGatewayUrl(masked.baseUrl ?? "", policy);
      const maxTokens = Math.min(
        request.maxTokens ?? policy.maxTokens,
        policy.maxTokens,
      );
      const outcome = await sendWithGuard({
        url: url.href,
        token: secret,
        modelId: masked.modelId ?? "",
        protocol,
        body: { messages: request.messages, max_tokens: maxTokens },
        abortSignal: request.abortSignal,
      });
      const durationMs = clock() - started;
      log({
        method: "complete",
        protocol,
        outcome: outcome.kind,
        durationMs,
        maxTokens,
      });
      if (outcome.kind === "redirect")
        throw new BztError(
          "PERMISSION_DENIED",
          "网关发生非法重定向，已阻断请求。",
        );
      if (outcome.kind === "timeout")
        throw new BztError("ZENTAO_TIMEOUT", "模型网关请求超时。");
      if (outcome.kind === "aborted")
        throw new BztError("ZENTAO_UNAVAILABLE", "模型网关请求已取消。");
      if (
        outcome.kind === "http-error" &&
        (outcome.status === 401 || outcome.status === 403)
      ) {
        credentialStore.markError(principal, "AUTH_FAILED", revision);
        throw new BztError(
          "AUTH_FAILED",
          "个人模型 Token 无效或已被撤销，请重新配置。",
        );
      }
      if (outcome.kind === "http-error" && outcome.status === 429) {
        credentialStore.markError(principal, "QUOTA_EXHAUSTED", revision);
        throw new BztError(
          "ZENTAO_UNAVAILABLE",
          "个人模型额度已耗尽，请补充个人配额。",
        );
      }
      if (outcome.kind !== "ok")
        throw new BztError("ZENTAO_UNAVAILABLE", "模型网关请求失败。", {
          outcome: outcome.kind,
        });
      if (containsCredentialLeak(outcome.text, secret))
        throw new BztError(
          "ZENTAO_UNAVAILABLE",
          "模型响应包含敏感凭据回显，已安全拦截。",
        );
      return {
        text: outcome.text,
        finishReason: "stop",
        usage: {},
      };
    },
  };
}

export type ModelGateway = ReturnType<typeof createModelGateway>;
