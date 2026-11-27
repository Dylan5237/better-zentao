import { z } from "zod";
import { BztError } from "../../core/errors.ts";
import { portalRolePage, type PortalRole } from "../portal-policy.ts";

/**
 * CR-009 §11.2 / ADR-28：AI 原位协作（In-context Copilot）契约与受控表单变更校验器。
 * - AI 不直接操作 DOM、不执行任意脚本、不直接改库。
 * - 出站模型前严格按 (tool, role) 字段白名单投影草稿，绝不外发无关或越权字段。
 * - AI 输出的字段变更按当前可信职责、表单工具、目标对象、字段类型/枚举白名单、版本号与已有手工输入严格校验。
 * - 绝不编造事实性字段（如 backfilled.actualStartedAt）；绝不静默覆盖用户已编辑字段。
 */

const shortText = z.string().trim().min(1).max(200);
const longText = z.string().max(4000);

export const copilotSectionSchema = z.enum([
  "workbench",
  "intake",
  "stories",
  "schedule",
  "release-risks",
  "ai-workspace",
]);

export const supportedPatchToolSchema = z.enum([
  "create_story",
  "assign_story",
  "reschedule_story",
  "handoff_story",
]);

export type SupportedPatchTool = z.infer<typeof supportedPatchToolSchema>;

/** 需要绑定目标需求编号的写入表单工具。 */
export const targetBoundPatchTools = new Set<SupportedPatchTool>([
  "assign_story",
  "reschedule_story",
  "handoff_story",
]);

/** 前端上报的当前活跃表单草稿快照（仅受控标量字段，不含凭据）。 */
export const formDraftSnapshotSchema = z.strictObject({
  formId: shortText,
  tool: supportedPatchToolSchema,
  targetObjectId: z.int().positive().optional(),
  revision: z.int().nonnegative(),
  fields: z.record(z.string().min(1).max(64), z.union([longText, z.boolean()])),
  userEditedFields: z.array(z.string().min(1).max(64)).max(64).default([]),
});

export type FormDraftSnapshot = z.infer<typeof formDraftSnapshotSchema>;

/** 当前页面与业务现场上下文快照（受服务端可信身份与职责再校验）。 */
export const pageContextSnapshotSchema = z.strictObject({
  view: copilotSectionSchema,
  selectedStoryId: z.int().positive().optional(),
  filters: z.record(z.string().min(1).max(32), z.string().max(200)).optional(),
  form: formDraftSnapshotSchema.optional(),
});

export type PageContextSnapshot = z.infer<typeof pageContextSnapshotSchema>;

export const formFieldPatchSchema = z.strictObject({
  field: z.string().min(1).max(64),
  value: z.union([longText, z.boolean()]),
  rationale: z.string().trim().min(1).max(240),
  mode: z.enum(["fill_empty", "propose_replace"]),
});

export type FormFieldPatch = z.infer<typeof formFieldPatchSchema>;

export const formPatchProposalSchema = z.strictObject({
  proposalId: z.string().min(1).max(64),
  formId: shortText,
  tool: supportedPatchToolSchema,
  baseRevision: z.int().nonnegative(),
  targetObjectId: z.int().positive().optional(),
  contextBinding: z.string().min(1).max(64).optional(),
  patches: z.array(formFieldPatchSchema).max(24),
  warnings: z.array(z.string().max(240)).max(16).default([]),
  missingFields: z.array(z.string().max(64)).max(16).default([]),
});

export type FormPatchProposal = z.infer<typeof formPatchProposalSchema>;

export const copilotTurnRequestSchema = z.strictObject({
  role: z.string().min(1).max(16),
  prompt: z.string().trim().min(1).max(2000),
  month: z
    .string()
    .regex(/^\d{4}-(?:0[1-9]|1[0-2])$/u)
    .optional(),
  context: pageContextSnapshotSchema,
});

export type CopilotTurnRequest = z.infer<typeof copilotTurnRequestSchema>;

export const copilotTurnResponseSchema = z.strictObject({
  ok: z.literal(true),
  turnId: z.string().min(1),
  kind: z.enum([
    "form_patch",
    "open_form_patch",
    "tool_result",
    "filter_suggestion",
    "clarification",
    "rejection",
  ]),
  summary: z.string(),
  routeSource: z.enum(["l1", "l3", "in_context"]),
  untrusted: z.boolean().default(false),
  proposal: formPatchProposalSchema.optional(),
  openForm: z
    .strictObject({
      section: z.literal("intake"),
      tool: supportedPatchToolSchema,
    })
    .optional(),
  tool: z.string().optional(),
  toolResult: z.unknown().optional(),
  filters: z.record(z.string(), z.string()).optional(),
});

export type CopilotTurnResponse = z.infer<typeof copilotTurnResponseSchema>;

/**
 * 事实性字段禁令（AGENTS.md 红线 3）：
 * 实际开始日期、完成时间、工时等事实字段严禁 AI 编造或填充。
 */
const forbiddenFactualFields = new Set<string>([
  "backfilled.actualStartedAt",
  "actualStartedAt",
  "finishedDate",
  "consumed",
]);

/** 按 (tool, role) 声明允许 AI 建议与出站感知的表单字段白名单。 */
const fbCreateStoryFields = new Set<string>([
  "product",
  "module",
  "intake.channel",
  "title",
  "spec.background",
  "spec.scope",
  "verify",
]);

const fullCreateStoryFields = new Set<string>([
  ...fbCreateStoryFields,
  "category",
  "plan",
  "version",
  "feedbackBy",
  "spec.notInScope",
  "spec.designRef.doc",
  "spec.designRef.section",
  "spec.designRef.version",
  "pri",
  "intake.rawText",
]);

const toolFieldAllowlist: Readonly<
  Record<SupportedPatchTool, ReadonlySet<string>>
> = {
  create_story: fullCreateStoryFields,
  assign_story: new Set(["storyIds", "to", "comment"]),
  reschedule_story: new Set(["storyIds", "toMonth", "reason", "moveTasks"]),
  handoff_story: new Set([
    "storyId",
    "mode",
    "receiver",
    "comment",
    "feature.product",
    "feature.module",
    "feature.title",
    "feature.scope",
  ]),
};

const categoryChoices = new Set(["", "design", "feature"]);
const channelChoices = new Set([
  "",
  "wecom",
  "meeting",
  "zentao",
  "verbal",
  "other",
]);
const priChoices = new Set(["", "1", "2", "3", "4"]);
const handoffModeChoices = new Set(["from_design", "activate"]);
const positiveIdPattern = /^[1-9]\d{0,9}$/u;
const storyIdListPattern = /^[1-9]\d{0,9}(?:\s*[,，\s]\s*[1-9]\d{0,9})*$/u;
const monthPattern = /^\d{4}-(?:0[1-9]|1[0-2])$/u;

export function allowedFieldsForForm(
  tool: SupportedPatchTool,
  role: PortalRole,
): ReadonlySet<string> {
  if (tool === "create_story" && role === "FB") return fbCreateStoryFields;
  return toolFieldAllowlist[tool];
}

/**
 * 出站模型前的最小上下文投影（CR-009 P1-5）：
 * 仅保留当前 (tool, role) 字段白名单内的字段，剥离任何额外或事实性字段；
 * 目标绑定型表单强制收窄 storyId / storyIds 至已核对的目标对象编号。
 */
export function projectOutboundFormFields(
  tool: SupportedPatchTool,
  role: PortalRole,
  fields: Readonly<Record<string, string | boolean>>,
  targetObjectId?: number,
): Record<string, string | boolean> {
  const allowed = allowedFieldsForForm(tool, role);
  const projected: Record<string, string | boolean> = {};
  for (const [key, value] of Object.entries(fields)) {
    if (!allowed.has(key) || forbiddenFactualFields.has(key)) continue;
    if (
      targetBoundPatchTools.has(tool) &&
      targetObjectId !== undefined &&
      (key === "storyId" || key === "storyIds")
    ) {
      projected[key] = String(targetObjectId);
      continue;
    }
    projected[key] =
      typeof value === "string" && value.length > 2000
        ? value.slice(0, 2000)
        : value;
  }
  return projected;
}

/** 校验 formId 与表单工具及完整目标对象集合的独立一致性（涵盖 storyId 与 storyIds）。 */
export function assertValidFormContext(
  form: FormDraftSnapshot,
  selectedStoryId?: number,
): void {
  if (form.formId !== form.tool && !form.formId.startsWith(`${form.tool}:`)) {
    throw new BztError(
      "INVALID_INPUT",
      "表单标识与表单工具不匹配，已拒绝本次原位建议。",
    );
  }
  if (targetBoundPatchTools.has(form.tool)) {
    if (form.targetObjectId === undefined) {
      throw new BztError(
        "INVALID_INPUT",
        "针对既有需求的表单必须绑定明确的目标需求编号。",
      );
    }
    if (
      selectedStoryId !== undefined &&
      form.targetObjectId !== selectedStoryId
    ) {
      throw new BztError(
        "PLAN_STALE",
        "表单目标对象与当前选中需求不一致，已拦截跨对象建议。",
        { conflict: true },
      );
    }
    const rawStoryId = form.fields.storyId;
    if (
      typeof rawStoryId === "string" &&
      rawStoryId.trim() !== "" &&
      rawStoryId.trim() !== String(form.targetObjectId)
    ) {
      throw new BztError(
        "PLAN_STALE",
        "表单内目标需求编号与上下文绑定不一致，已拦截。",
        { conflict: true },
      );
    }
    const rawStoryIds = form.fields.storyIds;
    if (typeof rawStoryIds === "string" && rawStoryIds.trim() !== "") {
      const parsedIds = rawStoryIds
        .split(/[\s,，、;；]+/u)
        .map((part) => part.trim())
        .filter(Boolean);
      if (
        parsedIds.length !== 1 ||
        parsedIds[0] !== String(form.targetObjectId)
      ) {
        throw new BztError(
          "PLAN_STALE",
          "表单内目标需求列表与绑定目标对象不一致，已拦截。",
          { conflict: true },
        );
      }
    }
  }
}

export interface RawFieldPatchCandidate {
  readonly field: string;
  readonly value: string | boolean;
  readonly rationale?: string | undefined;
}

/**
 * 校验并规范化 AI 生成的表单字段变更提议：
 * 1. 服务端校验 readOnly 与当前角色对该表单工具的授权；
 * 2. 强制核对 formId / targetObjectId / baseRevision（防跨对象与迟到覆盖）；
 * 3. 按 (tool, role) 白名单及字段类型/枚举契约过滤字段并拦截任何事实性字段；
 * 4. 对已有手工内容或非空字段强制设为 `propose_replace`（绝不静默覆盖）。
 */
export function validateFormPatchProposal(options: {
  readonly proposalId: string;
  readonly role: PortalRole;
  readonly readOnly: boolean;
  readonly currentForm: FormDraftSnapshot;
  readonly targetFormId: string;
  readonly targetTool: SupportedPatchTool;
  readonly baseRevision: number;
  readonly targetObjectId?: number | undefined;
  readonly contextBinding?: string | undefined;
  readonly candidates: readonly RawFieldPatchCandidate[];
  readonly missingFields?: readonly string[] | undefined;
}): FormPatchProposal {
  const {
    proposalId,
    role,
    readOnly,
    currentForm,
    targetFormId,
    targetTool,
    baseRevision,
    targetObjectId,
    contextBinding,
    candidates,
  } = options;

  if (readOnly)
    throw new BztError(
      "PERMISSION_DENIED",
      "当前服务处于只读模式，不可修改写入表单。",
    );

  const page = portalRolePage(role);
  if (!page.actions.includes(targetTool))
    throw new BztError("PERMISSION_DENIED", "当前职责无权辅助编辑该业务表单。");

  assertValidFormContext(currentForm);

  if (
    currentForm.formId !== targetFormId ||
    currentForm.tool !== targetTool ||
    currentForm.revision !== baseRevision ||
    (targetObjectId !== undefined &&
      currentForm.targetObjectId !== targetObjectId)
  ) {
    throw new BztError(
      "PLAN_STALE",
      "表单上下文已变化或草稿已被更新，已拦截迟到的 AI 建议。",
      { conflict: true },
    );
  }

  const allowed = allowedFieldsForForm(targetTool, role);
  const edited = new Set(currentForm.userEditedFields);
  const patches: FormFieldPatch[] = [];
  const warnings: string[] = [];
  const seen = new Set<string>();

  for (const candidate of candidates) {
    if (seen.has(candidate.field)) continue;
    if (forbiddenFactualFields.has(candidate.field)) {
      warnings.push(
        `已拦截事实性字段 ${candidate.field}（需由人工如实填写）。`,
      );
      continue;
    }
    if (!allowed.has(candidate.field)) {
      warnings.push(`已忽略当前角色未授权字段 ${candidate.field}。`);
      continue;
    }
    // 目标绑定型表单绝不允许 AI 篡改目标对象 ID。
    if (
      targetBoundPatchTools.has(targetTool) &&
      (candidate.field === "storyId" || candidate.field === "storyIds")
    ) {
      warnings.push(`已拦截对目标对象字段 ${candidate.field} 的修改。`);
      continue;
    }
    const normalized = normalizeFieldValue(
      targetTool,
      candidate.field,
      candidate.value,
    );
    if (normalized === undefined) {
      warnings.push(
        `字段 ${candidate.field} 的建议值不符合枚举或格式规范，已忽略。`,
      );
      continue;
    }
    const existing = currentForm.fields[candidate.field];
    const existingText =
      typeof existing === "string"
        ? existing.trim()
        : existing === true
          ? "true"
          : "";
    const normalizedText =
      typeof normalized === "string"
        ? normalized.trim()
        : normalized === true
          ? "true"
          : "";
    if (existingText === normalizedText) continue;

    // 关键非破坏性规则：用户已编辑（含主动清空）或已有非空内容的字段绝不自动静默覆盖。
    const mode: FormFieldPatch["mode"] =
      edited.has(candidate.field) || existingText !== ""
        ? "propose_replace"
        : "fill_empty";

    patches.push({
      field: candidate.field,
      value: normalized,
      rationale:
        candidate.rationale?.trim().slice(0, 240) || "基于当前业务语境生成建议",
      mode,
    });
    seen.add(candidate.field);
  }

  const missing = [...(options.missingFields ?? [])].filter((f) =>
    allowed.has(f),
  );
  if (targetTool === "create_story") {
    const projected = (name: string) => {
      const fromPatch = patches.find((p) => p.field === name)?.value;
      if (typeof fromPatch === "string" && fromPatch.trim()) return true;
      const cur = currentForm.fields[name];
      return typeof cur === "string" && cur.trim().length > 0;
    };
    for (const req of ["product", "module", "title", "spec.scope", "verify"]) {
      if (allowed.has(req) && !projected(req) && !missing.includes(req)) {
        missing.push(req);
      }
    }
  }

  return formPatchProposalSchema.parse({
    proposalId,
    formId: currentForm.formId,
    tool: currentForm.tool,
    baseRevision: currentForm.revision,
    ...(currentForm.targetObjectId === undefined
      ? {}
      : { targetObjectId: currentForm.targetObjectId }),
    ...(contextBinding === undefined ? {} : { contextBinding }),
    patches,
    warnings,
    missingFields: missing,
  });
}

function normalizeFieldValue(
  tool: SupportedPatchTool,
  field: string,
  value: string | boolean,
): string | boolean | undefined {
  if (field === "moveTasks") {
    return typeof value === "boolean" ? value : undefined;
  }
  if (typeof value !== "string") return undefined;
  const trimmed = value.trim();
  // P1-5：超长文本直接拒绝，绝不在枚举/月份校验前静默截断放行。
  if (trimmed.length > 4000) return undefined;
  if (field === "category")
    return categoryChoices.has(trimmed) ? trimmed : undefined;
  if (field === "intake.channel")
    return channelChoices.has(trimmed) ? trimmed : undefined;
  if (field === "pri") return priChoices.has(trimmed) ? trimmed : undefined;
  if (field === "toMonth")
    return monthPattern.test(trimmed) ? trimmed : undefined;
  if (field === "storyId")
    return positiveIdPattern.test(trimmed) ? trimmed : undefined;
  if (field === "storyIds")
    return storyIdListPattern.test(trimmed) ? trimmed : undefined;
  if (tool === "handoff_story" && field === "mode")
    return handoffModeChoices.has(trimmed) ? trimmed : undefined;
  if (
    (field === "product" ||
      field === "module" ||
      field === "feature.product" ||
      field === "feature.module") &&
    trimmed.length > 120
  ) {
    return undefined;
  }
  return trimmed;
}

const modelPatchEnvelopeSchema = z.object({
  summary: z.string().trim().min(1).max(400).optional(),
  patches: z
    .array(
      z.object({
        field: z.string().min(1).max(64),
        value: z.union([z.string(), z.boolean()]),
        rationale: z.string().optional(),
      }),
    )
    .max(24),
  missingFields: z.array(z.string().max(64)).max(16).optional(),
});

/** 从模型返回文本中安全解析受控 JSON 补丁（容忍 ```json 代码块，拒绝非对象或非法格式）。 */
export function parseModelPatchOutput(text: string): {
  readonly summary?: string;
  readonly patches: readonly RawFieldPatchCandidate[];
  readonly missingFields: readonly string[];
} {
  const fenced = /```(?:json)?\s*([\s\S]*?)```/iu.exec(text);
  const candidate = (fenced?.[1] ?? text).trim();
  const startIdx = candidate.indexOf("{");
  const endIdx = candidate.lastIndexOf("}");
  if (startIdx === -1 || endIdx <= startIdx) {
    return { patches: [], missingFields: [] };
  }
  try {
    const raw: unknown = JSON.parse(candidate.slice(startIdx, endIdx + 1));
    const parsed = modelPatchEnvelopeSchema.safeParse(raw);
    if (!parsed.success) return { patches: [], missingFields: [] };
    return {
      ...(parsed.data.summary === undefined
        ? {}
        : { summary: parsed.data.summary }),
      patches: parsed.data.patches,
      missingFields: parsed.data.missingFields ?? [],
    };
  } catch {
    return { patches: [], missingFields: [] };
  }
}
