import { z } from "zod";
import { zId } from "./common.ts";

export const storyWriteReceiptDto = z.object({ id: zId });
export const storyCommentReceiptDto = z
  .object({ data: zId })
  .transform(({ data }) => ({ id: data }));
