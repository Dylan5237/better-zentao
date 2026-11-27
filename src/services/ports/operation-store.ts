import type { Clock } from "../../core/clock.ts";
import { BztError } from "../../core/errors.ts";
import type {
  OperationRecord,
  OperationStatusPatch,
  OperationStepPatch,
  OperationStepRecord,
} from "../../core/store/index.ts";

/**
 * CR-009 §4.2：操作执行器依赖的窄存储端口。
 * LocalStore（SQLite）与 createInMemoryOperationStore（内存实现）都满足此契约，
 * 上层执行器不再感知 SQLite、文件锁或裸 SQL。
 */
export interface OperationStateStore {
  readonly location: {
    readonly instanceHash: string;
    readonly account: string;
    /** LocalStore 暴露（":memory:" 表示内存库）；内存实现可省略。 */
    readonly dbPath?: string;
  };
  transaction<T>(work: () => T): T;
  readonly operations: {
    insert(record: OperationRecord): void;
    get(opId: string): OperationRecord;
    updateStatus(opId: string, patch: OperationStatusPatch): void;
    listRecent(
      actor: string,
      instanceHash: string,
      limit: number,
    ): readonly string[];
  };
  readonly operationSteps: {
    insert(step: OperationStepRecord): void;
    get(opId: string, seq: number): OperationStepRecord;
    list(opId: string): OperationStepRecord[];
    update(opId: string, seq: number, patch: OperationStepPatch): void;
  };
  readonly cache: {
    delete(key: string): boolean;
    get?(key: string, now?: number): string | undefined;
    set?(key: string, value: string, ttlMs: number): void;
    setPermanent?(key: string, value: string): void;
  };
  /**
   * 补充读模型（角色缓存、来源关系、诉求登记、已读游标）。
   * SQLite LocalStore 全量提供；内存实现提供同语义的最小版本。
   */
  readonly storyRoles: {
    get(storyId: number): {
      storyId: number;
      maintainer: string | null;
      receiver: string | null;
      updatedAt: number;
    };
    upsert(role: {
      storyId: number;
      maintainer: string | null;
      receiver: string | null;
      updatedAt: number;
    }): void;
  };
  readonly sourceLinks: {
    listTo(
      toType: string,
      toId: string,
    ): ReadonlyArray<{
      fromType: string;
      fromId: string;
      relation: string;
    }>;
    listFrom(
      fromType: string,
      fromId: string,
    ): ReadonlyArray<{
      toType: string;
      toId: string;
      relation: string;
    }>;
    find?(key: {
      fromType: string;
      fromId: string;
      toType: string;
      toId: string;
      relation: string;
    }): { origin: string; verifiedAt: number | null } | undefined;
    upsert?(input: {
      fromType: string;
      fromId: string;
      toType: string;
      toId: string;
      relation: string;
      origin: string;
      verifiedAt: number | null;
    }): void;
  };
  readonly intake: {
    list(): ReadonlyArray<{
      intakeId: string;
      feedbackByText: string | null;
      feedbackByAccount: string | null;
      channel: string | null;
      createdBy: string;
      createdAt: number;
      backfilled: boolean;
      actualStartedAt: number | null;
    }>;
    get(intakeId: string): {
      intakeId: string;
      feedbackByText: string | null;
      feedbackByAccount: string | null;
      channel: string | null;
      createdBy: string;
      createdAt: number;
      backfilled: boolean;
      actualStartedAt: number | null;
    };
  };
  readonly seenCursor: {
    get(scope: string): { lastSeenAt: number } | undefined;
    set(scope: string, lastSeenAt: number): void;
  };
  withExclusiveLock<T>(opId: string, work: () => Promise<T>): Promise<T>;
}

interface InMemoryOptions {
  readonly instanceHash: string;
  readonly account: string;
  readonly clock: Clock;
}

function busy(): BztError {
  return new BztError("INVALID_INPUT", "本地操作正在执行，请稍后查询回执。", {
    conflict: true,
  });
}

function notFound(opId: string): BztError {
  return new BztError("NOT_FOUND", "未找到操作回执。", { opId });
}

/** 覆盖 listRecent 的可选 limit（内存版按全部历史过滤，截断由调用方处理）。 */
function clampLimit(limit: number): number {
  return Math.max(0, limit);
}

/**
 * CR-009 PC-03：零 SQLite 的内存操作状态存储，用于 Provider/执行器契约测试。
 * 语义与 LocalStore 对齐：同 opId 并发确认互斥、not_executed 记录可恢复。
 */
export function createInMemoryOperationStore(
  options: InMemoryOptions,
): OperationStateStore {
  const operations = new Map<string, OperationRecord>();
  const steps = new Map<string, OperationStepRecord[]>();
  const cacheKeys = new Set<string>();
  const history: string[] = [];
  const active = new Set<string>();
  const storyRoles = new Map<
    number,
    { maintainer: string | null; receiver: string | null }
  >();
  const sourceLinks: Array<{
    fromType: string;
    fromId: string;
    toType: string;
    toId: string;
    relation: string;
  }> = [];
  const intakes: Array<{
    intakeId: string;
    feedbackByText: string | null;
    feedbackByAccount: string | null;
    channel: string | null;
    createdBy: string;
    createdAt: number;
    backfilled: boolean;
    actualStartedAt: number | null;
  }> = [];
  const seenCursor = new Map<string, number>();

  const assertNotBusy = (opId: string) => {
    if (active.has(opId)) throw busy();
    active.add(opId);
  };
  const release = (opId: string) => {
    active.delete(opId);
  };

  const requireRecord = (opId: string): OperationRecord => {
    const record = operations.get(opId);
    if (!record) throw notFound(opId);
    return record;
  };

  const listSteps = (opId: string): OperationStepRecord[] => {
    const rows = steps.get(opId);
    if (!rows) throw notFound(opId);
    return [...rows].sort((left, right) => left.seq - right.seq);
  };

  const requireStep = (opId: string, seq: number): OperationStepRecord => {
    const row = listSteps(opId).find((entry) => entry.seq === seq);
    if (!row)
      throw new BztError("NOT_FOUND", "未找到操作步骤。", { opId, seq });
    return row;
  };

  return {
    location: {
      instanceHash: options.instanceHash,
      account: options.account,
    },
    transaction(work) {
      // 快照回滚，确保异常时 operations / operationSteps / history 原子一致（PC-03）。
      const savedOperations = new Map(operations);
      const savedSteps = new Map(
        [...steps.entries()].map(([opId, rows]) => [opId, [...rows]]),
      );
      const savedHistory = [...history];
      try {
        return work();
      } catch (error) {
        operations.clear();
        for (const [k, v] of savedOperations) operations.set(k, v);
        steps.clear();
        for (const [k, v] of savedSteps) steps.set(k, v);
        history.length = 0;
        history.push(...savedHistory);
        throw error;
      }
    },
    operations: {
      insert(record) {
        if (operations.has(record.opId))
          throw new BztError("INVALID_INPUT", "本地状态库记录已存在。", {
            action: "写入操作回执",
          });
        operations.set(record.opId, record);
        steps.set(record.opId, []);
        history.unshift(record.opId);
      },
      get: requireRecord,
      updateStatus(opId, patch) {
        const record = requireRecord(opId);
        operations.set(opId, {
          ...record,
          status: patch.status,
          executedAt:
            patch.executedAt === undefined
              ? record.executedAt
              : patch.executedAt,
        });
      },
      listRecent(actor, instanceHash, limit) {
        // 单实例单账号内存存储：planJson 内的 instanceHash 与 location 恒一致。
        void instanceHash;
        return history
          .filter((opId) => {
            const record = operations.get(opId);
            return record !== undefined && record.actor === actor;
          })
          .slice(0, clampLimit(limit));
      },
    },
    operationSteps: {
      insert(step) {
        const rows = steps.get(step.opId);
        if (!rows) throw notFound(step.opId);
        if (rows.some(({ seq }) => seq === step.seq))
          throw new BztError("INVALID_INPUT", "本地状态库记录已存在。", {
            action: "写入操作步骤",
          });
        rows.push(step);
      },
      get: requireStep,
      list: listSteps,
      update(opId, seq, patch) {
        const rows = steps.get(opId);
        if (!rows) throw notFound(opId);
        const index = rows.findIndex((row) => row.seq === seq);
        if (index === -1)
          throw new BztError("NOT_FOUND", "未找到操作步骤。", { opId, seq });
        const row = rows[index];
        if (!row) return;
        rows[index] = {
          ...row,
          state: patch.state,
          zentaoId:
            patch.zentaoId === undefined ? row.zentaoId : patch.zentaoId,
          readbackJson:
            patch.readbackJson === undefined
              ? row.readbackJson
              : patch.readbackJson,
          error: patch.error === undefined ? row.error : patch.error,
        };
      },
    },
    cache: {
      delete(key) {
        const existed = cacheKeys.has(key);
        cacheKeys.delete(key);
        return existed;
      },
    },
    storyRoles: {
      get(storyId) {
        const role = storyRoles.get(storyId);
        if (!role) throw notFound(`story:${storyId}`);
        return { storyId, ...role, updatedAt: 0 };
      },
      upsert(role) {
        storyRoles.set(role.storyId, {
          maintainer: role.maintainer,
          receiver: role.receiver,
        });
      },
    },
    sourceLinks: {
      find(key) {
        const found = sourceLinks.find(
          (link) =>
            link.fromType === key.fromType &&
            link.fromId === key.fromId &&
            link.toType === key.toType &&
            link.toId === key.toId &&
            link.relation === key.relation,
        );
        return found ? { origin: "local", verifiedAt: null } : undefined;
      },
      upsert(input) {
        sourceLinks.push({ ...input });
      },
      listTo(toType, toId) {
        return sourceLinks
          .filter((link) => link.toType === toType && link.toId === toId)
          .map(({ fromType, fromId, relation }) => ({
            fromType,
            fromId,
            relation,
          }));
      },
      listFrom(fromType, fromId) {
        return sourceLinks
          .filter(
            (link) => link.fromType === fromType && link.fromId === fromId,
          )
          .map(({ toType, toId, relation }) => ({
            toType,
            toId,
            relation,
          }));
      },
    },
    intake: {
      list: () => intakes.map((row) => ({ ...row })),
      get(intakeId) {
        const row = intakes.find((entry) => entry.intakeId === intakeId);
        if (!row) throw notFound(intakeId);
        return { ...row };
      },
    },
    seenCursor: {
      get: (scope) => {
        const value = seenCursor.get(scope);
        return value === undefined ? undefined : { lastSeenAt: value };
      },
      set: (scope, lastSeenAt) => {
        seenCursor.set(scope, lastSeenAt);
      },
    },
    async withExclusiveLock(opId, work) {
      assertNotBusy(opId);
      try {
        return await work();
      } finally {
        release(opId);
      }
    },
  };
}
