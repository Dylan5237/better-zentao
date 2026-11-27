import { z } from "zod";
import { BztError } from "./errors.ts";

export const readRetryDelaysMs = Object.freeze([300, 900]);

const concurrencySetting = z.int().positive();

export interface PartitionedReadPoolOptions {
  readonly perInstanceLimit: number;
  readonly perUserLimit: number;
  readonly authReserve: number;
  readonly maxQueueSize?: number;
}

export interface ReadSlotRequest {
  readonly instanceHash: string;
  readonly account: string;
  readonly priority?: "auth" | undefined;
}

interface PoolSlot {
  readonly resolve: () => void;
  readonly request: ReadSlotRequest;
}

/**
 * CR-008 §4.4：分区读取并发池。
 * 普通读取按「实例 × 用户」双额度限流；认证请求走每实例独立的保留通道，
 * 不受普通额度挤占，避免单实例慢查询饿死登录或其他实例（F-11）。
 */
export function createPartitionedReadPool(options: PartitionedReadPoolOptions) {
  const setting = z
    .strictObject({
      perInstanceLimit: concurrencySetting,
      perUserLimit: concurrencySetting,
      authReserve: concurrencySetting,
      maxQueueSize: concurrencySetting.default(256),
    })
    .safeParse(options);
  if (!setting.success)
    throw new BztError("INVALID_INPUT", "分区读取并发池配置不合法。");

  const { perInstanceLimit, perUserLimit, authReserve, maxQueueSize } =
    setting.data;
  const instanceInFlight = new Map<string, number>();
  const userInFlight = new Map<string, number>();
  const authInFlight = new Map<string, number>();
  const waiting: PoolSlot[] = [];
  const userKeyOf = (request: Readonly<ReadSlotRequest>) =>
    request.instanceHash + "\n" + request.account;

  function hasCapacity(request: Readonly<ReadSlotRequest>): boolean {
    if (request.priority === "auth")
      return (authInFlight.get(request.instanceHash) ?? 0) < authReserve;
    return (
      (instanceInFlight.get(request.instanceHash) ?? 0) < perInstanceLimit &&
      (userInFlight.get(userKeyOf(request)) ?? 0) < perUserLimit
    );
  }

  function acquire(request: Readonly<ReadSlotRequest>): void {
    if (request.priority === "auth") {
      authInFlight.set(
        request.instanceHash,
        (authInFlight.get(request.instanceHash) ?? 0) + 1,
      );
      return;
    }
    instanceInFlight.set(
      request.instanceHash,
      (instanceInFlight.get(request.instanceHash) ?? 0) + 1,
    );
    const userKey = userKeyOf(request);
    userInFlight.set(userKey, (userInFlight.get(userKey) ?? 0) + 1);
  }

  function release(request: Readonly<ReadSlotRequest>): void {
    if (request.priority === "auth") {
      authInFlight.set(
        request.instanceHash,
        Math.max(0, (authInFlight.get(request.instanceHash) ?? 0) - 1),
      );
    } else {
      instanceInFlight.set(
        request.instanceHash,
        Math.max(0, (instanceInFlight.get(request.instanceHash) ?? 0) - 1),
      );
      const userKey = userKeyOf(request);
      userInFlight.set(
        userKey,
        Math.max(0, (userInFlight.get(userKey) ?? 0) - 1),
      );
    }
    grant();
  }

  function grant(): void {
    for (let index = 0; index < waiting.length;) {
      const slot = waiting[index];
      if (!slot) break;
      if (!hasCapacity(slot.request)) {
        index += 1;
        continue;
      }
      waiting.splice(index, 1);
      acquire(slot.request);
      slot.resolve();
    }
  }

  async function withReadSlot<T>(
    request: ReadSlotRequest,
    fn: () => Promise<T>,
  ): Promise<T> {
    if (hasCapacity(request)) {
      acquire(request);
    } else {
      if (waiting.length >= maxQueueSize) {
        throw new BztError(
          "ZENTAO_UNAVAILABLE",
          "上游请求排队已满，请稍后重试。",
        );
      }
      await new Promise<void>((resolve) => {
        waiting.push({ resolve, request });
      });
    }
    try {
      return await fn();
    } finally {
      release(request);
    }
  }

  return { withReadSlot };
}

export type PartitionedReadPool = ReturnType<typeof createPartitionedReadPool>;

let readConcurrency = 8;
let readsInFlight = 0;
const waitingReads: Array<() => void> = [];
const writeTails = new Map<string, Promise<void>>();

function grantReadSlots(): void {
  while (readsInFlight < readConcurrency) {
    const next = waitingReads.shift();
    if (!next) return;
    readsInFlight++;
    next();
  }
}

export function configureReadConcurrency(concurrency: number): void {
  if (!concurrencySetting.safeParse(concurrency).success) {
    throw new BztError("INVALID_INPUT", "http.concurrency 必须是正整数。");
  }
  readConcurrency = concurrency;
  grantReadSlots();
}

export async function withReadSlot<T>(request: () => Promise<T>): Promise<T> {
  await new Promise<void>((resolve) => {
    waitingReads.push(resolve);
    grantReadSlots();
  });
  try {
    return await request();
  } finally {
    readsInFlight--;
    grantReadSlots();
  }
}

export async function withInstanceWriteLock<T>(
  instance: string,
  request: () => Promise<T>,
): Promise<T> {
  const previous = writeTails.get(instance);
  const completion = Promise.withResolvers<void>();
  writeTails.set(instance, completion.promise);
  try {
    await previous;
    return await request();
  } finally {
    completion.resolve();
    if (writeTails.get(instance) === completion.promise)
      writeTails.delete(instance);
  }
}
