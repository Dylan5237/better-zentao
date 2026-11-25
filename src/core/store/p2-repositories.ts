import type { DatabaseSync } from "node:sqlite";
import { z } from "zod";
import { execSql, execute, queryAll, queryOne } from "./sqlite-support.ts";
import type {
  NotificationRecord,
  RescheduleInput,
  RescheduleRecord,
  SnapshotItemInput,
  SnapshotRecord,
  SnapshotWithItems,
  StageRequirementRecord,
  WaiverInput,
  WaiverKey,
  WaiverRecord,
} from "./types.ts";

const stageRequirementsSelect = `
  SELECT story_id AS storyId, stage, required, waiver_reason AS waiverReason,
         decided_by AS decidedBy, decided_at AS decidedAt
  FROM stage_requirements`;
const stageRequirementRow = z.object({
  storyId: z.number().int(),
  stage: z.string(),
  required: z
    .union([z.literal(0), z.literal(1)])
    .transform((value) => value === 1),
  waiverReason: z.string().nullable(),
  decidedBy: z.string(),
  decidedAt: z.number().int(),
});

const waiversSelect = `
  SELECT rule_id AS ruleId, object_type AS objectType, object_id AS objectId,
         reason, approved_by AS approvedBy, at
  FROM waivers`;
const waiverRow = z.object({
  ruleId: z.string(),
  objectType: z.string(),
  objectId: z.string(),
  reason: z.string(),
  approvedBy: z.string(),
  at: z.number().int(),
});

const snapshotsSelect = `
  SELECT snap_id AS snapId, month, product_id AS productId, taken_at AS takenAt,
         taken_by AS takenBy, source
  FROM snapshots`;
const snapshotRow = z.object({
  snapId: z.string(),
  month: z.string(),
  productId: z.number().int(),
  takenAt: z.number().int(),
  takenBy: z.string(),
  source: z.enum(["local", "imported"]),
});

const snapshotItemRow = z.object({
  snapId: z.string(),
  storyId: z.number().int(),
  planId: z.number().int().nullable(),
  executionId: z.number().int().nullable(),
  progressAtSnap: z.string(),
});

const notificationsSelect = `
  SELECT dedupe_key AS dedupeKey, channel, target, sent_at AS sentAt, state
  FROM notifications`;
const notificationRow = z.object({
  dedupeKey: z.string(),
  channel: z.string(),
  target: z.string(),
  sentAt: z.number().int(),
  state: z.string(),
});

const reschedulesSelect = `
  SELECT id, story_id AS storyId, from_month AS fromMonth, to_month AS toMonth,
         reason, "by", at
  FROM reschedules`;
const rescheduleRow = z.object({
  id: z.number().int(),
  storyId: z.number().int(),
  fromMonth: z.string().nullable(),
  toMonth: z.string(),
  reason: z.string(),
  by: z.string(),
  at: z.number().int(),
});

export class StageRequirementsRepository {
  public constructor(private readonly database: DatabaseSync) {}

  public upsert(record: StageRequirementRecord): void {
    execute(
      this.database,
      `INSERT INTO stage_requirements (
         story_id, stage, required, waiver_reason, decided_by, decided_at
       ) VALUES (?, ?, ?, ?, ?, ?)
       ON CONFLICT (story_id, stage) DO UPDATE SET
         required = excluded.required,
         waiver_reason = excluded.waiver_reason,
         decided_by = excluded.decided_by,
         decided_at = excluded.decided_at`,
      [
        record.storyId,
        record.stage,
        Number(record.required),
        record.waiverReason,
        record.decidedBy,
        record.decidedAt,
      ],
      "写入阶段要求",
    );
  }

  public get(
    storyId: number,
    stage: string,
  ): StageRequirementRecord | undefined {
    return queryOne(
      this.database,
      `${stageRequirementsSelect} WHERE story_id = ? AND stage = ?`,
      [storyId, stage],
      stageRequirementRow,
      "读取阶段要求",
    );
  }

  public listByStory(storyId: number): readonly StageRequirementRecord[] {
    return queryAll(
      this.database,
      `${stageRequirementsSelect} WHERE story_id = ? ORDER BY stage`,
      [storyId],
      stageRequirementRow,
      "读取阶段要求",
    );
  }

  public delete(storyId: number, stage: string): boolean {
    return (
      execute(
        this.database,
        "DELETE FROM stage_requirements WHERE story_id = ? AND stage = ?",
        [storyId, stage],
        "删除阶段要求",
      ) > 0
    );
  }
}

export class WaiversRepository {
  public constructor(private readonly database: DatabaseSync) {}

  public upsert(record: WaiverInput): void {
    execute(
      this.database,
      `INSERT INTO waivers (rule_id, object_type, object_id, reason, approved_by, at)
       VALUES (?, ?, ?, ?, ?, ?)
       ON CONFLICT (rule_id, object_type, object_id) DO UPDATE SET
         reason = excluded.reason,
         approved_by = excluded.approved_by,
         at = excluded.at`,
      [
        record.ruleId,
        record.objectType ?? "story",
        record.objectId,
        record.reason,
        record.approvedBy,
        record.at,
      ],
      "写入豁免",
    );
  }

  public get(key: WaiverKey): WaiverRecord | undefined {
    return queryOne(
      this.database,
      `${waiversSelect} WHERE rule_id = ? AND object_type = ? AND object_id = ?`,
      [key.ruleId, key.objectType, key.objectId],
      waiverRow,
      "读取豁免",
    );
  }

  public listByObject(
    objectType: string,
    objectId: string,
  ): readonly WaiverRecord[] {
    return queryAll(
      this.database,
      `${waiversSelect} WHERE object_type = ? AND object_id = ? ORDER BY rule_id`,
      [objectType, objectId],
      waiverRow,
      "读取豁免",
    );
  }

  public listAll(): readonly WaiverRecord[] {
    return queryAll(
      this.database,
      `${waiversSelect} ORDER BY rule_id, object_type, object_id`,
      [],
      waiverRow,
      "读取豁免",
    );
  }

  public delete(key: WaiverKey): boolean {
    return (
      execute(
        this.database,
        "DELETE FROM waivers WHERE rule_id = ? AND object_type = ? AND object_id = ?",
        [key.ruleId, key.objectType, key.objectId],
        "删除豁免",
      ) > 0
    );
  }
}

export class SnapshotsRepository {
  public constructor(private readonly database: DatabaseSync) {}

  public createSnapshotWithItems(
    snapshot: SnapshotRecord,
    items: readonly SnapshotItemInput[],
  ): void {
    this.transaction(() => {
      execute(
        this.database,
        `INSERT INTO snapshots (snap_id, month, product_id, taken_at, taken_by, source)
         VALUES (?, ?, ?, ?, ?, ?)`,
        [
          snapshot.snapId,
          snapshot.month,
          snapshot.productId,
          snapshot.takenAt,
          snapshot.takenBy,
          snapshot.source,
        ],
        "写入月度快照",
      );
      for (const item of items) {
        execute(
          this.database,
          `INSERT INTO snapshot_items (snap_id, story_id, plan_id, execution_id, progress_at_snap)
           VALUES (?, ?, ?, ?, ?)`,
          [
            snapshot.snapId,
            item.storyId,
            item.planId,
            item.executionId,
            item.progressAtSnap,
          ],
          "写入月度快照明细",
        );
      }
    });
  }

  public getSnapshot(snapId: string): SnapshotWithItems | undefined {
    // 两次查询共用同一读事务，防止其他连接的删除或重建造成明细与快照不一致。
    return this.transaction(() => {
      const snapshot = queryOne(
        this.database,
        `${snapshotsSelect} WHERE snap_id = ?`,
        [snapId],
        snapshotRow,
        "读取月度快照",
      );
      if (!snapshot) return undefined;
      const items = queryAll(
        this.database,
        `SELECT snap_id AS snapId, story_id AS storyId, plan_id AS planId,
                execution_id AS executionId, progress_at_snap AS progressAtSnap
         FROM snapshot_items WHERE snap_id = ? ORDER BY story_id`,
        [snapId],
        snapshotItemRow,
        "读取月度快照明细",
      );
      return { ...snapshot, items };
    });
  }

  public listSnapshotsByMonthAndProduct(
    month: string,
    productId: number,
  ): readonly SnapshotRecord[] {
    return queryAll(
      this.database,
      `${snapshotsSelect} WHERE month = ? AND product_id = ? ORDER BY taken_at DESC, snap_id`,
      [month, productId],
      snapshotRow,
      "读取月度快照列表",
    );
  }

  public deleteSnapshot(snapId: string): boolean {
    return (
      execute(
        this.database,
        "DELETE FROM snapshots WHERE snap_id = ?",
        [snapId],
        "删除月度快照",
      ) > 0
    );
  }

  private transaction<T>(work: () => T): T {
    execSql(this.database, "BEGIN", "开始快照事务");
    try {
      const result = work();
      execSql(this.database, "COMMIT", "提交快照事务");
      return result;
    } catch (error) {
      try {
        execSql(this.database, "ROLLBACK", "回滚快照事务");
      } catch {
        // SQLite 可能已自动回滚，保留最初的报错。
      }
      throw error;
    }
  }
}

export class NotificationsRepository {
  public constructor(private readonly database: DatabaseSync) {}

  /** 同一 dedupeKey 只接受第一次写入。 */
  public recordIfAbsent(record: NotificationRecord): boolean {
    return (
      execute(
        this.database,
        `INSERT INTO notifications (dedupe_key, channel, target, sent_at, state)
         VALUES (?, ?, ?, ?, ?)
         ON CONFLICT (dedupe_key) DO NOTHING`,
        [
          record.dedupeKey,
          record.channel,
          record.target,
          record.sentAt,
          record.state,
        ],
        "记录通知",
      ) > 0
    );
  }

  public get(dedupeKey: string): NotificationRecord | undefined {
    return queryOne(
      this.database,
      `${notificationsSelect} WHERE dedupe_key = ?`,
      [dedupeKey],
      notificationRow,
      "读取通知",
    );
  }

  /** 时间戳为毫秒，区间为 [fromInclusive, toExclusive)。 */
  public listBySentDateRange(
    fromInclusive: number,
    toExclusive: number,
  ): readonly NotificationRecord[] {
    return queryAll(
      this.database,
      `${notificationsSelect} WHERE sent_at >= ? AND sent_at < ? ORDER BY sent_at, dedupe_key`,
      [fromInclusive, toExclusive],
      notificationRow,
      "读取通知列表",
    );
  }
}

export class ReschedulesRepository {
  public constructor(private readonly database: DatabaseSync) {}

  public append(record: RescheduleInput): void {
    execute(
      this.database,
      `INSERT INTO reschedules (story_id, from_month, to_month, reason, "by", at)
       VALUES (?, ?, ?, ?, ?, ?)`,
      [
        record.storyId,
        record.fromMonth,
        record.toMonth,
        record.reason,
        record.by,
        record.at,
      ],
      "追加挪月记录",
    );
  }

  public listByStory(storyId: number): readonly RescheduleRecord[] {
    return queryAll(
      this.database,
      `${reschedulesSelect} WHERE story_id = ? ORDER BY at, id`,
      [storyId],
      rescheduleRow,
      "读取挪月记录",
    );
  }

  /** 按目标月份筛选，范围两端都包含，格式为 YYYY-MM。 */
  public listByMonthRange(
    fromInclusive: string,
    toInclusive: string,
  ): readonly RescheduleRecord[] {
    return queryAll(
      this.database,
      `${reschedulesSelect} WHERE to_month BETWEEN ? AND ? ORDER BY at, id`,
      [fromInclusive, toInclusive],
      rescheduleRow,
      "读取挪月记录",
    );
  }
}
