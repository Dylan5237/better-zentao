import { z } from "zod";

const positiveId = z
  .union([
    z.number(),
    z
      .string()
      .regex(/^[1-9]\d*$/u)
      .transform(Number),
  ])
  .pipe(z.int().positive());

// P0 骨架仅使用需求的最小白名单。完整视图按 docs/06 §5 扩展。
export const storyDetailDto = z
  .object({
    id: positiveId,
    product: positiveId,
    type: z.literal("story"),
    title: z.string(),
    status: z.string(),
    executions: z
      .array(z.object({ id: positiveId, name: z.string() }))
      .default([]),
  })
  .brand<"StoryDetail">();

export type StoryDetail = z.infer<typeof storyDetailDto>;
