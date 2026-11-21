import { expect, it } from "vitest";
import { BztError } from "../../src/core/errors.ts";
import type { ErrorCode } from "../../src/core/errors.ts";

const retryableByCode = {
  INVALID_INPUT: false,
  AMBIGUOUS_ENTITY: false,
  NOT_FOUND: false,
  MISSING_REQUIRED: false,
  PREVIEW_REQUIRED: false,
  PREVIEW_TOO_FAST: false,
  PLAN_EXPIRED: false,
  PLAN_STALE: false,
  CAPABILITY_UNVERIFIED: false,
  CAPABILITY_DISABLED: false,
  PERMISSION_DENIED: false,
  AUTH_FAILED: false,
  ZENTAO_UNAVAILABLE: true,
  ZENTAO_TIMEOUT: true,
  ZENTAO_SCHEMA_MISMATCH: false,
  ZENTAO_BUSINESS_ERROR: false,
  RULE_VIOLATION: false,
  CONFIG_MISSING: false,
} satisfies Record<ErrorCode, boolean>;

it.each(Object.entries(retryableByCode) as [ErrorCode, boolean][])(
  "07 §2.4 %s 的 retryable 由错误码确定",
  (code, retryable) => {
    expect(new BztError(code, "合成提示")).toMatchObject({
      name: "BztError",
      code,
      retryable,
    });
  },
);
