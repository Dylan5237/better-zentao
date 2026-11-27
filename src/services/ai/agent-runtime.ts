import { z } from "zod";
import { BztError } from "../../core/errors.ts";
import type { Clock } from "../../core/clock.ts";
import { agentWorkPlanSchema } from "./contracts.ts";
import type {
  AgentTurnState,
  AgentWorkPlan,
  IntentResult,
  ModelCompletionResponse,
  WorkspaceContextSnapshot,
} from "./contracts.ts";
import type { ModelGateway } from "./model-gateway.ts";
import type { ModelPrincipal } from "./personal-model-store.ts";
import type { IntentRouter } from "./intent-router.ts";
import type { CapabilityRuntime } from "../capability-runtime.ts";

/**
 * CR-009 §4 / AI-01：最小 Agent 执行回合。
 * AgentWorkPlan 与 OperationPlan 严格分离：AI 只能查询、分析与生成
 * 可信操作预览（走上层业务服务的 prepare 路径）；任何确认尝试
 * 由 CapabilityRuntime 以 channel: "ai" 无条件拒绝。
 */

export interface AgentRuntimeOptions {
  readonly principal: ModelPrincipal & {
    readonly sessionId: string;
    readonly roles: readonly string[];
  };
  readonly router: IntentRouter;
  readonly gateway: ModelGateway;
  readonly runtime: CapabilityRuntime;
  readonly context: WorkspaceContextSnapshot;
  readonly clock: Clock;
}

interface TurnRecord {
  readonly turnId: string;
  text: string;
  state: AgentTurnState;
  intent: IntentResult | undefined;
  plan: AgentWorkPlan | undefined;
  result: unknown;
  error: string | undefined;
  createdAt: number;
  updatedAt: number;
}

const maxTurns = 64;
const turnIdPattern = /^turn_[0-9a-f]{16}$/u;

const planTextSchema = z.string().min(1);

const storyRefExtractor = /[##]?\b(\d{2,6})\b/u;

function extractStoryRef(text: string): number | undefined {
  const match = storyRefExtractor.exec(text);
  return match === null ? undefined : Number(match[1]);
}

export function createAgentRuntime(options: AgentRuntimeOptions) {
  const { principal, router, gateway, runtime, context, clock } = options;
  if (runtime.channel !== "ai")
    throw new BztError(
      "PERMISSION_DENIED",
      "AgentRuntime 必须绑定 channel='ai' 的 CapabilityRuntime。",
    );
  const turns = new Map<string, TurnRecord>();
  let sequence = 0;
  const cancelled = new Set<string>();

  function nextTurnId(): string {
    sequence += 1;
    return `turn_${sequence.toString(16).padStart(16, "0")}`;
  }

  const requireTurn = (turnId: string): TurnRecord => {
    const turn = turns.get(turnId);
    if (!turn) throw new BztError("NOT_FOUND", "未找到该 Agent 回合。");
    return turn;
  };

  const planFor = (
    intent: IntentResult,
    storyId: number | undefined,
  ): AgentWorkPlan => {
    if (intent.kind !== "routed") return { steps: [] };
    switch (intent.intent) {
      case "my_work":
        return {
          intent: "my_work",
          steps: [
            { tool: "get_my_work", rationale: "查询个人工作。", input: {} },
          ],
        };
      case "story_progress": {
        return {
          intent: "story_progress",
          steps: [
            {
              tool: "get_story_progress",
              rationale: "查看需求进展。",
              // 工具要求唯一编号；缺号时该步标记缺参，由 runPlan 追问。
              input: storyId === undefined ? undefined : { storyId },
            },
          ],
        };
      }
      case "workflow_risks":
        return {
          intent: "workflow_risks",
          steps: [
            {
              tool: "scan_workflow_risks",
              rationale: "扫描流程风险。",
              input: {},
            },
          ],
        };
      case "draft_story":
        return {
          intent: "draft_story",
          steps: [
            {
              tool: "create_story",
              rationale: "生成可信需求草稿预览（仅预览，不确认）。",
              input: {},
            },
          ],
        };
      default:
        return { steps: [] };
    }
  };

  const runPlan = async (
    turn: TurnRecord,
    plan: AgentWorkPlan,
  ): Promise<unknown> => {
    const steps = plan.steps.filter(({ input }) => input !== undefined);
    if (!steps.length)
      throw new BztError("INVALID_INPUT", "缺少需求编号，请补充后重试。");
    const outputs: unknown[] = [];
    for (const step of steps) {
      if (cancelled.has(turn.turnId)) {
        turn.state = "cancelled";
        throw new BztError("INVALID_INPUT", "Agent 回合已取消。");
      }
      // CapabilityRuntime 以 channel: "ai" 硬编码调用：
      // confirm_operation 无条件拒绝，其余工具仍受角色/范围收窄约束。
      const value = await runtime.invoke(
        principal.roles[0] ?? "FB",
        step.tool,
        step.input,
      );
      outputs.push(value);
    }
    return outputs.length === 1 ? outputs[0] : outputs;
  };

  return {
    /** 执行一个自然语言回合：路由 → 计划 → 工具调用（channel 恒为 "ai"）。 */
    async runTurn(rawText: unknown): Promise<
      Readonly<{
        turnId: string;
        state: AgentTurnState;
        intent: IntentResult | undefined;
      }>
    > {
      const text = planTextSchema.parse(rawText);
      if (turns.size >= maxTurns)
        throw new BztError("INVALID_INPUT", "Agent 回合数已达上限。");
      const turnId = nextTurnId();
      const now = clock();
      const turn: TurnRecord = {
        turnId,
        text,
        state: "routing",
        intent: undefined,
        plan: undefined,
        result: undefined,
        error: undefined,
        createdAt: now,
        updatedAt: now,
      };
      turns.set(turnId, turn);
      cancelled.delete(turnId);
      try {
        const routeRequest = { text };
        const storyId = extractStoryRef(text);
        const intent = await router.route(routeRequest, context);
        turn.intent = intent;
        turn.state = "planning";
        turn.updatedAt = clock();
        if (intent.kind !== "routed") {
          turn.state = "awaiting_human";
          return { turnId, state: turn.state, intent };
        }
        const plan = planFor(intent, storyId);
        turn.plan = plan;
        agentWorkPlanSchema.parse(plan);
        turn.state = "running";
        turn.updatedAt = clock();
        // 模型补全仅用于解释性文本（M1 最小闭环：直接透传路由结果）。
        void gateway;
        turn.result = await runPlan(turn, plan);
        turn.state = "done";
        turn.updatedAt = clock();
        return { turnId, state: turn.state, intent };
      } catch (error) {
        turn.state = "failed";
        turn.error =
          error instanceof BztError ? error.message : "Agent 回合执行失败。";
        turn.updatedAt = clock();
        if (error instanceof BztError) throw error;
        throw new BztError("ZENTAO_UNAVAILABLE", "Agent 回合执行失败。");
      }
    },

    /** 取消进行中的回合（幂等）。 */
    cancel(turnId: string): void {
      if (!turnIdPattern.test(turnId))
        throw new BztError("INVALID_INPUT", "回合编号不合法。");
      const turn = turns.get(turnId);
      if (!turn) throw new BztError("NOT_FOUND", "未找到该 Agent 回合。");
      cancelled.add(turnId);
      if (["done", "failed", "cancelled"].includes(turn.state)) return;
      turn.state = "cancelled";
      turn.updatedAt = clock();
    },

    /** 读取回合状态（含计划与结果，不含凭据）。 */
    getRun(turnId: string): Readonly<{
      turnId: string;
      state: AgentTurnState;
      intent: IntentResult | undefined;
      plan: AgentWorkPlan | undefined;
      result: unknown;
      error: string | undefined;
    }> {
      const turn = requireTurn(turnId);
      return {
        turnId: turn.turnId,
        state: turn.state,
        intent: turn.intent,
        plan: turn.plan,
        result: turn.result,
        error: turn.error,
      };
    },

    /** 模型补全直通（供测试验证网关预算与超时约束）。 */
    async completeTurnText(
      messages: ReadonlyArray<{
        role: "system" | "user" | "assistant";
        content: string;
      }>,
      abortSignal?: AbortSignal,
    ): Promise<ModelCompletionResponse> {
      return gateway.complete(principal, {
        messages: [...messages],
        ...(abortSignal === undefined ? {} : { abortSignal }),
      });
    },
  };
}

export type AgentRuntime = ReturnType<typeof createAgentRuntime>;
