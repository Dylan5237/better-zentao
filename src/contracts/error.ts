import { z } from "zod";
import type { ErrorCode } from "../core/errors.ts";

export const toolErrorMessages = {
  INVALID_INPUT: "工具参数或本地配置不合法，请核对后重试。",
  AMBIGUOUS_ENTITY: "找到多个匹配项，请明确选择。",
  NOT_FOUND: "对象不存在或没有查看权限。",
  MISSING_REQUIRED: "请补齐必填信息。",
  PREVIEW_REQUIRED: "请先展示操作预览并取得用户确认。",
  PREVIEW_TOO_FAST: "确认间隔不足，请展示预览并等待用户确认。",
  PLAN_EXPIRED: "操作计划已过期，请重新生成预览。",
  PLAN_STALE: "操作目标已变更，请重新生成预览。",
  CAPABILITY_UNVERIFIED: "该写入能力尚未验证，请在禅道手工操作。",
  CAPABILITY_DISABLED: "该能力已禁用，请由本人在禅道操作。",
  CAPABILITY_CLI_ONLY: "该操作仅允许通过 CLI 使用。",
  PERMISSION_DENIED: "禅道拒绝访问或超出工具权限。",
  AUTH_FAILED: "禅道登录失败，请运行 bzt doctor。",
  ZENTAO_UNAVAILABLE: "暂时无法访问禅道，请稍后重试。",
  ZENTAO_TIMEOUT: "读取禅道超时，请稍后重试或缩小范围。",
  ZENTAO_SCHEMA_MISMATCH: "工具未得到符合契约的结果，请联系管理员。",
  ZENTAO_BUSINESS_ERROR: "禅道返回业务错误。",
  RULE_VIOLATION: "操作不符合团队协作规范，请核对输入。",
  CONFIG_MISSING: "缺少所需配置。请检查禅道环境变量或团队配置。",
} satisfies Record<ErrorCode, string>;

export const toolErrorSchema = z.strictObject({
  ok: z.literal(false),
  code: z.custom<ErrorCode>(
    (value) =>
      typeof value === "string" && Object.hasOwn(toolErrorMessages, value),
  ),
  message: z.string(),
  details: z.record(z.string(), z.json()).optional(),
  retryable: z.boolean(),
});

export type ToolError = z.infer<typeof toolErrorSchema>;
