import { createHash, randomBytes } from "node:crypto";
import { z } from "zod";
import { BztError } from "../../core/errors.ts";
import type { CapabilityRuntime } from "../capability-runtime.ts";
import { portalRolePage, type PortalRole } from "../portal-policy.ts";
import {
  allowedFieldsForForm,
  assertValidFormContext,
  copilotTurnResponseSchema,
  parseModelPatchOutput,
  projectOutboundFormFields,
  validateFormPatchProposal,
  type CopilotTurnRequest,
  type CopilotTurnResponse,
  type FormDraftSnapshot,
  type RawFieldPatchCandidate,
} from "./copilot-contracts.ts";
import {
  createIntentRouter,
  extractStoryRef,
  myWorkWords,
  progressWords,
  riskWords,
} from "./intent-router.ts";
import type { ModelGateway } from "./model-gateway.ts";
import type { ModelPrincipal } from "./personal-model-store.ts";

/**
 * CR-009 §11.2 / ADR-28：服务端原位协作编排器（In-context Copilot）。
 * - 所有内置 AI 路径（含 L1 规则快通道）均要求当前主体个人大模型网关 `configured && verified`；
 * - 所有业务查询经 `CapabilityRuntime(channel="ai")` 执行，按服务端已验证的当前选定职责（非 roles[0]）授权；
 * - 表单上下文先做白名单出站投影再交由个人 `ModelGateway`，回包按职责、目标对象、类型/枚举白名单与版本号校验；
 * - 所有模型派生文本与字段建议统一标为 `untrusted: true`，绝不直接改库或确认写入。
 */

export interface CopilotTurnOptions {
  readonly principal: ModelPrincipal;
  readonly sessionId?: string | undefined;
  readonly role: PortalRole;
  readonly readOnly: boolean;
  readonly month: string;
  readonly runtime: CapabilityRuntime;
  readonly gateway: ModelGateway;
  readonly isRevoked: () => boolean;
  readonly abortSignal?: AbortSignal | undefined;
  readonly request: CopilotTurnRequest;
}

const intakeTriggerPattern =
  /(?:提(?:一个|一条|个|条)?需求|新建需求|创建需求|拟定(?:一条)?需求|帮我提需|发起需求)/u;
const filterTriggerPattern = /(?:筛|过滤|只看)/u;
const multiIntentJoinPattern = /(?:同时|顺便|顺带|并且|另外|再帮我)/u;
const promptMonthPattern = /\b(\d{4}-(?:0[1-9]|1[0-2]))\b/u;

function nextId(prefix: string): string {
  return `${prefix}_${randomBytes(8).toString("hex")}`;
}

function contextBindingOf(input: {
  readonly sessionId?: string | undefined;
  readonly principal: ModelPrincipal;
  readonly role: PortalRole;
  readonly formId: string;
  readonly tool: string;
  readonly targetObjectId?: number | undefined;
  readonly baseRevision: number;
}): string {
  return createHash("sha256")
    .update(
      [
        input.sessionId ?? "",
        input.principal.instanceHash,
        input.principal.account,
        input.role,
        input.formId,
        input.tool,
        String(input.targetObjectId ?? ""),
        String(input.baseRevision),
      ].join("\0"),
      "utf8",
    )
    .digest("hex")
    .slice(0, 32);
}

function assertPersonalGatewayReady(
  gateway: ModelGateway,
  principal: ModelPrincipal,
): void {
  const masked = gateway.getMasked(principal);
  if (!masked.configured) {
    throw new BztError(
      "CONFIG_MISSING",
      "请先在「个人 AI 设置」中配置您本人的企业大模型网关与 Token。",
    );
  }
  if (!masked.verified) {
    throw new BztError(
      "AUTH_FAILED",
      "个人大模型网关尚未通过连接测试，请先完成验证后再使用 AI 助手。",
    );
  }
}

function buildFormSystemPrompt(
  role: PortalRole,
  form: FormDraftSnapshot,
): string {
  const fields = [...allowedFieldsForForm(form.tool, role)].join(", ");
  return [
    "你是 better-zentao 研发协作工作台的原位填表助手。",
    `当前业务表单: ${form.tool}（角色: ${role}，草稿版本: r${form.revision}）。`,
    `仅允许输出以下字段的 JSON 建议: ${fields}。`,
    "严禁编造事实性字段（如实际开始日期、完成时间、消耗工时），严禁输出 HTML/JS 脚本。",
    '仅输出 JSON 对象，格式为 {"summary":"简短中文说明","patches":[{"field":"字段名","value":"字段值","rationale":"原因"}],"missingFields":["缺失必填字段"]}。',
  ].join("\n");
}

function fallbackCreateStoryCandidates(
  prompt: string,
  form: FormDraftSnapshot,
): readonly RawFieldPatchCandidate[] {
  const trimmed = prompt.trim();
  if (!trimmed) return [];
  const candidates: RawFieldPatchCandidate[] = [];
  const cleanTitle = trimmed
    .replace(
      /^(?:请|帮我|帮忙)?(?:按描述|根据描述)?(?:填充|填写|补全|修改|提一个|提一条|新建|创建|拟定)?(?:需求|表单)?[：:\s]*/u,
      "",
    )
    .slice(0, 40)
    .trim();
  if (cleanTitle && !String(form.fields.title ?? "").trim()) {
    candidates.push({
      field: "title",
      value: cleanTitle,
      rationale: "规则降级：从用户输入原文提取需求标题（请人工核对）",
    });
  }
  if (trimmed.length >= 6 && !String(form.fields["spec.scope"] ?? "").trim()) {
    candidates.push({
      field: "spec.scope",
      value: trimmed,
      rationale: "规则降级：保留用户输入原文作为实现范围草稿（请人工核对）",
    });
  }
  return candidates;
}

const allowedL3Intents = new Set([
  "my_work",
  "story_progress",
  "workflow_risks",
  "draft_story",
]);

const l3IntentOutputSchema = z.discriminatedUnion("kind", [
  z.strictObject({
    kind: z.literal("label"),
    intent: z.enum([
      "my_work",
      "story_progress",
      "workflow_risks",
      "draft_story",
    ]),
    confidence: z.enum(["high", "medium"]).default("medium"),
    storyId: z.number().int().positive().optional(),
    month: z
      .string()
      .regex(/^\d{4}-(?:0[1-9]|1[0-2])$/u)
      .optional(),
    riskFocus: z.enum(["overdue", "blocked", "all"]).optional(),
  }),
  z.strictObject({
    kind: z.literal("ambiguous"),
    question: z.string().trim().min(1).max(200).optional(),
  }),
  z.strictObject({
    kind: z.literal("unsupported"),
    reason: z.string().trim().min(1).max(200).optional(),
  }),
]);

type ParsedL3Intent =
  | {
      readonly kind: "label";
      readonly intent:
        "my_work" | "story_progress" | "workflow_risks" | "draft_story";
      readonly confidence: "high" | "medium";
      readonly storyId?: number | undefined;
      readonly month?: string | undefined;
      readonly riskFocus?: "overdue" | "blocked" | "all" | undefined;
    }
  | { readonly kind: "ambiguous"; readonly question?: string | undefined }
  | { readonly kind: "unsupported"; readonly reason?: string | undefined };

function buildIntentClassifierSystemPrompt(
  role: PortalRole,
  month: string,
  selectedStoryId?: number,
): string {
  return [
    "你是 better-zentao 研发协作工作台的意图分类器。",
    `当前职责: ${role}，工作月份: ${month}${selectedStoryId ? `，当前选中需求: #${selectedStoryId}` : ""}。`,
    "仅允许分类为以下受支持意图之一：my_work（我的工作/待办）、story_progress（查询某条需求进展）、workflow_risks（扫描月度或逾期/阻塞风险）、draft_story（新建/起草一条需求）。",
    "严禁输出 confirm_operation、delete 等写入确认或删除操作；若用户意图模糊、同时包含多个独立目标，请返回 kind=ambiguous 并给出中文澄清问题；若不在上述范围内，请返回 kind=unsupported。",
    '仅输出严格 JSON：{"kind":"label","intent":"my_work|story_progress|workflow_risks|draft_story","confidence":"high|medium","storyId":101,"month":"2026-11","riskFocus":"overdue|blocked|all"} 或 {"kind":"ambiguous","question":"..."} 或 {"kind":"unsupported","reason":"..."}。',
  ].join("\n");
}

function parseL3IntentOutput(rawText: string): ParsedL3Intent {
  const fenced = /```(?:json)?\s*([\s\S]*?)```/iu.exec(rawText);
  const candidate = (fenced?.[1] ?? rawText).trim();
  const start = candidate.indexOf("{");
  const end = candidate.lastIndexOf("}");
  if (start < 0 || end <= start) {
    return {
      kind: "ambiguous",
      question:
        "未能准确识别您的意图，请明确说明要查看个人工作、查询指定需求进展、扫描风险还是提出新需求。",
    };
  }
  let rawJson: unknown;
  try {
    rawJson = JSON.parse(candidate.slice(start, end + 1));
  } catch {
    return {
      kind: "ambiguous",
      question:
        "未能准确识别您的意图，请明确说明要查看个人工作、查询指定需求进展、扫描风险还是提出新需求。",
    };
  }
  const rawLabel = z
    .object({
      kind: z.literal("label"),
      intent: z.string(),
    })
    .safeParse(rawJson);
  if (rawLabel.success && !allowedL3Intents.has(rawLabel.data.intent)) {
    return {
      kind: "unsupported",
      reason: "模型建议的操作不在当前允许的业务意图范围内，已拦截。",
    };
  }
  const parsed = l3IntentOutputSchema.safeParse(rawJson);
  if (!parsed.success) {
    return {
      kind: "ambiguous",
      question:
        "未能准确识别您的意图，请明确说明要查看个人工作、查询指定需求进展、扫描风险还是提出新需求。",
    };
  }
  return parsed.data;
}

export async function runCopilotTurn(
  options: CopilotTurnOptions,
): Promise<CopilotTurnResponse> {
  const {
    principal,
    sessionId,
    role,
    readOnly,
    month,
    runtime,
    gateway,
    isRevoked,
    abortSignal,
    request,
  } = options;

  if (isRevoked()) throw new BztError("AUTH_FAILED", "本次会话已结束。");
  if (runtime.channel !== "ai")
    throw new BztError(
      "PERMISSION_DENIED",
      "Copilot 必须绑定 channel='ai' 的 CapabilityRuntime。",
    );

  // ChatGPT M1 评审硬边界 1：全部内置 AI 路径（含 L1 规则快通道）均要求个人网关已配置且已验证。
  assertPersonalGatewayReady(gateway, principal);

  const turnId = nextId("turn");
  const { prompt, context } = request;
  const effectiveMonth = request.month ?? month;

  // 1. 原位表单协作：当前用户正处于正式可写表单现场（优先覆盖 create_story 闭环）。
  if (context.form) {
    const form = context.form;
    const page = portalRolePage(role);
    // 先于模型调用校验 readOnly、职责授权与表单上下文/目标对象一致性，避免无谓外发上下文。
    if (readOnly)
      throw new BztError(
        "PERMISSION_DENIED",
        "当前服务处于只读模式，不可修改写入表单。",
      );
    if (!page.actions.includes(form.tool))
      throw new BztError(
        "PERMISSION_DENIED",
        "当前职责无权辅助编辑该业务表单。",
      );
    assertValidFormContext(form, context.selectedStoryId);

    const projectedFields = projectOutboundFormFields(
      form.tool,
      role,
      form.fields,
      form.targetObjectId,
    );
    const allowedSet = allowedFieldsForForm(form.tool, role);
    const projectedEdited = form.userEditedFields.filter((f) =>
      allowedSet.has(f),
    );
    const systemPrompt = buildFormSystemPrompt(role, form);
    const userPrompt = JSON.stringify({
      instruction: prompt,
      currentForm: {
        formId: form.formId,
        tool: form.tool,
        ...(form.targetObjectId === undefined
          ? {}
          : { targetObjectId: form.targetObjectId }),
        revision: form.revision,
        fields: projectedFields,
        userEditedFields: projectedEdited,
      },
    });
    const completion = await gateway.complete(principal, {
      messages: [
        { role: "system", content: systemPrompt },
        { role: "user", content: userPrompt },
      ],
      abortSignal,
    });
    if (isRevoked()) throw new BztError("AUTH_FAILED", "本次会话已结束。");

    const parsed = parseModelPatchOutput(completion.text);
    const modelParseFailed = !parsed.ok;
    const candidates = parsed.ok
      ? parsed.patches
      : form.tool === "create_story"
        ? fallbackCreateStoryCandidates(prompt, form)
        : [];

    const proposal = validateFormPatchProposal({
      proposalId: nextId("prop"),
      role,
      readOnly,
      currentForm: form,
      targetFormId: form.formId,
      targetTool: form.tool,
      baseRevision: form.revision,
      targetObjectId: form.targetObjectId,
      contextBinding: contextBindingOf({
        sessionId,
        principal,
        role,
        formId: form.formId,
        tool: form.tool,
        targetObjectId: form.targetObjectId,
        baseRevision: form.revision,
      }),
      candidates,
      missingFields: parsed.missingFields,
    });
    const finalProposal = modelParseFailed
      ? {
          ...proposal,
          warnings: [
            ...proposal.warnings,
            proposal.patches.length > 0
              ? "模型输出未按结构化字段格式返回，已降级按规则提取原文草稿，请人工核对并补充必填项。"
              : "模型输出未按结构化字段格式返回，本次未能生成有效字段补丁，请直接手工编辑表单。",
          ],
        }
      : proposal;

    const autoCount = finalProposal.patches.filter(
      (p) => p.mode === "fill_empty",
    ).length;
    const conflictCount = finalProposal.patches.filter(
      (p) => p.mode === "propose_replace",
    ).length;
    const summary = modelParseFailed
      ? finalProposal.patches.length > 0
        ? `模型输出无法解析为结构化补丁，已降级按规则提取 ${finalProposal.patches.length} 项基础草稿（请人工核对补充后点击「预览并创建」）。`
        : "模型输出无法解析为结构化补丁，未能生成字段变更，请直接手工编辑表单。"
      : (parsed.summary ??
        (finalProposal.patches.length === 0
          ? "未发现需要调整的表单字段，可继续手工编辑或点击「预览并创建」。"
          : `已生成 ${finalProposal.patches.length} 项字段建议（自动填充空字段 ${autoCount} 项，待您采纳的覆盖建议 ${conflictCount} 项）。`));

    return copilotTurnResponseSchema.parse({
      ok: true,
      turnId,
      kind: "form_patch",
      summary,
      routeSource: "in_context",
      // CR-009 P1-6 / AGENTS.md 红线 8：模型派生文本与字段建议一律标为不可信数据。
      untrusted: true,
      proposal: finalProposal,
    });
  }

  async function openCreateStoryForm(
    routeSource: "in_context" | "l1" | "l3",
  ): Promise<CopilotTurnResponse> {
    const page = portalRolePage(role);
    if (readOnly)
      throw new BztError(
        "PERMISSION_DENIED",
        "当前服务处于只读模式，无法发起提需求写入。",
      );
    if (!page.actions.includes("create_story"))
      throw new BztError("PERMISSION_DENIED", "当前职责无权提出需求。");

    const emptyForm: FormDraftSnapshot = {
      formId: "create_story",
      tool: "create_story",
      revision: 0,
      fields: {},
      userEditedFields: [],
    };
    const completion = await gateway.complete(principal, {
      messages: [
        { role: "system", content: buildFormSystemPrompt(role, emptyForm) },
        { role: "user", content: prompt },
      ],
      abortSignal,
    });
    if (isRevoked()) throw new BztError("AUTH_FAILED", "本次会话已结束。");

    const parsed = parseModelPatchOutput(completion.text);
    const modelParseFailed = !parsed.ok;
    const candidates = parsed.ok
      ? parsed.patches
      : fallbackCreateStoryCandidates(prompt, emptyForm);
    const proposal = validateFormPatchProposal({
      proposalId: nextId("prop"),
      role,
      readOnly,
      currentForm: emptyForm,
      targetFormId: "create_story",
      targetTool: "create_story",
      baseRevision: 0,
      contextBinding: contextBindingOf({
        sessionId,
        principal,
        role,
        formId: "create_story",
        tool: "create_story",
        baseRevision: 0,
      }),
      candidates,
      missingFields: parsed.missingFields,
    });
    const finalProposal = modelParseFailed
      ? {
          ...proposal,
          warnings: [
            ...proposal.warnings,
            proposal.patches.length > 0
              ? "模型输出未按结构化字段格式返回，已降级按规则提取原文草稿，请人工核对并补充必填项。"
              : "模型输出未按结构化字段格式返回，未能提取字段草稿，请在正式表单中手工填写。",
          ],
        }
      : proposal;

    return copilotTurnResponseSchema.parse({
      ok: true,
      turnId,
      kind: "open_form_patch",
      summary: modelParseFailed
        ? finalProposal.patches.length > 0
          ? `模型输出无法解析为结构化草稿，已打开正式「提出需求」表单并按规则提取 ${finalProposal.patches.length} 项基础草稿，请人工核对补充后点击「预览并创建」。`
          : "模型输出无法解析为结构化草稿，已为您打开空白正式「提出需求」表单（未自动填充字段），请手工填写后点击「预览并创建」。"
        : (parsed.summary ??
          (finalProposal.patches.length > 0
            ? `已为您打开正式「提出需求」表单并填充 ${finalProposal.patches.length} 项初步草稿，请核对补充后点击「预览并创建」。`
            : "已为您打开正式「提出需求」表单，请手工填写后点击「预览并创建」。")),
      routeSource,
      untrusted: true,
      openForm: { section: "intake", tool: "create_story" },
      proposal: finalProposal,
    });
  }

  // 2. 自然语言发起提需（仅单意图时短路，多意图交由意图分类器澄清）：打开同一正式「提出需求」表单。
  const hasSecondaryQueryIntent =
    myWorkWords.test(prompt) ||
    riskWords.test(prompt) ||
    progressWords.test(prompt) ||
    extractStoryRef(prompt) !== undefined ||
    multiIntentJoinPattern.test(prompt);
  if (intakeTriggerPattern.test(prompt) && !hasSecondaryQueryIntent) {
    return await openCreateStoryForm("in_context");
  }

  // 3. 在需求台账上的原位筛选建议（仅单意图且全部条件可映射时返回，多意图或含风险词交由意图分类器处理）。
  if (
    context.view === "stories" &&
    filterTriggerPattern.test(prompt) &&
    !hasSecondaryQueryIntent &&
    !intakeTriggerPattern.test(prompt)
  ) {
    const filters: Record<string, string> = {};
    if (/未就绪/u.test(prompt)) filters.progress = "未就绪";
    if (/设计/u.test(prompt)) filters.category = "design";
    if (/研发/u.test(prompt)) filters.category = "feature";
    if (Object.keys(filters).length > 0) {
      return copilotTurnResponseSchema.parse({
        ok: true,
        turnId,
        kind: "filter_suggestion",
        summary: "已为您整理原位筛选条件，点击即可直接应用到当前需求台账。",
        routeSource: "in_context",
        untrusted: false,
        filters,
      });
    }
  }

  // 4. 其余分析/查询/拟稿意图：L1 确定性规则短路（零冗余模型调用）→ L3 个人 ModelGateway 结构化意图分类兜底。
  let usedL3 = false;
  let l3Params: {
    storyId?: number | undefined;
    month?: string | undefined;
    riskFocus?: "overdue" | "blocked" | "all" | undefined;
  } = {};
  const router = createIntentRouter({
    classify: async (text) => {
      usedL3 = true;
      const completion = await gateway.complete(principal, {
        messages: [
          {
            role: "system",
            content: buildIntentClassifierSystemPrompt(
              role,
              effectiveMonth,
              context.selectedStoryId,
            ),
          },
          {
            role: "user",
            content: JSON.stringify({
              text,
              view: context.view,
              ...(context.selectedStoryId === undefined
                ? {}
                : { selectedStoryId: context.selectedStoryId }),
              month: effectiveMonth,
            }),
          },
        ],
        abortSignal,
      });
      if (isRevoked()) throw new BztError("AUTH_FAILED", "本次会话已结束。");
      const verdict = parseL3IntentOutput(completion.text);
      if (verdict.kind === "label") {
        l3Params = {
          storyId: verdict.storyId,
          month: verdict.month,
          riskFocus: verdict.riskFocus,
        };
      }
      return verdict;
    },
  });
  const explicitRef = extractStoryRef(prompt);
  const explicitStoryId =
    explicitRef !== undefined
      ? explicitRef
      : riskWords.test(prompt) || myWorkWords.test(prompt)
        ? undefined
        : context.selectedStoryId;
  const routed = await router.route(
    {
      text: prompt,
      ...(explicitStoryId === undefined ? {} : { storyId: explicitStoryId }),
    },
    {
      account: principal.account,
      instanceHash: principal.instanceHash,
      roles: [role],
      currentMonth: effectiveMonth,
      summary: {},
    },
  );

  if (routed.kind === "clarification") {
    return copilotTurnResponseSchema.parse({
      ok: true,
      turnId,
      kind: "clarification",
      summary: routed.question,
      routeSource: usedL3 ? "l3" : "l1",
      untrusted: usedL3,
    });
  }
  if (routed.kind === "rejection") {
    return copilotTurnResponseSchema.parse({
      ok: true,
      turnId,
      kind: "rejection",
      summary: routed.reason,
      routeSource: usedL3 ? "l3" : "l1",
      untrusted: usedL3,
    });
  }
  if (routed.kind !== "routed") {
    return copilotTurnResponseSchema.parse({
      ok: true,
      turnId,
      kind: "clarification",
      summary:
        "请一次描述一个具体目标，或在「AI 协作」工作台分步处理复杂任务。",
      routeSource: usedL3 ? "l3" : "l1",
      untrusted: usedL3,
    });
  }

  if (routed.intent === "draft_story") {
    return await openCreateStoryForm(routed.source);
  }

  let toolName: string;
  let toolInput: Record<string, unknown>;
  let invokeMonth = effectiveMonth;
  let extraNotice = "";
  switch (routed.intent) {
    case "story_progress": {
      const targetStoryId =
        explicitRef ?? l3Params.storyId ?? context.selectedStoryId;
      if (targetStoryId === undefined) {
        return copilotTurnResponseSchema.parse({
          ok: true,
          turnId,
          kind: "clarification",
          summary:
            "请告诉我需要查看的需求编号（例如 #101），或在列表中先选中一条需求。",
          routeSource: routed.source,
          untrusted: routed.source === "l3" || routed.untrusted,
        });
      }
      toolName = "get_story_progress";
      toolInput = { storyId: targetStoryId, view: "full", format: "data" };
      break;
    }
    case "workflow_risks": {
      toolName = "scan_workflow_risks";
      const targetMonth =
        promptMonthPattern.exec(prompt)?.[1] ??
        l3Params.month ??
        effectiveMonth;
      invokeMonth = targetMonth;
      const focusedRules: string[] = [];
      if (/逾期|超期/u.test(prompt) || l3Params.riskFocus === "overdue") {
        focusedRules.push("R01");
      }
      if (/阻塞|滞留/u.test(prompt) || l3Params.riskFocus === "blocked") {
        focusedRules.push("R02", "R03", "R04", "R07", "R11");
      }
      toolInput = {
        scope: { month: targetMonth },
        ...(focusedRules.length > 0
          ? { rules: [...new Set(focusedRules)] }
          : {}),
      };
      if (/研发|设计/u.test(prompt)) {
        extraNotice =
          "（说明：风险扫描接口按月度与规则集过滤，暂不支持按「研发/设计」类别二次筛选，已返回对应规则全部命中供核对。）";
      }
      break;
    }
    case "my_work":
      toolName = "get_my_work";
      toolInput = {};
      break;
    default:
      return copilotTurnResponseSchema.parse({
        ok: true,
        turnId,
        kind: "rejection",
        summary: "该请求不在当前支持的业务意图范围内。",
        routeSource: routed.source,
        untrusted: routed.source === "l3" || routed.untrusted,
      });
  }

  const toolResult = await runtime.invoke(
    role,
    toolName,
    toolInput,
    invokeMonth,
  );
  if (isRevoked()) throw new BztError("AUTH_FAILED", "本次会话已结束。");

  return copilotTurnResponseSchema.parse({
    ok: true,
    turnId,
    kind: "tool_result",
    summary: `已通过可信业务服务（${toolName} · 职责 ${role}）获取最新结构化结果。${extraNotice}`,
    routeSource: routed.source,
    untrusted: true,
    tool: toolName,
    toolResult,
  });
}
