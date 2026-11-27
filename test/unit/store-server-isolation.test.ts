import { createHash } from "node:crypto";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { BztError } from "../../src/core/errors.ts";
import {
  canonicalAccountDir,
  instanceHashOf,
  LocalStore,
  MIGRATIONS,
  openLocalStore,
} from "../../src/core/store/index.ts";

const instanceA = "https://instance-a.example.test/zentao";
const instanceB = "https://instance-b.example.test/zentao";
const accountA = "acct_a";
const accountB = "acct_b";
const now = 1_700_000_000_000;
const clock = () => now;
const cacheKey = "story:101";
const operation = {
  opId: "op_owner_fixture",
  kind: "assign_story",
  actor: accountA,
  level: "W2",
  inputHash: "fixture-digest",
  planJson: JSON.stringify({ instanceHash: instanceHashOf(instanceA) }),
  status: "confirmed",
  createdAt: now,
  expiresAt: null,
  executedAt: now,
} as const;

let folder: string;
let dbPath: string;
const stores: LocalStore[] = [];

beforeEach(() => {
  folder = mkdtempSync(join(tmpdir(), "bzt-server-store-"));
  dbPath = join(folder, "state.db");
});

afterEach(() => {
  for (const store of stores.splice(0).reverse()) store.close();
  rmSync(folder, { recursive: true, force: true });
});

function open(baseUrl = instanceA, account = accountA) {
  const options = {
    baseUrl,
    account,
    clock,
    dbPath,
    wal: true,
    busyTimeoutMs: 1000,
  };
  const store = openLocalStore(options);
  stores.push(store);
  return store;
}

const owner = { instance_hash: instanceHashOf(instanceA), account: accountA };

function readOwners() {
  using db = new DatabaseSync(dbPath, { readOnly: true });
  return db.prepare("SELECT instance_hash, account FROM store_meta").all();
}

function legacyDatabase() {
  const db = new DatabaseSync(dbPath);
  db.exec(`CREATE TABLE schema_migrations (
    version INTEGER PRIMARY KEY, name TEXT NOT NULL, applied_at INTEGER NOT NULL
  ) STRICT`);
  for (const migration of MIGRATIONS.filter(({ version }) => version <= 2)) {
    db.exec(migration.sql);
    db.prepare("INSERT INTO schema_migrations VALUES (?, ?, ?)").run(
      migration.version,
      migration.name,
      now,
    );
  }
  const store = new LocalStore(
    db,
    {
      dbPath,
      instanceHash: owner.instance_hash,
      account: owner.account,
      accountKey: owner.account,
    },
    clock,
  );
  stores.push(store);
  return store;
}

describe("SRV-ISO-02 服务端状态库所有者与目录隔离", () => {
  it("大小写不同的账号键在 Windows 上仍不同", () => {
    expect(canonicalAccountDir("Alice").toLowerCase()).not.toBe(
      canonicalAccountDir("alice").toLowerCase(),
    );
  });

  it.each([
    "Alice",
    "alice",
    "CON",
    "NUL.txt",
    "LPT1.log",
    "a/b",
    "a\\b",
    "../a:<*>? ",
    "用戶",
  ])("目录键安全且使用原始 UTF-8 账号的稳定哈希：%j", (account) => {
    const key = canonicalAccountDir(account);
    const digest = createHash("sha256").update(account, "utf8").digest("hex");
    expect(canonicalAccountDir(account)).toBe(key);
    const suffix = /-([0-9a-f]{16})$/u.exec(key)?.[1];
    expect(suffix).toBe(digest.slice(0, 16));
    expect(key).toMatch(/^[a-z0-9._-]+$/iu);
    expect(key).not.toMatch(/^(?:con|prn|aux|nul|com[1-9]|lpt[1-9])(?:\.|$)/iu);
    expect(key).not.toMatch(/^[.]|[. ]$/u);
  });

  it("显式启用 WAL，提交结果可从另一连接读取", () => {
    open().cache.set(cacheKey, "wal-value", 1000);
    using observer = new DatabaseSync(dbPath, { readOnly: true });
    expect(observer.prepare("PRAGMA journal_mode").get()).toEqual({
      journal_mode: "wal",
    });
    expect(observer.prepare("SELECT value FROM cache_kv").get()).toEqual({
      value: "wal-value",
    });
  });

  it("新库在迁移 003 记录唯一所有者", () => {
    const store = open();
    expect(store.schemaVersion).toBe(3);
    expect(store.appliedMigrations().at(-1)).toMatchObject({
      version: 3,
      name: "003-store-owner-meta",
    });
    expect(readOwners()).toEqual([owner]);
  });

  it.each([
    ["账号", instanceA, accountB],
    ["实例", instanceB, accountA],
  ])(
    "拒绝不同%s打开同一物理库，保留原有业务数据",
    (_scope, baseUrl, account) => {
      const original = open();
      original.operations.insert(operation);
      original.cache.set(cacheKey, "owner-value", 1000);
      original.close();

      expect
        .soft(() => open(baseUrl, account))
        .toThrow(
          expect.objectContaining({
            name: BztError.name,
            code: "PERMISSION_DENIED",
          }),
        );
      const reopened = open();
      expect(reopened.operations.get(operation.opId)).toEqual(operation);
      expect(reopened.cache.get(cacheKey)).toBe("owner-value");
    },
  );

  it.each(["operations", "cache_kv"] as const)(
    "无所有者元数据的历史库包含其他主体 %s 时拒绝打开",
    (table) => {
      const legacy = legacyDatabase();
      if (table === "operations") {
        legacy.operations.insert({ ...operation, actor: accountB });
      } else {
        using writer = new DatabaseSync(dbPath);
        writer
          .prepare("INSERT INTO cache_kv VALUES (?, ?, ?, ?, ?)")
          .run(
            instanceHashOf(instanceB),
            accountA,
            cacheKey,
            "legacy-value",
            now + 1000,
          );
      }
      legacy.close();

      expect(() => open()).toThrow(
        expect.objectContaining({
          name: BztError.name,
          code: "PERMISSION_DENIED",
        }),
      );
    },
  );

  it("同一主体的历史记录可迁移且保留原值", () => {
    const legacy = legacyDatabase();
    legacy.operations.insert(operation);
    legacy.cache.set(cacheKey, "legacy-value", 1000);
    legacy.close();

    const store = open();
    expect(store.operations.get(operation.opId)).toEqual(operation);
    expect(store.cache.get(cacheKey)).toBe("legacy-value");
    expect(readOwners()).toEqual([owner]);
  });
});

describe("SRV-CONC-02 SQLite 缓存过期清理", () => {
  it("使用调用者提供的 now，只清理到期的目标行", () => {
    const { cache } = open();
    cache.set(cacheKey, "at-cutoff", 1000);
    cache.set("story:102", "still-valid", 1001);

    expect(cache.get(cacheKey, now + 999)).toBe("at-cutoff");
    expect(cache.get(cacheKey, now + 1000)).toBeUndefined();

    using observer = new DatabaseSync(dbPath, { readOnly: true });
    expect(
      observer.prepare('SELECT "key", expires_at FROM cache_kv').all(),
    ).toEqual([{ key: "story:102", expires_at: now + 1001 }]);
  });

  it("过期读取与另一连接刷新交错时保留新值", () => {
    const writer = open();
    writer.cache.set(cacheKey, "expired", 1000);
    using connection = new DatabaseSync(dbPath);
    const reader = new LocalStore(connection, writer.location, clock);
    const prepare = connection.prepare.bind(connection);
    let refreshed = false;
    vi.spyOn(connection, "prepare").mockImplementation((sql) => {
      // 让另一连接恰在清理语句执行前提交刷新，避免依赖调度与睡眠。
      if (!refreshed && /DELETE\s+FROM\s+cache_kv\b/iu.test(sql)) {
        writer.cache.set(cacheKey, "refreshed", 2000);
        refreshed = true;
      }
      return prepare(sql);
    });

    reader.cache.get(cacheKey, now + 1000);
    expect(refreshed).toBe(true);
    expect(writer.cache.get(cacheKey, now + 1000)).toBe("refreshed");
  });
});
