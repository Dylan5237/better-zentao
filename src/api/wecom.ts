import { z } from "zod";
import type { Clock } from "../core/clock.ts";
import { BztError } from "../core/errors.ts";
import { postWecom } from "./internal/wecom-transport.ts";

const messageSchema = z.strictObject({
  content: z
    .string()
    .trim()
    .min(1)
    .refine((value) => Buffer.byteLength(value) <= 2048),
  mentionedIds: z.array(z.string().regex(/^[\w.-]+$/u)).optional(),
  mentionedPhones: z.array(z.string().regex(/^\+?\d{7,15}$/u)).optional(),
});

const responseSchema = z
  .object({
    errcode: z.int(),
    errmsg: z.string(),
  })
  .transform(({ errcode }) => ({ errcode }));

export type WecomMessage = z.infer<typeof messageSchema>;
export interface WecomReceipt {
  ok: boolean;
  status: number;
  errcode?: number;
  errmsgSummary?: string;
}

export async function sendWecomMessage(
  message: WecomMessage,
  options: {
    webhookUrl: string;
    clock: Clock;
    timeoutMs?: number;
    logSink?: (line: string) => void;
    env?: Readonly<{ BZT_LOG_LEVEL?: string }>;
  },
): Promise<WecomReceipt> {
  const parsed = messageSchema.safeParse(message);
  if (!parsed.success)
    throw new BztError("INVALID_INPUT", "企微机器人消息格式不合法。");
  const { content, mentionedIds, mentionedPhones } = parsed.data;
  const { status, body } = await postWecom(
    {
      msgtype: "text",
      text: {
        content,
        ...(mentionedIds?.length ? { mentioned_list: mentionedIds } : {}),
        ...(mentionedPhones?.length
          ? { mentioned_mobile_list: mentionedPhones }
          : {}),
      },
    },
    { ...options, timeoutMs: options.timeoutMs ?? 15_000 },
  );
  const receipt = responseSchema.safeParse(body);
  if (!receipt.success)
    return { ok: false, status, errmsgSummary: "企微机器人回执无法确认。" };
  const { errcode } = receipt.data;
  return errcode === 0
    ? { ok: true, status, errcode }
    : { ok: false, status, errcode, errmsgSummary: "企微机器人拒绝消息。" };
}
