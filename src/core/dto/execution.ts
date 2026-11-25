import { z } from "zod";
import {
  brandDto,
  zBool,
  zCollection,
  zCount,
  zDate,
  zHours,
  zId,
  zNullableId,
} from "./common.ts";

const probeProducts = zCollection(
  z.union([zId, z.object({ id: zId }).transform(({ id }) => id)]),
);
const probeScopeFields = {
  id: zId,
  status: z.enum([
    "wait",
    "doing",
    "suspended",
    "closed",
    "done",
    "pause",
    "cancel",
  ]),
  deleted: zBool.optional(),
  products: probeProducts.optional(),
};

export const probeProjectDto = z.object({
  ...probeScopeFields,
  multiple: zBool.optional(),
});

export const probeProjectViewDto = z.object({
  project: z.object({
    ...probeScopeFields,
    multiple: zBool,
  }),
  products: probeProducts.optional(),
});

export const probeExecutionDto = z.object({
  ...probeScopeFields,
  project: zId,
});

const projectBrand: unique symbol = Symbol("Project");
const executionBrand: unique symbol = Symbol("Execution");

export const projectDto = z
  .object({
    id: zId,
    parent: zNullableId.optional(),
    name: z.string().min(1),
    model: z.string().optional(),
    status: z.string().min(1),
  })
  .transform((project) => brandDto(project, projectBrand));

export type Project = z.infer<typeof projectDto>;

export const executionDto = z
  .object({
    id: zId,
    project: zId,
    parent: zNullableId.optional(),
    name: z.string().min(1),
    projectName: z.string().optional(),
    type: z.string().min(1),
    status: z.string().min(1),
    begin: zDate,
    end: zDate,
    progress: zHours.optional(),
    delay: zCount.optional(),
    totalEstimate: zHours.optional(),
    totalConsumed: zHours.optional(),
    totalLeft: zHours.optional(),
  })
  .transform((execution) => brandDto(execution, executionBrand));

export type Execution = z.infer<typeof executionDto>;
