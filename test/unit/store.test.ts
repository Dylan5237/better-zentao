import { createHash } from "node:crypto";
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, relative, sep } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { BztError } from "../../src/core/errors.ts";
import {
  checkSqlite,
  instanceHashOf,
  openLocalStore,
  resolveStoreLocation,
  sanitizeAccount,
} from "../../src/core/store/index.ts";
import type {
  IntakeRecord,
  LocalStore,
  OperationRecord,
  OperationStepRecord,
  SourceLinkRecord,
  StoryRoleRecord,
} from "../../src/core/store/index.ts";

const BASE_URL = "https://zentao.example.test/zentao";
const ACCOUNT = "alice";
const START = 1_700_000_000_000;

interface TestClock {
  readonly now: () => number;
  readonly set: (value: number) => void;
  readonly advance: (milliseconds: number) => void;
}

function testClock(start = START): TestClock {
  let current = start;
  return {
    now: () => current,
    set: (value) => {
      current = value;
    },
    advance: (milliseconds) => {
      current += milliseconds;
    },
  };
}

let homeDir: string;
let stores: LocalStore[];

beforeEach(() => {
  homeDir = mkdtempSync(join(tmpdir(), "bzt-store-"));
  stores = [];
});

afterEach(() => {
  for (const store of stores.splice(0)) store.close();
  rmSync(homeDir, { recursive: true, force: true });
});

interface TestOpenOptions {
  readonly baseUrl?: string;
  readonly account?: string;
  readonly homeDir?: string;
  readonly dbPath?: string;
}

function open(options: TestOpenOptions = {}, clock = testClock()) {
  const store = openLocalStore({
    baseUrl: options.baseUrl ?? BASE_URL,
    account: options.account ?? ACCOUNT,
    clock: clock.now,
    homeDir: options.homeDir ?? homeDir,
    ...(options.dbPath === undefined ? {} : { dbPath: options.dbPath }),
  });
  stores.push(store);
  return { store, clock };
}

function captureError(operation: () => unknown): BztError {
  try {
    operation();
  } catch (error) {
    if (error instanceof BztError) return error;
    throw error;
  }
  throw new Error("预期抛出 BztError，但调用成功。");
}

function readDatabase<T>(
  dbPath: string,
  inspect: (database: DatabaseSync) => T,
): T {
  const database = new DatabaseSync(dbPath);
  try {
    return inspect(database);
  } finally {
    database.close();
  }
}

function tableNames(database: DatabaseSync): string[] {
  return database
    .prepare("SELECT name FROM sqlite_master WHERE type = 'table'")
    .all()
    .map((row) => String(row.name));
}

function operation(overrides: Partial<OperationRecord> = {}): OperationRecord {
  return {
    opId: "op-1",
    kind: "story.create",
    actor: "alice",
    level: "W1",
    inputHash: "sha256:input",
    planJson: JSON.stringify({ steps: [] }),
    status: "confirmed",
    createdAt: START,
    expiresAt: null,
    executedAt: START + 1_000,
    ...overrides,
  };
}

function operationStep(
  overrides: Partial<OperationStepRecord> = {},
): OperationStepRecord {
  return {
    opId: "op-1",
    seq: 1,
    action: "create",
    targetType: "story",
    targetId: null,
    requestDigest: "sha256:request",
    zentaoId: 42,
    readbackJson: JSON.stringify({ id: 42 }),
    state: "done",
    error: null,
    ...overrides,
  };
}

function intake(overrides: Partial<IntakeRecord> = {}): IntakeRecord {
  return {
    intakeId: "in-1",
    rawText: "运营反馈：加个按部门筛选",
    feedbackByText: "运营小王",
    feedbackByAccount: "acct_fb",
    channel: "wecom",
    createdBy: "alice",
    createdAt: START,
    backfilled: false,
    actualStartedAt: null,
    ...overrides,
  };
}

function sourceLink(
  overrides: Partial<SourceLinkRecord> = {},
): SourceLinkRecord {
  return {
    fromType: "intake",
    fromId: "in-1",
    toType: "story",
    toId: "42",
    relation: "source",
    origin: "native",
    verifiedAt: START,
    ...overrides,
  };
}

function storyRole(overrides: Partial<StoryRoleRecord> = {}): StoryRoleRecord {
  return {
    storyId: 42,
    maintainer: "alice",
    receiver: "bob",
    updatedAt: START,
    ...overrides,
  };
}

describe("WP-10 状态目录与实例隔离", () => {
  it("归一化 baseUrl 生成稳定 SHA-256 实例哈希", () => {
    const expected = createHash("sha256")
      .update(new URL("https://zentao.example.test/zentao/").href)
      .digest("hex");

    expect(instanceHashOf(BASE_URL)).toBe(expected);
    expect(instanceHashOf(`${BASE_URL}/`)).toBe(expected);
    expect(instanceHashOf("https://ZENTAO.example.test/zentao")).toBe(expected);
    expect(instanceHashOf("https://other.example.test/zentao")).not.toBe(
      expected,
    );
  });

  it("拒绝非法基础地址与空账号", () => {
    for (const baseUrl of [
      "",
      "zentao.example.test",
      "https://user:pass@zentao.example.test/zentao",
      "https://zentao.example.test/zentao?x=1",
      "https://zentao.example.test/api.php",
    ])
      expect(captureError(() => instanceHashOf(baseUrl)).code).toBe(
        "INVALID_INPUT",
      );

    expect(
      captureError(() =>
        resolveStoreLocation({ baseUrl: BASE_URL, account: "   ", homeDir }),
      ).code,
    ).toBe("INVALID_INPUT");
    expect(
      captureError(() =>
        resolveStoreLocation({
          baseUrl: BASE_URL,
          account: ACCOUNT,
          homeDir: " ",
        }),
      ).code,
    ).toBe("CONFIG_MISSING");
  });

  it("账号清洗后只含安全字符且不会互相碰撞", () => {
    const traversal = sanitizeAccount("../../etc/passwd");
    expect(traversal).not.toContain("/");
    expect(traversal).not.toContain("\\");
    expect(traversal).not.toContain("..");
    expect(traversal).toMatch(/^[A-Za-z0-9._-]+$/u);

    expect(sanitizeAccount("a/b")).not.toBe(sanitizeAccount("a\\b"));
    expect(sanitizeAccount("a b")).not.toBe(sanitizeAccount("a_b"));
    expect(sanitizeAccount("  alice  ")).toBe(sanitizeAccount("alice"));
    expect(captureError(() => sanitizeAccount("   ")).code).toBe(
      "INVALID_INPUT",
    );
  });

  it("默认路径按 .better-zentao/<instanceHash>/<account>/state.db 分层", () => {
    const location = resolveStoreLocation({
      baseUrl: BASE_URL,
      account: ACCOUNT,
      homeDir,
    });

    expect(location.instanceHash).toMatch(/^[0-9a-f]{64}$/u);
    expect(location.account).toBe(ACCOUNT);
    expect(location.accountKey).toBe(sanitizeAccount(ACCOUNT));
    expect(relative(homeDir, location.dbPath).split(sep)).toEqual([
      ".better-zentao",
      location.instanceHash,
      location.accountKey,
      "state.db",
    ]);
  });

  it("清洗后的路径不会逃出 homeDir", () => {
    const location = resolveStoreLocation({
      baseUrl: BASE_URL,
      account: "../../etc/passwd",
      homeDir,
    });
    expect(relative(homeDir, location.dbPath).startsWith("..")).toBe(false);
  });

  it("支持自定义 dbPath 与 :memory:", () => {
    const customPath = join(homeDir, "nested", "state.db");
    const custom = resolveStoreLocation({
      baseUrl: BASE_URL,
      account: ACCOUNT,
      dbPath: customPath,
    });
    expect(custom.dbPath).toBe(customPath);
    expect(
      resolveStoreLocation({
        baseUrl: BASE_URL,
        account: ACCOUNT,
        dbPath: ":memory:",
      }).dbPath,
    ).toBe(":memory:");
    expect(
      captureError(() =>
        resolveStoreLocation({
          baseUrl: BASE_URL,
          account: ACCOUNT,
          dbPath: "   ",
        }),
      ).code,
    ).toBe("INVALID_INPUT");
  });

  it("不同实例与账号落到不同文件且不串数据", () => {
    const clock = testClock();
    const alice = openLocalStore({
      baseUrl: BASE_URL,
      account: "alice",
      clock: clock.now,
      homeDir,
    });
    const bob = openLocalStore({
      baseUrl: BASE_URL,
      account: "bob",
      clock: clock.now,
      homeDir,
    });
    const other = openLocalStore({
      baseUrl: "https://other.example.test/zentao",
      account: "alice",
      clock: clock.now,
      homeDir,
    });
    stores.push(alice, bob, other);

    expect(
      new Set([
        alice.location.dbPath,
        bob.location.dbPath,
        other.location.dbPath,
      ]).size,
    ).toBe(3);

    alice.operations.insert(operation({ opId: "alice-op" }));
    for (const store of [bob, other])
      expect(captureError(() => store.operations.get("alice-op")).code).toBe(
        "NOT_FOUND",
      );
  });

  it("自定义 dbPath 持久化，:memory: 不跨连接共享", () => {
    const customPath = join(homeDir, "nested", "state.db");
    const custom = open({ dbPath: customPath });
    expect(custom.store.location.dbPath).toBe(customPath);
    expect(existsSync(customPath)).toBe(true);

    const memory = openLocalStore({
      baseUrl: BASE_URL,
      account: ACCOUNT,
      clock: testClock().now,
      dbPath: ":memory:",
    });
    stores.push(memory);
    memory.operations.insert(operation());
    expect(memory.operations.get("op-1").opId).toBe("op-1");
    memory.close();

    const second = openLocalStore({
      baseUrl: BASE_URL,
      account: ACCOUNT,
      clock: testClock().now,
      dbPath: ":memory:",
    });
    stores.push(second);
    expect(captureError(() => second.operations.get("op-1")).code).toBe(
      "NOT_FOUND",
    );
  });
});

describe("WP-10 迁移", () => {
  it("保留 checkSqlite 导出", async () => {
    await expect(checkSqlite()).resolves.toMatch(/^\d+\.\d+\.\d+/u);
  });

  it("首次打开创建 7 张业务表与迁移记录", () => {
    const { store } = open();
    expect(store.schemaVersion).toBe(1);
    expect(store.appliedMigrations()).toEqual([
      { version: 1, name: "001-p1-tables", appliedAt: START },
    ]);

    const { dbPath } = store.location;
    store.close();
    readDatabase(dbPath, (database) => {
      expect(tableNames(database)).toEqual(
        expect.arrayContaining([
          "operations",
          "operation_steps",
          "intake",
          "source_links",
          "story_roles",
          "seen_cursor",
          "cache_kv",
          "schema_migrations",
        ]),
      );
    });
  });

  it("迁移可重复执行且不覆盖 applied_at", () => {
    const first = open({}, testClock());
    expect(first.store.migrate()).toBe(0);
    const applied = first.store.appliedMigrations();
    expect(applied).toHaveLength(1);
    const appliedAt = applied.at(-1)?.appliedAt;
    first.store.close();

    const second = open({}, testClock(START + 60_000));
    expect(second.store.schemaVersion).toBe(1);
    expect(second.store.appliedMigrations()).toHaveLength(1);
    expect(second.store.appliedMigrations().at(-1)?.appliedAt).toBe(appliedAt);
    expect(second.store.migrate()).toBe(0);
  });

  it("拒绝高于当前程序的迁移版本", () => {
    const { store } = open();
    const { dbPath } = store.location;
    store.close();
    readDatabase(dbPath, (database) => {
      database
        .prepare(
          "INSERT INTO schema_migrations (version, name, applied_at) VALUES (?, ?, ?)",
        )
        .run(99, "future", 0);
    });

    const error = captureError(() =>
      openLocalStore({
        baseUrl: BASE_URL,
        account: ACCOUNT,
        clock: testClock().now,
        homeDir,
      }),
    );
    expect(error.code).toBe("INVALID_INPUT");
    expect(error.message).toContain("版本高于");
  });

  it("拒绝被篡改的迁移记录", () => {
    const { store } = open();
    const { dbPath } = store.location;
    store.close();
    readDatabase(dbPath, (database) => {
      database
        .prepare("UPDATE schema_migrations SET name = ? WHERE version = 1")
        .run("tampered");
    });

    const error = captureError(() =>
      openLocalStore({
        baseUrl: BASE_URL,
        account: ACCOUNT,
        clock: testClock().now,
        homeDir,
      }),
    );
    expect(error.code).toBe("INVALID_INPUT");
    expect(error.message).toContain("迁移记录");
  });

  it("损坏的数据库文件以 BztError 报错", () => {
    const dbPath = join(homeDir, "broken", "state.db");
    mkdirSync(dirname(dbPath), { recursive: true });
    writeFileSync(dbPath, "not a sqlite database", "utf8");

    const error = captureError(() =>
      openLocalStore({
        baseUrl: BASE_URL,
        account: ACCOUNT,
        clock: testClock().now,
        dbPath,
      }),
    );
    expect(error.code).toBe("INVALID_INPUT");
    expect(error.message).toContain("本地状态库");
  });
});

describe("WP-10 operations 与 operation_steps", () => {
  it("operations 读写往返并保留可空时间", () => {
    const { store } = open();
    const record = operation();
    store.operations.insert(record);
    expect(store.operations.get("op-1")).toEqual(record);

    const partial = operation({
      opId: "op-2",
      status: "partial",
      expiresAt: START + 600_000,
      executedAt: null,
    });
    store.operations.insert(partial);
    expect(store.operations.get("op-2")).toEqual(partial);
  });

  it("operations 主键、枚举与更新时间约束", () => {
    const { store } = open();
    store.operations.insert(operation());

    expect(captureError(() => store.operations.insert(operation())).code).toBe(
      "INVALID_INPUT",
    );
    expect(
      captureError(() =>
        store.operations.insert({
          ...operation({ opId: "bad-level" }),
          level: "W9" as unknown as OperationRecord["level"],
        }),
      ).code,
    ).toBe("INVALID_INPUT");
    expect(
      captureError(() =>
        store.operations.insert({
          ...operation({ opId: "bad-status" }),
          status: "pending" as unknown as OperationRecord["status"],
        }),
      ).code,
    ).toBe("INVALID_INPUT");

    store.operations.updateStatus("op-1", {
      status: "failed",
      executedAt: START + 5,
    });
    expect(store.operations.get("op-1")).toMatchObject({
      status: "failed",
      executedAt: START + 5,
    });
    store.operations.updateStatus("op-1", { status: "confirmed" });
    expect(store.operations.get("op-1").executedAt).toBe(START + 5);
    expect(
      captureError(() =>
        store.operations.updateStatus("missing", { status: "failed" }),
      ).code,
    ).toBe("NOT_FOUND");

    expect(store.operations.delete("op-1")).toBe(true);
    expect(store.operations.delete("op-1")).toBe(false);
    expect(captureError(() => store.operations.get("op-1")).code).toBe(
      "NOT_FOUND",
    );
  });

  it("operation_steps 顺序、约束、更新与级联删除", () => {
    const { store } = open();
    store.operations.insert(operation());
    store.operationSteps.insert(operationStep({ seq: 2, action: "assign" }));
    store.operationSteps.insert(operationStep({ seq: 1, action: "create" }));

    expect(store.operationSteps.list("op-1").map((step) => step.seq)).toEqual([
      1, 2,
    ]);
    expect(store.operationSteps.get("op-1", 1).action).toBe("create");
    expect(
      captureError(() => store.operationSteps.insert(operationStep({ seq: 1 })))
        .code,
    ).toBe("INVALID_INPUT");
    expect(
      captureError(() =>
        store.operationSteps.insert(
          operationStep({
            seq: 3,
            state: "confirmed" as unknown as OperationStepRecord["state"],
          }),
        ),
      ).code,
    ).toBe("INVALID_INPUT");
    expect(
      captureError(() =>
        store.operationSteps.insert(operationStep({ opId: "missing", seq: 1 })),
      ).code,
    ).toBe("INVALID_INPUT");
    expect(captureError(() => store.operationSteps.get("op-1", 99)).code).toBe(
      "NOT_FOUND",
    );

    store.operationSteps.update("op-1", 1, {
      state: "unknown",
      zentaoId: null,
      error: "超时",
    });
    expect(store.operationSteps.get("op-1", 1)).toMatchObject({
      state: "unknown",
      zentaoId: null,
      error: "超时",
    });
    expect(
      captureError(() =>
        store.operationSteps.update("op-1", 99, { state: "failed" }),
      ).code,
    ).toBe("NOT_FOUND");

    expect(store.operationSteps.delete("op-1", 2)).toBe(true);
    expect(store.operationSteps.delete("op-1", 2)).toBe(false);

    expect(store.operations.delete("op-1")).toBe(true);
    expect(store.operationSteps.list("op-1")).toEqual([]);
  });
});

describe("WP-10 intake", () => {
  it("intake 往返、更新、列表与删除", () => {
    const { store } = open();
    const record = intake();
    store.intake.insert(record);
    expect(store.intake.get("in-1")).toEqual(record);

    store.intake.update("in-1", {
      backfilled: true,
      actualStartedAt: START + 1_000,
      channel: "manual",
    });
    expect(store.intake.get("in-1")).toMatchObject({
      rawText: record.rawText,
      backfilled: true,
      actualStartedAt: START + 1_000,
      channel: "manual",
    });
    store.intake.update("in-1", { feedbackByText: null });
    expect(store.intake.get("in-1").feedbackByText).toBeNull();

    expect(captureError(() => store.intake.insert(record)).code).toBe(
      "INVALID_INPUT",
    );
    expect(captureError(() => store.intake.update("in-1", {})).code).toBe(
      "INVALID_INPUT",
    );
    expect(
      captureError(() => store.intake.update("missing", { channel: "manual" }))
        .code,
    ).toBe("NOT_FOUND");

    store.intake.insert(intake({ intakeId: "in-2", createdAt: START + 5 }));
    expect(store.intake.list().map((item) => item.intakeId)).toEqual([
      "in-2",
      "in-1",
    ]);

    expect(store.intake.delete("in-1")).toBe(true);
    expect(store.intake.delete("in-1")).toBe(false);
    expect(captureError(() => store.intake.get("in-1")).code).toBe("NOT_FOUND");
  });
});

describe("WP-10 source_links", () => {
  it("source_links upsert、双向查询、删除与枚举约束", () => {
    const { store } = open();
    const link = sourceLink();
    store.sourceLinks.upsert(link);
    expect(store.sourceLinks.find(link)).toEqual(link);

    const updated = sourceLink({ origin: "local", verifiedAt: START + 9 });
    store.sourceLinks.upsert(updated);
    expect(store.sourceLinks.find(link)).toEqual(updated);

    store.sourceLinks.upsert(
      sourceLink({ relation: "pairs", toId: "43", origin: "local" }),
    );
    expect(store.sourceLinks.listFrom("intake", "in-1")).toHaveLength(2);
    expect(store.sourceLinks.listTo("story", "42")).toHaveLength(1);
    expect(store.sourceLinks.listTo("story", "43")).toHaveLength(1);

    expect(
      captureError(() =>
        store.sourceLinks.upsert(
          sourceLink({
            relation: "bad" as unknown as SourceLinkRecord["relation"],
          }),
        ),
      ).code,
    ).toBe("INVALID_INPUT");
    expect(
      captureError(() =>
        store.sourceLinks.upsert(
          sourceLink({
            origin: "bad" as unknown as SourceLinkRecord["origin"],
          }),
        ),
      ).code,
    ).toBe("INVALID_INPUT");

    expect(store.sourceLinks.remove(link)).toBe(true);
    expect(store.sourceLinks.remove(link)).toBe(false);
    expect(store.sourceLinks.find(link)).toBeUndefined();
  });
});

describe("WP-10 story_roles 与 seen_cursor", () => {
  it("story_roles 以需求 ID 覆盖更新", () => {
    const { store } = open();
    store.storyRoles.upsert(storyRole());
    expect(store.storyRoles.get(42)).toEqual(storyRole());

    const updated = storyRole({
      maintainer: null,
      receiver: "carol",
      updatedAt: START + 10,
    });
    store.storyRoles.upsert(updated);
    expect(store.storyRoles.get(42)).toEqual(updated);

    expect(store.storyRoles.delete(42)).toBe(true);
    expect(store.storyRoles.delete(42)).toBe(false);
    expect(captureError(() => store.storyRoles.get(42)).code).toBe("NOT_FOUND");
  });

  it("seen_cursor 首次为空、set 幂等覆盖并可删除", () => {
    const { store } = open();
    expect(store.seenCursor.get("my-work")).toBeUndefined();

    store.seenCursor.set("my-work", START);
    expect(store.seenCursor.get("my-work")).toEqual({
      scope: "my-work",
      lastSeenAt: START,
    });

    store.seenCursor.set("my-work", START + 20);
    expect(store.seenCursor.get("my-work")?.lastSeenAt).toBe(START + 20);

    expect(store.seenCursor.delete("my-work")).toBe(true);
    expect(store.seenCursor.delete("my-work")).toBe(false);
    expect(store.seenCursor.get("my-work")).toBeUndefined();
  });
});

describe("WP-10 cache_kv", () => {
  it("TTL 到期边界使用注入时钟并清理过期项", () => {
    const clock = testClock();
    const { store } = open({}, clock);
    store.cache.set("directory", "v1", 60_000);

    clock.advance(59_999);
    expect(store.cache.get("directory")).toBe("v1");
    clock.advance(1);
    expect(store.cache.get("directory")).toBeUndefined();
    expect(store.cache.get("directory")).toBeUndefined();
  });

  it("支持显式 now、覆盖写入、删除与批量清理", () => {
    const clock = testClock();
    const { store } = open({}, clock);

    store.cache.set("explicit", "v", 1_000);
    expect(store.cache.get("explicit", START + 999)).toBe("v");
    expect(store.cache.get("explicit", START + 1_000)).toBeUndefined();

    store.cache.set("key", "first", 1_000);
    store.cache.set("key", "second", 2_000);
    expect(store.cache.get("key")).toBe("second");
    expect(store.cache.delete("key")).toBe(true);
    expect(store.cache.delete("key")).toBe(false);

    clock.set(START);
    store.cache.set("short", "a", 1_000);
    store.cache.set("long", "b", 5_000);
    clock.set(START + 1_000);
    expect(store.cache.pruneExpired()).toBe(1);
    expect(store.cache.get("long")).toBe("b");
    clock.set(START + 5_000);
    expect(store.cache.pruneExpired()).toBe(1);
    expect(store.cache.pruneExpired()).toBe(0);
  });

  it("拒绝非法 TTL 与凭据类缓存键", () => {
    const { store } = open();
    for (const ttl of [0, -1, 1.5, Number.NaN, Number.POSITIVE_INFINITY])
      expect(captureError(() => store.cache.set("ttl", "v", ttl)).code).toBe(
        "INVALID_INPUT",
      );

    for (const key of [
      "",
      "   ",
      "access_token",
      "user-password",
      "session-secret",
      "Cookie",
      "authorization-header",
    ])
      expect(captureError(() => store.cache.set(key, "v", 1_000)).code).toBe(
        "INVALID_INPUT",
      );
    expect(captureError(() => store.cache.get("access_token")).code).toBe(
      "INVALID_INPUT",
    );
    expect(captureError(() => store.cache.delete("secret")).code).toBe(
      "INVALID_INPUT",
    );
  });

  it("SEC-04 同一 dbPath 下按实例与账号隔离缓存", () => {
    const sharedPath = join(homeDir, "shared", "state.db");
    const clock = testClock();
    const alice = openLocalStore({
      baseUrl: BASE_URL,
      account: "alice",
      clock: clock.now,
      dbPath: sharedPath,
    });
    const bob = openLocalStore({
      baseUrl: BASE_URL,
      account: "bob",
      clock: clock.now,
      dbPath: sharedPath,
    });
    const other = openLocalStore({
      baseUrl: "https://other.example.test/zentao",
      account: "alice",
      clock: clock.now,
      dbPath: sharedPath,
    });
    stores.push(alice, bob, other);

    alice.cache.set("story:42", "alice-value", 60_000);
    bob.cache.set("story:42", "bob-value", 60_000);
    other.cache.set("story:42", "other-value", 60_000);

    expect(alice.cache.get("story:42")).toBe("alice-value");
    expect(bob.cache.get("story:42")).toBe("bob-value");
    expect(other.cache.get("story:42")).toBe("other-value");

    alice.close();
    bob.close();
    other.close();
    readDatabase(sharedPath, (database) => {
      const rows = database
        .prepare(
          'SELECT instance_hash, account, "key" FROM cache_kv ORDER BY account, instance_hash',
        )
        .all();
      expect(rows).toHaveLength(3);
      const keys = rows.map(
        (row) =>
          `${String(row.instance_hash)}|${String(row.account)}|${String(row.key)}`,
      );
      expect(keys).toContain(`${alice.location.instanceHash}|alice|story:42`);
      expect(keys).toContain(`${bob.location.instanceHash}|bob|story:42`);
      expect(keys).toContain(`${other.location.instanceHash}|alice|story:42`);
    });
  });

  it("SEC-01 表结构不包含凭据字段", () => {
    const { store } = open();
    const { dbPath } = store.location;
    store.close();
    const forbidden =
      /password|passwd|token|secret|cookie|authorization|credential/iu;
    readDatabase(dbPath, (database) => {
      for (const table of tableNames(database)) {
        const columns = database
          .prepare(`PRAGMA table_info("${table}")`)
          .all()
          .map((row) => String(row.name));
        for (const column of columns)
          expect(forbidden.test(column)).toBe(false);
      }
    });
  });
});

describe("WP-10 文件持久化与关闭", () => {
  it("关闭后重新打开保留 7 张表的数据", () => {
    const clock = testClock();
    const first = openLocalStore({
      baseUrl: BASE_URL,
      account: ACCOUNT,
      clock: clock.now,
      homeDir,
    });
    stores.push(first);

    first.operations.insert(operation());
    first.operationSteps.insert(operationStep());
    first.intake.insert(intake());
    first.sourceLinks.upsert(sourceLink());
    first.storyRoles.upsert(storyRole());
    first.seenCursor.set("my-work", START);
    first.cache.set("directory", JSON.stringify({ items: [] }), 60_000);

    const { dbPath } = first.location;
    first.close();
    expect(existsSync(dbPath)).toBe(true);

    const second = openLocalStore({
      baseUrl: BASE_URL,
      account: ACCOUNT,
      clock: clock.now,
      homeDir,
    });
    stores.push(second);

    expect(second.location.dbPath).toBe(dbPath);
    expect(second.operations.get("op-1")).toEqual(operation());
    expect(second.operationSteps.list("op-1")).toEqual([operationStep()]);
    expect(second.intake.get("in-1")).toEqual(intake());
    expect(second.sourceLinks.find(sourceLink())).toEqual(sourceLink());
    expect(second.storyRoles.get(42)).toEqual(storyRole());
    expect(second.seenCursor.get("my-work")).toEqual({
      scope: "my-work",
      lastSeenAt: START,
    });
    expect(second.cache.get("directory")).toBe(JSON.stringify({ items: [] }));
    expect(second.appliedMigrations()).toHaveLength(1);
  });

  it("close 幂等，关闭后操作返回 BztError", () => {
    const { store } = open();
    store.close();
    expect(() => store.close()).not.toThrow();
    expect(captureError(() => store.operations.get("missing")).code).toBe(
      "INVALID_INPUT",
    );
  });
});
