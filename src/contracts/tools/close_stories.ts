import { z } from "zod";
import { flowMonthSchema } from "./reschedule_story.ts";

export { preparedOperationSchema as closeStoriesOutputSchema } from "../operation.ts";

const text = z.string().trim().min(1);
const cleanupClass = z.enum(["A", "B", "C"]);

// docs/07 §4.6，docs/09 AC-52。
export const closeStoriesInputSchema = z.discriminatedUnion("mode", [
  z
    .object({
      mode: z.literal("story"),
      storyIds: z.array(z.int().positive()).min(1).max(100),
      closedReason: z
        .enum(["done", "cancel", "duplicate", "postponed", "willnotdo"])
        .optional(),
    })
    .strict(),
  z
    .object({
      mode: z.literal("cleanup"),
      cleanup: z
        .object({
          scope: z
            .object({
              team: text.optional(),
              execution: text.optional(),
              beforeMonth: flowMonthSchema.optional(),
            })
            .strict(),
          classes: z.array(cleanupClass).optional(),
          reason: text.optional(),
        })
        .strict(),
    })
    .strict(),
]);

export type CloseStoriesInput = z.input<typeof closeStoriesInputSchema>;
