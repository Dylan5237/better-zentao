import { z } from "zod";
import { BztError } from "./errors.ts";

export const readRetryDelaysMs = Object.freeze([300, 900]);

const concurrencySetting = z.int().positive();
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
