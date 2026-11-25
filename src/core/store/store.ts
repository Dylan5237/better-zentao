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
import { execSql, queryOne, toStoreError } from "./sqlite-support.ts";
import type { AppliedMigration } from "./types.ts";

export interface OpenStoreOptions {
  readonly baseUrl: string;
  readonly account: string;
  readonly clock: Clock;
  readonly homeDir?: string;
  readonly dbPath?: string;
}

const foreignKeysRow = z.object({ foreign_keys: z.number().int() });
const memoryPath = ":memory:";
const busyTimeoutMs = 5_000;

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

  public close(): void {
    if (this.closed) return;
    this.closed = true;
    this.database.close();
  }
}

function openDatabase(dbPath: string): DatabaseSync {
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
  const location = resolveStoreLocation(options);
  ensureDirectory(location.dbPath);
  const database = openDatabase(location.dbPath);

  try {
    enableForeignKeys(database);
    applyMigrations(database, options.clock);
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
