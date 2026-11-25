import { parseArgs } from "node:util";
import {
  runSnapshotCommand,
  snapshotCommandError,
  snapshotCommandSchema,
  type SnapshotRuntimeOptions,
} from "../../services/snapshot.ts";

const invalidArgs = {
  exitCode: 2,
  message: "快照参数不合法。请检查 capture、export 或 import 的参数。",
};

/** 接收 bzt snapshot 之后的参数，由上层 CLI 输出结果。 */
export async function runSnapshotSchedulerCli(
  args: string[],
  runtime: Omit<SnapshotRuntimeOptions, "command">,
) {
  let parsed;
  try {
    parsed = parseArgs({
      args,
      options: {
        month: { type: "string" },
        product: { type: "string" },
        out: { type: "string" },
        in: { type: "string" },
        snap: { type: "string" },
        config: { type: "string" },
      },
      allowPositionals: true,
      strict: true,
      tokens: true,
    });
  } catch {
    return invalidArgs;
  }

  const names = parsed.tokens.flatMap((token) =>
    token.kind === "option" ? [token.name] : [],
  );
  if (parsed.positionals.length !== 1 || names.length !== new Set(names).size)
    return invalidArgs;

  const {
    month,
    product,
    out,
    in: input,
    snap: snapId,
    config,
  } = parsed.values;
  if (product !== undefined && !/^[1-9]\d*$/u.test(product)) return invalidArgs;
  const command = snapshotCommandSchema.safeParse({
    action: parsed.positionals[0],
    ...(month === undefined ? {} : { month }),
    ...(product === undefined ? {} : { product: Number(product) }),
    ...(out === undefined ? {} : { out }),
    ...(input === undefined ? {} : { input }),
    ...(snapId === undefined ? {} : { snapId }),
    ...(config === undefined ? {} : { config }),
  });
  if (!command.success) return invalidArgs;

  try {
    return {
      exitCode: 0,
      output: await runSnapshotCommand({ ...runtime, command: command.data }),
    };
  } catch (error) {
    return { exitCode: 1, ...snapshotCommandError(error) };
  }
}
