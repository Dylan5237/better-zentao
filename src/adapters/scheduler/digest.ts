import {
  runDailyDigest,
  type SchedulerRuntime,
} from "../../services/notify.ts";

interface DigestRuntime extends SchedulerRuntime {
  readonly stdout: (text: string) => void;
  readonly stderr: (text: string) => void;
}

export async function runDigestCommand(
  args: string[],
  runtime: DigestRuntime,
): Promise<number> {
  let force = false;
  let config: string | undefined;
  const invalid = () => {
    runtime.stderr(
      "参数不合法。用法为 bzt digest [--force] [--config 路径]。\n",
    );
    return 2;
  };
  for (let i = 0; i < args.length; i++) {
    const arg = args[i];
    if (arg === "--force" && !force) {
      force = true;
    } else if (arg === "--config" && config === undefined) {
      const value = args[++i];
      if (!value?.trim() || value.startsWith("--")) return invalid();
      config = value;
    } else return invalid();
  }
  try {
    const result = await runDailyDigest(
      { ...runtime, logSink: runtime.stderr },
      { config, force },
    );
    runtime.stdout(JSON.stringify(result) + "\n");
    return result.completeness === "partial" ||
      result.notified.some(({ state }) => state === "failed")
      ? 1
      : 0;
  } catch (error) {
    runtime.stderr(
      error instanceof Error && error.name === "BztError"
        ? error.message + "\n"
        : "无法生成每日摘要。\n",
    );
    return 1;
  }
}
