import { storyDetailDto } from "../../core/dto/story.ts";
import type { StoryDetail } from "../../core/dto/story.ts";
import { BztError } from "../../core/errors.ts";
import { assertNoBusinessError } from "./business-error.ts";

// WP-04 接入真实读取端点前，离线桩不会发出请求。
export const readStoryResponse: (
  storyId: number,
) => Promise<Response> = async () => {
  throw new BztError("ZENTAO_UNAVAILABLE", "当前阶段尚未接入禅道需求读取。");
};

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

  const story = storyDetailDto.safeParse(payload);
  assertNoBusinessError(payload, story.success);

  if (!story.success) {
    throw new BztError("ZENTAO_SCHEMA_MISMATCH", "禅道需求数据结构不匹配。", {
      fields: story.error.issues.map(({ path }) => path.join(".")),
    });
  }
  return story.data;
}
