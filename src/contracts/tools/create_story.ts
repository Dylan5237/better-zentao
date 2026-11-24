import { z } from "zod";
import { preparedOperationSchema } from "../operation.ts";

const text = z.string().trim().min(1);
const entity = z.union([text, z.int().positive()]).transform(String);
const id = z.int().positive();

export const storyDesignRefSchema = z
  .object({
    doc: text,
    section: z.string().optional(),
    version: text.optional(),
  })
  .strict();
export const storySpecSchema = z
  .object({
    background: z.string(),
    scope: z.string().optional(),
    designRef: storyDesignRefSchema.optional(),
    notInScope: z.string().optional(),
  })
  .strict();

// 规范必填字段由服务聚合报错，保留 MISSING_REQUIRED 和完整缺项列表。
export const createStoryInputSchema = z
  .object({
    product: entity,
    module: entity,
    title: text,
    category: z.enum(["feature", "design"]).optional(),
    spec: storySpecSchema.optional(),
    verify: z.string().optional(),
    plan: entity.optional(),
    version: text.optional(),
    pri: z
      .union([z.literal(1), z.literal(2), z.literal(3), z.literal(4)])
      .optional(),
    source: text.optional(),
    sourceNote: text.optional(),
    feedbackBy: text.optional(),
    maintainer: text.optional(),
    assignTo: text.optional(),
    requirementId: id.optional(),
    pair: z
      .object({ product: entity, module: entity, title: text.optional() })
      .strict()
      .optional(),
    derivesFrom: id.optional(),
    crossModule: z.boolean().optional(),
    backfilled: z.object({ actualStartedAt: text }).strict().optional(),
    states: z.object({ activate: z.boolean().optional() }).strict().optional(),
    intake: z
      .object({
        rawText: text,
        channel: z.enum(["wecom", "verbal", "meeting", "zentao", "other"]),
      })
      .strict()
      .optional(),
  })
  .strict();

export type CreateStoryInput = z.output<typeof createStoryInputSchema>;

export const createStoryOutputSchema = preparedOperationSchema.extend({
  intakes: z.array(z.strictObject({ intakeId: text, message: z.string() })),
  dryRun: z.literal(true).optional(),
});
