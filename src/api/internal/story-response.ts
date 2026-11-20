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

function isNonEmptyText(value: unknown): boolean {
  return typeof value === "string" && value.trim() !== "";
}

function hasBusinessError(value: unknown): boolean {
  return (
    isNonEmptyText(value) ||
    (typeof value === "object" &&
      value !== null &&
      Object.keys(value).length > 0)
  );
}

function summarizeBusinessMessage(message: unknown, error: unknown): string {
  // 仅转述诊断短句，服务端附带的字段值可能包含任意私密数据。
  const pending = [error, message];
  let excerpt = "";
  while (pending.length > 0) {
    const value = pending.pop();
    if (typeof value === "string") {
      for (const fragment of value.split(/[。！？；\r\n]+/u)) {
        const sentence = fragment.trim();
        if (!publicDiagnostic.test(sentence)) continue;
        excerpt = excerpt ? `${excerpt}。${sentence}` : sentence;
        if (excerpt.length > maxDiagnosticLength) {
          return excerpt.slice(0, maxDiagnosticLength - 1) + "…";
        }
      }
    } else if (typeof value === "object" && value !== null) {
      const children: unknown[] = Object.values(value);
      for (let index = children.length - 1; index >= 0; index--) {
        pending.push(children[index]);
      }
    }
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

  const story = storyDetailDto.safeParse(payload);
  const envelope = failureEnvelope.safeParse(payload);
  if (envelope.success) {
    const { result, message, error } = envelope.data;
    if (
      result === "fail" ||
      isNonEmptyText(error) ||
      (result !== "success" && isNonEmptyText(message)) ||
      (!story.success && (hasBusinessError(message) || hasBusinessError(error)))
    ) {
      throw new BztError(
        "ZENTAO_BUSINESS_ERROR",
        summarizeBusinessMessage(message, error),
      );
    }
  }

  if (!story.success) {
    throw new BztError("ZENTAO_SCHEMA_MISMATCH", "禅道需求数据结构不匹配。", {
      fields: story.error.issues.map(({ path }) => path.join(".")),
    });
  }
  return story.data;
}
