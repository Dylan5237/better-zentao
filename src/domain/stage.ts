import type { Task } from "../core/dto/task.ts";
import { htmlFragments } from "./html-fragments.ts";
import { isCancelledTask } from "./task.ts";

const stageRules = {
  design: { prefix: "【设计】", keywords: /调研|概要|概设|原型|\bUI\b/iu },
  review: { prefix: "【评审】", keywords: /评审/u },
  handoff: { prefix: "【传递】", keywords: /传递/u },
  dev: { prefix: "【研发】", keywords: /开发|研发/u },
  interface: { prefix: "【接口】", keywords: /接口|联调/u },
  test: { prefix: "【测试】", keywords: /测试|用例/u },
  acceptance: { prefix: "【验收】", keywords: /验收/u },
  delivery: { prefix: "【交付】", keywords: /交付|培训|手册/u },
};

export type Stage = keyof typeof stageRules;

function isStage(value: string): value is Stage {
  return Object.hasOwn(stageRules, value);
}

const stages = Object.keys(stageRules).filter(isStage);
const designStages: readonly Stage[] = ["design", "review", "handoff"];

const defaultWeights = {
  title: 3,
  assigneeGroup: 2,
  execution: 1,
  taskType: 1,
};

interface StageEvidence {
  readonly childTitles?: readonly string[];
  readonly executionKind?: "design" | "dev" | "ui";
  readonly assigneeGroup?: "design" | "test";
  readonly weights?: Partial<Record<keyof typeof defaultWeights, number>>;
  readonly prefixes?: Partial<Record<Stage, string>>;
}

type StageDetection =
  | { readonly stage: Stage; readonly confidence: "confirmed" | "inferred" }
  | { readonly stage: "unknown"; readonly confidence: "unknown" };

type StageTask = Pick<Task, "name"> & Partial<Pick<Task, "type" | "desc">>;

// docs/04 §3.2 同类信号每个阶段只计一次。最高分并列时保留未知。
export function detectStage(
  task: StageTask,
  evidence: StageEvidence = {},
): StageDetection {
  for (const [fragment] of (task.desc ?? "").matchAll(htmlFragments)) {
    const marker = /^<!--\s*bzt:stage=([a-z]+)\s*-->$/u.exec(fragment)?.[1];
    if (marker && isStage(marker))
      return { stage: marker, confidence: "confirmed" };
  }

  for (const stage of stages) {
    const { prefix } = stageRules[stage];
    if (task.name.startsWith(evidence.prefixes?.[stage] ?? prefix)) {
      return { stage, confidence: "confirmed" };
    }
  }

  const weights = { ...defaultWeights, ...evidence.weights };
  const titles = [task.name, ...(evidence.childTitles ?? [])];
  const groupStages: readonly (Stage | undefined)[] =
    evidence.assigneeGroup === "design"
      ? ["design", "acceptance"]
      : [evidence.assigneeGroup];
  const ranked = stages
    .map((stage) => {
      const titleMatches = titles.some((title) =>
        stageRules[stage].keywords.test(title),
      );
      const executionMatches =
        evidence.executionKind === "design" && designStages.includes(stage);
      const typeMatches =
        (stage === "test" || stage === "design") && task.type === stage;
      const score =
        Number(titleMatches) * weights.title +
        Number(groupStages.includes(stage)) * weights.assigneeGroup +
        Number(executionMatches) * weights.execution +
        Number(typeMatches) * weights.taskType;
      return { stage, score };
    })
    .sort((left, right) => right.score - left.score);
  const [best, runnerUp] = ranked;
  if (best && best.score >= 3 && best.score !== runnerUp?.score) {
    return { stage: best.stage, confidence: "inferred" };
  }
  return { stage: "unknown", confidence: "unknown" };
}

export type StageState =
  | { readonly status: "completed"; readonly finishedDate?: number }
  | { readonly status: "in_progress" | "cancelled" | "missing" };

export interface StageSummary {
  readonly stages: Readonly<Partial<Record<Stage, StageState>>>;
  readonly hasUnknownTasks: boolean;
}

type StageLeaf = StageTask &
  Pick<Task, "status"> &
  Partial<
    Pick<
      Task,
      "id" | "parent" | "isParent" | "closedReason" | "finishedDate" | "deleted"
    >
  > & { readonly evidence?: StageEvidence };

function summarizeStage(tasks: readonly StageLeaf[]): StageState {
  if (tasks.every(isCancelledTask)) {
    return {
      status: tasks.every((task) => task.closedReason?.trim())
        ? "cancelled"
        : "missing",
    };
  }
  if (
    tasks.some(
      (task) =>
        isCancelledTask(task) ||
        (task.status !== "closed" && task.status !== "done"),
    )
  ) {
    return { status: "in_progress" };
  }
  let finishedDate: number | undefined;
  for (const task of tasks) {
    if (
      task.finishedDate != null &&
      (finishedDate === undefined || task.finishedDate > finishedDate)
    ) {
      finishedDate = task.finishedDate;
    }
  }
  return finishedDate === undefined
    ? { status: "completed" }
    : { status: "completed", finishedDate };
}

// docs/04 §3.3 以叶子汇总阶段。未观察到的阶段在结果中省略，等同缺失。
export function summarizeStages(tasks: readonly StageLeaf[]): StageSummary {
  const activeTasks = tasks.filter((task) => !task.deleted);
  const tasksById = new Map<number, StageLeaf>();
  for (const task of activeTasks) {
    if (task.id !== undefined) tasksById.set(task.id, task);
  }

  const groups = new Map<Stage, StageLeaf[]>();
  const ancestorsWithLeaves = new Set<number>();
  let hasUnknownTasks = false;
  for (const task of activeTasks) {
    if (task.isParent) continue;

    let ancestorStage: Stage | undefined;
    const visited = new Set([task.id]);
    let parentId = task.parent;
    // 找到最近的阶段后仍需向上查找，记录所有拥有叶子的祖先。
    while (parentId != null && !visited.has(parentId)) {
      const ancestor = tasksById.get(parentId);
      if (!ancestor) break;
      visited.add(parentId);
      ancestorsWithLeaves.add(parentId);
      if (ancestorStage === undefined) {
        const detection = detectStage(ancestor, ancestor.evidence);
        if (detection.stage !== "unknown") ancestorStage = detection.stage;
      }
      parentId = ancestor.parent;
    }

    const stage = ancestorStage ?? detectStage(task, task.evidence).stage;
    if (stage === "unknown") {
      hasUnknownTasks = true;
      continue;
    }
    const group = groups.get(stage);
    if (group) group.push(task);
    else groups.set(stage, [task]);
  }
  hasUnknownTasks ||= activeTasks.some(
    (task) =>
      task.isParent &&
      (task.id === undefined || !ancestorsWithLeaves.has(task.id)),
  );

  const summary: Partial<Record<Stage, StageState>> = {};
  for (const [stage, leaves] of groups) summary[stage] = summarizeStage(leaves);
  return { stages: summary, hasUnknownTasks };
}
