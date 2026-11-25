import { z } from "zod";
import { civilDate } from "../../core/calendar.ts";
import { preparedOperationSchema } from "../operation.ts";

const id = z.int().positive();
const text = z.string().trim().min(1);
const stage = z.enum([
  "design",
  "review",
  "handoff",
  "dev",
  "interface",
  "test",
  "acceptance",
  "delivery",
]);

// docs/07 §4.3 条件必填在服务预检中提示。
export const decomposeStoriesInputSchema = z
  .object({
    storyIds: z.array(id).optional(),
    taskId: id.optional(),
    template: z.enum(["design", "feature", "next_stage", "subtasks"]),
    execution: text.optional(),
    assignees: z.partialRecord(stage, text).optional(),
    dates: z
      .partialRecord(
        stage,
        z.strictObject({
          estStarted: civilDate.optional(),
          deadline: civilDate.optional(),
        }),
      )
      .optional(),
    estimates: z.partialRecord(stage, z.number().nonnegative()).optional(),
    include: z
      .strictObject({
        interface: z.boolean().optional(),
        delivery: z.boolean().optional(),
      })
      .optional(),
    subtasks: z
      .array(
        z.strictObject({
          name: text,
          assignTo: text,
          deadline: civilDate.optional(),
          estimate: z.number().nonnegative().optional(),
        }),
      )
      .optional(),
    notify: z.boolean().optional(),
  })
  .strict();

export const decomposeStoriesOutputSchema = preparedOperationSchema
  .extend({
    completeness: z.literal("partial").optional(),
    gaps: z
      .array(z.strictObject({ source: text, reason: text }))
      .min(1)
      .optional(),
  })
  .refine(
    ({ completeness, gaps }) =>
      (completeness === undefined) === (gaps === undefined),
  );

export type DecomposeStoriesInput = z.input<typeof decomposeStoriesInputSchema>;
export type DecomposeStoriesOutput = z.output<
  typeof decomposeStoriesOutputSchema
>;
