import { readFileSync } from "node:fs";
import { z } from "zod";
import { ConfigError } from "./errors.js";

export const modes = ["personal", "strict-ai"] as const;
export const storyCategories = ["feature", "design"] as const;
export type Mode = typeof modes[number];
export type StoryCategory = typeof storyCategories[number];
export type Priority = 1 | 2 | 3 | 4;

const positive = z.number().int().positive();
const text = z.string().trim().min(1);
const modeSchema = z.enum(modes);
const defaultsSchema = z.object({
  designProductId: positive,
  runtimeProductId: positive,
  deliveryProductId: positive,
  defaultPri: z.literal([1, 2, 3, 4]),
  defaultCategory: z.enum(storyCategories),
});
const markSchema = z.object({
  source: text,
  sourceNotePrefix: text,
  titlePrefix: z.string().refine(value => value.trim().length > 0),
});
const profileSchema = z.object({
  mode: modeSchema.optional(),
  defaults: defaultsSchema.partial().optional(),
  aiMark: markSchema.partial().optional(),
  teams: z.record(text, z.object({
    department: text.optional(),
    members: z.array(text).optional(),
  }).refine(team => Boolean(team.department || team.members?.length))).optional(),
});

export type BetterZentaoProfile = z.infer<typeof profileSchema>;
export interface ConfigOptions extends BetterZentaoProfile {
  baseUrl?: string;
  account?: string;
  initialToken?: string;
  tokenOnly?: boolean;
  profilePath?: string;
  timeoutMs?: number;
  productId?: number;
  cacheTtlMs?: number;
  env?: NodeJS.ProcessEnv;
}

export interface BetterZentaoConfig {
  baseUrl: string;
  account: string;
  password?: string;
  initialToken?: string;
  tokenOnly: boolean;
  mode: Mode;
  timeoutMs: number;
  productId?: number;
  cacheTtlMs: number;
  defaults: z.infer<typeof defaultsSchema>;
  aiMark: z.infer<typeof markSchema>;
  teams: NonNullable<BetterZentaoProfile["teams"]>;
}

function parseProfile(value: unknown, label: string): BetterZentaoProfile {
  const result = profileSchema.safeParse(value);
  if (!result.success) throw new ConfigError(label + "的业务偏好格式无效");
  return result.data;
}

function readProfile(path: string): BetterZentaoProfile {
  let content: string;
  try {
    content = readFileSync(path, "utf8");
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return {};
    throw new ConfigError("无法读取禅道业务偏好文件");
  }
  let value: unknown;
  try {
    value = JSON.parse(content.replace(/^\uFEFF/, ""));
  } catch {
    throw new ConfigError("禅道业务偏好文件必须是有效的 JSON");
  }
  return parseProfile(value, "本地文件");
}

function numberSetting(value: string | number, name: string, min: number, max = Number.MAX_SAFE_INTEGER): number {
  const parsed = typeof value === "string" && !/^\d+$/.test(value.trim()) ? NaN : Number(value);
  if (!Number.isSafeInteger(parsed) || parsed < min || parsed > max) {
    throw new ConfigError(name + " 无效");
  }
  return parsed;
}

function rootUrl(value: string): string {
  try {
    const url = new URL(value);
    if (!["http:", "https:"].includes(url.protocol) || url.username || url.password || url.search || url.hash) {
      throw new Error();
    }
    return url.href.replace(/\/+$/, "");
  } catch {
    throw new ConfigError("ZENTAO_BASE_URL 必须是 HTTP(S) 禅道根地址");
  }
}

function nonEmpty(value: string | undefined): string | undefined {
  const trimmed = value?.trim();
  return trimmed ? trimmed : undefined;
}

export function resolveConfig(options: ConfigOptions = {}): BetterZentaoConfig {
  const env = options.env ?? process.env;
  const baseUrl = nonEmpty(options.baseUrl) ?? nonEmpty(env.ZENTAO_BASE_URL);
  const account = nonEmpty(options.account) ?? nonEmpty(env.ZENTAO_ACCOUNT);
  const tokenOnly = options.tokenOnly === true || options.initialToken !== undefined;
  const password = tokenOnly ? undefined : env.ZENTAO_PASSWORD;
  const missingVars = [
    ...(!baseUrl ? ["ZENTAO_BASE_URL"] : []),
    ...(!account ? ["ZENTAO_ACCOUNT"] : []),
    ...(!tokenOnly && !password ? ["ZENTAO_PASSWORD"] : []),
  ];
  if (missingVars.length) throw new ConfigError("缺少配置 " + missingVars.join("、"), missingVars);
  if (tokenOnly && !options.initialToken?.trim()) throw new ConfigError("Token 模式需要 initialToken");

  const profile = readProfile(nonEmpty(options.profilePath) ?? nonEmpty(env.ZENTAO_PROFILE_PATH) ?? "./better-zentao.local.json");
  const explicit = parseProfile(options, "构造参数");
  const mode = modeSchema.safeParse(explicit.mode ?? nonEmpty(env.ZENTAO_MODE) ?? profile.mode ?? "personal");
  if (!mode.success) throw new ConfigError("ZENTAO_MODE 必须为 personal 或 strict-ai");
  const productSetting = options.productId ?? nonEmpty(env.ZENTAO_PRODUCT_ID);
  return {
    baseUrl: rootUrl(baseUrl!),
    account: account!,
    password,
    tokenOnly,
    initialToken: options.initialToken,
    mode: mode.data,
    timeoutMs: numberSetting(options.timeoutMs ?? nonEmpty(env.ZENTAO_TIMEOUT_MS) ?? 30_000, "ZENTAO_TIMEOUT_MS", 1, 2_147_483_647),
    productId: productSetting === undefined ? undefined : numberSetting(productSetting, "ZENTAO_PRODUCT_ID", 1),
    cacheTtlMs: numberSetting(options.cacheTtlMs ?? nonEmpty(env.ZENTAO_CACHE_TTL_MS) ?? 600_000, "ZENTAO_CACHE_TTL_MS", 0),
    defaults: {
      designProductId: 42, runtimeProductId: 43, deliveryProductId: 44,
      defaultPri: 2, defaultCategory: "feature", ...profile.defaults, ...explicit.defaults,
    },
    aiMark: {
      source: "ai", sourceNotePrefix: "AI-Agent", titlePrefix: "[AI创建] ", ...profile.aiMark, ...explicit.aiMark,
    },
    teams: { ...profile.teams, ...explicit.teams },
  };
}
