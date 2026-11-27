import { z } from "zod";
import { queryResultSchema } from "../result.ts";

const text = z.string().trim().min(1);
const month = z.string().regex(/^\d{4}-(?:0[1-9]|1[0-2])$/u);
const id = z.int().positive();
export const personSchema = z.strictObject({
  account: text,
  realname: z.string(),
  untrusted: z.literal(true),
});
export const progressLevelSchema = z.enum(["recorded", "inferred"]);

export const storyItemSchema = z.strictObject({
  id,
  title: z.string(),
  url: z.url(),
  untrusted: z.literal(true),
  product: z.strictObject({ id, name: z.string(), untrusted: z.literal(true) }),
  module: z
    .strictObject({ id, path: z.string(), untrusted: z.literal(true) })
    .optional(),
  category: z.enum(["feature", "design", "other"]),
  status: z.string(),
  progress: z.strictObject({ value: z.string(), level: progressLevelSchema }),
  plan: z
    .strictObject({
      id,
      title: z.string(),
      month: month.optional(),
      untrusted: z.literal(true),
    })
    .optional(),
  version: z.string().optional(),
  maintainer: personSchema.optional(),
  currentOwner: personSchema.optional(),
  receiver: personSchema.optional(),
  feedbackBy: z.string().optional(),
  nextStage: z.string().optional(),
  nextDeadline: z.iso.date().optional(),
  riskCodes: z.array(text),
});

export const queryStoriesInputSchema = z
  .object({
    product: text.optional(),
    module: text.optional(),
    plan: text.optional(),
    month: z.union([month, z.enum(["本月", "下月", "上月"])]).optional(),
    version: text.optional(),
    role: z.enum(["maintainer", "receiver", "raised", "assigned"]).optional(),
    who: text.optional(),
    feedbackBy: text.optional(),
    openedFrom: z.iso.date().optional(),
    openedTo: z.iso.date().optional(),
    category: z.enum(["feature", "design"]).optional(),
    progress: z.array(text).optional(),
    status: z.array(text).optional(),
    type: z.enum(["story", "requirement"]).optional(),
    unlinked: z.boolean().optional(),
    keyword: text.optional(),
    page: z.int().positive().optional(),
    limit: z.int().positive().optional(),
  })
  .strict()
  .refine(
    ({ openedFrom, openedTo }) =>
      !openedFrom || !openedTo || openedFrom <= openedTo,
    {
      path: ["openedTo"],
      message: "登记时间范围的结束日期不能早于起始日期。",
    },
  );

export const queryStoriesOutputSchema = queryResultSchema(
  z.strictObject({
    items: z.array(storyItemSchema),
    countsByProgress: z.record(z.string(), z.int().nonnegative()),
    page: z.int().positive().optional(),
    pageSize: z.int().positive().optional(),
    total: z.int().nonnegative().optional(),
    hasMore: z.boolean().optional(),
  }),
);
export type StoryItem = z.infer<typeof storyItemSchema>;
export type QueryStoriesInput = z.input<typeof queryStoriesInputSchema>;
export type QueryStoriesOutput = z.output<typeof queryStoriesOutputSchema>;
