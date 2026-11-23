import type { CaptureReport, SanitizedFixture } from "../probe-capture.ts";
import type { SanitizedJson } from "../../core/dto/fixture.ts";
import { BztError } from "../../core/errors.ts";
import { createFixtureSanitizer } from "./fixture-sanitizer.ts";

// 只在 API 内部签发。门面仅引用此键的类型。
export const captureFixtureBrand: unique symbol = Symbol("SanitizedFixture");
export const captureReportBrand: unique symbol = Symbol("CaptureReport");

interface PendingFixture {
  readonly endpoint: string;
  readonly status: number;
  readonly sample: "normal" | "empty";
  readonly body: unknown;
}

function freezeBody(body: SanitizedJson): void {
  if (body === null || typeof body !== "object") return;
  for (const child of Object.values<SanitizedJson>(body)) freezeBody(child);
  Object.freeze(body);
}

export function createCaptureFixtures(
  inputs: readonly PendingFixture[],
  options: {
    readonly knownSecrets: readonly string[];
    readonly configuredAccount: string;
  },
): readonly SanitizedFixture[] {
  const sanitizer = createFixtureSanitizer(options);
  const bodies = sanitizer.sanitizeBatch(inputs.map(({ body }) => body));
  return Object.freeze(
    inputs.map(({ endpoint, status, sample }, index) => {
      const body = bodies[index];
      if (body === undefined)
        throw new BztError("INVALID_INPUT", "夹具脱敏结果不完整。");
      freezeBody(body);
      const fixture = {
        endpoint,
        status,
        sample,
        body,
        [captureFixtureBrand]: true as const,
      };
      Object.defineProperty(fixture, captureFixtureBrand, {
        enumerable: false,
      });
      return Object.freeze(fixture);
    }),
  );
}

export function createCaptureReport(
  fixtures: readonly SanitizedFixture[],
  gaps: CaptureReport["gaps"],
): CaptureReport {
  const report: CaptureReport = {
    fixtures,
    gaps: Object.freeze(gaps.map((gap) => Object.freeze({ ...gap }))),
    completeness: gaps.length > 0 ? "partial" : "complete",
    [captureReportBrand]: true,
  };
  Object.defineProperty(report, captureReportBrand, { enumerable: false });
  return Object.freeze(report);
}
