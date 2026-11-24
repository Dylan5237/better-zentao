import { z } from "zod";
import {
  createStoryInputSchema,
  storyDesignRefSchema,
  storySpecSchema,
} from "./create_story.ts";

export const maxImportRows = 50;

export const importStoriesInputSchema = z
  .object({
    source: z.discriminatedUnion("kind", [
      // 行需在合并 defaults 后独立校验，坏行不破坏整个批次。
      z
        .object({
          kind: z.literal("table"),
          rows: z.array(z.unknown()).min(1).max(maxImportRows),
        })
        .strict(),
      z
        .object({
          kind: z.literal("file"),
          path: z.string().trim().min(1),
          format: z.enum(["csv", "xlsx", "md"]),
        })
        .strict(),
    ]),
    defaults: createStoryInputSchema
      .partial()
      .extend({
        spec: storySpecSchema
          .partial()
          .extend({
            designRef: storyDesignRefSchema.partial().optional(),
          })
          .optional(),
      })
      .optional(),
    dryRun: z.boolean().optional(),
  })
  .strict();

export type ImportStoriesInput = z.output<typeof importStoriesInputSchema>;

export { createStoryOutputSchema as importStoriesOutputSchema } from "./create_story.ts";
