import { z } from "zod";
import type {
  OperationLevel,
  OperationStatus,
  OperationStepState,
} from "../core/store/index.ts";

const seq = z.int().positive();
const nonempty = z.string().trim().min(1);
const fields = z.record(
  nonempty,
  z.strictObject({
    value: z.json(),
    origin: z.enum(["user", "default", "derived"]),
  }),
);

export const operationStepSchema = z.strictObject({
  action: nonempty,
  type: z.enum(["story", "task", "comment", "link"]),
  product: seq,
  id: seq.optional(),
  fromStep: seq.optional(),
  fields,
  cacheKeys: z
    .array(
      nonempty.regex(
        /^(?!.*(?:password|passwd|token|secret|cookie|authorization|credential))/iu,
      ),
    )
    .optional(),
});

export const operationPlanSchema = z.strictObject({
  kind: nonempty,
  summary: nonempty,
  steps: z.array(operationStepSchema).min(1),
  affects: z.array(nonempty).optional(),
  warnings: z
    .array(z.strictObject({ code: nonempty, message: nonempty }))
    .optional(),
});

export const confirmOperationSchema = z.strictObject({
  opId: nonempty,
  previewAck: z.boolean().optional(),
  resume: z.boolean().optional(),
  excludeSteps: z.array(seq).optional(),
});

export const getOperationSchema = z
  .strictObject({ opId: nonempty.optional(), recent: seq.max(100).optional() })
  .refine(({ opId, recent }) => opId === undefined || recent === undefined);

export const preparedOperationSchema = z.strictObject({
  ok: z.literal(true),
  opId: z.string(),
  kind: nonempty,
  level: z.enum(["W0", "W1", "W2", "W3"]),
  expiresAt: z.union([z.literal(""), z.iso.datetime()]),
  preview: z.strictObject({
    summary: z.string(),
    steps: z.array(
      z.strictObject({
        seq,
        action: z.string(),
        target: z.string(),
        fields,
      }),
    ),
    affects: z.array(z.string()),
  }),
  warnings: z.array(z.strictObject({ code: z.string(), message: z.string() })),
  requiresPreviewAck: z.boolean(),
});

export const operationResultSchema = z.strictObject({
  ok: z.boolean(),
  opId: nonempty,
  status: z.enum(["confirmed", "partial", "unknown", "not_executed", "failed"]),
  steps: z.array(
    z.strictObject({
      seq,
      action: z.string(),
      state: z.enum(["done", "skipped", "failed", "unknown", "pending"]),
      zentaoId: seq.optional(),
      url: z.url().optional(),
      error: z.string().optional(),
    }),
  ),
  created: z.array(
    z.strictObject({
      type: operationStepSchema.shape.type,
      id: seq,
      url: z.url(),
    }),
  ),
  nextActions: z.array(z.string()).optional(),
  notified: z
    .array(
      z.strictObject({
        target: z.string(),
        channel: z.literal("wecom"),
        state: z.enum(["sent", "queued", "failed"]),
      }),
    )
    .optional(),
});

export type OperationPlan = z.infer<typeof operationPlanSchema>;
export type OperationStep = z.infer<typeof operationStepSchema>;
export type ConfirmOperation = z.infer<typeof confirmOperationSchema>;
export type GetOperation = z.infer<typeof getOperationSchema>;

export interface PreparedOperation {
  ok: true;
  opId: string;
  kind: string;
  level: OperationLevel;
  expiresAt: string;
  preview: {
    summary: string;
    steps: Array<{
      seq: number;
      action: string;
      target: string;
      fields: OperationStep["fields"];
    }>;
    affects: string[];
  };
  warnings: Array<{ code: string; message: string }>;
  requiresPreviewAck: boolean;
}

export interface OperationResult {
  ok: boolean;
  opId: string;
  status: OperationStatus;
  steps: Array<{
    seq: number;
    action: string;
    state: OperationStepState;
    zentaoId?: number;
    url?: string;
    error?: string;
  }>;
  created: Array<{ type: OperationStep["type"]; id: number; url: string }>;
  nextActions?: string[];
  notified?: Array<{
    target: string;
    channel: "wecom";
    state: "sent" | "queued" | "failed";
  }>;
}
