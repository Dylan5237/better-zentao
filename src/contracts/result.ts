import { z } from "zod";

export function queryResultSchema<T extends z.ZodType>(data: T) {
  return z
    .object({
      ok: z.literal(true),
      data,
      scope: z.strictObject({
        asOf: z.iso.datetime({ offset: true }),
        filters: z.record(z.string(), z.unknown()),
        timeBasis: z.string().optional(),
      }),
      completeness: z.enum(["complete", "partial"]),
      gaps: z.array(z.strictObject({ source: z.string(), reason: z.string() })),
      inferences: z.array(
        z.strictObject({
          field: z.string(),
          level: z.enum(["recorded", "inferred"]),
          basis: z.string(),
        }),
      ),
      truncated: z.boolean().optional(),
      links: z
        .array(z.strictObject({ label: z.string(), url: z.url() }))
        .optional(),
      hints: z.array(z.string()).optional(),
    })
    .strict()
    .refine(
      ({ completeness, gaps }) =>
        (completeness === "complete") === (gaps.length === 0),
      { path: ["completeness"], message: "完整性状态必须与缺口一致。" },
    );
}
