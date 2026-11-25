import { parseArgs } from "node:util";
import type { SchedulerRuntime } from "../../services/notify.ts";
import { runScheduleTask } from "../../services/schedule-task.ts";

interface TaskRuntime extends SchedulerRuntime {
  readonly stdout: (text: string) => void;
  readonly stderr: (text: string) => void;
}

export async function runScheduleTaskCommand(
  args: string[],
  runtime: TaskRuntime,
): Promise<number> {
  const invalid = () => {
    runtime.stderr("参数不合法。请检查任务计划命令、目标和选项。\n");
    return 2;
  };
  let parsed;
  try {
    parsed = parseArgs({
      args,
      options: { config: { type: "string" }, "dry-run": { type: "boolean" } },
      allowPositionals: true,
      tokens: true,
    });
  } catch {
    return invalid();
  }
  const names = parsed.tokens.flatMap((token) =>
    token.kind === "option" ? [token.name] : [],
  );
  const [action, target] = parsed.positionals;
  const { config, "dry-run": dryRun } = parsed.values;
  if (
    (action !== "install" && action !== "status" && action !== "uninstall") ||
    (target !== "digest" && target !== "snapshot") ||
    parsed.positionals.length !== 2 ||
    names.length !== new Set(names).size ||
    (config !== undefined && !config.trim()) ||
    (dryRun !== undefined && action !== "install")
  ) {
    return invalid();
  }
  try {
    const result = await runScheduleTask({
      ...runtime,
      action,
      target,
      dryRun,
      config,
    });
    runtime.stdout(JSON.stringify(result) + "\n");
    return 0;
  } catch (error) {
    runtime.stderr(
      error instanceof Error && error.name === "BztError"
        ? error.message + "\n"
        : "无法处理 Windows 任务计划文件。\n",
    );
    return 1;
  }
}
