import { stderr } from "node:process";
import { z } from "zod";
import { BztError } from "./errors.ts";

const routeSegment = /^(?:[A-Za-z][A-Za-z0-9_-]*|\{[A-Za-z][A-Za-z0-9_]*\})$/u;
const credentialWords =
  /password|passwd|pwd|token|authorization|bearer|credential|cookie|secret|apikey|privatekey|phpsessid|zentaosid|sessionid|webhook/iu;

export const httpPathTemplate = z.string().refine((value) => {
  if (value === "/index.php" || value === "/api.php/v1/tokens") return true;
  const [root, entry, version, ...segments] = value.split("/");
  return (
    root === "" &&
    entry === "api.php" &&
    (version === "v1" || version === "v2") &&
    segments.length > 0 &&
    segments.every(
      (segment) =>
        routeSegment.exec(segment)?.[0] === segment &&
        !credentialWords.test(segment.replace(/[^a-z]/giu, "")) &&
        !/[a-f\d]{32}/iu.test(segment),
    )
  );
});

const httpLogFields = z.object({
  method: z.enum(["GET", "POST", "PUT", "PATCH", "DELETE"]),
  pathTemplate: httpPathTemplate,
  status: z.union([z.literal(0), z.int().min(100).max(599)]),
  durationMs: z.number().min(0),
  opId: z.uuid().optional(),
  objectId: z.int().positive().optional(),
});

const logLevels = { debug: 0, info: 1, warn: 2, error: 3 };
const logLevel = z.enum(["debug", "info", "warn", "error"]);

export function writeHttpLog(
  input: unknown,
  sink: (line: string) => void = (line) => stderr.write(line),
  env?: Readonly<{ BZT_LOG_LEVEL?: string }>,
): void {
  const event = httpLogFields.safeParse(input);
  if (!event.success) {
    throw new BztError("INVALID_INPUT", "日志字段不合法。");
  }
  const configuredLevel = logLevel.safeParse(env?.BZT_LOG_LEVEL?.trim());
  const minimum =
    logLevels[configuredLevel.success ? configuredLevel.data : "info"];
  const { status } = event.data;
  let severity = logLevels.info;
  if (status === 0 || status >= 500) severity = logLevels.error;
  else if (status >= 300) severity = logLevels.warn;

  if (severity >= minimum) sink(JSON.stringify(event.data) + "\n");
}
