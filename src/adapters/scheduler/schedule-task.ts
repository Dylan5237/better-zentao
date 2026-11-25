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
  const [action, target, flag] = args;
  if (
    (action !== "install" && action !== "status" && action !== "uninstall") ||
    (target !== "digest" && target !== "snapshot") ||
    args.length > 3 ||
    (flag !== undefined && (flag !== "--dry-run" || action !== "install"))
  ) {
    runtime.stderr(
      "参数不合法。用法为 bzt schedule-task <install|status|uninstall> <digest|snapshot>，install 可加 --dry-run。\n",
    );
    return 2;
  }
  try {
    const result = await runScheduleTask({
      ...runtime,
      action,
      target,
      dryRun: flag ? true : undefined,
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
