import { z } from "zod";
import { civilDate } from "../../core/calendar.ts";
import { queryResultSchema } from "../result.ts";

const text = z.string().trim().min(1);
const newTaskSchema = z
  .object({
    estimateHours: z.number().positive(),
    earliestStart: civilDate.optional(),
    deadline: civilDate.optional(),
    skills: z.array(text).optional(),
  })
  .strict()
  .refine(
    ({ earliestStart, deadline }) =>
      !earliestStart || !deadline || earliestStart <= deadline,
    { path: ["deadline"], message: "截止日不能早于最早开始日期。" },
  );

export const getMemberScheduleInputSchema = z
  .object({
    members: z.array(text).min(1).optional(),
    weeks: z.int().positive().optional(),
    bucket: z.enum(["day", "week"]).default("week"),
    newTask: newTaskSchema.optional(),
    format: z.enum(["table", "html"]).default("table"),
  })
  .strict();

const person = z.strictObject({ account: z.string(), realname: z.string() });
const taskItem = z.strictObject({
  id: z.int().positive(),
  name: z.string(),
  url: z.url(),
  status: z.string(),
  assignedTo: person.optional(),
  estStarted: civilDate.optional(),
  deadline: civilDate.optional(),
  left: z.number().nonnegative().optional(),
  timeState: z.enum(["overdue", "unscheduled"]),
  overdueDays: z.int().nonnegative().optional(),
  story: z
    .strictObject({ id: z.int().positive(), title: z.string() })
    .optional(),
  execution: z.strictObject({ id: z.int().positive(), name: z.string() }),
  isParent: z.literal(false),
});

export const getMemberScheduleOutputSchema = queryResultSchema(
  z.strictObject({
    members: z.array(
      person.extend({
        capacityHours: z.number(),
        buckets: z.array(
          z.strictObject({
            start: civilDate,
            end: civilDate,
            leftHours: z.number().nonnegative(),
            taskCount: z.int().nonnegative(),
            missingEstimate: z.int().nonnegative(),
          }),
        ),
        overdue: z.array(taskItem),
        unscheduled: z.array(taskItem),
      }),
    ),
    suggestions: z
      .array(
        person.extend({
          suggestedDeadline: civilDate,
          reason: z.string(),
        }),
      )
      .max(3)
      .optional(),
  }),
);

export type GetMemberScheduleOutput = z.output<
  typeof getMemberScheduleOutputSchema
>;
