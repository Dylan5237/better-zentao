import { createServer, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { modelGatewayPolicySchema } from "../../src/services/ai/contracts.ts";
import { createHttpModelTransport } from "../../src/services/ai/internal/http-transport.ts";
import {
  isPrivateAddress,
  validateGatewayUrl,
} from "../../src/services/ai/model-gateway.ts";

/**
 * CR-009 §11.1 / ADR-26：受控企业大模型网关 HTTP 传输层（src/services/ai/internal/）。
 * 全程离线使用本机受控 HTTP 服务器验证：
 * - DNS 目的 IP 钉死（pinned lookup）与 Host 头保留；
 * - OpenAI/Anthropic 协议编解码与 enterprise-custom 显式拒绝；
 * - IPv4/IPv6（含 fe80::/10、fc00::/7、::ffff:7f00:1、NAT64）与普通域名误杀回归；
 * - 302 零重定向、HTTP 429、流式响应体上限即时中止与 AbortSignal 取消。
 */

const token = "synthetic-http-transport-token-9876";

describe("HTTP ModelTransport 真实本地回环与安全护栏", () => {
  let server: Server;
  let port = 0;
  let lastRequest: {
    url: string | undefined;
    host: string | undefined;
    headers: Record<string, string | string[] | undefined>;
    body: string;
  } | null = null;

  beforeAll(async () => {
    server = createServer((req, res) => {
      const chunks: Buffer[] = [];
      req.on("data", (c: Buffer) => chunks.push(c));
      req.on("end", () => {
        const body = Buffer.concat(chunks).toString("utf8");
        lastRequest = {
          url: req.url,
          host: req.headers.host,
          headers: req.headers,
          body,
        };
        if (req.url === "/v1/chat/completions") {
          const parsed = JSON.parse(body) as { model?: string };
          if (parsed.model === "trigger-redirect") {
            res.writeHead(302, { Location: "http://169.254.169.254/latest" });
            res.end();
            return;
          }
          if (parsed.model === "trigger-429") {
            res.writeHead(429, { "Content-Type": "application/json" });
            res.end(JSON.stringify({ error: "rate_limited" }));
            return;
          }
          if (parsed.model === "trigger-oversize") {
            res.writeHead(200, { "Content-Type": "application/json" });
            res.write(
              JSON.stringify({
                choices: [{ message: { content: "x".repeat(4096) } }],
              }),
            );
            res.end();
            return;
          }
          if (parsed.model === "trigger-slow") {
            res.writeHead(200, { "Content-Type": "application/json" });
            res.write('{"choices":');
            // 故意挂起等待客户端 AbortSignal 中止（低于 maxResponseBytes 上限）。
            return;
          }
          res.writeHead(200, { "Content-Type": "application/json" });
          res.end(
            JSON.stringify({
              choices: [{ message: { content: "合成模型回复" } }],
            }),
          );
          return;
        }
        if (req.url === "/v1/messages") {
          res.writeHead(200, { "Content-Type": "application/json" });
          res.end(
            JSON.stringify({
              content: [{ type: "text", text: "Anthropic 合成回复" }],
            }),
          );
          return;
        }
        res.writeHead(404);
        res.end();
      });
    });
    await new Promise<void>((resolve) => {
      server.listen(0, "127.0.0.1", () => {
        port = (server.address() as AddressInfo).port;
        resolve();
      });
    });
  });

  afterAll(async () => {
    await new Promise<void>((resolve) => server.close(() => resolve()));
  });

  function pinnedPolicy() {
    return modelGatewayPolicySchema.parse({
      allowedGateways: [
        {
          origin: `http://llm.corp.example:${port}`,
          pathPrefix: "/v1",
          allowInsecure: true,
          allowPrivateNetwork: true,
        },
      ],
      timeoutMs: 5_000,
      maxTokens: 1024,
    });
  }

  it("DNS 钉死将解析 IP 直接绑定到 Socket，同时保留原始 Host 头并完成 OpenAI/Anthropic 往返", async () => {
    const dnsLookup = vi.fn(async () => [
      { address: "127.0.0.1", family: 4 as const },
    ]);
    const transport = createHttpModelTransport({
      policy: pinnedPolicy(),
      dnsLookup,
    });

    const openai = await transport.send({
      url: `http://llm.corp.example:${port}/v1`,
      token,
      modelId: "corp-gpt",
      protocol: "openai-compatible",
      body: { messages: [{ role: "user", content: "ping" }], max_tokens: 64 },
    });
    expect(openai).toEqual({ kind: "ok", text: "合成模型回复" });
    expect(dnsLookup).toHaveBeenCalledWith("llm.corp.example");
    expect(lastRequest?.url).toBe("/v1/chat/completions");
    expect(lastRequest?.host).toBe(`llm.corp.example:${port}`);
    expect(lastRequest?.headers.authorization).toBe(`Bearer ${token}`);

    const anthropic = await transport.send({
      url: `http://llm.corp.example:${port}/v1`,
      token,
      modelId: "corp-claude",
      protocol: "anthropic-compatible",
      body: {
        messages: [
          { role: "system", content: "sys" },
          { role: "user", content: "hi" },
        ],
        max_tokens: 64,
      },
    });
    expect(anthropic).toEqual({ kind: "ok", text: "Anthropic 合成回复" });
    expect(lastRequest?.url).toBe("/v1/messages");
    expect(lastRequest?.headers["x-api-key"]).toBe(token);
  });

  it("P1-1：规范化 IPv4/IPv6 网段判定（含 fe80::/10、::ffff:7f00:1、NAT64）且不误拒普通域名", () => {
    for (const privateAddr of [
      "localhost",
      "api.localhost",
      "127.0.0.1",
      "10.1.2.3",
      "100.64.0.1",
      "169.254.169.254",
      "172.16.0.1",
      "192.168.1.5",
      "::1",
      "::",
      "::ffff:127.0.0.1",
      "::ffff:7f00:1",
      "fe80::1",
      "febf::1234",
      "fc00::1",
      "fd12:3456::1",
      "64:ff9b::10.0.0.1",
    ]) {
      expect(isPrivateAddress(privateAddr), privateAddr).toBe(true);
    }
    for (const publicAddr of [
      "fc-gateway.example.com",
      "fd-ai.corp.example",
      "fe80-llm.example.com",
      "203.0.113.20",
      "2001:4860:4860::8888",
      "2606:4700::1111",
    ]) {
      expect(isPrivateAddress(publicAddr), publicAddr).toBe(false);
    }
  });

  it("DNS 解析到任意私网/环回/元数据 IP 时零连接拒绝", async () => {
    const strictPolicy = modelGatewayPolicySchema.parse({
      allowedGateways: [
        { origin: "https://fc-gateway.example.com", pathPrefix: "/v1" },
      ],
      timeoutMs: 5_000,
      maxTokens: 1024,
    });
    for (const badIp of [
      "127.0.0.1",
      "169.254.169.254",
      "10.1.2.3",
      "febf::1",
      "::ffff:7f00:1",
    ]) {
      const transport = createHttpModelTransport({
        policy: strictPolicy,
        dnsLookup: async () => [{ address: badIp }],
      });
      const result = await transport.send({
        url: "https://fc-gateway.example.com/v1",
        token,
        modelId: "corp-gpt",
        protocol: "openai-compatible",
        body: { messages: [{ role: "user", content: "ping" }] },
      });
      expect(result).toEqual({ kind: "network" });
    }
  });

  it("P2-1 & P2-2：拦截 302、HTTP 429、流式超限响应、在途 Abort、enterprise-custom 与带查询参数 URL", async () => {
    const dnsLookup = async () => [
      { address: "127.0.0.1", family: 4 as const },
    ];
    const transport = createHttpModelTransport({
      policy: pinnedPolicy(),
      dnsLookup,
      maxResponseBytes: 32,
    });

    // 302 零重定向
    expect(
      await transport.send({
        url: `http://llm.corp.example:${port}/v1`,
        token,
        modelId: "trigger-redirect",
        protocol: "openai-compatible",
        body: { messages: [{ role: "user", content: "ping" }] },
      }),
    ).toEqual({ kind: "redirect" });

    // HTTP 429
    expect(
      await transport.send({
        url: `http://llm.corp.example:${port}/v1`,
        token,
        modelId: "trigger-429",
        protocol: "openai-compatible",
        body: { messages: [{ role: "user", content: "ping" }] },
      }),
    ).toEqual({ kind: "http-error", status: 429 });

    // 流式超限响应即时断开
    expect(
      await transport.send({
        url: `http://llm.corp.example:${port}/v1`,
        token,
        modelId: "trigger-oversize",
        protocol: "openai-compatible",
        body: { messages: [{ role: "user", content: "ping" }] },
      }),
    ).toEqual({ kind: "network" });

    // 流读取期间 AbortSignal 即时中断
    const abort = new AbortController();
    const pending = transport.send({
      url: `http://llm.corp.example:${port}/v1`,
      token,
      modelId: "trigger-slow",
      protocol: "openai-compatible",
      body: { messages: [{ role: "user", content: "ping" }] },
      abortSignal: abort.signal,
    });
    setTimeout(() => abort.abort(), 30);
    expect(await pending).toEqual({ kind: "timeout" });

    // 未实现协议 enterprise-custom 显式拒绝
    expect(
      await transport.send({
        url: `http://llm.corp.example:${port}/v1`,
        token,
        modelId: "corp-gpt",
        protocol: "enterprise-custom",
        body: { messages: [{ role: "user", content: "ping" }] },
      }),
    ).toEqual({ kind: "network" });

    // 含 query 或 fragment 的 Base URL 被 validateGatewayUrl 拒绝
    expect(() =>
      validateGatewayUrl(
        `http://llm.corp.example:${port}/v1?foo=bar`,
        pinnedPolicy(),
      ),
    ).toThrow(/查询参数或片段/u);
    expect(() =>
      validateGatewayUrl(
        `http://llm.corp.example:${port}/v1#frag`,
        pinnedPolicy(),
      ),
    ).toThrow(/查询参数或片段/u);
  });
});
