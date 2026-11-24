import { featureProgress } from "../domain/progress.ts";
import { detectStage, summarizeStages } from "../domain/stage.ts";
import {
  elapsedWorkdays,
  type RiskHit,
  type RuleContext,
  type StageInput,
} from "./types.ts";

export const id = "R02";
export const name = "研发完成测试未接续";

// docs/04 §5 R02、§5.1；docs/09 AC-53。
export function evaluate(
  { story, tasks = [], tasksComplete, required }: StageInput,
  context: RuleContext,
): RiskHit[] {
  if (
    story?.category !== "feature" ||
    story.deleted ||
    story.status !== "active"
  )
    return [];

  const {
    stages: { test, ...upstream },
    hasUnknownTasks,
  } = summarizeStages(tasks);
  const dev = upstream.dev;
  const inter = upstream.interface;
  if (
    hasUnknownTasks ||
    dev?.status !== "completed" ||
    (required?.interface && inter?.status !== "completed") ||
    !featureProgress({
      ...story,
      stages: upstream,
      tasksComplete,
      required,
    }).flags.includes(id)
  )
    return [];

  const missing = !test || test.status === "missing";
  if (!missing) {
    if (test.status !== "in_progress") return [];
    // 沿用阶段汇总的叶子和继承口径。只有每个测试叶子都在 wait 才算尚未接续。
    const waiting = summarizeStages(
      tasks.map((task) => ({
        ...task,
        status: task.status === "wait" ? "done" : "doing",
      })),
    );
    if (waiting.stages.test?.status !== "completed") return [];
  }

  // 接口阶段也已完成时，两段完成时间都明确才能知道实际起点。
  const interfaceFinished =
    inter?.status === "completed" ? inter.finishedDate : dev.finishedDate;
  const elapsed =
    dev.finishedDate === undefined || interfaceFinished === undefined
      ? null
      : elapsedWorkdays(Math.max(dev.finishedDate, interfaceFinished), context);
  const threshold = missing
    ? (context.thresholds?.R02?.missingAfter ?? {
        workdays: 1,
        source: "default",
      })
    : (context.thresholds?.R02?.waitAfter ?? {
        workdays: 2,
        source: "default",
      });
  const stalled = elapsed !== null && elapsed.workdays > threshold.workdays;
  if (!missing && !stalled) return [];

  const inferred = tasks.some((task) => {
    if (task.deleted) return false;
    const { stage, confidence } = detectStage(task, task.evidence);
    return (
      confidence === "inferred" &&
      (stage === "dev" || stage === "interface" || stage === "test")
    );
  });

  return [
    {
      ruleId: id,
      objectType: "story",
      objectId: story.id,
      state: stalled ? "stalled" : "gap",
      severity: "high",
      confidence: inferred ? "inferred" : "recorded",
      since: elapsed?.since ?? null,
      threshold,
      evidence: [
        "研发与适用的接口工作已结束",
        missing ? "缺少测试任务" : "测试任务仍在等待",
        ...(elapsed === null ? ["起点未知"] : []),
      ],
      suggestion: missing
        ? "请研发主管补建测试任务。"
        : "请研发主管与测试人员确认接续安排。",
    },
  ];
}
