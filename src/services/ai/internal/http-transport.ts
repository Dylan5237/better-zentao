import { lookup } from "node:dns/promises";
import {
  request as httpRequest,
  type ClientRequest,
  type IncomingMessage,
} from "node:http";
import { request as httpsRequest } from "node:https";
import { z } from "zod";
import type { ModelGatewayPolicy } from "../contracts.ts";
import {
  assertSupportedProtocol,
  isPrivateAddress,
  matchesPathPrefix,
  validateGatewayUrl,
  type ModelTransport,
} from "../model-gateway.ts";

/**
 * CR-009 §11.1 / ADR-26：最窄网络例外目录（src/services/ai/internal/）。
 * 实现受控企业大模型网关 HTTP 传输层：
 * - 仅支持 OpenAI-compatible（/chat/completions）与 Anthropic-compatible（/messages）；
 * - 最终请求 URL 复核管理员白名单与规范化路径前缀；
 * - DNS 目的 IP 钉死（pinned lookup）：解析并逐条校验全部 IP 后，直接把已校验 IP 绑定至 TCP/TLS
 *   连接，同时保留原始主机名用于 TLS SNI、证书校验与 Host 头，彻底消除 DNS 重绑定窗口；
 * - 永不自动跟随 3xx 重定向；
 * - 流式累计字节上限保护（256 KiB），越限时立即中止连接，全程绑定 AbortSignal。
 */

export type DnsRecord = Readonly<{
  address: string;
  family?: 4 | 6 | undefined;
}>;

export type DnsLookup = (hostname: string) => Promise<readonly DnsRecord[]>;

export interface HttpModelTransportOptions {
  readonly policy: ModelGatewayPolicy;
  readonly dnsLookup?: DnsLookup | undefined;
  readonly maxResponseBytes?: number | undefined;
}

const defaultMaxResponseBytes = 256 * 1024;

const openAiResponseSchema = z.object({
  choices: z
    .array(
      z.object({
        message: z
          .object({
            content: z.union([
              z.string(),
              z.array(z.object({ text: z.string().optional() })),
            ]),
          })
          .optional(),
      }),
    )
    .min(1),
});

const anthropicResponseSchema = z.object({
  content: z
    .array(
      z.object({
        type: z.string().optional(),
        text: z.string().optional(),
      }),
    )
    .min(1),
});

const bodyRequestSchema = z.object({
  messages: z.array(
    z.object({
      role: z.enum(["system", "user", "assistant"]),
      content: z.string(),
    }),
  ),
  max_tokens: z.number().int().positive().optional(),
});

function defaultLookup(hostname: string): Promise<readonly DnsRecord[]> {
  return lookup(hostname, { all: true, verbatim: true }).then((rows) =>
    rows.map((row) => ({
      address: row.address,
      family: row.family === 6 ? 6 : 4,
    })),
  );
}

function originOf(url: URL): string {
  return `${url.protocol}//${url.host}`;
}

function inferFamily(record: DnsRecord): 4 | 6 {
  if (record.family === 4 || record.family === 6) return record.family;
  return record.address.includes(":") ? 6 : 4;
}

function endpointFor(
  base: URL,
  protocol: "openai-compatible" | "anthropic-compatible",
): URL {
  const target = new URL(base.href);
  target.search = "";
  target.hash = "";
  const cleanPath =
    target.pathname.length > 1
      ? target.pathname.replace(/\/+$/u, "")
      : target.pathname;
  const suffix =
    protocol === "anthropic-compatible" ? "/messages" : "/chat/completions";
  if (cleanPath.endsWith(suffix)) {
    target.pathname = cleanPath;
  } else {
    target.pathname = cleanPath === "/" ? suffix : `${cleanPath}${suffix}`;
  }
  return target;
}

function extractText(
  protocol: "openai-compatible" | "anthropic-compatible",
  payload: unknown,
): string | undefined {
  if (protocol === "anthropic-compatible") {
    const parsed = anthropicResponseSchema.safeParse(payload);
    if (!parsed.success) return undefined;
    return parsed.data.content
      .map((part) => part.text ?? "")
      .join("")
      .trim();
  }
  const parsed = openAiResponseSchema.safeParse(payload);
  if (!parsed.success) return undefined;
  const content = parsed.data.choices[0]?.message?.content;
  if (typeof content === "string") return content;
  if (Array.isArray(content))
    return content
      .map((part) => part.text ?? "")
      .join("")
      .trim();
  return undefined;
}

type RawOutcome =
  | { readonly kind: "ok"; readonly body: string }
  | { readonly kind: "http-error"; readonly status: number }
  | { readonly kind: "redirect" }
  | { readonly kind: "timeout" }
  | { readonly kind: "network" };

function sendPinnedRequest(options: {
  readonly targetUrl: URL;
  readonly pinnedAddress: string;
  readonly pinnedFamily: 4 | 6;
  readonly headers: Record<string, string>;
  readonly body: string;
  readonly maxResponseBytes: number;
  readonly abortSignal?: AbortSignal | undefined;
}): Promise<RawOutcome> {
  const {
    targetUrl,
    pinnedAddress,
    pinnedFamily,
    headers,
    body,
    maxResponseBytes,
    abortSignal,
  } = options;
  if (abortSignal?.aborted) return Promise.resolve({ kind: "timeout" });

  return new Promise<RawOutcome>((resolve) => {
    let settled = false;
    const finish = (outcome: RawOutcome) => {
      if (settled) return;
      settled = true;
      abortSignal?.removeEventListener("abort", onAbort);
      resolve(outcome);
    };

    const pinnedLookup = (
      _hostname: string,
      opts: { all?: boolean | undefined },
      cb: (
        err: NodeJS.ErrnoException | null,
        address: string | { address: string; family: number }[],
        family?: number,
      ) => void,
    ) => {
      if (opts.all === true) {
        cb(null, [{ address: pinnedAddress, family: pinnedFamily }]);
      } else {
        cb(null, pinnedAddress, pinnedFamily);
      }
    };

    const bodyBuffer = Buffer.from(body, "utf8");
    const requestHeaders: Record<string, string | number> = {
      ...headers,
      Host: targetUrl.host,
      "Content-Length": bodyBuffer.byteLength,
    };

    const onResponse = (res: IncomingMessage) => {
      const status = res.statusCode ?? 0;
      if (status >= 300 && status < 400) {
        res.resume();
        req.destroy();
        finish({ kind: "redirect" });
        return;
      }
      if (status < 200 || status >= 300) {
        res.resume();
        req.destroy();
        finish({ kind: "http-error", status });
        return;
      }

      const chunks: Buffer[] = [];
      let totalBytes = 0;

      res.on("data", (chunk: Buffer | string) => {
        if (settled) return;
        const buf = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk, "utf8");
        totalBytes += buf.byteLength;
        if (totalBytes > maxResponseBytes) {
          res.destroy();
          req.destroy();
          finish({ kind: "network" });
          return;
        }
        chunks.push(buf);
      });

      res.on("end", () => {
        if (settled) return;
        finish({ kind: "ok", body: Buffer.concat(chunks).toString("utf8") });
      });

      res.on("aborted", () => {
        finish(
          abortSignal?.aborted ? { kind: "timeout" } : { kind: "network" },
        );
      });

      res.on("error", () => {
        finish(
          abortSignal?.aborted ? { kind: "timeout" } : { kind: "network" },
        );
      });
    };

    const isHttps = targetUrl.protocol === "https:";
    const req: ClientRequest = isHttps
      ? httpsRequest(
          targetUrl,
          {
            agent: false,
            method: "POST",
            headers: requestHeaders,
            servername: targetUrl.hostname,
            lookup: pinnedLookup,
          },
          onResponse,
        )
      : httpRequest(
          targetUrl,
          {
            agent: false,
            method: "POST",
            headers: requestHeaders,
            lookup: pinnedLookup,
          },
          onResponse,
        );

    const onAbort = () => {
      req.destroy();
      finish({ kind: "timeout" });
    };
    abortSignal?.addEventListener("abort", onAbort, { once: true });

    req.on("error", () => {
      finish(abortSignal?.aborted ? { kind: "timeout" } : { kind: "network" });
    });

    req.end(bodyBuffer);
  });
}

export function createHttpModelTransport(
  options: HttpModelTransportOptions,
): ModelTransport {
  const {
    policy,
    dnsLookup = defaultLookup,
    maxResponseBytes = defaultMaxResponseBytes,
  } = options;

  return {
    async send(request) {
      let protocol: "openai-compatible" | "anthropic-compatible";
      let baseUrl: URL;
      let targetUrl: URL;
      try {
        protocol = assertSupportedProtocol(request.protocol);
        baseUrl = validateGatewayUrl(request.url, policy);
        targetUrl = endpointFor(baseUrl, protocol);
        // 对最终构造出的目标请求 URL 再次执行完整白名单与安全边界校验。
        validateGatewayUrl(targetUrl.href, policy);
      } catch {
        return { kind: "network" };
      }

      const rule = policy.allowedGateways.find(
        (entry) =>
          originOf(targetUrl) === entry.origin &&
          (entry.pathPrefix === undefined ||
            matchesPathPrefix(targetUrl.pathname, entry.pathPrefix)),
      );
      if (!rule) return { kind: "network" };

      if (request.abortSignal?.aborted) return { kind: "timeout" };

      // DNS 解析与地址钉死：先核查全部解析结果，再将校验后的 IP 直接绑定到实际 Socket 连接。
      let addresses: readonly DnsRecord[];
      try {
        addresses = await dnsLookup(targetUrl.hostname);
      } catch {
        return { kind: "network" };
      }
      if (addresses.length === 0) return { kind: "network" };
      if (
        !rule.allowPrivateNetwork &&
        addresses.some(({ address }) => isPrivateAddress(address))
      ) {
        return { kind: "network" };
      }
      const pinned = addresses[0];
      if (!pinned) return { kind: "network" };

      const parsedBody = bodyRequestSchema.safeParse(request.body);
      if (!parsedBody.success) return { kind: "network" };

      const headers: Record<string, string> = {
        "Content-Type": "application/json",
        Accept: "application/json",
      };
      let payload: unknown;
      if (protocol === "anthropic-compatible") {
        headers["x-api-key"] = request.token;
        headers["anthropic-version"] = "2023-06-01";
        const system = parsedBody.data.messages
          .filter((m) => m.role === "system")
          .map((m) => m.content)
          .join("\n");
        const messages = parsedBody.data.messages.filter(
          (m) => m.role !== "system",
        );
        payload = {
          model: request.modelId,
          max_tokens: parsedBody.data.max_tokens ?? policy.maxTokens,
          ...(system ? { system } : {}),
          messages,
        };
      } else {
        headers.Authorization = `Bearer ${request.token}`;
        payload = {
          model: request.modelId,
          messages: parsedBody.data.messages,
          max_tokens: parsedBody.data.max_tokens ?? policy.maxTokens,
          temperature: 0.2,
        };
      }

      const outcome = await sendPinnedRequest({
        targetUrl,
        pinnedAddress: pinned.address,
        pinnedFamily: inferFamily(pinned),
        headers,
        body: JSON.stringify(payload),
        maxResponseBytes,
        abortSignal: request.abortSignal,
      });

      if (outcome.kind !== "ok") return outcome;

      let decoded: unknown;
      try {
        decoded = JSON.parse(outcome.body);
      } catch {
        return { kind: "network" };
      }
      const extracted = extractText(protocol, decoded);
      if (extracted === undefined) return { kind: "network" };
      return { kind: "ok", text: extracted };
    },
  };
}
