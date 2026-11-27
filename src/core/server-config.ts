import { readFile } from "node:fs/promises";
import { z } from "zod";
import { hasAbsoluteHttpSyntax, normalizeZentaoBaseUrl } from "./base-url.ts";
import {
  assertNoConfigCredentials,
  rejectDuplicateKeys,
  type ConfigEnv,
} from "./config.ts";
import { BztError } from "./errors.ts";

const text = z.string().trim().min(1);
const positiveInt = z.int().positive();
const instanceIdKey = z.string().regex(/^[A-Za-z0-9_-]{1,64}$/u);

function parseStrictOrigin(raw: string): string | undefined {
  const trimmed = raw.trim();
  if (!hasAbsoluteHttpSyntax(trimmed) || trimmed.endsWith("/"))
    return undefined;
  const parsed = URL.parse(trimmed);
  if (
    !parsed ||
    (parsed.protocol !== "http:" && parsed.protocol !== "https:") ||
    parsed.username ||
    parsed.password ||
    parsed.search ||
    parsed.hash ||
    parsed.pathname !== "/" ||
    trimmed.includes("?") ||
    trimmed.includes("#")
  )
    return undefined;
  return parsed.origin;
}

const aiGatewayRuleSchema = z.strictObject({
  origin: text
    .refine((value) => parseStrictOrigin(value) !== undefined, {
      message: "模型网关 origin 必须是不含路径、查询或凭据的合法源地址。",
    })
    .transform((value) => parseStrictOrigin(value) ?? value),
  pathPrefix: text.optional(),
  allowInsecure: z.boolean().default(false),
  allowPrivateNetwork: z.boolean().default(false),
});

const serverAiConfigSchema = z.strictObject({
  enabled: z.boolean().default(false),
  masterKeyFile: text.optional(),
  allowedGateways: z.array(aiGatewayRuleSchema).default([]),
  timeoutMs: positiveInt.max(120_000).default(30_000),
  maxTokens: positiveInt.max(16_384).default(2048),
});

const serverInstanceSchema = z.strictObject({
  name: text,
  baseUrl: text
    .refine((value) => normalizeZentaoBaseUrl(value) !== null, {
      message: "禅道实例地址不合法。",
    })
    .transform((value) => normalizeZentaoBaseUrl(value)?.href ?? value),
  teamConfigPath: text,
  enabled: z.boolean().optional(),
  ai: z
    .strictObject({
      allowedGateways: z.array(aiGatewayRuleSchema).optional(),
    })
    .optional(),
});

export type ServerInstanceConfig = z.output<typeof serverInstanceSchema>;

export const serverConfigSchema = z
  .strictObject({
    $schema: text.optional(),
    version: z.literal(1).default(1),
    host: text.default("127.0.0.1"),
    port: z.int().min(0).max(65535).default(17330),
    externalOrigin: text
      .refine((value) => parseStrictOrigin(value) !== undefined, {
        message: "externalOrigin 必须是不含路径、查询或凭据的合法源地址。",
      })
      .transform((value) => parseStrictOrigin(value) ?? value),
    allowInsecureHttp: z.boolean().default(false),
    trustedProxies: z.array(text).default([]),
    dataDir: text,
    readOnly: z.boolean().default(true),
    session: z
      .strictObject({
        idleTimeoutMinutes: positiveInt.default(480),
        absoluteTimeoutMinutes: positiveInt.default(1440),
        maxSessions: positiveInt.default(500),
        maxSessionsPerUser: positiveInt.default(5),
      })
      .prefault({}),
    cache: z
      .strictObject({
        reportTtlSeconds: positiveInt.max(300).default(60),
      })
      .prefault({}),
    http: z
      .strictObject({
        perInstanceConcurrency: positiveInt.default(16),
        perUserConcurrency: positiveInt.default(4),
        authReserve: positiveInt.default(2),
      })
      .prefault({}),
    notify: z
      .strictObject({
        enabled: z.boolean().default(false),
      })
      .prefault({}),
    ai: serverAiConfigSchema.prefault({}),
    instances: z
      .record(instanceIdKey, serverInstanceSchema)
      .refine((value) => Object.keys(value).length > 0, {
        message: "至少需要登记一个禅道实例。",
      }),
  })
  .superRefine((config, ctx) => {
    if (
      config.externalOrigin.startsWith("http://") &&
      !config.allowInsecureHttp
    ) {
      ctx.addIssue({
        code: "custom",
        path: ["externalOrigin"],
        message: "HTTP 外部源仅在显式设置 allowInsecureHttp: true 时允许。",
      });
    }
    const seenUrls = new Set<string>();
    for (const [id, instance] of Object.entries(config.instances)) {
      if (seenUrls.has(instance.baseUrl)) {
        ctx.addIssue({
          code: "custom",
          path: ["instances", id, "baseUrl"],
          message: "同一禅道地址不能重复登记为多个实例 ID。",
        });
      }
      seenUrls.add(instance.baseUrl);
    }
  });

export type ServerConfig = z.output<typeof serverConfigSchema>;

export async function loadServerConfig(
  path: string,
  env: ConfigEnv = {},
): Promise<ServerConfig> {
  const trimmed = path.trim();
  if (!trimmed)
    throw new BztError("INVALID_INPUT", "集中服务配置路径不能为空。", {
      fields: ["serverConfig"],
    });
  let contents: string;
  try {
    contents = await readFile(trimmed, "utf8");
  } catch {
    throw new BztError("INVALID_INPUT", "无法读取集中服务配置文件。", {
      fields: ["serverConfig"],
    });
  }
  let raw: unknown;
  try {
    raw = JSON.parse(contents);
  } catch {
    throw new BztError("INVALID_INPUT", "集中服务配置文件不是合法 JSON。", {
      fields: ["serverConfig"],
    });
  }
  rejectDuplicateKeys(contents, "serverConfig");
  assertNoConfigCredentials(raw, env);
  const parsed = serverConfigSchema.safeParse(raw);
  if (!parsed.success)
    throw new BztError("INVALID_INPUT", "集中服务配置字段不合法。", {
      fields: ["serverConfig"],
    });
  return parsed.data;
}
