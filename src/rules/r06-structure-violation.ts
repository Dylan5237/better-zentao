import { summarizeStages, type Stage } from "../domain/stage.ts";
import { isActiveFeature, localDate, storyTasks } from "./p2-evidence.ts";
import type { RiskHit, RuleContext, RuleInput } from "./types.ts";

export const id = "R06";
export const name = "结构违规";

const stages = [
  ["dev", "研发", true],
  ["interface", "接口", false],
  ["test", "测试", true],
  ["acceptance", "验收", true],
  ["delivery", "交付", false],
] as const satisfies readonly (readonly [Stage, string, boolean])[];

function hit(
  objectType: "story" | "task",
  objectId: number,
  since: string | null,
  evidence: string[],
): RiskHit {
  return {
    ruleId: id,
    objectType,
    objectId,
    state: "gap",
    severity: "medium",
    confidence: "recorded",
    since,
    evidence,
    suggestion: "请核对需求的 L3 计划、任务归属及阶段拆解。",
  };
}

// docs/04 §5 R06、§6。只有多人任务和缺阶段检查受上线日约束。
export function evaluate(input: RuleInput, context: RuleContext): RiskHit[] {
  const { story, tasks = [], plan, hasL3Plan } = input;
  const { systemStartDate } = context;
  const isNew = (since: string | null) =>
    since !== null && systemStartDate !== undefined && since >= systemStartDate;
  const hits: RiskHit[] = [];

  if (isActiveFeature(story)) {
    const since = localDate(story.openedDate, context);
    const evidence: string[] = [];
    const missingPlan =
      hasL3Plan !== undefined
        ? !hasL3Plan
        : plan !== undefined
          ? plan?.kind !== "l3" || plan.deleted === true
          : story.plan?.length === 0;
    if (missingPlan) evidence.push("研发需求未挂 L3 计划");
    if (isNew(since) && input.tasksComplete !== false) {
      const linked = storyTasks(tasks, story.id);
      if (linked.some((task) => !task.deleted)) {
        const summary = summarizeStages(linked);
        const missing = stages
          .filter(([stage, , required]) => {
            const status = summary.stages[stage]?.status;
            return (
              (input.required?.[stage] ?? required) &&
              (status === undefined || status === "missing")
            );
          })
          .map(([, label]) => label);
        if (missing.length)
          evidence.push("已拆解的研发需求缺少必需阶段：" + missing.join("、"));
      }
    }
    if (evidence.length) hits.push(hit("story", story.id, since, evidence));
  }

  for (const task of tasks) {
    if (task.deleted) continue;
    const evidence: string[] = [];
    const since = localDate(task.openedDate, context);
    if (task.story === null) evidence.push("任务未关联需求");
    if ((task.mode === "linear" || task.mode === "multi") && isNew(since))
      evidence.push("系统上线后新建了多人任务");
    if (evidence.length) hits.push(hit("task", task.id, since, evidence));
  }
  return hits;
}
