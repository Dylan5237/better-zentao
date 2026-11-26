import { parseArgs } from "node:util";
import { runConfigEditor } from "../../services/config-ui.ts";
import { runSnapshotSchedulerCli } from "../scheduler/snapshot.ts";
import { runScheduleTaskCommand } from "../scheduler/schedule-task.ts";
import { runDigestCommand } from "../scheduler/digest.ts";
import { renderTeamConfigEditorHtml } from "./render/config-editor-html.ts";
import { runDeleteStory } from "../../services/delete-story.ts";
import { getDoctorStatus } from "../../services/doctor.ts";
import { installAgent } from "../../services/install-agent.ts";
import { runProbeCapture } from "../../services/probe-capture.ts";
import { runProbeWrite } from "../../services/probe-write.ts";
import { startMcpServer } from "../mcp/server.ts";
import { runServeCommand } from "../server/command.ts";
import { runWebCommand } from "../web/command.ts";

interface CliRuntime {
  readonly stdout: (text: string) => void;
  readonly stderr: (text: string) => void;
  readonly env: Readonly<Record<string, string | undefined>>;
  readonly homeDir?: string;
  readonly clock: () => number;
  readonly nodeVersion: string;
  readonly onShutdown?: (cleanup: () => Promise<void> | void) => void;
}

const help = `用法
  bzt --help
  bzt doctor [--live] [--config 路径] [--product ID]    环境自检
  bzt probe capture [--out 目录] [--config 路径] [--product ID]    只读采集脱敏夹具
  bzt probe write <能力> --product 29 [--config 路径] [--assignee 测试账号] [--visible-tag] [--out 目录]
  bzt probe write --all --product 29 [--config 路径] [--assignee 测试账号] [--visible-tag] [--out 目录]
  bzt probe cleanup --product 29 --story ID [--config 路径]    关闭 #29 测试需求
  bzt delete --story ID [--confirm] [--config 路径]    预览研发需求，添加 --confirm 删除并回读
  bzt install-agent <codex|claude|gemini> [--config 路径] [--project 目录] [--dry-run]
      也接受 --agent <codex|claude|gemini>，--project 仅用于 Claude Code
  bzt config-ui [--config 路径] [--out HTML路径]    生成配置编辑页
  bzt web [--config 团队配置路径] [--port 端口]    启动单人本地门户
  bzt serve --server-config 路径    启动集中部署多用户服务
  bzt snapshot [capture|export|import] [选项]    采集或交换月初快照
  bzt digest [--config 路径] [--force] [--dry-run]    生成每日摘要
  bzt schedule-task <install|status|uninstall> <digest|snapshot> [--config 路径] [--dry-run]
  bzt mcp       启动 stdio 服务
`;

function invalidArgs(runtime: CliRuntime): number {
  runtime.stderr("参数不合法。请运行 bzt --help。\n");
  return 2;
}

export async function runCli(
  args: string[],
  runtime: CliRuntime,
): Promise<number> {
  const [first, ...rest] = args;
  if (!rest.includes("--help") && !rest.includes("-h")) {
    if (first === "web") return runWebCommand(rest, runtime);
    if (first === "serve") return runServeCommand(rest, runtime);
    if (first === "digest") return runDigestCommand(rest, runtime);
    if (first === "schedule-task") return runScheduleTaskCommand(rest, runtime);
    if (first === "snapshot") {
      const result = await runSnapshotSchedulerCli(rest, runtime);
      if ("output" in result)
        runtime.stdout(JSON.stringify(result.output) + "\n");
      else runtime.stderr(result.message + "\n");
      return result.exitCode;
    }
  } else if (
    ["digest", "schedule-task", "snapshot", "web", "serve"].includes(
      first ?? "",
    )
  ) {
    runtime.stdout(help);
    return 0;
  }
  let parsed;
  try {
    parsed = parseArgs({
      args,
      options: {
        help: { type: "boolean", short: "h" },
        config: { type: "string" },
        product: { type: "string" },
        out: { type: "string" },
        live: { type: "boolean" },
        story: { type: "string" },
        confirm: { type: "boolean" },
        assignee: { type: "string" },
        "visible-tag": { type: "boolean" },
        all: { type: "boolean" },
        agent: { type: "string" },
        project: { type: "string" },
        "dry-run": { type: "boolean" },
      },
      allowPositionals: true,
      strict: true,
      tokens: true,
    });
  } catch {
    return invalidArgs(runtime);
  }

  const { values, positionals, tokens } = parsed;
  const [command, action, capability] = positionals;
  const capture = command === "probe" && action === "capture";
  const write = command === "probe" && action === "write";
  const cleanup = command === "probe" && action === "cleanup";
  const probe = capture || write || cleanup;
  const install = command === "install-agent";
  const remove = command === "delete";
  const configUi = command === "config-ui";
  if (
    positionals.length > (write ? 3 : probe || install ? 2 : 1) ||
    (!probe && command === "probe") ||
    (!capture && !write && !configUi && values.out !== undefined) ||
    (!write &&
      (values.assignee !== undefined ||
        values.all !== undefined ||
        values["visible-tag"] !== undefined)) ||
    (!cleanup && !remove && values.story !== undefined) ||
    (!remove && values.confirm !== undefined) ||
    ((remove || configUi) && values.product !== undefined) ||
    (command !== "doctor" && values.live !== undefined) ||
    (!install &&
      (values.agent !== undefined ||
        values.project !== undefined ||
        values["dry-run"] !== undefined)) ||
    (install &&
      (values.product !== undefined ||
        (action !== undefined && values.agent !== undefined)))
  ) {
    return invalidArgs(runtime);
  }
  if (write || cleanup || install || remove || configUi) {
    const names = tokens.flatMap((token) =>
      token.kind === "option" ? [token.name] : [],
    );
    if (names.length !== new Set(names).size) return invalidArgs(runtime);
  }
  if (values.help || args.length === 0) {
    runtime.stdout(help);
    return 0;
  }

  if (configUi) {
    if (values.out?.trim() === "" || values.config?.trim() === "")
      return invalidArgs(runtime);
    try {
      const { completeness, gaps } = await runConfigEditor({
        ...runtime,
        config: values.config,
        out: values.out,
        render: renderTeamConfigEditorHtml,
      });
      runtime.stdout(JSON.stringify({ ok: true, completeness, gaps }) + "\n");
      return 0;
    } catch {
      runtime.stderr("无法生成配置编辑页，请检查配置与输出路径。\n");
      return 1;
    }
  }

  if (remove) {
    const result = await runDeleteStory({
      story: values.story,
      confirm: values.confirm,
      config: values.config,
      env: runtime.env,
      homeDir: runtime.homeDir,
      clock: runtime.clock,
      logSink: runtime.stderr,
    });
    if ("invalidArgs" in result) {
      runtime.stderr(result.message + "\n");
      return 2;
    }
    runtime.stdout(JSON.stringify(result) + "\n");
    return result.status === "confirmed" ? 0 : 1;
  }

  if (install) {
    const result = await installAgent({
      agent: action ?? values.agent,
      config: values.config,
      project: values.project,
      dryRun: values["dry-run"],
      homeDir: runtime.homeDir,
      env: runtime.env,
    });
    if (!result.ok) {
      runtime.stderr(result.message + "\n");
      return result.invalidArgs ? 2 : 1;
    }
    runtime.stdout(JSON.stringify(result) + "\n");
    return 0;
  }
  if (command === "doctor") {
    const status = await getDoctorStatus(runtime.env, runtime.nodeVersion, {
      homeDir: runtime.homeDir,
      clock: runtime.clock,
      live: values.live,
      logSink: runtime.stderr,
      cli: { config: values.config, product: values.product },
    });
    runtime.stdout(
      JSON.stringify({ node: runtime.nodeVersion, ...status }) + "\n",
    );
    return status.ok ? 0 : 1;
  }
  if (capture) {
    const result = await runProbeCapture({
      env: runtime.env,
      homeDir: runtime.homeDir,
      clock: runtime.clock,
      logSink: runtime.stderr,
      cli: { config: values.config, product: values.product, out: values.out },
    });
    if (result.kind !== "captured") {
      runtime.stderr(result.message + "\n");
      return result.kind === "invalid-args" ? 2 : 1;
    }
    runtime.stdout(JSON.stringify(result.summary) + "\n");
    return 0;
  }
  if (write || cleanup) {
    const common = { config: values.config, product: values.product };
    const result = await runProbeWrite({
      env: runtime.env,
      homeDir: runtime.homeDir,
      clock: runtime.clock,
      logSink: runtime.stderr,
      cli: cleanup
        ? { ...common, action: "cleanup", story: values.story }
        : {
            ...common,
            action: "write",
            capability,
            all: values.all,
            assignee: values.assignee,
            visibleTag: values["visible-tag"],
            out: values.out,
          },
    });
    if (result.invalidArgs) {
      runtime.stderr((result.error ?? "参数不合法。") + "\n");
      return 2;
    }
    runtime.stdout(JSON.stringify(result) + "\n");
    return result.ok ? 0 : 1;
  }
  if (
    command === "mcp" &&
    values.config === undefined &&
    values.product === undefined
  ) {
    await startMcpServer({
      env: runtime.env,
      homeDir: runtime.homeDir,
      clock: runtime.clock,
      logSink: runtime.stderr,
    });
    return 0;
  }
  return invalidArgs(runtime);
}
