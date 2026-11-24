import { z } from "zod";
import { brandDto, zCount, zDate, zHours, zId, zNullableId } from "./common.ts";

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
