import { z } from "zod";
import { queryResultSchema } from "../result.ts";
import { parentRiskSchema, taskItemSchema } from "./get_team_work.ts";
import { personSchema, storyItemSchema } from "./query_stories.ts";

export const myWorkGroupSchema = z.enum([
  "new",
  "action",
  "waiting_ready",
  "maintained",
  "raised",
  "can_start",
]);
export const getMyWorkInputSchema = z
  .object({
    groups: z.array(myWorkGroupSchema).optional(),
    horizonDays: z.int().nonnegative().optional(),
    since: z
      .union([
        z.literal("last_seen"),
        z.iso.datetime({ offset: true }),
        z.iso.date(),
      ])
      .optional(),
    markSeen: z.boolean().optional(),
  })
  .strict();

export const getMyWorkOutputSchema = queryResultSchema(
  z.strictObject({
    new: z.array(z.union([taskItemSchema, storyItemSchema])),
    action: z.strictObject({
      overdue: z.array(taskItemSchema),
      dueToday: z.array(taskItemSchema),
      dueSoon: z.array(taskItemSchema),
      unscheduled: z.array(taskItemSchema),
      toReceive: z.array(storyItemSchema),
      toReview: z.array(storyItemSchema),
    }),
    waiting_ready: z.array(
      storyItemSchema.extend({ waitingFor: personSchema.optional() }),
    ),
    maintained: z.array(storyItemSchema),
    raised: z.array(storyItemSchema),
    can_start: z.strictObject({
      tests: z.array(taskItemSchema),
      upcomingTests: z.array(taskItemSchema),
      acceptDeliver: z.array(taskItemSchema),
    }),
    parentRisks: z.array(parentRiskSchema).optional(),
  }),
);
export type GetMyWorkInput = z.input<typeof getMyWorkInputSchema>;
export type GetMyWorkOutput = z.output<typeof getMyWorkOutputSchema>;
