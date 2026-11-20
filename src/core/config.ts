import { z } from "zod";

export const PROBE_PRODUCT_ID = 29;

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
