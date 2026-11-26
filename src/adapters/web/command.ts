import { parseArgs } from "node:util";
import { preparePortalStartup } from "../../services/portal-startup.ts";
import type { WorkbenchRuntime } from "../../services/workbench.ts";
import { publishPortalLaunch } from "./portal-launch.ts";
import { startPortal } from "./server.ts";

export async function runWebCommand(
  args: string[],
  runtime: WorkbenchRuntime & {
    stdout: (s: string) => void;
    stderr: (s: string) => void;
  },
) {
  let parsed;
  try {
    parsed = parseArgs({
      args,
      options: { config: { type: "string" }, port: { type: "string" } },
      tokens: true,
    });
  } catch {
    runtime.stderr("用法：bzt web [--config 路径] [--port 端口]\n");
    return 2;
  }
  const { port = "17329", config } = parsed.values;
  if (
    !/^\d{1,5}$/u.test(port) ||
    Number(port) > 65535 ||
    config?.trim() === "" ||
    new Set(parsed.tokens.map((t) => (t.kind === "option" ? t.name : "")))
      .size !== parsed.tokens.length
  ) {
    runtime.stderr("门户参数不合法，请检查端口或配置路径。\n");
    return 2;
  }
  const configuredTeam = config ?? runtime.env.BZT_CONFIG?.trim();
  const options = {
    ...runtime,
    env: {
      ...runtime.env,
      BZT_CONFIG: configuredTeam || "config/team.local.json",
    },
  };
  let settings;
  try {
    settings = await preparePortalStartup(options, !configuredTeam);
  } catch {
    runtime.stderr(
      "无法加载本机门户设置，请检查环境变量、本地状态目录和团队配置文件。\n",
    );
    return 1;
  }
  let portal: Awaited<ReturnType<typeof startPortal>> | undefined;
  const publishLaunch = async (url: string) => {
    if (runtime.homeDir && portal)
      await publishPortalLaunch(runtime.homeDir, portal.instanceId, url);
  };
  try {
    portal = await startPortal({
      port: Number(port),
      clock: runtime.clock,
      startup: settings.startup,
      login: settings.login,
      onLaunchUrlChanged: publishLaunch,
    });
  } catch {
    runtime.stderr(
      "无法监听本机端口，请检查占用情况或使用 --port 指定其他端口。\n",
    );
    return 1;
  }
  try {
    await publishLaunch(portal.launchUrl);
  } catch {
    runtime.stderr("无法保存双击启动入口，请打开终端显示的本机链接。\n");
  }
  runtime.stdout("本地禅道工作台 " + portal.launchUrl + " （Ctrl+C 关闭）\n");
  return 0;
}
