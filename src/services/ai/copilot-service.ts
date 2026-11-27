import { createHash, randomBytes } from "node:crypto";
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
      rationale: "从自然语言诉求提炼需求标题",
    });
  }
  if (trimmed.length >= 6 && !String(form.fields["spec.scope"] ?? "").trim()) {
    candidates.push({
      field: "spec.scope",
      value: trimmed,
      rationale: "根据自然语言描述补全本次实现范围（N03）",
    });
  }
  if (
    /验收|测试|标准/u.test(trimmed) ||
    !String(form.fields.verify ?? "").trim()
  ) {
    candidates.push({
      field: "verify",
      value: `1. ${cleanTitle || "核心功能"}按实现范围可正常使用；2. 权限与边界条件符合团队规范。`,
      rationale: "生成可核对的验收标准草稿（请人工复核补充）",
    });
  }
  return candidates;
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
    const candidates =
      parsed.patches.length > 0
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

    const autoCount = proposal.patches.filter(
      (p) => p.mode === "fill_empty",
    ).length;
    const conflictCount = proposal.patches.filter(
      (p) => p.mode === "propose_replace",
    ).length;
    const summary =
      parsed.summary ??
      (proposal.patches.length === 0
        ? "未发现需要调整的表单字段，可继续手工编辑或点击「预览并创建」。"
        : `已生成 ${proposal.patches.length} 项字段建议（自动填充空字段 ${autoCount} 项，待您采纳的覆盖建议 ${conflictCount} 项）。`);

    return copilotTurnResponseSchema.parse({
      ok: true,
      turnId,
      kind: "form_patch",
      summary,
      routeSource: "in_context",
      // CR-009 P1-6 / AGENTS.md 红线 8：模型派生文本与字段建议一律标为不可信数据。
      untrusted: true,
      proposal,
    });
  }

  // 2. 自然语言发起提需：由系统打开同一正式「提出需求」表单并注入受控草稿，绝不维护第二套表单。
  if (intakeTriggerPattern.test(prompt)) {
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
    const candidates =
      parsed.patches.length > 0
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

    return copilotTurnResponseSchema.parse({
      ok: true,
      turnId,
      kind: "open_form_patch",
      summary:
        parsed.summary ??
        "已为您打开正式「提出需求」表单并填充初步草稿，请核对补充后点击「预览并创建」。",
      routeSource: "in_context",
      untrusted: true,
      openForm: { section: "intake", tool: "create_story" },
      proposal,
    });
  }

  // 3. 在需求台账上的原位筛选建议：仅当用户所有筛选条件都能完整映射为可执行台账条件时返回，
  //    若包含风险/逾期/阻塞/巡检等台账不支持的筛选词，绝不丢弃主要条件，直接转交风险扫描或查询。
  if (
    context.view === "stories" &&
    filterTriggerPattern.test(prompt) &&
    !riskWords.test(prompt)
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

  // 4. 其余分析/查询类意图：通过 IntentRouter + CapabilityRuntime(channel="ai") 执行真实业务查询。
  const router = createIntentRouter();
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
      routeSource: "l1",
      untrusted: false,
    });
  }
  if (routed.kind === "rejection") {
    return copilotTurnResponseSchema.parse({
      ok: true,
      turnId,
      kind: "rejection",
      summary: routed.reason,
      routeSource: "l1",
      untrusted: false,
    });
  }
  if (routed.kind !== "routed") {
    return copilotTurnResponseSchema.parse({
      ok: true,
      turnId,
      kind: "clarification",
      summary:
        "请一次描述一个具体目标，或在「AI 协作」工作台分步处理复杂任务。",
      routeSource: "l1",
      untrusted: false,
    });
  }

  let toolName: string;
  let toolInput: Record<string, unknown>;
  let invokeMonth = effectiveMonth;
  let extraNotice = "";
  switch (routed.intent) {
    case "story_progress": {
      if (explicitStoryId === undefined) {
        return copilotTurnResponseSchema.parse({
          ok: true,
          turnId,
          kind: "clarification",
          summary:
            "请告诉我需要查看的需求编号（例如 #101），或在列表中先选中一条需求。",
          routeSource: routed.source,
          untrusted: routed.untrusted,
        });
      }
      toolName = "get_story_progress";
      toolInput = { storyId: explicitStoryId, view: "full", format: "data" };
      break;
    }
    case "workflow_risks": {
      toolName = "scan_workflow_risks";
      const targetMonth =
        promptMonthPattern.exec(prompt)?.[1] ?? effectiveMonth;
      invokeMonth = targetMonth;
      const focusedRules: string[] = [];
      if (/逾期|超期/u.test(prompt)) {
        focusedRules.push("R01");
      }
      if (/阻塞|滞留/u.test(prompt)) {
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
      toolName = "query_stories";
      toolInput = {};
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
