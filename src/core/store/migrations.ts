import type { DatabaseSync } from "node:sqlite";
import { z } from "zod";
import type { Clock } from "../clock.ts";
import { BztError } from "../errors.ts";
import { execSql, execute, queryAll, queryOne } from "./sqlite-support.ts";
import type { AppliedMigration } from "./types.ts";

export interface Migration {
  readonly version: number;
  readonly name: string;
  readonly sql: string;
}

const SCHEMA_MIGRATIONS_SQL = `
  CREATE TABLE IF NOT EXISTS schema_migrations (
    version INTEGER PRIMARY KEY,
    name TEXT NOT NULL,
    applied_at INTEGER NOT NULL
  ) STRICT
`;

const P1_TABLES_SQL = `
  CREATE TABLE IF NOT EXISTS operations (
    op_id TEXT PRIMARY KEY,
    kind TEXT NOT NULL,
    actor TEXT NOT NULL,
    level TEXT NOT NULL CHECK (level IN ('W0', 'W1', 'W2', 'W3')),
    input_hash TEXT NOT NULL,
    plan_json TEXT NOT NULL,
    status TEXT NOT NULL CHECK (
      status IN ('confirmed', 'partial', 'unknown', 'not_executed', 'failed')
    ),
    created_at INTEGER NOT NULL,
    expires_at INTEGER,
    executed_at INTEGER
  ) STRICT;

  CREATE TABLE IF NOT EXISTS operation_steps (
    op_id TEXT NOT NULL REFERENCES operations(op_id) ON DELETE CASCADE,
    seq INTEGER NOT NULL CHECK (seq >= 0),
    action TEXT NOT NULL,
    target_type TEXT,
    target_id TEXT,
    request_digest TEXT,
    zentao_id INTEGER,
    readback_json TEXT,
    state TEXT NOT NULL CHECK (
      state IN ('done', 'skipped', 'failed', 'unknown', 'pending')
    ),
    error TEXT,
    PRIMARY KEY (op_id, seq)
  ) STRICT;

  CREATE TABLE IF NOT EXISTS intake (
    intake_id TEXT PRIMARY KEY,
    raw_text TEXT NOT NULL,
    feedback_by_text TEXT,
    feedback_by_account TEXT,
    channel TEXT,
    created_by TEXT NOT NULL,
    created_at INTEGER NOT NULL,
    backfilled INTEGER NOT NULL DEFAULT 0 CHECK (backfilled IN (0, 1)),
    actual_started_at INTEGER
  ) STRICT;

  CREATE TABLE IF NOT EXISTS source_links (
    from_type TEXT NOT NULL,
    from_id TEXT NOT NULL,
    to_type TEXT NOT NULL,
    to_id TEXT NOT NULL,
    relation TEXT NOT NULL CHECK (
      relation IN ('source', 'pairs', 'derives', 'links')
    ),
    origin TEXT NOT NULL CHECK (origin IN ('native', 'local')),
    verified_at INTEGER,
    PRIMARY KEY (from_type, from_id, to_type, to_id, relation)
  ) STRICT;

  CREATE INDEX IF NOT EXISTS source_links_target
    ON source_links (to_type, to_id);

  CREATE TABLE IF NOT EXISTS story_roles (
    story_id INTEGER PRIMARY KEY,
    maintainer TEXT,
    receiver TEXT,
    updated_at INTEGER NOT NULL
  ) STRICT;

  CREATE TABLE IF NOT EXISTS seen_cursor (
    scope TEXT PRIMARY KEY,
    last_seen_at INTEGER NOT NULL
  ) STRICT;

  CREATE TABLE IF NOT EXISTS cache_kv (
    instance_hash TEXT NOT NULL,
    account TEXT NOT NULL,
    "key" TEXT NOT NULL,
    value TEXT NOT NULL,
    expires_at INTEGER NOT NULL,
    PRIMARY KEY (instance_hash, account, "key")
  ) STRICT;

  CREATE INDEX IF NOT EXISTS cache_kv_expires_at ON cache_kv (expires_at);
`;

const P2_TABLES_SQL = `
  CREATE TABLE stage_requirements (
    story_id INTEGER NOT NULL,
    stage TEXT NOT NULL,
    required INTEGER NOT NULL CHECK (required IN (0, 1)),
    waiver_reason TEXT,
    decided_by TEXT NOT NULL,
    decided_at INTEGER NOT NULL,
    PRIMARY KEY (story_id, stage)
  ) STRICT;

  CREATE TABLE waivers (
    rule_id TEXT NOT NULL,
    object_type TEXT NOT NULL DEFAULT 'story',
    object_id TEXT NOT NULL,
    reason TEXT NOT NULL,
    approved_by TEXT NOT NULL,
    at INTEGER NOT NULL,
    PRIMARY KEY (rule_id, object_type, object_id)
  ) STRICT;

  CREATE TABLE snapshots (
    snap_id TEXT PRIMARY KEY,
    month TEXT NOT NULL,
    product_id INTEGER NOT NULL,
    taken_at INTEGER NOT NULL,
    taken_by TEXT NOT NULL,
    source TEXT NOT NULL CHECK (source IN ('local', 'imported'))
  ) STRICT;

  CREATE TABLE snapshot_items (
    snap_id TEXT NOT NULL REFERENCES snapshots(snap_id) ON DELETE CASCADE,
    story_id INTEGER NOT NULL,
    plan_id INTEGER,
    execution_id INTEGER,
    progress_at_snap TEXT NOT NULL,
    PRIMARY KEY (snap_id, story_id)
  ) STRICT;

  CREATE TABLE notifications (
    dedupe_key TEXT PRIMARY KEY,
    channel TEXT NOT NULL,
    target TEXT NOT NULL,
    sent_at INTEGER NOT NULL,
    state TEXT NOT NULL
  ) STRICT;

  CREATE TABLE reschedules (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    story_id INTEGER NOT NULL,
    from_month TEXT,
    to_month TEXT NOT NULL,
    reason TEXT NOT NULL,
    "by" TEXT NOT NULL,
    at INTEGER NOT NULL
  ) STRICT;

  CREATE INDEX reschedules_story_at ON reschedules (story_id, at);
`;

const OWNER_META_SQL = `
  CREATE TABLE store_meta (
    singleton INTEGER PRIMARY KEY CHECK (singleton = 1),
    instance_hash TEXT NOT NULL,
    account TEXT NOT NULL,
    created_at INTEGER NOT NULL
  ) STRICT;
`;

/** 迁移按 version 升序追加；已发布的迁移不得改名或改写。 */
export const MIGRATIONS: readonly Migration[] = [
  { version: 1, name: "001-p1-tables", sql: P1_TABLES_SQL },
  { version: 2, name: "002-p2-tables", sql: P2_TABLES_SQL },
  { version: 3, name: "003-store-owner-meta", sql: OWNER_META_SQL },
];

const appliedRow = z.object({
  version: z.number().int(),
  name: z.string(),
  applied_at: z.number().int(),
});

export function listAppliedMigrations(
  database: DatabaseSync,
): AppliedMigration[] {
  return queryAll(
    database,
    "SELECT version, name, applied_at FROM schema_migrations ORDER BY version",
    [],
    appliedRow,
    "读取迁移记录",
  ).map((row) => ({
    version: row.version,
    name: row.name,
    appliedAt: row.applied_at,
  }));
}

/**
 * 可重复执行的迁移：按 schema_migrations 跳过已应用版本。
 * 每个版本单独事务；并发首启时在 BEGIN IMMEDIATE 后再次确认，避免重复插入。
 */
export function applyMigrations(database: DatabaseSync, clock: Clock): number {
  execSql(database, SCHEMA_MIGRATIONS_SQL, "初始化迁移记录");

  const appliedRows = queryAll(
    database,
    "SELECT version, name, applied_at FROM schema_migrations ORDER BY version",
    [],
    appliedRow,
    "读取迁移记录",
  );
  const knownByVersion = new Map<number, Migration>();
  for (const migration of MIGRATIONS)
    knownByVersion.set(migration.version, migration);
  const maximumKnown = MIGRATIONS.reduce(
    (maximum, migration) => Math.max(maximum, migration.version),
    0,
  );

  for (const row of appliedRows) {
    const known = knownByVersion.get(row.version);
    if (!known) {
      if (row.version > maximumKnown)
        throw new BztError(
          "INVALID_INPUT",
          "本地状态库版本高于当前程序支持。",
          {
            version: row.version,
          },
        );
      throw new BztError("INVALID_INPUT", "本地状态库包含未知迁移记录。", {
        version: row.version,
      });
    }
    if (known.name !== row.name)
      throw new BztError(
        "INVALID_INPUT",
        "本地状态库迁移记录与当前程序不一致。",
        { version: row.version, expected: known.name, actual: row.name },
      );
  }

  const appliedVersions = new Set(appliedRows.map((row) => row.version));
  let count = 0;

  for (const migration of MIGRATIONS) {
    if (appliedVersions.has(migration.version)) continue;

    execSql(database, "BEGIN IMMEDIATE", "开始迁移事务");
    try {
      const existing = queryOne(
        database,
        "SELECT version, name, applied_at FROM schema_migrations WHERE version = ?",
        [migration.version],
        appliedRow,
        "确认迁移记录",
      );
      if (existing) {
        if (existing.name !== migration.name)
          throw new BztError(
            "INVALID_INPUT",
            "本地状态库迁移记录与当前程序不一致。",
            { version: migration.version, expected: migration.name },
          );
        execSql(database, "COMMIT", "提交迁移事务");
        continue;
      }

      execSql(database, migration.sql, `执行迁移 ${migration.version}`);
      execute(
        database,
        "INSERT INTO schema_migrations (version, name, applied_at) VALUES (?, ?, ?)",
        [migration.version, migration.name, clock()],
        `记录迁移 ${migration.version}`,
      );
      execSql(database, "COMMIT", "提交迁移事务");
      count += 1;
    } catch (error) {
      try {
        execSql(database, "ROLLBACK", "回滚迁移事务");
      } catch {
        // 事务已失效时回滚也会失败，保留原始错误更有用。
      }
      throw error;
    }
  }

  return count;
}
