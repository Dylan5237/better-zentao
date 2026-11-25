import { z } from "zod";
import type { TeamConfig } from "../core/config.ts";
import type { StoryDetail } from "../core/dto/story.ts";
import type { WaiverRecord } from "../core/store/index.ts";
import { rules, type RuleInput } from "../rules/index.ts";

type Actions = NonNullable<StoryDetail["actions"]>;
type RuleWaiver = NonNullable<RuleInput["waivers"]>[number];
type WaiverEntry = { ruleId: string; by: string; reason: string };

const stageNote = z.object({
  stageRequirements: z
    .record(z.string(), z.object({ required: z.boolean() }))
    .optional(),
});
const text = z.string().trim().min(1);
const waiverNote = z.strictObject({
  rule: text,
  reason: text,
  version: text.optional(),
  approvedBy: text.optional(),
});
const ruleIds = new Map<string, RuleWaiver["ruleId"]>(
  rules.map(({ id }) => [id, id]),
);
const legacyStage =
  /^\[bzt:meta v1\]\s+stage\.([a-z]+)=(true|false)\s+\|\s+reason=\S[^\r\n]*$/u;
const legacyWaiver =
  /^\[bzt:waiver v1\]\s+rule=(R\d{2})(?:\s+\|\s+version=([^\s|]+))?\s+\|\s+approvedBy=([^\s|]+)\s+\|\s+reason=(\S[^\r\n]*)$/u;

export function readJsonNote<T>(
  kind: string,
  comment: string,
  schema: z.ZodType<T>,
) {
  const prefix = "[bzt:" + kind + " v1 ";
  if (!comment.startsWith(prefix) || !comment.endsWith("]")) return undefined;
  try {
    const value: unknown = JSON.parse(comment.slice(prefix.length, -1));
    return schema.safeParse(value).data;
  } catch (error) {
    if (!(error instanceof SyntaxError)) throw error;
    return undefined;
  }
}

function orderedComments(actions: Actions = []) {
  return [...actions]
    .sort((a, b) => (a.date ?? 0) - (b.date ?? 0) || a.id - b.id)
    .flatMap(({ actor, action, comment, date }) => {
      if (!actor || !comment || action.toLowerCase() !== "commented") return [];
      const body = comment.trim();
      // 22.6 有时将单条评论回读为一个富文本段落。
      const paragraph = /^<p>([\s\S]*)<\/p>$/iu.exec(body)?.[1];
      return [{ actor, date, text: paragraph?.trim() ?? body }];
    });
}

// docs/04 §2：已验证的禅道评论覆盖缓存，缓存只补没有评论的阶段。
export function foldStageRequirements(
  defaults: Readonly<Record<string, { required: boolean }>>,
  cached: readonly { stage: string; required: boolean }[] = [],
  actions?: Actions,
) {
  const required = new Map(
    Object.entries(defaults).map(([stage, settings]) => [
      stage,
      settings.required,
    ]),
  );
  for (const entry of cached)
    if (required.has(entry.stage)) required.set(entry.stage, entry.required);
  for (const { text } of orderedComments(actions)) {
    const settings = readJsonNote("meta", text, stageNote)?.stageRequirements;
    for (const [stage, value] of Object.entries(settings ?? {}))
      if (required.has(stage)) required.set(stage, value.required);
    const match = legacyStage.exec(text);
    if (match?.[1] && required.has(match[1]))
      required.set(match[1], match[2] === "true");
  }
  return Object.fromEntries(required);
}

function waiverComments(actions?: Actions) {
  return orderedComments(actions).flatMap(({ actor, date, text }) => {
    const legacy = legacyWaiver.exec(text);
    const note =
      readJsonNote("waiver", text, waiverNote) ??
      (legacy?.[1] && legacy[3] && legacy[4]
        ? {
            rule: legacy[1],
            version: legacy[2],
            approvedBy: legacy[3],
            reason: legacy[4],
          }
        : undefined);
    if (!note || (note.approvedBy !== undefined && note.approvedBy !== actor))
      return [];
    const ruleId = ruleIds.get(note.rule.toUpperCase());
    return ruleId
      ? [
          {
            ruleId,
            by: actor,
            date,
            reason: note.reason.trim(),
            version: note.version,
          },
        ]
      : [];
  });
}

export function cachedWaiverEntries(
  rows: readonly Pick<WaiverRecord, "ruleId" | "approvedBy" | "reason">[],
): WaiverEntry[] {
  return rows.map(({ ruleId, approvedBy, reason }) => ({
    ruleId,
    by: approvedBy,
    reason,
  }));
}

export function foldRuleWaivers(
  objectType: RuleWaiver["objectType"],
  objectId: number,
  cached: readonly WaiverEntry[],
  source?: {
    actions: Actions | undefined;
    approvers: readonly (string | null)[];
  },
): RuleWaiver[] {
  const byRule = new Map<RuleWaiver["ruleId"], RuleWaiver>();
  for (const { ruleId, by, reason } of cached) {
    const id = ruleIds.get(ruleId.toUpperCase());
    if (id && id !== "R13")
      byRule.set(id, { ruleId: id, by, reason, objectType, objectId });
  }
  if (source) {
    for (const { ruleId, by, reason } of waiverComments(source.actions)) {
      // R13 还需要产品管理批准和版本归属证据。
      if (ruleId !== "R13" && source.approvers.includes(by))
        byRule.set(ruleId, { ruleId, by, reason, objectType, objectId });
    }
  }
  return [...byRule.values()];
}

export function resolveReleaseWaiver(
  config: Pick<TeamConfig, "versionTag" | "roles">,
  row: Pick<StoryDetail, "id" | "keywords" | "lastEditedDate">,
  actions: Actions,
  waivers: readonly WaiverRecord[],
  version: string,
) {
  const prefix = config.versionTag.keywordPrefix;
  const versionTags =
    row.keywords
      ?.split(/[\s,，、;；]+/u)
      .filter((tag) => tag.startsWith(prefix)) ?? [];
  // 本地表没有版本列。当前唯一标签与编辑时间必须同时支持例外归属。
  const belongsToCurrentVersion = (at: number | null) =>
    versionTags.length === 1 &&
    versionTags[0] === prefix + version &&
    at != null &&
    row.lastEditedDate != null &&
    at >= row.lastEditedDate;
  const shared = waiverComments(actions)
    .filter(
      (note) =>
        note.ruleId === "R13" &&
        config.roles.PM?.includes(note.by) &&
        (note.version === undefined
          ? belongsToCurrentVersion(note.date)
          : note.version === version),
    )
    .at(-1);
  const local = waivers.find(
    ({ ruleId, approvedBy, reason, at }) =>
      ruleId === "R13" &&
      config.roles.PM?.includes(approvedBy) &&
      reason.trim() &&
      belongsToCurrentVersion(at),
  );
  const reason = shared?.reason ?? local?.reason;
  const approvedBy = shared?.by ?? local?.approvedBy;
  if (!approvedBy || !reason) return [];
  return [
    {
      storyId: row.id,
      version,
      approvedBy,
      reason: reason.length > 500 ? reason.slice(0, 499) + "…" : reason,
    },
  ];
}
