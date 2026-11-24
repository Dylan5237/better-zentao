import { createHash } from "node:crypto";
import { homedir } from "node:os";
import { join, resolve } from "node:path";
import { normalizeZentaoBaseUrl } from "../base-url.ts";
import { BztError } from "../errors.ts";

export interface StoreLocationOptions {
  readonly baseUrl: string;
  readonly account: string;
  /** 未传时使用当前用户主目录；显式传入空串视为配置缺失。 */
  readonly homeDir?: string;
  /** 传入时优先于 homeDir；支持 ":memory:"。 */
  readonly dbPath?: string;
}

export interface StoreLocation {
  readonly dbPath: string;
  /** 归一化 baseUrl 的 SHA-256，十六进制。05 §6 的实例隔离键。 */
  readonly instanceHash: string;
  /** 原始账号（去掉首尾空白），用于 SEC-04 缓存作用域。 */
  readonly account: string;
  /** 可安全落盘的账号目录名。 */
  readonly accountKey: string;
}

const unsafeAccountChars = /[^A-Za-z0-9._-]+/gu;
const accountEdges = /^[._-]+|[._-]+$/gu;
const reservedAccount = /^(?:con|prn|aux|nul|com[1-9]|lpt[1-9])$/iu;
const memoryPath = ":memory:";

/**
 * 05 §6：目录按实例 + 账号隔离。
 * URL 归一化与 config 共用同一口径，保证尾斜杠、大小写不同仍落到同一实例。
 */
export function instanceHashOf(baseUrl: string): string {
  const normalized = normalizeZentaoBaseUrl(baseUrl.trim());
  if (!normalized)
    throw new BztError("INVALID_INPUT", "禅道基础地址不合法。", {
      fields: ["baseUrl"],
    });
  return createHash("sha256").update(normalized.href, "utf8").digest("hex");
}

/**
 * 账号来自环境变量，可能含路径分隔符或保留字符。
 * 已安全的账号保持原名；发生替换或撞上 Windows 保留名时追加原始账号哈希，
 * 避免 "a/b" 与 "a\\b" 之类清洗后同名，也给正常账号保留可读目录。
 */
export function sanitizeAccount(account: string): string {
  const trimmed = account.trim();
  if (!trimmed)
    throw new BztError("INVALID_INPUT", "禅道账号不能为空。", {
      fields: ["account"],
    });
  const sanitized = trimmed
    .replace(unsafeAccountChars, "_")
    .replace(accountEdges, "");
  const safe = (sanitized || "account").slice(0, 48);
  if (safe === trimmed && !reservedAccount.test(safe)) return safe;
  const digest = createHash("sha256")
    .update(trimmed, "utf8")
    .digest("hex")
    .slice(0, 12);
  return `${safe}-${digest}`;
}

export function resolveStoreLocation(
  options: StoreLocationOptions,
): StoreLocation {
  const account = options.account.trim();
  if (!account)
    throw new BztError("INVALID_INPUT", "禅道账号不能为空。", {
      fields: ["account"],
    });
  const instanceHash = instanceHashOf(options.baseUrl);
  const accountKey = sanitizeAccount(account);

  const customPath = options.dbPath?.trim();
  let dbPath: string;
  if (customPath !== undefined) {
    if (!customPath)
      throw new BztError("INVALID_INPUT", "本地状态库路径不能为空。", {
        fields: ["dbPath"],
      });
    dbPath = customPath === memoryPath ? customPath : resolve(customPath);
  } else {
    const providedHome = options.homeDir?.trim();
    const home = providedHome === undefined ? homedir() : providedHome;
    if (!home)
      throw new BztError("CONFIG_MISSING", "无法确定本地状态目录。", {
        fields: ["homeDir"],
      });
    // docs/08 CFG-09 与 05 §6：<home>/.better-zentao/<instanceHash>/<account>/state.db
    dbPath = join(
      resolve(home),
      ".better-zentao",
      instanceHash,
      accountKey,
      "state.db",
    );
  }

  return { dbPath, instanceHash, account, accountKey };
}
