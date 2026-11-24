import { z } from "zod";
import { brandDto, zDate, zId, zNullableId } from "./common.ts";

const releaseBrand: unique symbol = Symbol("Release");

export const releaseDto = z
  .object({
    id: zId,
    name: z.string().min(1),
    product: zNullableId.optional(),
    date: zDate.optional(),
    status: z.string().optional(),
  })
  .transform((release) => brandDto(release, releaseBrand));

export type Release = z.infer<typeof releaseDto>;
