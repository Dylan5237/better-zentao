import { summarizeRelease } from "../domain/release.ts";
import type { RiskHit, RuleContext, RuleInput } from "./types.ts";

export const id = "R13";
export const name = "发布门禁未满足";

// docs/03 N12、docs/04 §4.8、§5 R13。以版本就绪结果为准，并按阻塞需求输出。
export function evaluate(
  { release }: RuleInput,
  context: RuleContext,
): RiskHit[] {
  if (!release) return [];
  const { today, calendar } = context;
  const summary = summarizeRelease({ ...release, today, calendar });
  const threshold = context.thresholds?.R13?.beforeRelease ?? {
    workdays: 3,
    source: "default",
  };
  if (
    summary.gate !== "blocked" ||
    summary.workdaysUntilRelease === null ||
    summary.workdaysUntilRelease > threshold.workdays
  )
    return [];

  const inRelease = new Set(summary.storyIds);
  const waived = new Set(summary.waivers.map((waiver) => waiver.storyId));
  const incompleteTests = new Set(summary.testIncompleteStoryIds);
  const missingTestEvidence = new Set(summary.testEvidenceMissingStoryIds);
  const hits: RiskHit[] = [];
  for (const story of release.stories) {
    if (
      story.product !== release.product ||
      !inRelease.delete(story.id) ||
      story.progress === "已取消" ||
      waived.has(story.id)
    )
      continue;

    const evidence: string[] = [];
    const missingEvidence = missingTestEvidence.has(story.id);
    if (incompleteTests.has(story.id)) {
      evidence.push(
        missingEvidence ? "测试阶段证据不完整" : "发布门禁要求测试完成",
      );
      if (!missingEvidence && summary.flags.includes("已发布·测试未完成"))
        evidence.push("已发布·测试未完成");
    }
    if (
      story.bugs.some(
        (bug) =>
          !bug.deleted &&
          bug.status !== "closed" &&
          (bug.severity === 1 || bug.severity === 2),
      )
    )
      evidence.push("关联的严重 Bug 尚未关闭");
    if (!evidence.length) continue;
    hits.push({
      ruleId: id,
      objectType: "story",
      objectId: story.id,
      state: "gap",
      severity: "high",
      confidence: missingEvidence ? "inferred" : "recorded",
      since: null,
      threshold,
      evidence,
      suggestion: "请核对测试与严重 Bug 的处置情况，并确认发布安排。",
    });
  }
  return hits;
}
