import { z } from "zod";
import type { OperationStep } from "../../contracts/operation.ts";

/**
 * CR-009 §4.1：操作网关端口定义（零 src/api 依赖）。
 * 由 ZentaoGateway 与 MemoryBusinessProvider 各自实现，供 OperationExecutor 与 BusinessProvider 复用。
 */

export const idSchema = z.int().positive();

export const targetSnapshot = z.object({
  id: idSchema,
  type: z.enum(["story", "task", "comment", "link"]),
  product: idSchema,
  status: z.string().nullable().optional(),
  maintainer: z.string().nullable().optional(),
  assignedTo: z.string().nullable().optional(),
  plan: z.array(idSchema).optional(),
  executions: z.array(idSchema).optional(),
  lastEditedDate: z.int().nullable().optional(),
  spec: z.string().nullable().optional(),
});

export type OperationTargetSnapshot = z.infer<typeof targetSnapshot>;
export type OperationTarget = Pick<
  OperationTargetSnapshot,
  "id" | "type" | "product"
>;

export interface StepRequest {
  opId: string;
  seq: number;
  step: Readonly<OperationStep>;
  id?: number | undefined;
}

export interface ReverseQuery {
  opId: string;
  type: OperationStep["type"];
  product: number;
  title: string;
  execution?: number;
  createdBy: string;
  since: number;
  until: number;
}

export const lookupResult = z.object({
  complete: z.boolean(),
  matches: z.array(
    z.object({
      id: idSchema,
      product: idSchema,
      title: z.string(),
      createdBy: z.string(),
      createdAt: z.int(),
    }),
  ),
});

export const writeReceipt = z.object({
  id: idSchema.optional(),
  actionId: idSchema.optional(),
});

export const readbackReceipt = z.object({
  verified: z.boolean(),
  snapshot: targetSnapshot.optional(),
});

/** 业务服务注入已投影的 API 调用。校验和反查必须绕过查询缓存。 */
export interface OperationGateway {
  readTarget(target: OperationTarget): Promise<OperationTargetSnapshot>;
  write(request: StepRequest): Promise<z.infer<typeof writeReceipt>>;
  readback(
    request: StepRequest & {
      zentaoId?: number;
      actionId?: number;
      attemptedAt?: number;
    },
  ): Promise<z.infer<typeof readbackReceipt>>;
  reverseLookup(query: ReverseQuery): Promise<z.infer<typeof lookupResult>>;
}
