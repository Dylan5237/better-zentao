import { z } from "zod";
import { BztError } from "./errors.ts";

export const PROBE_PRODUCT_ID = 29;
const DEFAULT_ZENTAO_TIMEOUT_MS = 15_000;
const timeoutSetting = z
  .string()
  .regex(/^\d+$/u)
  .transform(Number)
  .pipe(z.int().min(1).max(2_147_483_647));

export function resolveZentaoTimeout(
  env?: Readonly<{ ZENTAO_TIMEOUT_MS?: string }>,
): number {
  const value = env?.ZENTAO_TIMEOUT_MS?.trim();
  if (!value) return DEFAULT_ZENTAO_TIMEOUT_MS;

  const timeout = timeoutSetting.safeParse(value);
  if (!timeout.success) {
    throw new BztError(
      "INVALID_INPUT",
      "ZENTAO_TIMEOUT_MS 必须是有效的毫秒数。",
    );
  }
  return timeout.data;
}

export const probeSettings = z
  .strictObject({
    productId: z.literal(PROBE_PRODUCT_ID).default(PROBE_PRODUCT_ID),
  })
  .default({ productId: PROBE_PRODUCT_ID });

export const requiredEnv = [
  "ZENTAO_BASE_URL",
  "ZENTAO_ACCOUNT",
  "ZENTAO_PASSWORD",
] as const;
