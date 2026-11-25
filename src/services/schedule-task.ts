import {
  lstat,
  mkdir,
  mkdtemp,
  readFile,
  rename,
  rm,
  rmdir,
  writeFile,
} from "node:fs/promises";
import { join, resolve } from "node:path";
import { z } from "zod";
import { formatLocalDate } from "../core/calendar.ts";
import { assertNoConfigCredentials, loadFileConfig } from "../core/config.ts";
import { BztError } from "../core/errors.ts";
import { requireCollector, type SchedulerRuntime } from "./notify.ts";

const argsSchema = z
  .object({
    action: z.enum(["install", "status", "uninstall"]),
    target: z.enum(["digest", "snapshot"]),
    dryRun: z.boolean().optional(),
  })
  .refine(({ action, dryRun }) => action === "install" || dryRun === undefined);
const ioError = z.object({ code: z.string() });

async function fileExists(path: string): Promise<boolean> {
  try {
    if (!(await lstat(path)).isFile())
      throw new BztError("INVALID_INPUT", "任务计划 XML 路径不是普通文件。");
    return true;
  } catch (error) {
    if (ioError.safeParse(error).data?.code === "ENOENT") return false;
    throw error;
  }
}

async function publishXml(
  directory: string,
  path: string,
  xml: string,
): Promise<void> {
  await mkdir(directory, { recursive: true });
  const staging = await mkdtemp(join(directory, ".task-"));
  const pending = join(staging, "task.xml");
  try {
    await writeFile(pending, xml, { encoding: "utf8", flag: "wx" });
    await rename(pending, path);
  } finally {
    await rm(pending, { force: true });
    await rmdir(staging);
  }
}

export async function runScheduleTask(
  options: SchedulerRuntime & {
    action: string;
    target: string;
    dryRun?: boolean;
  },
) {
  const parsed = argsSchema.safeParse(options);
  if (!parsed.success)
    throw new BztError("INVALID_INPUT", "任务计划参数不合法。");
  const { action, target, dryRun = false } = parsed.data;
  const { env, clock } = options;
  const { config, stateDir } = await loadFileConfig(options);
  if (action === "install")
    requireCollector(
      env.ZENTAO_ACCOUNT,
      target === "digest"
        ? config.notify.digest.collector
        : config.snapshot.collector,
    );
  if (!stateDir)
    throw new BztError(
      "CONFIG_MISSING",
      "无法确定本地状态目录，请设置 BZT_HOME。",
    );

  const taskName = `better-zentao-${target}`;
  const directory = resolve(stateDir, "scheduler");
  const xmlPath = join(directory, `${taskName}.xml`);
  if (/[\p{Cc}\u2028\u2029]/u.test(xmlPath))
    throw new BztError("INVALID_INPUT", "任务计划 XML 路径不合法。");
  try {
    assertNoConfigCredentials(xmlPath, env);
  } catch {
    throw new BztError("INVALID_INPUT", "任务计划 XML 路径包含凭据。");
  }
  // 指引以 PowerShell 命令展示。单引号转义避免路径内字符变成命令。
  const quote = (value: string) => "'" + value.replaceAll("'", "''") + "'";
  const targetArg = `/TN ${quote(taskName)}`;
  const base = { ok: true, action, target, xmlPath, taskName, dryRun };
  if (action === "status") {
    return {
      ...base,
      exists: await fileExists(xmlPath),
      commandHints: [`schtasks /Query ${targetArg}`],
    };
  }
  if (action === "uninstall") {
    const removed = await fileExists(xmlPath);
    if (removed) await rm(xmlPath, { force: true });
    return {
      ...base,
      exists: false,
      removed,
      commandHints: [`schtasks /Delete ${targetArg}`],
    };
  }

  const day = formatLocalDate(clock(), config.timezone);
  const time = target === "digest" ? config.notify.digest.time : "09:00";
  const template = await readFile(
    new URL(`../../templates/windows-task-${target}.xml`, import.meta.url),
    "utf8",
  );
  const xml = template
    .replaceAll("{{TRIGGER_TIME}}", `${day}T${time}:00`)
    .replaceAll("{{DAY_OF_MONTH}}", String(config.snapshot.day))
    .replaceAll("{{WORKING_DIR}}", "%USERPROFILE%")
    .replaceAll("{{ARGS}}", `/d /c bzt ${target}`);
  if (!dryRun) await publishXml(directory, xmlPath, xml);
  return {
    ...base,
    exists: !dryRun || (await fileExists(xmlPath)),
    commandHints: [`schtasks /Create /XML ${quote(xmlPath)} ${targetArg}`],
    ...(dryRun ? { xml } : {}),
  };
}
