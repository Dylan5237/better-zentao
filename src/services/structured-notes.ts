import { z } from "zod";
import type { TeamConfig } from "../core/config.ts";
import type { StoryDetail } from "../core/dto/story.ts";
import type { StoryRoleRecord, WaiverRecord } from "../core/store/index.ts";
import { resolveStoryRoles } from "../domain/roles.ts";
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

/**
 * CR-009 D-204：允许通过 `[bzt:meta v1]` 评论或本地缓存变更阶段要求的受权作者集合。
 * 统一涵盖团队配置中的 PM / DM / RM 以及按统一规则解析出的当前需求维护人（maintainer）。
 */
export function stageRequirementApprovers(
  roles: TeamConfig["roles"],
  maintainer?: string | null,
): readonly string[] {
  return [
    ...(roles.PM ?? []),
    ...(roles.DM ?? []),
    ...(roles.RM ?? []),
    ...(maintainer ? [maintainer] : []),
  ];
}

/**
 * 统一解析需求维护人并产出阶段要求受权作者集合，确保 management / risk / snapshot / tracking / flow
 * 五处入口使用完全一致的维护人与作者授权口径。
 */
export function resolveStoryStageApprovers(
  config: Pick<TeamConfig, "roles" | "modules" | "moduleDefaults">,
  story: Parameters<typeof resolveStoryRoles>[0]["story"] & {
    readonly product: number;
    readonly module?: number | null | undefined;
  },
  stored?: StoryRoleRecord,
): readonly string[] {
  const moduleKey = `${story.product}:${story.module ?? 0}`;
  const mod = config.modules[moduleKey];
  const fallback = config.moduleDefaults[story.product];
  const { maintainer } = resolveStoryRoles({
    story,
    module: {
      maintainer: mod?.designLead ?? fallback?.designLead,
      devLead: mod?.devLead ?? fallback?.devLead,
    },
    ...(stored ? { stored } : {}),
  });
  return stageRequirementApprovers(config.roles, maintainer);
}

// docs/04 §2 & CR-009 D-204：仅提取经过受权作者校验的显式阶段要求决定（不含默认值），
// 供拆解服务区分「显式要求为默认值」与「从未显式设置」。
export function foldExplicitStageRequirements(
  stages: readonly string[],
  cached: readonly {
    stage: string;
    required: boolean;
    decidedBy?: string | null | undefined;
  }[] = [],
  actions?: Actions,
  authorizedActors?: readonly (string | null | undefined)[],
): Map<string, boolean> {
  const validStages = new Set(stages);
  const explicit = new Map<string, boolean>();
  const allowed = new Set(
    (authorizedActors ?? []).filter(
      (actor): actor is string =>
        typeof actor === "string" && actor.trim().length > 0,
    ),
  );
  const enforceAuthor = allowed.size > 0;
  for (const entry of cached) {
    if (!validStages.has(entry.stage)) continue;
    // 若缓存记录了 decidedBy 且启用作者校验，则无权作者写入的缓存记录同样被忽略。
    if (
      enforceAuthor &&
      typeof entry.decidedBy === "string" &&
      entry.decidedBy.trim().length > 0 &&
      !allowed.has(entry.decidedBy)
    ) {
      continue;
    }
    explicit.set(entry.stage, entry.required);
  }
  for (const { actor, text } of orderedComments(actions)) {
    if (enforceAuthor && !allowed.has(actor)) continue;
    const settings = readJsonNote("meta", text, stageNote)?.stageRequirements;
    for (const [stage, value] of Object.entries(settings ?? {}))
      if (validStages.has(stage)) explicit.set(stage, value.required);
    const match = legacyStage.exec(text);
    if (match?.[1] && validStages.has(match[1]))
      explicit.set(match[1], match[2] === "true");
  }
  return explicit;
}

// docs/04 §2 & CR-009 D-204：已验证的禅道评论覆盖缓存，缓存只补没有评论的阶段。
// 当提供受权作者名单且非空时，缓存记录（decidedBy）与禅道评论（actor）均严格校验受权作者；
// 未配置任何受权职责的旧夹具（authorizedActors 为空）保留显式历史兼容口径。
export function foldStageRequirements(
  defaults: Readonly<Record<string, { required: boolean }>>,
  cached: readonly {
    stage: string;
    required: boolean;
    decidedBy?: string | null | undefined;
  }[] = [],
  actions?: Actions,
  authorizedActors?: readonly (string | null | undefined)[],
) {
  const required = new Map(
    Object.entries(defaults).map(([stage, settings]) => [
      stage,
      settings.required,
    ]),
  );
  const explicit = foldExplicitStageRequirements(
    Object.keys(defaults),
    cached,
    actions,
    authorizedActors,
  );
  for (const [stage, value] of explicit) required.set(stage, value);
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
