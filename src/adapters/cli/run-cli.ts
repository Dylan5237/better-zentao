import { parseArgs } from "node:util";
import { runDeleteStory } from "../../services/delete-story.ts";
import { getDoctorStatus } from "../../services/doctor.ts";
import { installAgent } from "../../services/install-agent.ts";
import { runProbeCapture } from "../../services/probe-capture.ts";
import { runProbeWrite } from "../../services/probe-write.ts";
import { startMcpServer } from "../mcp/server.ts";

interface CliRuntime {
  readonly stdout: (text: string) => void;
  readonly stderr: (text: string) => void;
  readonly env: Readonly<Record<string, string | undefined>>;
  readonly homeDir?: string;
  readonly clock: () => number;
  readonly nodeVersion: string;
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
  if (
    positionals.length > (write ? 3 : probe || install ? 2 : 1) ||
    (!probe && command === "probe") ||
    (!capture && !write && values.out !== undefined) ||
    (!write &&
      (values.assignee !== undefined ||
        values.all !== undefined ||
        values["visible-tag"] !== undefined)) ||
    (!cleanup && !remove && values.story !== undefined) ||
    (!remove && values.confirm !== undefined) ||
    (remove && values.product !== undefined) ||
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
  if (write || cleanup || install || remove) {
    const names = tokens.flatMap((token) =>
      token.kind === "option" ? [token.name] : [],
    );
    if (names.length !== new Set(names).size) return invalidArgs(runtime);
  }
  if (values.help || args.length === 0) {
    runtime.stdout(help);
    return 0;
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
