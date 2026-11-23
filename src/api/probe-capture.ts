import type { Clock } from "../core/clock.ts";
import type { SanitizedJson } from "../core/dto/fixture.ts";
import type { ErrorCode } from "../core/errors.ts";
import type {
  captureFixtureBrand,
  captureReportBrand,
} from "./internal/capture-fixture.ts";
import { collectProbeFixtures } from "./internal/probe-capture.ts";

export interface SanitizedFixture {
  readonly [captureFixtureBrand]: true;
  readonly endpoint: string;
  readonly status: number;
  readonly body: SanitizedJson;
  readonly sample: "normal" | "empty";
}

export interface CaptureReport {
  readonly [captureReportBrand]: true;
  readonly fixtures: readonly SanitizedFixture[];
  readonly completeness: "complete" | "partial";
  readonly gaps: readonly {
    readonly endpoint: string;
    readonly code: ErrorCode;
  }[];
}

export interface CaptureOptions {
  readonly baseUrl: string;
  readonly account: string;
  readonly password: string;
  readonly timeoutMs: number;
  readonly productId?: number;
  readonly clock: Clock;
  readonly sleep?: (ms: number) => Promise<void>;
  readonly logSink?: (line: string) => void;
  readonly logLevel?: "debug" | "info" | "warn" | "error";
}

export function captureProbeFixtures(
  options: CaptureOptions,
): Promise<CaptureReport> {
  const {
    account,
    baseUrl,
    clock,
    logLevel,
    logSink,
    password,
    productId,
    sleep,
    timeoutMs,
  } = options;
  return collectProbeFixtures(
    {
      account,
      baseUrl,
      clock,
      logSink,
      password,
      sleep,
      env: { ZENTAO_TIMEOUT_MS: String(timeoutMs), BZT_LOG_LEVEL: logLevel },
    },
    productId,
  );
}
