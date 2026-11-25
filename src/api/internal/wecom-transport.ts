import type { Clock } from "../../core/clock.ts";
import { readConfigEnvironment, resolveLogLevel } from "../../core/config.ts";
import { BztError } from "../../core/errors.ts";

const pathTemplate = "/cgi-bin/webhook/send";
const method = "POST";

export async function postWecom(
  payload: object,
  options: {
    webhookUrl: string;
    timeoutMs: number;
    clock: Clock;
    logSink?: (line: string) => void;
    env?: Readonly<{ BZT_LOG_LEVEL?: string }>;
  },
): Promise<{ status: number; body?: unknown }> {
  const { clock, logSink, env, timeoutMs } = options;
  const input = options.webhookUrl.trim();
  readConfigEnvironment({ BZT_WECOM_WEBHOOK: input });
  const url = URL.parse(input);
  if (!url || url.searchParams.size !== 1)
    throw new BztError("INVALID_INPUT", "企微机器人地址不合法。");

  const started = clock();
  let status = 0;
  try {
    const response = await fetch(url, {
      method,
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(payload),
      redirect: "error",
      signal: AbortSignal.timeout(timeoutMs),
    });
    status = response.status;
    if (!response.ok || response.redirected) {
      void response.body?.cancel().catch(() => {});
      return { status };
    }
    const body: unknown = await response.json();
    return { status, body };
  } catch {
    // 网络异常和解析异常可能包含原地址或响应正文。
    return { status };
  } finally {
    const level = resolveLogLevel(env);
    if (
      logSink &&
      (level === "debug" ||
        level === "info" ||
        status === 0 ||
        status >= 500 ||
        (level === "warn" && status >= 300))
    ) {
      try {
        const durationMs = Math.max(0, clock() - started);
        logSink(
          JSON.stringify({ method, pathTemplate, status, durationMs }) + "\n",
        );
      } catch {
        // 日志输出失败不能覆盖已取得的传输结果。
      }
    }
  }
}
