import { z } from "zod";

export { preparedOperationSchema as rescheduleStoryOutputSchema } from "../operation.ts";

export const normalizedMonthSchema = z
  .string()
  .regex(/^\d{4}-(?:0[1-9]|1[0-2])$/u);
export const flowMonthSchema = z
  .string()
  .trim()
  .pipe(z.union([normalizedMonthSchema, z.enum(["本月", "下月", "上月"])]));

// docs/07 §4.5。
export const rescheduleStoryInputSchema = z
  .object({
    storyIds: z.array(z.int().positive()).min(1).max(100),
    toMonth: flowMonthSchema,
    reason: z.string().trim().min(1),
    moveTasks: z.boolean().optional(),
  })
  .strict();

export type RescheduleStoryInput = z.input<typeof rescheduleStoryInputSchema>;
