type ErrorCode =
  | "INVALID_INPUT"
  | "PERMISSION_DENIED"
  | "PLAN_EXPIRED"
  | "ZENTAO_UNAVAILABLE"
  | "ZENTAO_BUSINESS_ERROR"
  | "ZENTAO_SCHEMA_MISMATCH";

export class BztError extends Error {
  constructor(
    public readonly code: ErrorCode,
    message: string,
    public readonly details?: Readonly<Record<string, unknown>>,
  ) {
    super(message);
    this.name = "BztError";
  }
}
