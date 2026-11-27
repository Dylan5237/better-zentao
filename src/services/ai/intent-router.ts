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

/** L3 模型分类器适配器：输入文本与工作台上下文，输出结构化意图判定。 */
export type IntentClassifier = (
  text: string,
  context: WorkspaceContextSnapshot,
) => Promise<
  | {
      readonly kind: "label";
      readonly intent: string;
      readonly confidence: "high" | "medium";
    }
  | { readonly kind: "ambiguous"; readonly question?: string | undefined }
  | { readonly kind: "unsupported"; readonly reason?: string | undefined }
>;

const dateLikePattern = /\b\d{4}-\d{2}(?:-\d{2})?\b/gu;
const storyRef = /(?:#|(?:需求|story)\s*#?)(\d{2,6})\b/iu;
export const riskWords = /风险|巡检|扫描|排查|逾期|超期|阻塞|滞留|缺口/u;
export const myWorkWords =
  /(我|本人)?(今天|当前)?(要做什么|的工作|待办|任务列表)/u;
const draftWords =
  /(?:拟定|起草|提交|创建|新建|发起)(?:一[条个])?(?:需求|story)/iu;
export const progressWords = /(进展|进度|做到哪|什么状态|什么阶段)/u;
const storyContextWords =
  /(?:需求|story|这条|这个需求|该需求|选中需求|当前需求)/iu;
const multiIntentJoinWords = /(?:同时|顺便|顺带|并且|另外|再帮我)/u;
const standaloneProgressPattern =
  /^(?:请|帮我)?(?:看|查|查看)?(?:一下)?(?:当前)?(?:进展|进度|做到哪了?|什么状态|什么阶段)[？?]?$/u;
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
    const hasRisk = riskWords.test(text);
    const hasMyWork = myWorkWords.test(text);
    const hasDraft = draftWords.test(text);
    // 仅当文本显式提及需求编号，或在选中需求时具备明确需求语境/纯进展问法，才命中需求进展；
    // 绝不因页面存在 selectedStoryId 就把「航班什么状态」等无关请求或歧义文本劫持进 story_progress。
    const hasProgress =
      explicitStory !== undefined
        ? progressWords.test(text) ||
          (!hasRisk &&
            !hasDraft &&
            !hasMyWork &&
            /(?:看|查|查看|打开|了解|详情|需求|story|^)\s*#?\d{2,6}/iu.test(
              text,
            ))
        : input.storyId !== undefined &&
          progressWords.test(text) &&
          (storyContextWords.test(text) ||
            standaloneProgressPattern.test(text.trim()));

    // 多意图共存（命中多个意图族，或包含明确并列连接词）时，L1 不静默择一，交由 L3 澄清或拆解。
    const familyCount = [hasRisk, hasMyWork, hasDraft, hasProgress].filter(
      Boolean,
    ).length;
    if (familyCount > 1 || multiIntentJoinWords.test(text)) return undefined;

    if (hasRisk && explicitStory === undefined)
      return {
        kind: "routed",
        intent: "workflow_risks",
        confidence: "high",
        source: "l1",
        missing: [],
        untrusted: false,
      };
    if (
      hasProgress &&
      (explicitStory !== undefined || input.storyId !== undefined)
    )
      return {
        kind: "routed",
        intent: "story_progress",
        confidence: "high",
        source: "l1",
        missing: [],
        untrusted: false,
      };
    if (hasRisk)
      return {
        kind: "routed",
        intent: "workflow_risks",
        confidence: "high",
        source: "l1",
        missing: [],
        untrusted: false,
      };
    if (hasDraft)
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
    if (hasMyWork)
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
      return {
        kind: "rejection",
        reason: verdict.reason?.trim() || "该请求不在当前支持范围内。",
      };
    if (verdict.kind === "ambiguous")
      return {
        kind: "clarification",
        question:
          verdict.question?.trim() ||
          "请问您想查询个人工作、需求进展、扫描风险还是提出新需求？",
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
