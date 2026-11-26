import { BztError } from "../core/errors.ts";

/** CR-008 §4.4：写协调器目标的规范键。 */
export interface WriteTarget {
  readonly type: string;
  readonly id: number | string;
}

interface CoordinatorOptions {
  /** 单一目标最多同时进入临界区的写入数；默认 1（串行）。 */
  readonly perTargetSlots?: number;
}

type TargetKey = string;

const keyOf = (instanceHash: string, target: WriteTarget): TargetKey =>
  `${instanceHash}\n${target.type}\n${String(target.id)}`;

/**
 * CR-008 §4.4：进程级目标写协调器（F-08）。
 * 对同一 (instanceHash, targetType, targetId) 串行化「checkTargets → write → readback」；
 * 多目标按规范键字典序加锁防死锁。仅为单进程协调，不是禅道全局锁：
 * 外部并发仍依赖 checkTargets 乐观指纹校验与写后回读。
 */
export function createTargetWriteCoordinator(options: CoordinatorOptions = {}) {
  const slots = options.perTargetSlots ?? 1;
  if (!Number.isSafeInteger(slots) || slots < 1)
    throw new BztError("INVALID_INPUT", "每目标写槽位数必须是正整数。");
  const inFlight = new Map<TargetKey, number>();
  const queued = new Map<TargetKey, Array<() => void>>();

  function canonicalKeys(
    instanceHash: string,
    targets: readonly WriteTarget[],
  ): TargetKey[] {
    const unique = new Map<TargetKey, WriteTarget>();
    for (const target of targets)
      unique.set(keyOf(instanceHash, target), target);
    return [...unique.keys()].sort();
  }

  async function withTargets<T>(
    instanceHash: string,
    targets: readonly WriteTarget[],
    fn: () => Promise<T>,
  ): Promise<T> {
    const keys = canonicalKeys(instanceHash, targets);
    const acquired: TargetKey[] = [];
    try {
      for (const key of keys) await acquire(key);
      acquired.push(...keys);
      return await fn();
    } finally {
      for (const key of acquired.reverse()) release(key);
    }
  }

  function acquire(key: TargetKey): Promise<void> {
    const used = inFlight.get(key) ?? 0;
    if (used < slots) {
      inFlight.set(key, used + 1);
      return Promise.resolve();
    }
    return new Promise<void>((resolve) => {
      const waiters = queued.get(key) ?? [];
      waiters.push(resolve);
      queued.set(key, waiters);
    });
  }

  function release(key: TargetKey): void {
    const used = inFlight.get(key);
    if (used === undefined) return;
    const next = queued.get(key)?.shift();
    if (next) {
      next();
      return;
    }
    if (used <= 1) inFlight.delete(key);
    else inFlight.set(key, used - 1);
  }

  return { withTargets };
}

export type TargetWriteCoordinator = ReturnType<
  typeof createTargetWriteCoordinator
>;
