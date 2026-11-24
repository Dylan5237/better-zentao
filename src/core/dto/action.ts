import { z } from "zod";
import { brandDto, dateTimeSchema, zAccount, zId } from "./common.ts";

const actionBrand: unique symbol = Symbol("Action");

export function actionDtoFor(timezone?: string) {
  return z
    .object({
      id: zId,
      actor: zAccount,
      action: z.string(),
      date: dateTimeSchema(timezone),
      comment: z.string().nullish(),
    })
    .transform((action) => brandDto(action, actionBrand));
}

export type Action = z.output<ReturnType<typeof actionDtoFor>>;
