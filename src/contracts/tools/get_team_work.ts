import { z } from "zod";
import { queryResultSchema } from "../result.ts";
import { personSchema } from "./query_stories.ts";

const text = z.string().trim().min(1);
const id = z.int().positive();
const execution = z.strictObject({
  id,
  name: z.string(),
  untrusted: z.literal(true),
});

export const taskItemSchema = z.strictObject({
  id,
  name: z.string(),
  url: z.url(),
  untrusted: z.literal(true),
  stage: z.string().optional(),
  stageLevel: z.enum(["confirmed", "inferred"]).optional(),
  status: z.string(),
  assignedTo: personSchema.optional(),
  estStarted: z.iso.date().optional(),
  deadline: z.iso.date().optional(),
  left: z.number().optional(),
  timeState: z.enum([
    "overdue",
    "due_today",
    "due_soon",
    "on_track",
    "unscheduled",
    "done",
  ]),
  overdueDays: z.int().nonnegative().optional(),
  story: z
    .strictObject({ id, title: z.string(), untrusted: z.literal(true) })
    .optional(),
  execution,
  isParent: z.boolean(),
});

export const parentRiskSchema = z.strictObject({
  task: taskItemSchema,
  allChildrenFinished: z.boolean().nullable(),
  reason: z.string(),
});

export const getTeamWorkInputSchema = z
  .object({
    team: text.optional(),
    members: z.array(text).min(1).optional(),
    product: text.optional(),
    view: z.enum(["overdue", "due_soon", "all_open"]).optional(),
    groupBy: z.enum(["member", "story", "execution"]).optional(),
  })
  .strict();

export const getTeamWorkOutputSchema = queryResultSchema(
  z.strictObject({
    groups: z.array(
      z.strictObject({
        key: text,
        label: z.string(),
        untrusted: z.literal(true),
        count: z.int().nonnegative(),
        items: z.array(taskItemSchema),
      }),
    ),
    totals: z.strictObject({
      overdue: z.int().nonnegative(),
      dueSoon: z.int().nonnegative(),
      open: z.int().nonnegative(),
    }),
    parentRisks: z.array(parentRiskSchema),
  }),
);
export type TaskItem = z.infer<typeof taskItemSchema>;
export type GetTeamWorkInput = z.input<typeof getTeamWorkInputSchema>;
export type GetTeamWorkOutput = z.output<typeof getTeamWorkOutputSchema>;
