import { z } from "zod";
import { storyDetailDto } from "../../core/dto/story.ts";
import type { StoryDetail } from "../../core/dto/story.ts";
import { BztError } from "../../core/errors.ts";

const failureEnvelope = z.object({
  result: z.unknown().optional(),
  error: z.unknown().optional(),
  message: z.unknown().optional(),
});

const publicDiagnostic =
  /^(?:(?:需求)?标题(?:已存在|不能为空|过长)|(?:该)?需求不存在|缺少必填(?:字段|项)|参数不合法|没有(?:创建|查看)需求的权限)$/u;
const maxDiagnosticLength = 120;

// WP-04 接入真实读取端点前，离线桩不会发出请求。
export const readStoryResponse: (
  storyId: number,
) => Promise<Response> = async () => {
  throw new BztError("ZENTAO_UNAVAILABLE", "当前阶段尚未接入禅道需求读取。");
};

function nonEmptyText(value: unknown): string {
  return typeof value === "string" ? value.trim() : "";
}

function summarizeBusinessMessage(text: string): string {
  // 仅转述诊断短句，服务端附带的字段值可能包含任意私密数据。
  const excerpt = text
    .split(/[。！？；\r\n]+/u)
    .map((sentence) => sentence.trim())
    .filter((sentence) => publicDiagnostic.test(sentence))
    .join("。");
  if (excerpt.length > maxDiagnosticLength) {
    return excerpt.slice(0, maxDiagnosticLength - 1) + "…";
  }
  return excerpt || "禅道返回业务错误。";
}

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
  if (envelope.success) {
    const message =
      nonEmptyText(envelope.data.message) || nonEmptyText(envelope.data.error);
    if (envelope.data.result === "fail" || message) {
      throw new BztError(
        "ZENTAO_BUSINESS_ERROR",
        summarizeBusinessMessage(message),
      );
    }
  }

  const story = storyDetailDto.safeParse(payload);
  if (!story.success) {
    throw new BztError("ZENTAO_SCHEMA_MISMATCH", "禅道需求数据结构不匹配。", {
      fields: story.error.issues.map(({ path }) => path.join(".")),
    });
  }
  return story.data;
}
