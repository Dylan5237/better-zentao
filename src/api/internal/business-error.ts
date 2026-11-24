import { z } from "zod";
import { BztError } from "../../core/errors.ts";

const failureEnvelope = z.object({
  result: z.unknown().optional(),
  status: z.unknown().optional(),
  error: z.unknown().optional(),
  message: z.unknown().optional(),
});

const publicDiagnostic =
  /^(?:(?:需求)?标题(?:已存在|不能为空|过长)|(?:该)?需求不存在|缺少必填(?:字段|项)|参数不合法|没有(?:创建|查看)需求的权限)$/u;
const maxDiagnosticLength = 120;

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

export function assertNoBusinessError(
  payload: unknown,
  hasValidBody: boolean,
  allowReceiptMessage = false,
): void {
  const envelope = failureEnvelope.safeParse(payload);
  if (!envelope.success) return;
  const { result, status, message, error } = envelope.data;
  const receiptDiagnostic = allowReceiptMessage
    ? summarizeBusinessMessage(message, error)
    : undefined;
  // docs/06 §2.2 合法主体可以附带结构化元数据。
  // v2 创建的成功回执也有 message；缺少 ID 时普通提示不能证明写入失败。
  if (
    result === "fail" ||
    isNonEmptyText(error) ||
    (!hasValidBody && hasBusinessError(error)) ||
    (allowReceiptMessage
      ? status === "fail" || receiptDiagnostic !== "禅道返回业务错误。"
      : (result !== "success" && isNonEmptyText(message)) ||
        (!hasValidBody && hasBusinessError(message)))
  ) {
    throw new BztError(
      "ZENTAO_BUSINESS_ERROR",
      receiptDiagnostic ?? summarizeBusinessMessage(message, error),
    );
  }
}
