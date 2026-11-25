import { civilDate } from "../core/calendar.ts";
import type { Bug } from "../core/dto/bug.ts";
import type { Story } from "../core/dto/story.ts";
import type { Stage, StageSummary } from "./stage.ts";

type ProgressInput = Pick<Story, "status"> &
  Pick<StageSummary, "stages"> &
  Partial<Pick<StageSummary, "hasUnknownTasks">> & {
    readonly tasksComplete?: boolean;
  };

interface FeatureInput extends ProgressInput, Pick<Story, "closedReason"> {
  readonly required?: Readonly<Partial<Record<Stage, boolean>>>;
  readonly bugs?: readonly (Pick<Bug, "status" | "severity"> &
    Pick<Bug, "deleted">)[];
  readonly today?: string;
  readonly releaseDate?: string | null;
}

const featureStages = [
  "dev",
  "interface",
  "test",
  "acceptance",
  "delivery",
] as const;
const defaultRequired: readonly Stage[] = ["dev", "test", "acceptance"];
const cancelledReasons = new Set([
  "cancel",
  "duplicate",
  "postponed",
  "willnotdo",
]);

function hasTasks({ stages, hasUnknownTasks }: ProgressInput): boolean {
  return hasUnknownTasks === true || Object.keys(stages).length > 0;
}

function isDraft(status: string): boolean {
  return status === "draft" || status === "reviewing";
}

// docs/04 §4.4、§6 关闭需要阶段证据。综合任务保留为无法判断。
function classifyFeature(input: FeatureInput): FeatureProgress {
  const { status, stages, closedReason, bugs, hasUnknownTasks } = input;
  const isRequired = (stage: Stage) =>
    input.required?.[stage] ?? defaultRequired.includes(stage);
  const completed = (stage: Stage) => stages[stage]?.status === "completed";
  const inProgress = (stage: Stage) => stages[stage]?.status === "in_progress";

  if (isDraft(status)) return "未就绪";
  if (status === "closed") {
    if (closedReason && cancelledReasons.has(closedReason)) return "已取消";
    if (input.tasksComplete === false) return "已关闭·证据缺失";
    const required = featureStages.filter(isRequired);
    const allRequiredCompleted = required.every(completed);
    return allRequiredCompleted && featureStages.some(completed)
      ? "已完成"
      : "已关闭·证据缺失";
  }
  if (input.tasksComplete === false) return "无法判断";
  if (!hasTasks(input)) return "待接收";
  if (inProgress("dev") || inProgress("interface")) return "研发中";
  if (hasUnknownTasks && !featureStages.some(completed)) return "无法判断";
  const testMissing = !stages.test || stages.test.status === "missing";
  if (isRequired("test") && testMissing) return "待测试";
  const seriousBug = bugs?.some(
    ({ severity, status, deleted }) =>
      !deleted && (severity === 1 || severity === 2) && status !== "closed",
  );
  if ((!testMissing && !completed("test")) || seriousBug) return "测试中";
  if (isRequired("acceptance") && !completed("acceptance")) return "待验收";
  if (isRequired("delivery") && !completed("delivery")) return "待交付";
  return featureStages.some(completed) ? "可关闭" : "无法判断";
}

export function featureProgress(input: FeatureInput) {
  const progress = classifyFeature(input);
  const flags: ("R02" | "已发布·测试未完成")[] = [];
  const { today, releaseDate, stages } = input;
  // docs/04 §5 R02 需要研发完成以及适用的接口阶段结束。
  if (
    progress === "待测试" &&
    stages.dev?.status === "completed" &&
    (!stages.interface ||
      stages.interface.status === "completed" ||
      stages.interface.status === "cancelled")
  )
    flags.push("R02");
  if (
    input.tasksComplete !== false &&
    stages.test?.status !== "completed" &&
    today &&
    releaseDate &&
    civilDate.safeParse(today).success &&
    civilDate.safeParse(releaseDate).success &&
    today > releaseDate
  )
    flags.push("已发布·测试未完成");
  return { progress, flags };
}

export type FeatureProgress =
  | "未就绪"
  | "已取消"
  | "已完成"
  | "已关闭·证据缺失"
  | "无法判断"
  | "待接收"
  | "研发中"
  | "待测试"
  | "测试中"
  | "待验收"
  | "待交付"
  | "可关闭";

// docs/04 §4.7 保留原始分母；零分母没有可计算的比率。
export function completionRate(numerator: number, denominator: number) {
  return {
    numerator,
    denominator,
    rate: denominator > 0 ? numerator / denominator : null,
  };
}

interface DesignInput extends ProgressInput {
  readonly hasRelatedFeature?: boolean;
}

// docs/04 §4.5 草稿已有任务时，按设计阶段证据判断。
export function designProgress(input: DesignInput) {
  const { stages, status, hasRelatedFeature } = input;
  if (input.tasksComplete === false) return { progress: "无法判断", flags: [] };
  if (isDraft(status) && !hasTasks(input))
    return { progress: "未就绪", flags: [] };
  if (stages.design?.status !== "completed")
    return { progress: "设计中", flags: [] };
  if (stages.review?.status !== "completed")
    return { progress: "待评审", flags: [] };
  if (stages.handoff?.status !== "completed")
    return { progress: "待传递", flags: [] };
  if (!hasRelatedFeature) return { progress: "待移交", flags: ["R07"] };
  return { progress: "已移交", flags: [] };
}
