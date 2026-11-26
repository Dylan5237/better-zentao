import { createHash } from "node:crypto";
import { z } from "zod";
import { BztError } from "../core/errors.ts";
import type { CacheRepository } from "../core/store/repositories.ts";

const ttlMs = 7 * 24 * 60 * 60 * 1000;
const checkIntervalMs = 5 * 60 * 1000;
const prefix = "portal-report-v1:";
const report = z.looseObject({
  ok: z.literal(true),
  completeness: z.enum(["complete", "partial"]),
});
const row = z.object({ savedAt: z.int(), report });
type Snapshot = z.infer<typeof row>;
const probeRow = z.object({
  checkedAt: z.int(),
  revision: z.string().optional(),
});
export type PortalReadMode = "default" | "sync" | "cached";

function stableJson(value: unknown) {
  return JSON.stringify(value, (_: string, entry: unknown) =>
    entry && typeof entry === "object" && !Array.isArray(entry)
      ? Object.fromEntries(
          Object.entries(entry).sort(([a], [b]) => a.localeCompare(b)),
        )
      : entry,
  );
}

const hash = (value: unknown) =>
  createHash("sha256").update(stableJson(value)).digest("hex");

function response(entry: Snapshot, fromCache: boolean, retained = false) {
  return {
    ...entry.report,
    snapshot: {
      savedAt: entry.savedAt,
      fromCache,
      ...(retained && { retained }),
    },
  };
}

export function createPortalSnapshots(
  cache: Pick<CacheRepository, "get" | "set" | "pruneExpired" | "trimPrefix">,
  clock: () => number,
  sampleActivity: () => Promise<unknown>,
) {
  const inFlight = new Map<string, Promise<unknown>>();
  let probe: Promise<z.infer<typeof probeRow>> | undefined;
  let generation = 0;

  function load<T>(key: string, schema: z.ZodType<T>): T | undefined {
    try {
      const raw = cache.get(key);
      return raw ? schema.parse(JSON.parse(raw)) : undefined;
    } catch {
      return undefined;
    }
  }

  function save(key: string, value: unknown) {
    try {
      const json = JSON.stringify(value);
      if (Buffer.byteLength(json) <= 2 * 1024 * 1024)
        cache.set(key, json, ttlMs);
    } catch {
      // 本地缓存不可用时，仍可直接显示已取得的数据。
    }
  }
  try {
    cache.pruneExpired();
  } catch {
    // 快照不是登录的前置条件。
  }

  async function read(
    role: string,
    tool: string,
    input: unknown,
    mode: PortalReadMode,
    fetchReport: () => Promise<unknown>,
    configRevision = "",
  ) {
    const key = prefix + hash([configRevision, role, tool, input]);
    const old = load(key, row);
    if (old && mode !== "sync") return response(old, true);
    if (mode === "cached") return { ok: false };
    const pending = inFlight.get(key);
    if (pending) return pending;
    const stamp = generation;
    const update = (async () => {
      try {
        const result = await fetchReport();
        const parsed = report.safeParse(result);
        if (
          !parsed.success ||
          (old?.report.completeness === "complete" &&
            parsed.data.completeness === "partial")
        ) {
          return old ? response(old, true, true) : result;
        }
        const entry = { report: parsed.data, savedAt: clock() };
        if (generation === stamp) {
          save(key, entry);
          try {
            cache.trimPrefix(prefix, 128);
          } catch {
            // 过期记录仍会由缓存有效期清理。
          }
        }
        return response(entry, false);
      } catch (error) {
        if (
          old &&
          (!(error instanceof BztError) ||
            ![
              "AUTH_FAILED",
              "PERMISSION_DENIED",
              "INVALID_INPUT",
              "NOT_FOUND",
            ].includes(error.code))
        )
          return response(old, true, true);
        throw error;
      }
    })();
    inFlight.set(key, update);
    try {
      return await update;
    } finally {
      if (inFlight.get(key) === update) inFlight.delete(key);
    }
  }

  async function check(
    role: string,
    acknowledge?: string,
    section = "workbench",
  ) {
    const key = "portal-activity-v1";
    const baselineKey = "portal-activity-base-v1:" + role + ":" + section;
    const previous = load(key, probeRow);
    if (!previous || clock() - previous.checkedAt >= checkIntervalMs) {
      probe ??= (async () => {
        const checkedAt = clock();
        try {
          const current = { checkedAt, revision: hash(await sampleActivity()) };
          save(key, current);
          return current;
        } catch {
          const failure = { checkedAt };
          save(key, failure);
          return failure;
        }
      })().finally(() => {
        probe = undefined;
      });
    }
    const activity = (await probe) ?? previous;
    let baseline = load(baselineKey, z.string());
    const revision = activity?.revision;
    if (revision && (!baseline || acknowledge === revision)) {
      baseline = revision;
      save(baselineKey, baseline);
    }
    return {
      revision,
      changed: Boolean(revision && baseline !== revision),
      available: Boolean(revision),
    };
  }

  return {
    read,
    check,
    invalidate() {
      generation++;
      inFlight.clear();
      try {
        cache.trimPrefix(prefix, 0);
      } catch {
        // 缓存清理失败不能掩盖已经完成的禅道操作。
      }
    },
  };
}
