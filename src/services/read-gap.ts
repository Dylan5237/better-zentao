import type { BztError } from "../core/errors.ts";

export function readGapReason(source: string, error: BztError) {
  if (source.startsWith("tasks:") && error.code === "PERMISSION_DENIED")
    return "当前账号没有该迭代的查看权限。需纳入统计时，请联系项目负责人在禅道核对迭代访问授权。";
  return `读取失败（${error.code}）。`;
}
