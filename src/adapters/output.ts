import { ConfigError, InvalidParamError, ZentaoApiError, ZentaoCreateUnconfirmedError, ZentaoError } from "../core/errors.js";
import type { BetterZentaoClient } from "../index.js";

export function publicError(error: unknown, remote = false) {
  if (error instanceof ConfigError) {
    return { name: error.name, code: error.code, message: error.message, missingVars: error.missingVars };
  }
  if (error instanceof ZentaoCreateUnconfirmedError) {
    return { name: error.name, code: error.code, message: error.message, metadata: error.metadata, id: error.id, url: error.url };
  }
  if (error instanceof ZentaoApiError) {
    return { name: error.name, code: error.code, message: remote ? "禅道 API 请求失败" : error.message, status: error.status };
  }
  if (error instanceof ZentaoError) {
    const message = remote && !(error instanceof InvalidParamError) ? "禅道操作未完成" : error.message;
    return { name: error.name, code: error.code, message };
  }
  return { name: "RuntimeError", code: "RUNTIME_ERROR", message: "工具运行失败，请检查配置和连接" };
}

export function safeOutput(value: object, client?: BetterZentaoClient, secrets: readonly string[] = []): Record<string, unknown> {
  const redactions = [...new Set(secrets.filter(Boolean))].sort((a, b) => b.length - a.length);
  function clean(input: unknown): unknown {
    if (typeof input === "string") {
      let text = input;
      for (const secret of redactions) text = text.split(secret).join("[redacted]");
      return client?.redactText(text) ?? text;
    }
    if (Array.isArray(input)) return input.map(clean);
    if (input && typeof input === "object") {
      return Object.fromEntries(Object.entries(input).filter(([key, entry]) =>
        entry !== undefined && !/^(?:password|resetToken|token)$/i.test(key)).map(([key, entry]) => [key, clean(entry)]));
    }
    return input;
  }
  return clean(value) as Record<string, unknown>;
}
