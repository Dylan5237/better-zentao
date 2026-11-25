import { z } from "zod";
import { queryResultSchema } from "../result.ts";
import { queryStoriesInputSchema, storyItemSchema } from "./query_stories.ts";

export const getMonthlyDevQueueInputSchema = z
  .object({
    team: z.string().trim().min(1).optional(),
    month: queryStoriesInputSchema.shape.month,
    includeNotReady: z.boolean().optional(),
  })
  .strict();

const queueStory = storyItemSchema.extend({
  carriedOver: z.boolean(),
  planNoIteration: z.boolean(),
  iterationNoPlan: z.boolean(),
});
const items = z.array(queueStory);
const count = z.int().nonnegative();
export const getMonthlyDevQueueOutputSchema = queryResultSchema(
  z.strictObject({
    buckets: z.strictObject({
      toReceive: items,
      inDev: items,
      carriedOver: items,
      planNoIteration: items,
      iterationNoPlan: items,
    }),
    notReady: items.optional(),
    monthEndWarnings: items.optional(),
    counts: z.strictObject({
      mainPool: count,
      toReceive: count,
      inDev: count,
      carriedOver: count,
      planNoIteration: count,
      iterationNoPlan: count,
      notReady: count,
      unbucketed: count,
      missing: count,
    }),
    mainPoolIds: z.array(z.int().positive()),
    unbucketedStoryIds: z.array(z.int().positive()),
    missingStoryIds: z.array(z.int().positive()),
    carryOverSource: z.enum(["snapshot", "history", "mixed"]).nullable(),
  }),
);
export type GetMonthlyDevQueueInput = z.input<
  typeof getMonthlyDevQueueInputSchema
>;
export type GetMonthlyDevQueueOutput = z.output<
  typeof getMonthlyDevQueueOutputSchema
>;
