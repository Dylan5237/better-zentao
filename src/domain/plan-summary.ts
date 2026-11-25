import type { WorkCalendar } from "../core/calendar.ts";
import { isInLastWorkdaysOfMonth, monthlyDevPoolIds } from "./month.ts";
import { completionRate, type FeatureProgress } from "./progress.ts";
import {
  isCancelledTask,
  selectLeafTasks,
  type LeafCountTask,
} from "./task.ts";

export interface PlanStory {
  readonly id: number;
  readonly progress: FeatureProgress;
  readonly tasks: readonly LeafCountTask[];
  readonly children?: readonly { readonly id: number }[];
  readonly planKind?: "l3" | "legacyRelease" | "other";
  readonly owner?: string | null;
  readonly module?: number | null;
}

type GroupBy = "owner" | "module" | "progress";

const progressBucket = {
  已完成: "completed",
  研发中: "inProgress",
  待测试: "inProgress",
  测试中: "inProgress",
  待验收: "inProgress",
  待交付: "inProgress",
  可关闭: "inProgress",
  待接收: "toReceive",
  未就绪: "notReady",
  已取消: "cancelled",
  "已关闭·证据缺失": "unknown",
  无法判断: "unknown",
} as const satisfies Record<FeatureProgress, string>;
type PlanBucket = (typeof progressBucket)[FeatureProgress];

function measureStory(story: PlanStory) {
  const leaves = selectLeafTasks(story.tasks).filter(
    (task) => !isCancelledTask(task),
  );
  const completedLeaves = leaves.filter(
    ({ status }) => status === "done" || status === "closed",
  ).length;
  const bucket = progressBucket[story.progress];
  return {
    ...story,
    bucket:
      bucket === "completed" && leaves.length === 0
        ? ("unknown" as const)
        : bucket,
    activeOrDoneLeafTasks: leaves.length,
    completedLeafTasks: completedLeaves,
  };
}

function summarize(stories: readonly ReturnType<typeof measureStory>[]) {
  const counts: Record<PlanBucket, number> = {
    completed: 0,
    inProgress: 0,
    toReceive: 0,
    notReady: 0,
    cancelled: 0,
    unknown: 0,
  };
  let completedLeafTasks = 0;
  let activeOrDoneLeafTasks = 0;
  for (const story of stories) {
    counts[story.bucket]++;
    completedLeafTasks += story.completedLeafTasks;
    activeOrDoneLeafTasks += story.activeOrDoneLeafTasks;
  }
  return {
    total: stories.length,
    counts,
    storyDeliveryRate: completionRate(
      counts.completed,
      stories.length - counts.cancelled,
    ),
    taskCompletionRate: completionRate(
      completedLeafTasks,
      activeOrDoneLeafTasks,
    ),
  };
}

function indexStories<T extends { readonly id: number }>(
  stories: readonly T[],
) {
  const indexed = new Map<number, T>();
  for (const story of stories) {
    if (!indexed.has(story.id)) indexed.set(story.id, story);
  }
  return indexed;
}

// docs/04 §4.7、§6 汇总使用同一份去重后的需求集合与独立分母。
export function summarizePlan(
  stories: readonly PlanStory[],
  asOf: string,
  groupBy?: GroupBy,
) {
  const unique = [...indexStories(stories).values()]
    .filter(
      ({ planKind, children }) =>
        planKind !== "legacyRelease" && !children?.length,
    )
    .map(measureStory);
  const groups = new Map<string | number | null, (typeof unique)[number][]>();
  if (groupBy) {
    for (const story of unique) {
      const key =
        groupBy === "progress" ? story.bucket : (story[groupBy] ?? null);
      const group = groups.get(key);
      if (group) group.push(story);
      else groups.set(key, [story]);
    }
  }
  return {
    asOf,
    ...summarize(unique),
    groups: [...groups].map(([key, group]) => ({ key, ...summarize(group) })),
  };
}

interface MonthlyDevQueueInput {
  readonly month: string;
  readonly today: string;
  readonly calendar: WorkCalendar;
  readonly stories: readonly PlanStory[];
  readonly planStoryIds: readonly number[]; // 来自本月 L3，已排除历史版本计划。
  readonly iterationStoryIds: readonly number[]; // 来自本月研发迭代。
  readonly previousSnapshotStoryIds?: readonly number[];
  readonly historyCarryOverStoryIds?: readonly number[];
}

type QueueStory = PlanStory & { readonly carriedOver: boolean };
const inDev = new Set<FeatureProgress>(["研发中", "待测试", "测试中"]);

// docs/04 §4.6、docs/09 AC-54 先按进展放入主桶，遗留标记独立于主池归属。
export function classifyMonthlyDevQueue(input: MonthlyDevQueueInput) {
  const { month, today, calendar, planStoryIds, iterationStoryIds } = input;
  const mainPoolIds = monthlyDevPoolIds(planStoryIds, iterationStoryIds);
  const currentIds = new Set(mainPoolIds);
  const planIds = new Set(planStoryIds);
  const iterationIds = new Set(iterationStoryIds);
  const previousIds =
    input.previousSnapshotStoryIds ?? input.historyCarryOverStoryIds;
  const carryOverSource = input.previousSnapshotStoryIds
    ? "snapshot"
    : input.historyCarryOverStoryIds
      ? "history"
      : null;
  const carryOverIds = new Set(previousIds);
  const storyById = indexStories(input.stories);
  const buckets: Record<
    | "toReceive"
    | "inDev"
    | "carriedOver"
    | "planNoIteration"
    | "iterationNoPlan",
    QueueStory[]
  > = {
    toReceive: [],
    inDev: [],
    carriedOver: [],
    planNoIteration: [],
    iterationNoPlan: [],
  };
  const notReady: QueueStory[] = [];
  const unbucketedStoryIds: number[] = [];
  const missingStoryIds: number[] = [];

  for (const id of monthlyDevPoolIds(mainPoolIds, [...carryOverIds])) {
    const story = storyById.get(id);
    if (!story) {
      missingStoryIds.push(id);
      continue;
    }
    const current = currentIds.has(id);
    const { progress } = story;
    const carriedOver =
      carryOverIds.has(id) && progress !== "已完成" && progress !== "已取消";
    const item = { ...story, carriedOver };
    if (current && progress === "未就绪") notReady.push(item);
    else if (current && progress === "待接收") buckets.toReceive.push(item);
    else if (current && inDev.has(progress)) buckets.inDev.push(item);
    else if (carriedOver) buckets.carriedOver.push(item);
    else if (planIds.has(id) && !iterationIds.has(id))
      buckets.planNoIteration.push(item);
    else if (
      iterationIds.has(id) &&
      !planIds.has(id) &&
      story.planKind !== "l3"
    )
      buckets.iterationNoPlan.push(item);
    else if (current) unbucketedStoryIds.push(id);
  }
  const monthEndWarnings =
    today.slice(0, 7) === month && isInLastWorkdaysOfMonth(today, calendar)
      ? [...buckets.toReceive, ...buckets.inDev].filter(({ tasks }) => {
          const leaves = selectLeafTasks(tasks);
          return (
            leaves.length > 0 && leaves.every(({ status }) => status === "wait")
          );
        })
      : [];
  return {
    mainPoolIds,
    buckets,
    notReady,
    unbucketedStoryIds,
    missingStoryIds,
    monthEndWarnings,
    carryOverSource,
  };
}

interface CommitmentStory {
  readonly id: number;
  readonly progress: FeatureProgress;
  readonly inCurrentMonth: boolean;
}

// docs/03 N13、docs/09 AC-65 缺少快照或现状时保留证据缺口。
export function compareCommitmentSnapshot(
  snapshotStoryIds: readonly number[] | undefined,
  currentStories: readonly CommitmentStory[],
  rescheduleReasons: ReadonlyMap<number, string> = new Map(),
) {
  if (snapshotStoryIds === undefined)
    return { snapshotAvailable: false as const };
  const snapshot = new Set(snapshotStoryIds);
  const current = indexStories(currentStories);
  const fulfilled: number[] = [];
  const carriedOver: { id: number; reason: string | null }[] = [];
  const pendingStoryIds: number[] = [];
  const cancelledStoryIds: number[] = [];
  const unknownStoryIds: number[] = [];
  for (const id of snapshot) {
    const story = current.get(id);
    const reason = rescheduleReasons.get(id) ?? null;
    if (reason) carriedOver.push({ id, reason });
    else if (!story) unknownStoryIds.push(id);
    else if (story.progress === "已完成") fulfilled.push(id);
    else if (story.progress === "已取消") cancelledStoryIds.push(id);
    else if (!story.inCurrentMonth) carriedOver.push({ id, reason });
    else if (progressBucket[story.progress] === "unknown")
      unknownStoryIds.push(id);
    else pendingStoryIds.push(id);
  }
  const inserted = [...current.values()]
    .filter(({ id, inCurrentMonth }) => inCurrentMonth && !snapshot.has(id))
    .map(({ id }) => id);
  return {
    snapshotAvailable: true as const,
    fulfilled,
    carriedOver,
    inserted,
    pendingStoryIds,
    cancelledStoryIds,
    unknownStoryIds,
  };
}
