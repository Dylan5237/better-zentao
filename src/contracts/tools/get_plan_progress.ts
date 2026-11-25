import { z } from "zod";
import { queryResultSchema } from "../result.ts";
import { queryStoriesInputSchema, storyItemSchema } from "./query_stories.ts";

const text = z.string().trim().min(1);
const count = z.int().nonnegative();
const id = z.int().positive();
const ids = z.array(id);
export const getPlanProgressInputSchema = z
  .object({
    view: z.enum(["plan", "release", "commitment", "iteration"]),
    product: text.optional(),
    plan: text.optional(),
    month: queryStoriesInputSchema.shape.month,
    version: text.optional(),
    execution: text.optional(),
    groupBy: z.enum(["owner", "module", "progress"]).optional(),
  })
  .strict();

const rate = z.strictObject({
  numerator: count,
  denominator: count,
  rate: z.number().min(0).max(1).nullable(),
});
const planCounts = z.strictObject({
  completed: count,
  inProgress: count,
  toReceive: count,
  notReady: count,
  cancelled: count,
  unknown: count,
});
const planTotals = {
  total: count,
  counts: planCounts,
  storyDeliveryRate: rate,
  taskCompletionRate: rate,
};
const compliance = z.array(
  z.strictObject({
    owner: z.string().nullable(),
    counts: z.partialRecord(z.enum(["R05", "R06"]), count),
  }),
);
const comparedStory = storyItemSchema.extend({
  stages: z.array(
    z.strictObject({
      stage: z.string(),
      status: z.enum(["completed", "in_progress", "cancelled", "missing"]),
    }),
  ),
});
const crossProduct = z.array(
  z.strictObject({ stories: z.array(comparedStory).min(2) }),
);
const snapshot = z.strictObject({
  productId: id,
  snapId: text,
  takenAt: count,
  source: z.enum(["local", "imported"]),
});
const bugItem = z.strictObject({
  id,
  title: z.string(),
  severity: count,
  status: z.string(),
  story: id.optional(),
  url: z.url(),
  untrusted: z.literal(true),
});
const plan = z.strictObject({
  view: z.literal("plan"),
  asOf: z.iso.datetime(),
  ...planTotals,
  groups: z.array(
    z.strictObject({ key: z.union([z.string(), id, z.null()]), ...planTotals }),
  ),
  planIds: ids,
});
const release = z.strictObject({
  view: z.literal("release"),
  version: text,
  productId: id.nullable(),
  releaseDate: z.iso.date().nullable(),
  dateSource: z.enum(["release", "calendar", "legacyPlan"]).nullable(),
  workdaysUntilRelease: z.int().nullable(),
  storyIds: ids,
  progressGroups: z.array(
    z.strictObject({ progress: z.string(), storyIds: ids }),
  ),
  testCompletionRate: rate,
  testIncompleteStoryIds: ids,
  testEvidenceMissingStoryIds: ids,
  openSeriousBugs: z.array(bugItem),
  openBugs: z.array(bugItem),
  unlinkedSeriousBugs: z.array(bugItem),
  unlinkedBugIds: ids,
  lateLeafTasks: z.array(
    z.strictObject({ storyId: id, taskId: id, deadline: z.iso.date() }),
  ),
  waivers: z.array(
    z.strictObject({
      storyId: id,
      version: text,
      approvedBy: text,
      reason: text,
      untrusted: z.literal(true),
    }),
  ),
  gate: z.enum(["ready", "waiver", "blocked", "unknown"]),
  flags: z.array(z.literal("已发布·测试未完成")),
  releaseWarningStoryIds: ids,
});
const commitment = z.strictObject({
  view: z.literal("commitment"),
  snapshots: z.array(snapshot),
  missingSnapshotProductIds: ids,
  snapshotAvailable: z.boolean(),
  fulfilled: ids,
  carriedOver: z.array(
    z.strictObject({
      id,
      reason: z.string().nullable(),
      untrusted: z.literal(true),
    }),
  ),
  inserted: ids,
  pendingStoryIds: ids,
  cancelledStoryIds: ids,
  unknownStoryIds: ids,
});
const iteration = z.strictObject({
  view: z.literal("iteration"),
  executionIds: ids,
  storyIds: ids,
  decompositionTimeliness: rate,
  overdueRate: rate,
  testCycleMedianWorkdays: z.number().nonnegative().nullable(),
  testCycleSampleSize: count,
  visibleHours: z.strictObject({
    estimate: z.number().nonnegative(),
    consumed: z.number().nonnegative(),
    left: z.number().nonnegative(),
    leafTaskCount: count,
    missingHoursTaskCount: count,
  }),
  snapshotAvailable: z.boolean(),
  snapshots: z.array(snapshot),
  missingSnapshotProductIds: ids,
  complianceByOwner: compliance,
  crossProduct,
});
export const getPlanProgressOutputSchema = queryResultSchema(
  z.discriminatedUnion("view", [plan, release, commitment, iteration]),
);
export type GetPlanProgressInput = z.input<typeof getPlanProgressInputSchema>;
export type GetPlanProgressOutput = z.output<
  typeof getPlanProgressOutputSchema
>;
