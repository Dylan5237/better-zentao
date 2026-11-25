import { z } from "zod";
import { zAccount, zCollection, zId } from "./common.ts";

// The v2 actions return an envelope, with the target ID supplied by the request.
const actionReceipt = z
  .object({
    status: z.literal("success").optional(),
    result: z.literal("success").optional(),
  })
  .refine(({ status, result }) => status !== undefined || result !== undefined)
  .transform(() => undefined);

export const storyLinkExecutionReceiptDto = actionReceipt;
export const taskCreateReceiptDto = z.object({ id: zId });
export const taskActionReceiptDto = actionReceipt;

export const taskExecutionTeamDto = z
  .object({
    id: zId,
    teamMembers: zCollection(zAccount.pipe(z.string().min(1)), true),
  })
  .transform(({ id, teamMembers }) => ({
    id,
    accounts: teamMembers,
  }));
