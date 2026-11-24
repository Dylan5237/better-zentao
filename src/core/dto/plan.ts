import { z } from "zod";
import {
  brandDto,
  zBool,
  zCollection,
  zDate,
  zId,
  zParentPlanId,
} from "./common.ts";
import { storyDtoFor } from "./story.ts";

const productPlanBrand: unique symbol = Symbol("ProductPlan");
const planDetailBrand: unique symbol = Symbol("PlanDetail");

export interface ProductPlan {
  readonly [productPlanBrand]: true;
  readonly id: number;
  readonly product: number;
  readonly parent: number | null;
  readonly title: string;
  readonly status: string;
  readonly begin: string | null;
  readonly end: string | null;
  readonly deleted: boolean;
  readonly children: readonly ProductPlan[];
}

export const productPlanDto: z.ZodType<ProductPlan> = z.lazy(() =>
  z
    .object({
      id: zId,
      product: zId,
      parent: zParentPlanId,
      title: z.string(),
      status: z.string(),
      begin: zDate,
      end: zDate,
      deleted: zBool,
      children: zCollection(productPlanDto).default([]),
    })
    .transform((plan) => brandDto(plan, productPlanBrand)),
);

const moduleKey = z
  .string()
  .regex(/^(?:0|[1-9]\d*)$/u)
  .refine((key) => Number.isSafeInteger(Number(key)));

export function planDetailDtoFor(timezone: string) {
  return z
    .object({
      plan: productPlanDto,
      planStories: zCollection(storyDtoFor(timezone)),
      modulePairs: z.record(moduleKey, z.string()),
      childrenPlans: zCollection(productPlanDto).default([]),
    })
    .transform((detail) => brandDto(detail, planDetailBrand));
}

export type PlanDetail = z.output<ReturnType<typeof planDetailDtoFor>>;

export function* walkProductPlans(
  plans: readonly ProductPlan[],
): Generator<ProductPlan> {
  for (const plan of plans) {
    yield plan;
    yield* walkProductPlans(plan.children);
  }
}
