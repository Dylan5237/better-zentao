import { z } from "zod";
import {
  brandDto,
  dateTimeSchema,
  zAccount,
  zBool,
  zCount,
  zDate,
  zId,
  zNullableId,
} from "./common.ts";

const bugBrand: unique symbol = Symbol("Bug");

export function bugDtoFor(timezone: string) {
  const datetime = dateTimeSchema(timezone);
  return z
    .object({
      id: zId,
      product: zId,
      project: zNullableId.optional(),
      module: zNullableId.optional(),
      execution: zNullableId.optional(),
      story: zNullableId.optional(),
      task: zNullableId.optional(),
      title: z.string().min(1),
      status: z.string().min(1),
      severity: zCount,
      feedbackBy: z.string().nullable().optional(),
      openedBy: zAccount.optional(),
      assignedTo: zAccount.optional(),
      openedDate: datetime.optional(),
      assignedDate: datetime.optional(),
      deadline: zDate.optional(),
      resolvedDate: datetime.optional(),
      closedDate: datetime.optional(),
      deleted: zBool.optional(),
    })
    .transform((bug) => brandDto(bug, bugBrand));
}

export type Bug = z.output<ReturnType<typeof bugDtoFor>>;
