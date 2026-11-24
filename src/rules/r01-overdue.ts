import { summarizeLeafWork } from "../domain/task.ts";
import type { RiskHit, RuleTime } from "./types.ts";

export const id = "R01";
export const name = "任务逾期";

interface Input {
  readonly tasks?: Parameters<typeof summarizeLeafWork>[0];
}

// docs/04 §5 R01、§4.2–4.3。父任务与历史延期不计入当前逾期。
export function evaluate({ tasks = [] }: Input, context: RuleTime): RiskHit[] {
  const { leaves } = summarizeLeafWork(tasks, context);
  const byId = new Map(
    tasks.filter((task) => !task.deleted).map((task) => [task.id, task]),
  );
  return leaves
    .filter(({ time }) => time.status === "overdue")
    .map(({ taskId }) => ({
      ruleId: id,
      objectType: "task",
      objectId: taskId,
      state: "gap",
      severity: "high",
      confidence: "recorded",
      since: byId.get(taskId)?.deadline ?? null,
      evidence: ["叶子任务仍未完成，且已超过截止日"],
      suggestion: "请当前处理人核实进展和截止日期。",
    }));
}
