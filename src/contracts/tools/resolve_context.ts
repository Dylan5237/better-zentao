import { z } from "zod";
import { civilDate } from "../../core/calendar.ts";
import { queryResultSchema } from "../result.ts";

const name = z.string().trim().min(1);
const id = z.int().positive();
const month = z.string().regex(/^\d{4}-(?:0[1-9]|1[0-2])$/u);

// docs/07 §2.1、§3.1。ID 按工具契约以字符串传入。
export const resolveContextInputSchema = z
  .object({
    people: z.array(name).optional(),
    product: name.optional(),
    module: name.optional(),
    plan: name.optional(),
    execution: name.optional(),
    month: z.union([month, z.enum(["本月", "下月", "上月"])]).optional(),
  })
  .strict();

const identity = {
  account: name,
  realname: z.string(),
  roles: z.array(z.string()),
};

export const resolveContextDataSchema = z.strictObject({
  people: z.array(
    z.strictObject({ input: name, ...identity, team: z.string().optional() }),
  ),
  product: z
    .strictObject({
      id,
      name: z.string(),
      state: z.enum(["design", "runtime", "delivery", "other"]),
    })
    .optional(),
  module: z
    .strictObject({
      id,
      path: z.string(),
      designLead: z.string().optional(),
      devLead: z.string().optional(),
      testLead: z.string().optional(),
    })
    .optional(),
  plan: z
    .strictObject({
      id,
      title: z.string(),
      begin: civilDate,
      end: civilDate,
      level: z.enum(["L2", "L3"]),
    })
    .optional(),
  execution: z
    .strictObject({
      id,
      name: z.string(),
      kind: z.enum(["design", "dev", "ui", "other"]),
      month: month.optional(),
    })
    .optional(),
  me: z.strictObject(identity),
});

export const resolveContextOutputSchema = queryResultSchema(
  resolveContextDataSchema,
);

export type ResolveContextInput = z.input<typeof resolveContextInputSchema>;
export type ResolveContextOutput = z.output<typeof resolveContextOutputSchema>;
