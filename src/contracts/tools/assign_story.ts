import { z } from "zod";

export { preparedOperationSchema as assignStoryOutputSchema } from "../operation.ts";

// docs/07 §2.1、§3.9。
export const assignStoryInputSchema = z
  .object({
    storyIds: z.array(z.int().positive()).min(1).max(100),
    to: z.string().trim().min(1),
    comment: z.string().optional(),
    notify: z.boolean().default(true),
  })
  .strict();

export type AssignStoryInput = z.input<typeof assignStoryInputSchema>;
