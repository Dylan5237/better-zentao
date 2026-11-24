import { z } from "zod";
import { queryResultSchema } from "../result.ts";
import { taskItemSchema } from "./get_team_work.ts";
import { progressLevelSchema, storyItemSchema } from "./query_stories.ts";
import { scanWorkflowRisksOutputSchema } from "./scan_workflow_risks.ts";

const id = z.int().positive();
export const getStoryProgressInputSchema = z
  .object({
    storyId: id.optional(),
    intakeId: z.string().trim().min(1).optional(),
    requirementId: id.optional(),
    view: z.enum(["full", "dev"]).optional(),
    format: z.enum(["data", "card"]).optional(),
  })
  .strict()
  .refine(
    ({ storyId, intakeId, requirementId }) =>
      [storyId, intakeId, requirementId].filter((value) => value !== undefined)
        .length === 1,
    { message: "请指定且只指定一个需求或来源编号。" },
  );

const bugItem = z.strictObject({
  id,
  title: z.string(),
  severity: z.int().nonnegative(),
  status: z.string(),
  story: id.optional(),
  url: z.url(),
  untrusted: z.literal(true),
});
const full = z.strictObject({
  story: storyItemSchema,
  progress: z.strictObject({
    value: z.string(),
    level: progressLevelSchema,
    basis: z.string(),
  }),
  stages: z.array(
    z.strictObject({
      stage: z.string(),
      required: z.boolean(),
      state: z.enum([
        "missing",
        "not_started",
        "doing",
        "done",
        "waived",
        "cancelled",
      ]),
      tasks: z.array(taskItemSchema),
      evidence: z.array(z.string()),
    }),
  ),
  people: z.strictObject({
    feedbackBy: z.string().optional(),
    raisedBy: z.string(),
    maintainer: z.string().optional(),
    currentOwner: z.string().optional(),
    receiver: z.string().optional(),
    untrusted: z.literal(true),
  }),
  related: z.strictObject({
    requirement: id.optional(),
    pair: id.optional(),
    derivesFrom: id.optional(),
    requirements: z.array(id).optional(),
    pairs: z.array(id).optional(),
    bugs: z.array(bugItem),
  }),
  risks: scanWorkflowRisksOutputSchema.shape.data.shape.hits,
  card: z.string().optional(),
  untrusted: z.literal(true),
});

export const getStoryProgressOutputSchema = queryResultSchema(
  z.union([
    full,
    z.strictObject({
      scope: z.string().max(2000).optional(),
      designRef: z.string().max(2000).optional(),
      verify: z.string().max(2000).optional(),
      tasks: z.array(taskItemSchema),
      untrusted: z.literal(true),
    }),
    z.strictObject({
      candidates: z.array(
        z.strictObject({
          id,
          title: z.string().optional(),
          url: z.url(),
          untrusted: z.literal(true),
        }),
      ),
    }),
  ]),
);
export type GetStoryProgressInput = z.input<typeof getStoryProgressInputSchema>;
export type GetStoryProgressOutput = z.output<
  typeof getStoryProgressOutputSchema
>;
