import type { DatabaseSync } from "node:sqlite";
import { z } from "zod";
import type { Clock } from "../clock.ts";
import { BztError } from "../errors.ts";
import { execute, queryAll, queryOne } from "./sqlite-support.ts";
import type { BindValue } from "./sqlite-support.ts";
import type {
  IntakePatch,
  IntakeRecord,
  OperationRecord,
  OperationStatusPatch,
  OperationStepPatch,
  OperationStepRecord,
  SeenCursorRecord,
  SourceLinkKey,
  SourceLinkRecord,
  StoryRoleRecord,
} from "./types.ts";

const operationRow = z.object({
  op_id: z.string(),
  kind: z.string(),
  actor: z.string(),
  level: z.enum(["W0", "W1", "W2", "W3"]),
  input_hash: z.string(),
  plan_json: z.string(),
  status: z.enum(["confirmed", "partial", "unknown", "not_executed", "failed"]),
  created_at: z.number().int(),
  expires_at: z.number().int().nullable(),
  executed_at: z.number().int().nullable(),
});

const operationStepRow = z.object({
  op_id: z.string(),
  seq: z.number().int(),
  action: z.string(),
  target_type: z.string().nullable(),
  target_id: z.string().nullable(),
  request_digest: z.string().nullable(),
  zentao_id: z.number().int().nullable(),
  readback_json: z.string().nullable(),
  state: z.enum(["done", "skipped", "failed", "unknown", "pending"]),
  error: z.string().nullable(),
});

const intakeRow = z.object({
  intake_id: z.string(),
  raw_text: z.string(),
  feedback_by_text: z.string().nullable(),
  feedback_by_account: z.string().nullable(),
  channel: z.string().nullable(),
  created_by: z.string(),
  created_at: z.number().int(),
  backfilled: z.union([z.literal(0), z.literal(1)]),
  actual_started_at: z.number().int().nullable(),
});

const sourceLinkRow = z.object({
  from_type: z.string(),
  from_id: z.string(),
  to_type: z.string(),
  to_id: z.string(),
  relation: z.enum(["source", "pairs", "derives", "links"]),
  origin: z.enum(["native", "local"]),
  verified_at: z.number().int().nullable(),
});

const storyRoleRow = z.object({
  story_id: z.number().int(),
  maintainer: z.string().nullable(),
  receiver: z.string().nullable(),
  updated_at: z.number().int(),
});

const seenCursorRow = z.object({
  scope: z.string(),
  last_seen_at: z.number().int(),
});

const cacheRow = z.object({
  value: z.string(),
  expires_at: z.number().int(),
});

function toOperation(row: z.infer<typeof operationRow>): OperationRecord {
  return {
    opId: row.op_id,
    kind: row.kind,
    actor: row.actor,
    level: row.level,
    inputHash: row.input_hash,
    planJson: row.plan_json,
    status: row.status,
    createdAt: row.created_at,
    expiresAt: row.expires_at,
    executedAt: row.executed_at,
  };
}

function toOperationStep(
  row: z.infer<typeof operationStepRow>,
): OperationStepRecord {
  return {
    opId: row.op_id,
    seq: row.seq,
    action: row.action,
    targetType: row.target_type,
    targetId: row.target_id,
    requestDigest: row.request_digest,
    zentaoId: row.zentao_id,
    readbackJson: row.readback_json,
    state: row.state,
    error: row.error,
  };
}

function toIntake(row: z.infer<typeof intakeRow>): IntakeRecord {
  return {
    intakeId: row.intake_id,
    rawText: row.raw_text,
    feedbackByText: row.feedback_by_text,
    feedbackByAccount: row.feedback_by_account,
    channel: row.channel,
    createdBy: row.created_by,
    createdAt: row.created_at,
    backfilled: row.backfilled === 1,
    actualStartedAt: row.actual_started_at,
  };
}

function toSourceLink(row: z.infer<typeof sourceLinkRow>): SourceLinkRecord {
  return {
    fromType: row.from_type,
    fromId: row.from_id,
    toType: row.to_type,
    toId: row.to_id,
    relation: row.relation,
    origin: row.origin,
    verifiedAt: row.verified_at,
  };
}

function toStoryRole(row: z.infer<typeof storyRoleRow>): StoryRoleRecord {
  return {
    storyId: row.story_id,
    maintainer: row.maintainer,
    receiver: row.receiver,
    updatedAt: row.updated_at,
  };
}

function toSeenCursor(row: z.infer<typeof seenCursorRow>): SeenCursorRecord {
  return { scope: row.scope, lastSeenAt: row.last_seen_at };
}

function emptyPatchError(): BztError {
  return new BztError("INVALID_INPUT", "没有需要更新的字段。", { fields: [] });
}

export class OperationsRepository {
  public constructor(private readonly database: DatabaseSync) {}

  public insert(record: OperationRecord): void {
    execute(
      this.database,
      `INSERT INTO operations (
        op_id, kind, actor, level, input_hash, plan_json,
        status, created_at, expires_at, executed_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      [
        record.opId,
        record.kind,
        record.actor,
        record.level,
        record.inputHash,
        record.planJson,
        record.status,
        record.createdAt,
        record.expiresAt,
        record.executedAt,
      ],
      "写入操作回执",
    );
  }

  public get(opId: string): OperationRecord {
    const row = queryOne(
      this.database,
      "SELECT * FROM operations WHERE op_id = ?",
      [opId],
      operationRow,
      "读取操作回执",
    );
    if (!row) throw new BztError("NOT_FOUND", "未找到操作回执。", { opId });
    return toOperation(row);
  }

  public updateStatus(opId: string, patch: OperationStatusPatch): void {
    const assignments = ["status = ?"];
    const parameters: BindValue[] = [patch.status];
    if (patch.executedAt !== undefined) {
      assignments.push("executed_at = ?");
      parameters.push(patch.executedAt);
    }
    parameters.push(opId);
    const changes = execute(
      this.database,
      `UPDATE operations SET ${assignments.join(", ")} WHERE op_id = ?`,
      parameters,
      "更新操作回执",
    );
    if (changes === 0)
      throw new BztError("NOT_FOUND", "未找到操作回执。", { opId });
  }

  public delete(opId: string): boolean {
    return (
      execute(
        this.database,
        "DELETE FROM operations WHERE op_id = ?",
        [opId],
        "删除操作回执",
      ) > 0
    );
  }
}

export class OperationStepsRepository {
  public constructor(private readonly database: DatabaseSync) {}

  public insert(step: OperationStepRecord): void {
    execute(
      this.database,
      `INSERT INTO operation_steps (
        op_id, seq, action, target_type, target_id, request_digest,
        zentao_id, readback_json, state, error
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      [
        step.opId,
        step.seq,
        step.action,
        step.targetType,
        step.targetId,
        step.requestDigest,
        step.zentaoId,
        step.readbackJson,
        step.state,
        step.error,
      ],
      "写入操作步骤",
    );
  }

  public get(opId: string, seq: number): OperationStepRecord {
    const row = queryOne(
      this.database,
      "SELECT * FROM operation_steps WHERE op_id = ? AND seq = ?",
      [opId, seq],
      operationStepRow,
      "读取操作步骤",
    );
    if (!row)
      throw new BztError("NOT_FOUND", "未找到操作步骤。", { opId, seq });
    return toOperationStep(row);
  }

  public list(opId: string): OperationStepRecord[] {
    return queryAll(
      this.database,
      "SELECT * FROM operation_steps WHERE op_id = ? ORDER BY seq",
      [opId],
      operationStepRow,
      "读取操作步骤",
    ).map(toOperationStep);
  }

  public update(opId: string, seq: number, patch: OperationStepPatch): void {
    const assignments = ["state = ?"];
    const parameters: BindValue[] = [patch.state];
    if (patch.zentaoId !== undefined) {
      assignments.push("zentao_id = ?");
      parameters.push(patch.zentaoId);
    }
    if (patch.readbackJson !== undefined) {
      assignments.push("readback_json = ?");
      parameters.push(patch.readbackJson);
    }
    if (patch.error !== undefined) {
      assignments.push("error = ?");
      parameters.push(patch.error);
    }
    parameters.push(opId, seq);
    const changes = execute(
      this.database,
      `UPDATE operation_steps SET ${assignments.join(", ")}
       WHERE op_id = ? AND seq = ?`,
      parameters,
      "更新操作步骤",
    );
    if (changes === 0)
      throw new BztError("NOT_FOUND", "未找到操作步骤。", { opId, seq });
  }

  public delete(opId: string, seq: number): boolean {
    return (
      execute(
        this.database,
        "DELETE FROM operation_steps WHERE op_id = ? AND seq = ?",
        [opId, seq],
        "删除操作步骤",
      ) > 0
    );
  }
}

export class IntakeRepository {
  public constructor(private readonly database: DatabaseSync) {}

  public insert(record: IntakeRecord): void {
    execute(
      this.database,
      `INSERT INTO intake (
        intake_id, raw_text, feedback_by_text, feedback_by_account,
        channel, created_by, created_at, backfilled, actual_started_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      [
        record.intakeId,
        record.rawText,
        record.feedbackByText,
        record.feedbackByAccount,
        record.channel,
        record.createdBy,
        record.createdAt,
        record.backfilled ? 1 : 0,
        record.actualStartedAt,
      ],
      "写入原始诉求",
    );
  }

  public get(intakeId: string): IntakeRecord {
    const row = queryOne(
      this.database,
      "SELECT * FROM intake WHERE intake_id = ?",
      [intakeId],
      intakeRow,
      "读取原始诉求",
    );
    if (!row) throw new BztError("NOT_FOUND", "未找到原始诉求。", { intakeId });
    return toIntake(row);
  }

  public list(): IntakeRecord[] {
    return queryAll(
      this.database,
      "SELECT * FROM intake ORDER BY created_at DESC, intake_id DESC",
      [],
      intakeRow,
      "读取原始诉求",
    ).map(toIntake);
  }

  public update(intakeId: string, patch: IntakePatch): void {
    const assignments: string[] = [];
    const parameters: BindValue[] = [];
    if (patch.feedbackByText !== undefined) {
      assignments.push("feedback_by_text = ?");
      parameters.push(patch.feedbackByText);
    }
    if (patch.feedbackByAccount !== undefined) {
      assignments.push("feedback_by_account = ?");
      parameters.push(patch.feedbackByAccount);
    }
    if (patch.channel !== undefined) {
      assignments.push("channel = ?");
      parameters.push(patch.channel);
    }
    if (patch.backfilled !== undefined) {
      assignments.push("backfilled = ?");
      parameters.push(patch.backfilled ? 1 : 0);
    }
    if (patch.actualStartedAt !== undefined) {
      assignments.push("actual_started_at = ?");
      parameters.push(patch.actualStartedAt);
    }
    if (assignments.length === 0) throw emptyPatchError();

    parameters.push(intakeId);
    const changes = execute(
      this.database,
      `UPDATE intake SET ${assignments.join(", ")} WHERE intake_id = ?`,
      parameters,
      "更新原始诉求",
    );
    if (changes === 0)
      throw new BztError("NOT_FOUND", "未找到原始诉求。", { intakeId });
  }

  public delete(intakeId: string): boolean {
    return (
      execute(
        this.database,
        "DELETE FROM intake WHERE intake_id = ?",
        [intakeId],
        "删除原始诉求",
      ) > 0
    );
  }
}

export class SourceLinkRepository {
  public constructor(private readonly database: DatabaseSync) {}

  public upsert(link: SourceLinkRecord): void {
    execute(
      this.database,
      `INSERT INTO source_links (
        from_type, from_id, to_type, to_id, relation, origin, verified_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?)
      ON CONFLICT (from_type, from_id, to_type, to_id, relation)
      DO UPDATE SET origin = excluded.origin,
                    verified_at = excluded.verified_at`,
      [
        link.fromType,
        link.fromId,
        link.toType,
        link.toId,
        link.relation,
        link.origin,
        link.verifiedAt,
      ],
      "写入来源关系",
    );
  }

  public find(key: SourceLinkKey): SourceLinkRecord | undefined {
    const row = queryOne(
      this.database,
      `SELECT * FROM source_links
       WHERE from_type = ? AND from_id = ? AND to_type = ?
         AND to_id = ? AND relation = ?`,
      [key.fromType, key.fromId, key.toType, key.toId, key.relation],
      sourceLinkRow,
      "读取来源关系",
    );
    return row ? toSourceLink(row) : undefined;
  }

  public listFrom(fromType: string, fromId: string): SourceLinkRecord[] {
    return queryAll(
      this.database,
      `SELECT * FROM source_links
       WHERE from_type = ? AND from_id = ? ORDER BY relation, to_type, to_id`,
      [fromType, fromId],
      sourceLinkRow,
      "读取来源关系",
    ).map(toSourceLink);
  }

  public listTo(toType: string, toId: string): SourceLinkRecord[] {
    return queryAll(
      this.database,
      `SELECT * FROM source_links
       WHERE to_type = ? AND to_id = ? ORDER BY relation, from_type, from_id`,
      [toType, toId],
      sourceLinkRow,
      "读取来源关系",
    ).map(toSourceLink);
  }

  public remove(key: SourceLinkKey): boolean {
    return (
      execute(
        this.database,
        `DELETE FROM source_links
         WHERE from_type = ? AND from_id = ? AND to_type = ?
           AND to_id = ? AND relation = ?`,
        [key.fromType, key.fromId, key.toType, key.toId, key.relation],
        "删除来源关系",
      ) > 0
    );
  }
}

export class StoryRoleRepository {
  public constructor(private readonly database: DatabaseSync) {}

  public upsert(role: StoryRoleRecord): void {
    execute(
      this.database,
      `INSERT INTO story_roles (story_id, maintainer, receiver, updated_at)
       VALUES (?, ?, ?, ?)
       ON CONFLICT (story_id) DO UPDATE SET
         maintainer = excluded.maintainer,
         receiver = excluded.receiver,
         updated_at = excluded.updated_at`,
      [role.storyId, role.maintainer, role.receiver, role.updatedAt],
      "写入角色缓存",
    );
  }

  public get(storyId: number): StoryRoleRecord {
    const row = queryOne(
      this.database,
      "SELECT * FROM story_roles WHERE story_id = ?",
      [storyId],
      storyRoleRow,
      "读取角色缓存",
    );
    if (!row) throw new BztError("NOT_FOUND", "未找到角色缓存。", { storyId });
    return toStoryRole(row);
  }

  public delete(storyId: number): boolean {
    return (
      execute(
        this.database,
        "DELETE FROM story_roles WHERE story_id = ?",
        [storyId],
        "删除角色缓存",
      ) > 0
    );
  }
}

export class SeenCursorRepository {
  public constructor(private readonly database: DatabaseSync) {}

  public get(scope: string): SeenCursorRecord | undefined {
    const row = queryOne(
      this.database,
      "SELECT * FROM seen_cursor WHERE scope = ?",
      [scope],
      seenCursorRow,
      "读取游标",
    );
    return row ? toSeenCursor(row) : undefined;
  }

  public set(scope: string, lastSeenAt: number): void {
    execute(
      this.database,
      `INSERT INTO seen_cursor (scope, last_seen_at) VALUES (?, ?)
       ON CONFLICT (scope) DO UPDATE SET last_seen_at = excluded.last_seen_at`,
      [scope, lastSeenAt],
      "写入游标",
    );
  }

  public delete(scope: string): boolean {
    return (
      execute(
        this.database,
        "DELETE FROM seen_cursor WHERE scope = ?",
        [scope],
        "删除游标",
      ) > 0
    );
  }
}

const credentialKey =
  /(?:password|passwd|token|secret|cookie|authorization|credential)/iu;

function assertCacheKey(key: string): void {
  if (!key.trim())
    throw new BztError("INVALID_INPUT", "缓存键不能为空。", {
      fields: ["key"],
    });
  // SEC-01：凭据只来自环境变量或系统凭据库，不进入本地存储。
  if (credentialKey.test(key))
    throw new BztError("INVALID_INPUT", "缓存键不能包含凭据字段。", {
      fields: ["key"],
    });
}

export class CacheRepository {
  public constructor(
    private readonly database: DatabaseSync,
    private readonly clock: Clock,
    private readonly instanceHash: string,
    private readonly account: string,
  ) {}

  /** SEC-04：缓存按实例 + 账号分区，即使误共用 dbPath 也不会串号。 */
  public set(key: string, value: string, ttlMs: number): void {
    assertCacheKey(key);
    if (!Number.isSafeInteger(ttlMs) || ttlMs <= 0)
      throw new BztError("INVALID_INPUT", "缓存有效期必须是正整数毫秒。", {
        fields: ["ttlMs"],
      });
    const expiresAt = this.clock() + ttlMs;
    if (!Number.isSafeInteger(expiresAt))
      throw new BztError("INVALID_INPUT", "缓存有效期超出可表示范围。", {
        fields: ["ttlMs"],
      });
    execute(
      this.database,
      `INSERT INTO cache_kv (instance_hash, account, "key", value, expires_at)
       VALUES (?, ?, ?, ?, ?)
       ON CONFLICT (instance_hash, account, "key") DO UPDATE SET
         value = excluded.value,
         expires_at = excluded.expires_at`,
      [this.instanceHash, this.account, key, value, expiresAt],
      "写入缓存",
    );
  }

  /** 到期即失效：expires_at <= now 视为已过期并从库中清理。 */
  public get(key: string, now: number = this.clock()): string | undefined {
    assertCacheKey(key);
    const row = queryOne(
      this.database,
      `SELECT value, expires_at FROM cache_kv
       WHERE instance_hash = ? AND account = ? AND "key" = ?`,
      [this.instanceHash, this.account, key],
      cacheRow,
      "读取缓存",
    );
    if (!row) return undefined;
    if (row.expires_at <= now) {
      this.delete(key);
      return undefined;
    }
    return row.value;
  }

  public delete(key: string): boolean {
    assertCacheKey(key);
    return (
      execute(
        this.database,
        `DELETE FROM cache_kv
         WHERE instance_hash = ? AND account = ? AND "key" = ?`,
        [this.instanceHash, this.account, key],
        "删除缓存",
      ) > 0
    );
  }

  public pruneExpired(now: number = this.clock()): number {
    return execute(
      this.database,
      `DELETE FROM cache_kv
       WHERE instance_hash = ? AND account = ? AND expires_at <= ?`,
      [this.instanceHash, this.account, now],
      "清理过期缓存",
    );
  }
}
