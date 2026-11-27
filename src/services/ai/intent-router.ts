import { z } from "zod";
import { BztError } from "../../core/errors.ts";
import {
  intentResultSchema,
  intentRouteRequestSchema,
  type IntentResult,
  type IntentRouteRequest,
} from "./contracts.ts";
import type { WorkspaceContextSnapshot } from "./contracts.ts";

/**
 * CR-009 §4 / AI-01：三层意图漏斗的 M1 最小实现。
 * L1 = 确定性规则匹配（高置信短路）；L3 = 注入的模型分类器适配器。
 * 歧义澄清、缺项追问、多意图拆解、不支持拒识与不可信文本标记全部落地。
 */

/** L3 模型分类器适配器：输入文本，输出意图标签（替身实现用于离线验证）。 */
export type IntentClassifier = (
  text: string,
  context: WorkspaceContextSnapshot,
) => Promise<
  | {
      readonly kind: "label";
      readonly intent: string;
      readonly confidence: "high" | "medium";
    }
  | { readonly kind: "ambiguous" }
  | { readonly kind: "unsupported" }
>;

const dateLikePattern = /\b\d{4}-\d{2}(?:-\d{2})?\b/gu;
const storyRef = /[##]?\b(\d{2,6})\b/u;
export const riskWords = /风险|巡检|扫描|排查|逾期|超期|阻塞|滞留|缺口/u;
export const myWorkWords =
  /(我|本人)?(今天|当前)?(要做什么|的工作|待办|任务列表)/u;
const draftWords = /(拟定|起草|提交|创建|新建)一条?(需求|story)/iu;
const progressWords = /(进展|进度|做到哪|什么状态|什么阶段)/u;
const injectionMarkers =
  /(忽略(以上|之前)(的)?(指令|提示)|disregard|system\s*prompt|你现在是|假装你是|jailbreak)/iu;

/** 提取文本中的需求编号，自动排除 YYYY-MM / YYYY-MM-DD 日期中的年份（如「巡检 2026-11」）。 */
export function extractStoryRef(text: string): number | undefined {
  const withoutDates = text.replace(dateLikePattern, " ");
  const matched = storyRef.exec(withoutDates)?.[1];
  return matched === undefined ? undefined : Number(matched);
}

const intentLabels = [
  "my_work",
  "story_progress",
  "workflow_risks",
  "draft_story",
] as const;

type IntentLabel = (typeof intentLabels)[number];

function isIntentLabel(value: string): value is IntentLabel {
  return intentLabels.some((label) => label === value);
}

export interface IntentRouterOptions {
  /** L3 模型分类器（M1 用规则替身或注入假模型）。 */
  readonly classify?: IntentClassifier | undefined;
}

export function createIntentRouter(options: IntentRouterOptions = {}) {
  const l1Route = (input: IntentRouteRequest): IntentResult | undefined => {
    const text = input.text;
    const explicitStory = extractStoryRef(text);
    // 明确询问风险/逾期/阻塞/巡检且文本中未点名具体需求编号时，优先路由到风险扫描，不被环境 selectedStoryId 劫持。
    if (riskWords.test(text) && explicitStory === undefined)
      return {
        kind: "routed",
        intent: "workflow_risks",
        confidence: "high",
        source: "l1",
        missing: [],
        untrusted: false,
      };
    if (input.storyId !== undefined || explicitStory !== undefined) {
      if (progressWords.test(text) || input.storyId !== undefined)
        return {
          kind: "routed",
          intent: "story_progress",
          confidence: "high",
          source: "l1",
          missing: [],
          untrusted: false,
        };
    }
    if (riskWords.test(text))
      return {
        kind: "routed",
        intent: "workflow_risks",
        confidence: "high",
        source: "l1",
        missing: [],
        untrusted: false,
      };
    if (draftWords.test(text))
      return {
        kind: "routed",
        intent: "draft_story",
        confidence: "high",
        source: "l1",
        missing: [
          { field: "product", hint: "请说明需求所属产品。" },
          { field: "title", hint: "请给出需求标题。" },
        ],
        untrusted: false,
      };
    if (myWorkWords.test(text))
      return {
        kind: "routed",
        intent: "my_work",
        confidence: "high",
        source: "l1",
        missing: [],
        untrusted: false,
      };
    return undefined;
  };

  const l3Route = async (
    input: IntentRouteRequest,
    context: WorkspaceContextSnapshot,
  ): Promise<IntentResult> => {
    const classifier = options.classify;
    if (!classifier)
      return {
        kind: "rejection",
        reason: "未配置模型分类器，无法理解该请求。",
      };
    const verdict = await classifier(input.text, context);
    if (verdict.kind === "unsupported")
      return { kind: "rejection", reason: "该请求不在当前支持范围内。" };
    if (verdict.kind === "ambiguous")
      return {
        kind: "clarification",
        question: "请问您想查询个人工作、需求进展还是扫描风险？",
      };
    if (!isIntentLabel(verdict.intent))
      return { kind: "rejection", reason: "该请求不在当前支持范围内。" };
    return {
      kind: "routed",
      intent: verdict.intent,
      confidence: verdict.confidence,
      source: "l3",
      missing: [],
      untrusted: false,
    };
  };

  return {
    async route(
      raw: unknown,
      context: WorkspaceContextSnapshot,
    ): Promise<IntentResult> {
      const parsed = intentRouteRequestSchema.safeParse(raw);
      if (!parsed.success)
        throw new BztError("INVALID_INPUT", "意图路由请求不合法。");
      const input = parsed.data;
      // 提示词注入检测：文本标记为不可信但不改变行为（红线 8）。
      const untrusted = injectionMarkers.test(input.text);
      const direct = l1Route(input);
      if (direct && direct.kind === "routed" && direct.confidence === "high")
        return { ...direct, untrusted: untrusted || direct.untrusted };
      const fallback = await l3Route(input, context);
      return untrusted && fallback.kind === "routed"
        ? { ...fallback, untrusted: true }
        : fallback;
    },

    /** 多意图拆解：按句号/分号/换行切成子请求，逐一路由。 */
    async decompose(
      raw: unknown,
      context: WorkspaceContextSnapshot,
    ): Promise<IntentResult[]> {
      const parsed = intentRouteRequestSchema.safeParse(raw);
      if (!parsed.success)
        throw new BztError("INVALID_INPUT", "意图路由请求不合法。");
      const segments = parsed.data.text
        .split(/[。;；\n]+/u)
        .map((part) => part.trim())
        .filter(Boolean);
      if (segments.length < 2)
        throw new BztError("INVALID_INPUT", "文本不包含多个意图。");
      return Promise.all(
        segments.map((text) => this.route({ ...parsed.data, text }, context)),
      );
    },
  };
}

export type IntentRouter = ReturnType<typeof createIntentRouter>;

/** 校验拆解结果形状（测试辅助）。 */
export function assertIntentResults(value: unknown): IntentResult[] {
  return z.array(intentResultSchema).parse(value);
}
