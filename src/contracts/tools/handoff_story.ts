import { z } from "zod";

export { preparedOperationSchema as handoffStoryOutputSchema } from "../operation.ts";

const text = z.string().trim().min(1);
export const handoffDesignRefSchema = z
  .object({ doc: text, section: text, version: text.optional() })
  .strict();

const common = {
  storyId: z.int().positive(),
  receiver: text.optional(),
  comment: text.optional(),
  notify: z.boolean().optional(),
};

// docs/07 §4.4。
export const handoffStoryInputSchema = z.discriminatedUnion("mode", [
  z
    .object({
      ...common,
      mode: z.literal("from_design"),
      feature: z
        .object({
          product: text.optional(),
          module: text.optional(),
          title: text.optional(),
          scope: text.optional(),
          designRef: handoffDesignRefSchema.optional(),
        })
        .strict()
        .optional(),
    })
    .strict(),
  z.object({ ...common, mode: z.literal("activate") }).strict(),
]);

export type HandoffStoryInput = z.input<typeof handoffStoryInputSchema>;
