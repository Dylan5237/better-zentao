export async function mapLimit<T, R>(items: readonly T[], limit: number, run: (item: T) => Promise<R>): Promise<R[]> {
  const result: R[] = [];
  let index = 0;
  await Promise.all(Array.from({ length: Math.min(limit, items.length) }, async () => {
    while (index < items.length) {
      const next = index++;
      result[next] = await run(items[next]);
    }
  }));
  return result;
}

export function requestPool(limit: number) {
  let running = 0;
  const queued: Array<() => void> = [];
  return async function run<T>(request: () => Promise<T>): Promise<T> {
    if (running < limit) running++;
    else await new Promise<void>(resolve => queued.push(resolve));
    try {
      return await request();
    } finally {
      const next = queued.shift();
      if (next) next();
      else running--;
    }
  };
}
