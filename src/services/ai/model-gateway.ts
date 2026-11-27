import { BztError } from "../../core/errors.ts";
import type { Clock } from "../../core/clock.ts";
import type {
  MaskedModelConfig,
  ModelCompletionRequest,
  ModelCompletionResponse,
  ModelGatewayPolicy,
} from "./contracts.ts";
import type {
  ModelPrincipal,
  PersonalModelStore,
} from "./personal-model-store.ts";

/**
 * CR-009 §5.3：个人企业大模型网关（出站策略校验 + 受控传输）。
 * M1 不调用全局 fetch：传输层经注入接口（transport.send）模拟，
 * 真实出站留待 M3 的 src/services/ai/internal/ 窄例外。
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
  readonly transport: ModelTransport;
  readonly clock: Clock;
  /** 结构化脱敏日志：只记方法、模型、状态与耗时，不记正文或 Token。 */
  readonly logSink?: (line: string) => void;
}

const privateIpv4 =
  /^(?:10|127|169\.254|172\.(?:1[6-9]|2\d|3[01])|192\.168)\./u;
const privateIpv6 = /^(?:f[cd]|fe80|::1|::)/iu;
const loopbackHosts = new Set(["localhost", "ip6-localhost", "ip6-loopback"]);
const metadataHost = /^169\.254\.169\.254$/u;

function privateAddressOf(hostname: string): boolean {
  if (loopbackHosts.has(hostname.toLowerCase())) return true;
  if (metadataHost.test(hostname)) return true;
  if (privateIpv4.test(hostname)) return true;
  const bare = hostname.replace(/^\[|\]$/gu, "");
  return privateIpv6.test(bare);
}

function originOf(url: URL): string {
  return `${url.protocol}//${url.host}`;
}

function matchesPathPrefix(pathname: string, prefix: string): boolean {
  const normalized = prefix.endsWith("/") ? prefix.slice(0, -1) : prefix;
  if (!normalized) return true;
  return pathname === normalized || pathname.startsWith(`${normalized}/`);
}

/**
 * CR-009 MG-02：网关 URL 校验。
 * 拒绝内嵌凭据、非 HTTPS（除非管理员规则显式允许）、非白名单来源、
 * 私网/环回/链路本地/元数据地址（除非规则显式允许）；强制 redirect: "error"。
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
  if (url.username || url.password)
    throw new BztError("INVALID_INPUT", "网关地址不能内嵌凭据。");
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
  if (privateAddressOf(url.hostname) && !rule.allowPrivateNetwork)
    throw new BztError("PERMISSION_DENIED", "禁止访问内网或本机地址。");
  return url;
}

function notConfigured(): BztError {
  return new BztError("CONFIG_MISSING", "请先配置个人模型网关。");
}

function notVerified(): BztError {
  return new BztError("AUTH_FAILED", "个人模型网关尚未通过连接验证。");
}

export function createModelGateway(options: ModelGatewayOptions) {
  const { policy, credentialStore, transport, clock, logSink } = options;

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
     * 按配置 revision 绑定结果，防止轮换竞态把新 Token 误标为已验证。
     */
    async testConnection(
      principal: ModelPrincipal,
      abortSignal?: AbortSignal,
    ): Promise<Readonly<{ ok: boolean; masked: MaskedModelConfig }>> {
      const started = clock();
      const { masked, secret, revision } = resolve(principal);
      const url = validateGatewayUrl(masked.baseUrl ?? "", policy);
      const outcome = await sendWithGuard({
        url: url.href,
        token: secret,
        modelId: masked.modelId ?? "",
        protocol: masked.protocol ?? "openai-compatible",
        body: {
          messages: [{ role: "user", content: "连接测试（非业务探活）。" }],
          max_tokens: 8,
        },
        abortSignal,
      });
      const durationMs = clock() - started;
      log({
        method: "test-connection",
        model: masked.modelId,
        outcome: outcome.kind,
        durationMs,
      });
      if (outcome.kind === "ok") {
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
     * 只解析本人 Token（零回退），执行超时、取消、异常脱敏与 maxTokens 预算。
     */
    async complete(
      principal: ModelPrincipal,
      request: ModelCompletionRequest,
    ): Promise<ModelCompletionResponse> {
      const started = clock();
      const { masked, secret, revision } = resolve(principal);
      if (!masked.verified) throw notVerified();
      const url = validateGatewayUrl(masked.baseUrl ?? "", policy);
      const maxTokens = Math.min(
        request.maxTokens ?? policy.maxTokens,
        policy.maxTokens,
      );
      const outcome = await sendWithGuard({
        url: url.href,
        token: secret,
        modelId: masked.modelId ?? "",
        protocol: masked.protocol ?? "openai-compatible",
        body: { messages: request.messages, max_tokens: maxTokens },
        abortSignal: request.abortSignal,
      });
      const durationMs = clock() - started;
      log({
        method: "complete",
        model: masked.modelId,
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
      return {
        text: outcome.text,
        finishReason: "stop",
        usage: {},
      };
    },
  };
}

export type ModelGateway = ReturnType<typeof createModelGateway>;
