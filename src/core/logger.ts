import { stderr } from "node:process";
import { z } from "zod";
import { BztError } from "./errors.ts";

const httpLogFields = z.object({
  method: z.enum(["GET", "POST", "PUT", "PATCH", "DELETE"]),
  pathTemplate: z.enum(["/api.php/v1/stories/{id}", "/api.php/v2/stories"]),
  status: z.int().min(100).max(599),
  durationMs: z.number().min(0),
  opId: z.uuid().optional(),
  objectId: z.int().positive().optional(),
});

export function writeHttpLog(
  input: unknown,
  sink: (line: string) => void = (line) => stderr.write(line),
): void {
  const event = httpLogFields.safeParse(input);
  if (!event.success) {
    throw new BztError("INVALID_INPUT", "日志字段不合法。");
  }
  sink(JSON.stringify(event.data) + "\n");
}
