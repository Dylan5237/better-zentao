/** 05 §5.3 的写入五态；用于操作回执。 */
export type OperationStatus =
  "confirmed" | "partial" | "unknown" | "not_executed" | "failed";

/** 07 §2.3 OperationResult.steps[].state。 */
export type OperationStepState =
  "done" | "skipped" | "failed" | "unknown" | "pending";

/** 05 §5.2 的授权级别由服务端判定后落库。 */
export type OperationLevel = "W0" | "W1" | "W2" | "W3";

/** 05 §6 source_links.relation。 */
export type SourceRelation = "source" | "pairs" | "derives" | "links";

/** 05 §6 source_links.origin：禅道原生关系或只在本地记录。 */
export type SourceOrigin = "native" | "local";

export interface OperationRecord {
  readonly opId: string;
  readonly kind: string;
  readonly actor: string;
  readonly level: OperationLevel;
  readonly inputHash: string;
  readonly planJson: string;
  readonly status: OperationStatus;
  readonly createdAt: number;
  readonly expiresAt: number | null;
  readonly executedAt: number | null;
}

export interface OperationStatusPatch {
  readonly status: OperationStatus;
  /** 不传表示保持原值；传 null 表示明确清空。 */
  readonly executedAt?: number | null;
}

export interface OperationStepRecord {
  readonly opId: string;
  readonly seq: number;
  readonly action: string;
  readonly targetType: string | null;
  readonly targetId: string | null;
  readonly requestDigest: string | null;
  readonly zentaoId: number | null;
  readonly readbackJson: string | null;
  readonly state: OperationStepState;
  readonly error: string | null;
}

export interface OperationStepPatch {
  readonly state: OperationStepState;
  readonly zentaoId?: number | null;
  readonly readbackJson?: string | null;
  readonly error?: string | null;
}

export interface IntakeRecord {
  readonly intakeId: string;
  readonly rawText: string;
  readonly feedbackByText: string | null;
  readonly feedbackByAccount: string | null;
  readonly channel: string | null;
  readonly createdBy: string;
  readonly createdAt: number;
  readonly backfilled: boolean;
  readonly actualStartedAt: number | null;
}

export interface IntakePatch {
  readonly feedbackByText?: string | null;
  readonly feedbackByAccount?: string | null;
  readonly channel?: string | null;
  readonly backfilled?: boolean;
  readonly actualStartedAt?: number | null;
}

export interface SourceLinkKey {
  readonly fromType: string;
  readonly fromId: string;
  readonly toType: string;
  readonly toId: string;
  readonly relation: SourceRelation;
}

export interface SourceLinkRecord extends SourceLinkKey {
  readonly origin: SourceOrigin;
  readonly verifiedAt: number | null;
}

export interface StoryRoleRecord {
  readonly storyId: number;
  readonly maintainer: string | null;
  readonly receiver: string | null;
  readonly updatedAt: number;
}

export interface SeenCursorRecord {
  readonly scope: string;
  readonly lastSeenAt: number;
}

export interface AppliedMigration {
  readonly version: number;
  readonly name: string;
  readonly appliedAt: number;
}
