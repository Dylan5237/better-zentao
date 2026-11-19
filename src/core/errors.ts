export class ZentaoError extends Error {
  constructor(message: string, readonly code = "ZENTAO_ERROR") {
    super(message);
    this.name = this.constructor.name;
  }
}

export class ConfigError extends ZentaoError {
  constructor(message: string, readonly missingVars: readonly string[] = []) {
    super(message, "CONFIG_ERROR");
  }
}

export class InvalidParamError extends ZentaoError {
  constructor(message: string) {
    super(message, "INVALID_PARAM");
  }
}

export class ZentaoApiError extends ZentaoError {
  constructor(message: string, readonly status?: number, readonly candidateId?: number) {
    super(message, "ZENTAO_API_ERROR");
  }
}

export class ZentaoAuthExpiredError extends ZentaoError {
  constructor() {
    super("禅道授权已失效，请重新授权", "ZENTAO_AUTH_EXPIRED");
  }
}

export interface ResponseMetadata {
  status: number | "unknown";
  mediaType: "application/json" | "application/problem+json" | "text/html" | "text/plain" | "unknown";
  bytes: number | "unknown";
  bodyKind: "empty" | "non-json" | "null" | "array" | "object" | "number" | "boolean" | "string" | "unknown";
}

export const unknownResponse: ResponseMetadata = {
  status: "unknown", mediaType: "unknown", bytes: "unknown", bodyKind: "unknown",
};

export class ZentaoCreateUnconfirmedError extends ZentaoError {
  constructor(
    readonly metadata: ResponseMetadata = unknownResponse,
    readonly id?: number,
    readonly url?: string,
  ) {
    const { status, mediaType, bytes, bodyKind } = metadata;
    const receipt = id ? "，已知 ID=" + id : "";
    super(
      "需求创建未确认（status=" + status + "，mediaType=" + mediaType +
      "，bytes=" + bytes + "，bodyKind=" + bodyKind + "）" + receipt +
      "。禁止重试创建，请先核查现有需求。",
      "CREATE_UNCONFIRMED",
    );
  }
}
