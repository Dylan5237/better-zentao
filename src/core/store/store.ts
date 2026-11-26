import { mkdirSync } from "node:fs";
import { dirname } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { z } from "zod";
import type { Clock } from "../clock.ts";
import { BztError } from "../errors.ts";
import { resolveStoreLocation } from "./location.ts";
import type { StoreLocation } from "./location.ts";
import { applyMigrations, listAppliedMigrations } from "./migrations.ts";
import {
  CacheRepository,
  IntakeRepository,
  NotificationsRepository,
  OperationStepsRepository,
  OperationsRepository,
  ReschedulesRepository,
  SeenCursorRepository,
  SnapshotsRepository,
  SourceLinkRepository,
  StageRequirementsRepository,
  StoryRoleRepository,
  WaiversRepository,
} from "./repositories.ts";
import { execSql, execute, queryOne, toStoreError } from "./sqlite-support.ts";
import type { AppliedMigration } from "./types.ts";

export interface OpenStoreOptions {
  readonly baseUrl: string;
  readonly account: string;
  readonly clock: Clock;
  readonly homeDir?: string;
  readonly dbPath?: string;
  /** CR-008 §4.4：集中部署启用 WAL，读写连接互不阻塞。 */
  readonly wal?: boolean;
  /** 覆盖默认 5000ms 的锁等待；Server 模式收敛为 1000ms。 */
  readonly busyTimeoutMs?: number;
}

const foreignKeysRow = z.object({ foreign_keys: z.number().int() });
const storeMetaRow = z.object({
  instance_hash: z.string(),
  account: z.string(),
});
const rowCount = z.object({ count: z.number().int() });
const memoryPath = ":memory:";
const defaultBusyTimeoutMs = 5_000;
const busyTimeoutSetting = z.int().positive();

function ownerDenied(): BztError {
  return new BztError(
    "PERMISSION_DENIED",
    "本地状态库所有者与当前账号不一致，拒绝打开。",
  );
}

function ensureDirectory(dbPath: string): void {
  if (dbPath === memoryPath) return;
  try {
    mkdirSync(dirname(dbPath), { recursive: true, mode: 0o700 });
  } catch (error) {
    throw toStoreError("创建状态目录", error);
  }
}

function enableForeignKeys(database: DatabaseSync): void {
  execSql(database, "PRAGMA foreign_keys = ON", "启用外键约束");
  const row = queryOne(
    database,
    "PRAGMA foreign_keys",
    [],
    foreignKeysRow,
    "检查外键约束",
  );
  if (row?.foreign_keys !== 1)
    throw new BztError("INVALID_INPUT", "本地状态库无法启用外键约束。");
}

function enableWal(database: DatabaseSync): void {
  execSql(database, "PRAGMA journal_mode = WAL", "启用 WAL 日志模式");
  execSql(database, "PRAGMA synchronous = NORMAL", "设置 WAL 同步级别");
}

/**
 * CR-008 §4.4（003-store-owner-meta）：打开库时强制校验所有者。
 * 已有记录错配，或 003 之前的单人库包含其他主体的 operations / cache_kv
 * 记录时立即拒绝；既有主体唯一一致（或全空库）时自动补写所有者。
 */
function ensureOwnerMeta(
  database: DatabaseSync,
  location: StoreLocation,
  clock: Clock,
): void {
  const stored = queryOne(
    database,
    "SELECT instance_hash, account FROM store_meta WHERE singleton = 1",
    [],
    storeMetaRow,
    "读取库所有者",
  );
  if (stored) {
    if (
      stored.instance_hash !== location.instanceHash ||
      stored.account !== location.account
    )
      throw ownerDenied();
    return;
  }
  const foreignOperations = queryOne(
    database,
    `SELECT COUNT(*) AS count FROM operations
     WHERE actor <> ?
       OR (CASE WHEN json_valid(plan_json)
           THEN json_extract(plan_json, '$.instanceHash') END) <> ?`,
    [location.account, location.instanceHash],
    rowCount,
    "校验操作回执主体",
  )?.count;
  const foreignCache = queryOne(
    database,
    `SELECT COUNT(*) AS count FROM cache_kv
     WHERE instance_hash <> ? OR account <> ?`,
    [location.instanceHash, location.account],
    rowCount,
    "校验缓存主体",
  )?.count;
  if ((foreignOperations ?? 0) > 0 || (foreignCache ?? 0) > 0)
    throw ownerDenied();
  execute(
    database,
    `INSERT INTO store_meta (singleton, instance_hash, account, created_at)
     VALUES (1, ?, ?, ?)`,
    [location.instanceHash, location.account, clock()],
    "写入库所有者",
  );
}

export class LocalStore {
  public readonly location: StoreLocation;
  public readonly operations: OperationsRepository;
  public readonly operationSteps: OperationStepsRepository;
  public readonly intake: IntakeRepository;
  public readonly sourceLinks: SourceLinkRepository;
  public readonly storyRoles: StoryRoleRepository;
  public readonly seenCursor: SeenCursorRepository;
  public readonly cache: CacheRepository;
  public readonly stageRequirements: StageRequirementsRepository;
  public readonly waivers: WaiversRepository;
  public readonly snapshots: SnapshotsRepository;
  public readonly notifications: NotificationsRepository;
  public readonly reschedules: ReschedulesRepository;

  private readonly database: DatabaseSync;
  private readonly clock: Clock;
  private closed = false;

  /** 调用方应使用 openLocalStore，确保迁移与外键已就绪。 */
  public constructor(
    database: DatabaseSync,
    location: StoreLocation,
    clock: Clock,
  ) {
    this.database = database;
    this.location = location;
    this.clock = clock;
    this.operations = new OperationsRepository(database);
    this.operationSteps = new OperationStepsRepository(database);
    this.intake = new IntakeRepository(database);
    this.sourceLinks = new SourceLinkRepository(database);
    this.storyRoles = new StoryRoleRepository(database);
    this.seenCursor = new SeenCursorRepository(database);
    this.cache = new CacheRepository(
      database,
      clock,
      location.instanceHash,
      location.account,
    );
    this.stageRequirements = new StageRequirementsRepository(database);
    this.waivers = new WaiversRepository(database);
    this.snapshots = new SnapshotsRepository(database);
    this.notifications = new NotificationsRepository(database);
    this.reschedules = new ReschedulesRepository(database);
  }

  /** 幂等迁移入口，返回本次应用的版本数。 */
  public migrate(): number {
    return applyMigrations(this.database, this.clock);
  }

  public appliedMigrations(): AppliedMigration[] {
    return listAppliedMigrations(this.database);
  }

  public get schemaVersion(): number {
    return this.appliedMigrations().at(-1)?.version ?? 0;
  }

  /**
   * CR-008 §4.4：供 prepare 等多表写入使用的单事务原语。
   * BEGIN IMMEDIATE 先取写锁，异常时回滚，保证中间状态不可见。
   */
  public transaction<T>(work: () => T): T {
    execSql(this.database, "BEGIN IMMEDIATE", "开始本地事务");
    try {
      const result = work();
      execSql(this.database, "COMMIT", "提交本地事务");
      return result;
    } catch (error) {
      try {
        execSql(this.database, "ROLLBACK", "回滚本地事务");
      } catch {
        // 事务可能已被 SQLite 自动回滚，保留最初的报错。
      }
      throw error;
    }
  }

  public close(): void {
    if (this.closed) return;
    this.closed = true;
    this.database.close();
  }
}

function openDatabase(dbPath: string, busyTimeoutMs: number): DatabaseSync {
  try {
    return new DatabaseSync(dbPath, {
      // 多个本机进程（CLI/MCP）可能同时使用同一账号库，短暂等待锁而不是立即失败。
      timeout: busyTimeoutMs,
      enableForeignKeyConstraints: true,
    });
  } catch (error) {
    throw toStoreError("打开", error);
  }
}

export function openLocalStore(options: OpenStoreOptions): LocalStore {
  if (options.busyTimeoutMs !== undefined) {
    const parsed = busyTimeoutSetting.safeParse(options.busyTimeoutMs);
    if (!parsed.success)
      throw new BztError("INVALID_INPUT", "锁等待毫秒数必须是正整数。", {
        fields: ["busyTimeoutMs"],
      });
  }
  const location = resolveStoreLocation(options);
  ensureDirectory(location.dbPath);
  const database = openDatabase(
    location.dbPath,
    options.busyTimeoutMs ?? defaultBusyTimeoutMs,
  );

  try {
    enableForeignKeys(database);
    if (options.wal && location.dbPath !== memoryPath) enableWal(database);
    applyMigrations(database, options.clock);
    // 003-store-owner-meta：所有者校验失败立即关闭句柄，不读业务表。
    ensureOwnerMeta(database, location, options.clock);
  } catch (error) {
    try {
      database.close();
    } catch {
      // 打开失败路径上的关闭错误不覆盖原始原因。
    }
    throw error;
  }

  return new LocalStore(database, location, options.clock);
}
