import { z } from "zod";
import type { BetterZentaoClient } from "../../index.js";
import { validateInput } from "../../services/inputs.js";

export type CliField = "text" | "id" | "reference" | "number" | "list" | "boolean" | "dryRun";

export interface ToolDef {
  name: string;
  command: string;
  description: string;
  schema: z.ZodObject;
  readOnly: boolean;
  cli: Record<string, CliField>;
  positional?: string[];
  prepare: (input: unknown) => (client: BetterZentaoClient) => Promise<object>;
}

export function defineTool<S extends z.ZodObject>(tool: Omit<ToolDef, "prepare" | "schema"> & {
  schema: S;
  invoke: (client: BetterZentaoClient, input: z.output<S>) => Promise<object>;
}): ToolDef {
  const { invoke, ...definition } = tool;
  return {
    ...definition,
    prepare(input: unknown) {
      const validated = validateInput(tool.schema, input);
      return client => invoke(client, validated);
    },
  };
}
