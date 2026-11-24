import { z } from "zod";
import { civilDate } from "../../core/calendar.ts";
import { queryResultSchema } from "../result.ts";

const name = z.string().trim().min(1);
const severity = z.enum(["info", "low", "medium", "high"]);
const month = z.string().regex(/^\d{4}-(?:0[1-9]|1[0-2])$/u);

// docs/07 §2.1、§3.10。规则 ID 允许来自后续阶段。
export const scanWorkflowRisksInputSchema = z
  .object({
    scope: z
      .object({
        product: name.optional(),
        team: name.optional(),
        module: name.optional(),
        month: z.union([month, z.enum(["上月", "本月", "下月"])]).optional(),
        mine: z.boolean().optional(),
      })
      .strict(),
    rules: z.array(name).optional(),
    minSeverity: severity.optional(),
    groupBy: z.enum(["rule", "owner", "story"]).optional(),
  })
  .strict();

export const scanWorkflowRisksOutputSchema = queryResultSchema(
  z.strictObject({
    hits: z.array(
      z.strictObject({
        rule: name,
        severity,
        level: z.enum(["recorded", "inferred"]),
        object: z.strictObject({
          type: z.enum(["story", "task", "bug", "requirement"]),
          id: z.int().positive(),
          title: z.string(),
          untrusted: z.literal(true),
          url: z.url(),
        }),
        owner: z
          .strictObject({ account: name, realname: z.string() })
          .optional(),
        since: civilDate.optional(),
        reason: z.string(),
        suggestion: z.string(),
        waived: z
          .strictObject({
            by: name,
            reason: z.string(),
            untrusted: z.literal(true),
          })
          .optional(),
      }),
    ),
    summary: z.array(
      z.strictObject({ rule: name, name, count: z.int().nonnegative() }),
    ),
  }),
);

export type ScanWorkflowRisksInput = z.input<
  typeof scanWorkflowRisksInputSchema
>;
export type ScanWorkflowRisksOutput = z.output<
  typeof scanWorkflowRisksOutputSchema
>;
