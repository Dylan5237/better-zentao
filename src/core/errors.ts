export type ErrorCode =
  | "INVALID_INPUT"
  | "AMBIGUOUS_ENTITY"
  | "NOT_FOUND"
  | "MISSING_REQUIRED"
  | "PREVIEW_REQUIRED"
  | "PREVIEW_TOO_FAST"
  | "PLAN_EXPIRED"
  | "PLAN_STALE"
  | "CAPABILITY_UNVERIFIED"
  | "CAPABILITY_DISABLED"
  | "PERMISSION_DENIED"
  | "AUTH_FAILED"
  | "ZENTAO_UNAVAILABLE"
  | "ZENTAO_TIMEOUT"
  | "ZENTAO_SCHEMA_MISMATCH"
  | "ZENTAO_BUSINESS_ERROR"
  | "RULE_VIOLATION"
  | "CONFIG_MISSING";

export class BztError extends Error {
  public readonly retryable: boolean;

  constructor(
    public readonly code: ErrorCode,
    message: string,
    public readonly details?: Readonly<Record<string, unknown>>,
  ) {
    super(message);
    this.name = "BztError";
    // docs/07 §2.4
    this.retryable = code === "ZENTAO_UNAVAILABLE" || code === "ZENTAO_TIMEOUT";
  }
}
