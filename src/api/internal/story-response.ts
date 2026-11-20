import { z } from "zod";
import { storyDetailDto } from "../../core/dto/story.ts";
import type { StoryDetail } from "../../core/dto/story.ts";
import { BztError } from "../../core/errors.ts";

const failureEnvelope = z.object({
  result: z.unknown().optional(),
  error: z.unknown().optional(),
  message: z.unknown().optional(),
});

export async function decodeStoryResponse(
  response: Response,
): Promise<StoryDetail> {
  // docs/06 §2.2 的成功状态包含 201。
  if (!response.ok) {
    throw new BztError("ZENTAO_UNAVAILABLE", "禅道读取失败。", {
      status: response.status,
    });
  }

  let payload: unknown;
  try {
    payload = await response.json();
  } catch {
    throw new BztError("ZENTAO_SCHEMA_MISMATCH", "禅道响应无法解码为 JSON。");
  }

  const envelope = failureEnvelope.safeParse(payload);
  if (
    envelope.success &&
    (envelope.data.result === "fail" ||
      envelope.data.error !== undefined ||
      envelope.data.message !== undefined)
  ) {
    throw new BztError("ZENTAO_BUSINESS_ERROR", "禅道返回业务错误。");
  }

  const story = storyDetailDto.safeParse(payload);
  if (!story.success) {
    throw new BztError("ZENTAO_SCHEMA_MISMATCH", "禅道需求数据结构不匹配。", {
      fields: story.error.issues.map(({ path }) => path.join(".")),
    });
  }
  return story.data;
}
