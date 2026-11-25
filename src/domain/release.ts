import {
  civilDate,
  countWorkdaysBetween,
  type WorkCalendar,
} from "../core/calendar.ts";
import type { Bug } from "../core/dto/bug.ts";
import type { Release } from "../core/dto/release.ts";
import type { Story } from "../core/dto/story.ts";
import type { Task } from "../core/dto/task.ts";
import { completionRate, type FeatureProgress } from "./progress.ts";
import type { StageSummary } from "./stage.ts";
import { isTaskFinished, selectLeafTasks, type LeafCountTask } from "./task.ts";

type ReleaseBug = Pick<Bug, "id" | "status" | "severity" | "deleted">;

export interface ReleaseStory
  extends
    Pick<Story, "id" | "product" | "keywords" | "plan">,
    Pick<StageSummary, "stages"> {
  readonly progress: FeatureProgress;
  readonly tasks: readonly (LeafCountTask & Pick<Task, "deadline">)[];
  readonly tasksComplete?: boolean;
  readonly bugs: readonly ReleaseBug[];
}

interface ReleaseVersion {
  readonly product: number;
  readonly version: string;
}

interface ReleaseWaiver {
  readonly storyId: number;
  readonly version: string;
  readonly approvedBy: string;
  readonly reason: string;
}

interface ReleaseInput extends ReleaseVersion {
  readonly today: string;
  readonly calendar: WorkCalendar;
  readonly stories: readonly ReleaseStory[];
  readonly releases?: readonly Pick<Release, "product" | "name" | "date">[];
  readonly releaseCalendar?: readonly (ReleaseVersion & {
    readonly date: string;
  })[];
  readonly legacyPlans?: readonly (ReleaseVersion & {
    readonly id: number;
    readonly end: string | null;
  })[];
  readonly keywordPrefix?: string;
  readonly waivers?: readonly ReleaseWaiver[];
}

function resolveReleaseDate(
  input: ReleaseInput,
  legacyPlans: NonNullable<ReleaseInput["legacyPlans"]>,
) {
  const dateFromRelease = input.releases?.find(
    ({ product, name, date }) =>
      product === input.product &&
      name === input.version &&
      civilDate.safeParse(date).success,
  )?.date;
  if (dateFromRelease)
    return { releaseDate: dateFromRelease, dateSource: "release" as const };
  const dateFromCalendar = input.releaseCalendar?.find(
    ({ product, version, date }) =>
      product === input.product &&
      version === input.version &&
      civilDate.safeParse(date).success,
  )?.date;
  if (dateFromCalendar)
    return { releaseDate: dateFromCalendar, dateSource: "calendar" as const };
  const dateFromPlan = legacyPlans.find(
    ({ end }) => civilDate.safeParse(end).success,
  )?.end;
  if (dateFromPlan)
    return { releaseDate: dateFromPlan, dateSource: "legacyPlan" as const };
  return { releaseDate: null, dateSource: null };
}

// docs/03 N12、docs/04 §4.8、§6 发布门禁保留阻塞证据，例外按需求和版本生效。
export function summarizeRelease(input: ReleaseInput) {
  const { product, version, today, calendar } = input;
  const legacyPlans = (input.legacyPlans ?? []).filter(
    (plan) => plan.product === product && plan.version === version,
  );
  const legacyPlanIds = new Set(legacyPlans.map(({ id }) => id));
  const keyword = `${input.keywordPrefix ?? "版本:"}${version}`;
  const { releaseDate, dateSource } = resolveReleaseDate(input, legacyPlans);

  const storyIds = new Set<number>();
  const progressGroups = new Map<FeatureProgress, number[]>();
  const testIncompleteStoryIds: number[] = [];
  const testEvidenceMissingStoryIds: number[] = [];
  let activeStoryCount = 0;
  const blockedStoryIds = new Set<number>();
  const bugs = new Map<number, ReleaseBug>();
  const lateLeafTasks: { storyId: number; taskId: number; deadline: string }[] =
    [];
  for (const story of input.stories) {
    if (story.product !== product || storyIds.has(story.id)) continue;
    const tagged = story.keywords?.split(/[\s,，、;；]+/u).includes(keyword);
    if (!tagged && !story.plan?.some((id) => legacyPlanIds.has(id))) continue;

    storyIds.add(story.id);
    const group = progressGroups.get(story.progress);
    if (group) group.push(story.id);
    else progressGroups.set(story.progress, [story.id]);
    const cancelled = story.progress === "已取消";
    if (!cancelled) {
      activeStoryCount++;
      if (
        story.tasksComplete === false ||
        story.stages.test?.status !== "completed"
      ) {
        testIncompleteStoryIds.push(story.id);
        blockedStoryIds.add(story.id);
      }
      if (story.tasksComplete === false)
        testEvidenceMissingStoryIds.push(story.id);
    }
    for (const bug of story.bugs) {
      if (bug.deleted || bug.status === "closed") continue;
      bugs.set(bug.id, bug);
      if (!cancelled && isSerious(bug)) blockedStoryIds.add(story.id);
    }
    if (releaseDate) {
      for (const task of selectLeafTasks(story.tasks)) {
        if (isTaskFinished(task.status)) continue;
        const deadline = civilDate.safeParse(task.deadline).data;
        if (deadline && deadline > releaseDate)
          lateLeafTasks.push({ storyId: story.id, taskId: task.id, deadline });
      }
    }
  }
  const openBugs = [...bugs.values()].sort(
    (left, right) => left.severity - right.severity || left.id - right.id,
  );
  const waivers = (input.waivers ?? []).filter(
    (waiver) =>
      waiver.version === version &&
      storyIds.has(waiver.storyId) &&
      waiver.approvedBy.trim() !== "" &&
      waiver.reason.trim() !== "",
  );
  const waivedStoryIds = new Set(waivers.map(({ storyId }) => storyId));
  let gate: "unknown" | "ready" | "waiver" | "blocked" = "unknown";
  if (storyIds.size > 0) {
    if (blockedStoryIds.size === 0) gate = "ready";
    else
      gate = [...blockedStoryIds].every((id) => waivedStoryIds.has(id))
        ? "waiver"
        : "blocked";
  }
  return {
    releaseDate,
    dateSource,
    workdaysUntilRelease: releaseDate
      ? countWorkdaysBetween(today, releaseDate, calendar)
      : null,
    storyIds: [...storyIds],
    progressGroups: [...progressGroups].map(([progress, ids]) => ({
      progress,
      storyIds: ids,
    })),
    testCompletionRate: completionRate(
      activeStoryCount - testIncompleteStoryIds.length,
      activeStoryCount,
    ),
    testIncompleteStoryIds,
    testEvidenceMissingStoryIds,
    openSeriousBugs: openBugs.filter(isSerious),
    openBugs,
    lateLeafTasks,
    waivers,
    gate,
    flags:
      releaseDate &&
      today > releaseDate &&
      testIncompleteStoryIds.length > testEvidenceMissingStoryIds.length
        ? ["已发布·测试未完成" as const]
        : [],
  };
}

function isSerious({ severity }: ReleaseBug): boolean {
  return severity === 1 || severity === 2;
}
