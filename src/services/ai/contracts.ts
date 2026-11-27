import { z } from "zod";

/**
 * CR-009 §4 / §5：AI 原生编排层契约（意图路由、个人模型网关与 Agent 运行时）。
 * M1 全部离线验证：零真实出站 fetch，传输层经注入接口模拟。
 */

// ---------------------------------------------------------------------------
// 意图路由（L1 规则 → L3 模型）
// ---------------------------------------------------------------------------

export const intentNameSchema = z.enum([
  "my_work",
  "story_progress",
  "workflow_risks",
  "draft_story",
  "unsupported",
]);

export type IntentName = z.infer<typeof intentNameSchema>;

/** L1 规则命中的高置信意图；未命中时交 L3 模型分类。 */
export const intentRouteRequestSchema = z.strictObject({
  text: z.string().min(1).max(2000),
  /** 已解析的实体（编号等），来自 resolve_context。 */
  storyId: z.int().positive().optional(),
  requirementId: z.int().positive().optional(),
});

export type IntentRouteRequest = z.infer<typeof intentRouteRequestSchema>;

export const missingParameterSchema = z.strictObject({
  field: z.string().min(1),
  hint: z.string().min(1),
});

export const intentClarificationSchema = z.strictObject({
  kind: z.literal("clarification"),
  question: z.string().min(1),
});

export const intentDecompositionSchema = z.strictObject({
  kind: z.literal("decomposition"),
  intents: z.array(intentRouteRequestSchema).min(2),
});

export const intentRejectionSchema = z.strictObject({
  kind: z.literal("rejection"),
  reason: z.string().min(1),
});

export const intentResultSchema = z.discriminatedUnion("kind", [
  z.strictObject({
    kind: z.literal("routed"),
    intent: intentNameSchema.exclude(["unsupported"]),
    confidence: z.enum(["high", "medium"]),
    source: z.enum(["l1", "l3"]),
    missing: z.array(missingParameterSchema).default([]),
    untrusted: z.boolean().default(false),
  }),
  intentClarificationSchema,
  intentDecompositionSchema,
  intentRejectionSchema,
]);

export type IntentResult = z.infer<typeof intentResultSchema>;

// ---------------------------------------------------------------------------
// 工作区上下文快照
// ---------------------------------------------------------------------------

export const workspaceContextSnapshotSchema = z.strictObject({
  account: z.string().min(1),
  instanceHash: z.string().min(1),
  roles: z.array(z.string()).default([]),
  currentMonth: z.string().regex(/^\d{4}-(?:0[1-9]|1[0-2])$/u),
  /** 供意图路由参考的只读业务摘要（已投影、脱敏）。 */
  summary: z
    .strictObject({
      openStoryCount: z.int().nonnegative().optional(),
      overdueTaskCount: z.int().nonnegative().optional(),
    })
    .default({}),
});

export type WorkspaceContextSnapshot = z.infer<
  typeof workspaceContextSnapshotSchema
>;

// ---------------------------------------------------------------------------
// 个人模型配置与网关策略
// ---------------------------------------------------------------------------

export const personalModelConfigInputSchema = z.strictObject({
  baseUrl: z.string().min(1),
  modelId: z.string().min(1),
  protocol: z.enum([
    "openai-compatible",
    "anthropic-compatible",
    "enterprise-custom",
  ]),
  token: z.string().min(8).max(4096),
});

export type PersonalModelConfigInput = z.infer<
  typeof personalModelConfigInputSchema
>;

export const maskedModelConfigSchema = z.strictObject({
  configured: z.boolean(),
  verified: z.boolean(),
  verifiedAt: z.number().int().optional(),
  baseUrl: z.string().optional(),
  protocol: z
    .enum(["openai-compatible", "anthropic-compatible", "enterprise-custom"])
    .optional(),
  modelId: z.string().optional(),
  tokenHint: z.string().optional(),
  lastErrorCode: z.string().optional(),
});

export type MaskedModelConfig = z.infer<typeof maskedModelConfigSchema>;

export const allowedGatewayRuleSchema = z.strictObject({
  origin: z.string().min(1),
  /** 管理员显式允许 http: 或私网地址时置 true。 */
  allowInsecure: z.boolean().default(false),
  allowPrivateNetwork: z.boolean().default(false),
  pathPrefix: z.string().optional(),
});

export type AllowedGatewayRule = z.infer<typeof allowedGatewayRuleSchema>;

export const modelGatewayPolicySchema = z.strictObject({
  allowedGateways: z.array(allowedGatewayRuleSchema).default([]),
  timeoutMs: z.int().positive().default(15_000),
  maxTokens: z.int().positive().default(2048),
});

export type ModelGatewayPolicy = z.infer<typeof modelGatewayPolicySchema>;

// ---------------------------------------------------------------------------
// 模型消息与补全
// ---------------------------------------------------------------------------

export const modelMessageSchema = z.strictObject({
  role: z.enum(["system", "user", "assistant"]),
  content: z.string(),
});

export type ModelMessage = z.infer<typeof modelMessageSchema>;

export const modelCompletionRequestSchema = z.strictObject({
  messages: z.array(modelMessageSchema).min(1),
  maxTokens: z.int().positive().optional(),
  abortSignal: z
    .custom<AbortSignal>((value) => value instanceof AbortSignal)
    .optional(),
});

export type ModelCompletionRequest = z.infer<
  typeof modelCompletionRequestSchema
>;

export const modelCompletionResponseSchema = z.strictObject({
  text: z.string(),
  finishReason: z.enum(["stop", "length", "error"]),
  usage: z
    .strictObject({
      promptTokens: z.int().nonnegative().optional(),
      completionTokens: z.int().nonnegative().optional(),
    })
    .default({}),
});

export type ModelCompletionResponse = z.infer<
  typeof modelCompletionResponseSchema
>;

// ---------------------------------------------------------------------------
// Agent 工作计划与回合状态
// ---------------------------------------------------------------------------

export const agentWorkPlanSchema = z.strictObject({
  steps: z
    .array(
      z.strictObject({
        tool: z.string().min(1),
        rationale: z.string(),
        input: z.record(z.string(), z.unknown()).optional(),
      }),
    )
    .default([]),
  /** 计划只是 Agent 的执行意图，不是已授权的操作（区别于 OperationPlan）。 */
  intent: intentNameSchema.optional(),
});

export type AgentWorkPlan = z.infer<typeof agentWorkPlanSchema>;

export const agentTurnStateSchema = z.enum([
  "pending",
  "routing",
  "planning",
  "running",
  "awaiting_human",
  "done",
  "cancelled",
  "failed",
]);

export type AgentTurnState = z.infer<typeof agentTurnStateSchema>;
