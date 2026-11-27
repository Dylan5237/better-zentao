import { createCipheriv, createDecipheriv, randomBytes } from "node:crypto";
import { mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { z } from "zod";
import { BztError } from "../../core/errors.ts";
import { canonicalAccountDir } from "../../core/store/location.ts";
import type {
  MaskedModelConfig,
  PersonalModelConfigInput,
} from "./contracts.ts";

/**
 * CR-009 §5.2：个人企业大模型凭据存储（AES-256-GCM AEAD）。
 * 主密钥仅经注入提供，绝不写入存储文件；每条记录独立 96-bit IV，
 * AAD 绑定 instanceHash + account + keyVersion，防止密文跨主体拷贝重放。
 */

const keyVersion = 1;
const masterKeyLength = 32;
const ivLength = 12;
const authTagLength = 16;

/** 存储主体键：(instanceHash, canonicalAccountKey)。 */
export type ModelPrincipal = Readonly<{
  instanceHash: string;
  account: string;
}>;

export interface PersonalModelStoreOptions {
  /** 32 字节主密钥；绝不持久化在存储文件中。 */
  readonly masterKey: Buffer;
  /** 凭据根目录；未传时使用内存后端（测试用）。 */
  readonly dataDir?: string | undefined;
}

interface StoredRecord {
  readonly revision: string;
  readonly ciphertext: string;
  readonly iv: string;
  readonly tag: string;
  readonly baseUrl: string;
  readonly protocol: PersonalModelConfigInput["protocol"];
  readonly modelId: string;
  readonly tokenHint: string;
  readonly verified: boolean;
  readonly verifiedAt: number | null;
  readonly lastErrorCode: string | null;
}

const recordSchema = z.strictObject({
  version: z.literal(1),
  records: z.record(
    z.string(),
    z.strictObject({
      revision: z.string().min(1),
      ciphertext: z.string(),
      iv: z.string(),
      tag: z.string(),
      baseUrl: z.string(),
      protocol: z.enum([
        "openai-compatible",
        "anthropic-compatible",
        "enterprise-custom",
      ]),
      modelId: z.string(),
      tokenHint: z.string(),
      verified: z.boolean(),
      verifiedAt: z.number().int().nullable(),
      lastErrorCode: z.string().nullable(),
    }),
  ),
});

type StoredFile = z.infer<typeof recordSchema>;

function createEmptyFile(): StoredFile {
  return { version: 1, records: {} };
}

function aadOf(principal: ModelPrincipal): Buffer {
  return Buffer.from(
    `${principal.instanceHash}\0${principal.account}\0${keyVersion}`,
    "utf8",
  );
}

function principalKey(principal: ModelPrincipal): string {
  return `${principal.instanceHash}\n${principal.account}`;
}

/** 生成安全的 tokenHint（如 "••••9f2a"），绝不回显完整 Token。 */
function tokenHintOf(token: string): string {
  if (token.length < 8) return "••••";
  return `••••${token.slice(-4)}`;
}

function assertMasterKey(masterKey: Buffer): void {
  if (!Buffer.isBuffer(masterKey) || masterKey.length !== masterKeyLength)
    throw new BztError("INVALID_INPUT", "主密钥必须是 32 字节。", {
      fields: ["masterKey"],
    });
}

function missingRecord(): BztError {
  return new BztError("NOT_FOUND", "当前账号尚未配置个人模型网关。");
}

/**
 * CR-009 MG-01：加密个人模型凭据存储。
 * 支持文件后端（0700 目录 / 0600 文件，按实例 + 账号隔离）
 * 与内存后端（测试注入），两者共享同一加密语义。
 */
export function createPersonalModelStore(options: PersonalModelStoreOptions) {
  const masterKey = options.masterKey;
  assertMasterKey(masterKey);
  const fileBacked = options.dataDir !== undefined;
  // 文件后端布局：<dataDir>/ai-credentials/<instanceHash>/<canonicalAccount>.json
  const fileFor = (principal: ModelPrincipal) =>
    options.dataDir === undefined
      ? undefined
      : join(
          options.dataDir,
          "ai-credentials",
          principal.instanceHash,
          `${canonicalAccountDir(principal.account)}.json`,
        );
  const memory = new Map<string, StoredRecord>();

  const ensureDir = (file: string) => {
    try {
      mkdirSync(dirname(file), { recursive: true, mode: 0o700 });
    } catch {
      // 目录已存在或不可创建时由后续读写报错。
    }
  };

  const loadFile = (file: string): StoredFile => {
    try {
      const raw = readFileSync(file, "utf8");
      const parsed = recordSchema.safeParse(JSON.parse(raw));
      if (!parsed.success) throw new Error("bad-record");
      return parsed.data;
    } catch {
      return createEmptyFile();
    }
  };

  const saveFile = (file: string, data: StoredFile): void => {
    ensureDir(file);
    try {
      writeFileSync(file, JSON.stringify(data), {
        encoding: "utf8",
        mode: 0o600,
        flag: "wx",
      });
    } catch {
      // 已存在时覆盖（轮换 Token 场景）。
      writeFileSync(file, JSON.stringify(data), {
        encoding: "utf8",
        mode: 0o600,
      });
    }
  };

  const loadRecord = (principal: ModelPrincipal): StoredRecord | undefined => {
    const key = principalKey(principal);
    if (fileBacked) {
      const file = fileFor(principal);
      if (!file) return undefined;
      const record = loadFile(file).records[key];
      return record === undefined ? undefined : record;
    }
    return memory.get(key);
  };

  const persistRecord = (
    principal: ModelPrincipal,
    record: StoredRecord | undefined,
  ): void => {
    const key = principalKey(principal);
    if (fileBacked) {
      const file = fileFor(principal);
      if (!file) return;
      // 物理隔离：每个主体文件只保留当前主体记录；删除时彻底移除磁盘文件，删除失败明确报错。
      if (record === undefined) {
        try {
          rmSync(file, { force: true });
        } catch {
          throw new BztError(
            "ZENTAO_UNAVAILABLE",
            "未能彻底删除磁盘上的个人模型凭据文件。",
          );
        }
        return;
      }
      saveFile(file, { version: 1, records: { [key]: record } });
      return;
    }
    if (record === undefined) memory.delete(key);
    else memory.set(key, record);
  };

  const encrypt = (principal: ModelPrincipal, token: string) => {
    const iv = randomBytes(ivLength);
    const cipher = createCipheriv("aes-256-gcm", masterKey, iv, {
      authTagLength,
    });
    cipher.setAAD(aadOf(principal));
    const ciphertext = Buffer.concat([
      cipher.update(token, "utf8"),
      cipher.final(),
    ]);
    const tag = cipher.getAuthTag();
    return { ciphertext, iv, tag };
  };

  const decrypt = (principal: ModelPrincipal, record: StoredRecord): string => {
    const iv = Buffer.from(record.iv, "base64");
    const tag = Buffer.from(record.tag, "base64");
    const data = Buffer.from(record.ciphertext, "base64");
    const decipher = createDecipheriv("aes-256-gcm", masterKey, iv, {
      authTagLength,
    });
    decipher.setAAD(aadOf(principal));
    decipher.setAuthTag(tag);
    try {
      return Buffer.concat([decipher.update(data), decipher.final()]).toString(
        "utf8",
      );
    } catch {
      throw new BztError(
        "AUTH_FAILED",
        "个人模型凭据解密失败，请重新保存配置。",
      );
    }
  };

  return {
    /** 保存（或轮换）个人配置；生成不可复用的随机版本标识并重置验证状态（即便删除后重建也不碰撞）。 */
    save(principal: ModelPrincipal, input: PersonalModelConfigInput): string {
      assertMasterKey(masterKey);
      const revision = randomBytes(16).toString("hex");
      const { ciphertext, iv, tag } = encrypt(principal, input.token);
      persistRecord(principal, {
        revision,
        ciphertext: ciphertext.toString("base64"),
        iv: iv.toString("base64"),
        tag: tag.toString("base64"),
        baseUrl: input.baseUrl,
        protocol: input.protocol,
        modelId: input.modelId,
        tokenHint: tokenHintOf(input.token),
        verified: false,
        verifiedAt: null,
        lastErrorCode: null,
      });
      return revision;
    },
    /** 脱敏读取：永不返回原始 Token；若当前主密钥无法解开既有密文则即时显式标注未就绪。 */
    getMasked(principal: ModelPrincipal): MaskedModelConfig {
      const record = loadRecord(principal);
      if (!record)
        return {
          configured: false,
          verified: false,
          lastErrorCode: undefined,
        };
      let decryptable = true;
      try {
        decrypt(principal, record);
      } catch {
        decryptable = false;
      }
      return {
        configured: true,
        verified: decryptable ? record.verified : false,
        verifiedAt:
          decryptable && record.verifiedAt !== null
            ? record.verifiedAt
            : undefined,
        baseUrl: record.baseUrl,
        protocol: record.protocol,
        modelId: record.modelId,
        tokenHint: record.tokenHint,
        lastErrorCode: decryptable
          ? (record.lastErrorCode ?? undefined)
          : "MASTER_KEY_MISMATCH",
      };
    },
    /** 仅返回本人（principal）的 Token；零回退、零跨主体读取。 */
    resolveSecret(principal: ModelPrincipal): string {
      assertMasterKey(masterKey);
      const record = loadRecord(principal);
      if (!record) throw missingRecord();
      return decrypt(principal, record);
    },
    /** 返回本人（principal）的 Token 与唯一版本标识，供探活/调用防轮换及删除重建竞态。 */
    resolveSecretWithRevision(
      principal: ModelPrincipal,
    ): Readonly<{ secret: string; revision: string }> {
      assertMasterKey(masterKey);
      const record = loadRecord(principal);
      if (!record) throw missingRecord();
      return { secret: decrypt(principal, record), revision: record.revision };
    },
    markVerified(
      principal: ModelPrincipal,
      verifiedAt: number,
      expectedRevision?: string,
    ): boolean {
      const record = loadRecord(principal);
      if (!record) {
        if (expectedRevision !== undefined) return false;
        throw missingRecord();
      }
      if (
        expectedRevision !== undefined &&
        record.revision !== expectedRevision
      )
        return false;
      persistRecord(principal, {
        ...record,
        verified: true,
        verifiedAt,
        lastErrorCode: null,
      });
      return true;
    },
    markError(
      principal: ModelPrincipal,
      code: string,
      expectedRevision?: string,
    ): boolean {
      const record = loadRecord(principal);
      if (!record) {
        if (expectedRevision !== undefined) return false;
        throw missingRecord();
      }
      if (
        expectedRevision !== undefined &&
        record.revision !== expectedRevision
      )
        return false;
      persistRecord(principal, {
        ...record,
        verified: false,
        lastErrorCode: code,
      });
      return true;
    },
    delete(principal: ModelPrincipal): void {
      persistRecord(principal, undefined);
    },
  };
}

export type PersonalModelStore = ReturnType<typeof createPersonalModelStore>;
