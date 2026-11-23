import { parseArgs } from "node:util";
import { getDoctorStatus } from "../../services/doctor.ts";
import { runProbeCapture } from "../../services/probe-capture.ts";
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
  bzt doctor [--config 路径] [--product ID]    本地环境自检
  bzt probe capture [--out 目录] [--config 路径] [--product ID]    只读采集脱敏夹具
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
      },
      allowPositionals: true,
      strict: true,
    });
  } catch {
    return invalidArgs(runtime);
  }

  const { values, positionals } = parsed;
  const [command, action] = positionals;
  const capture = command === "probe" && action === "capture";
  if (
    positionals.length > (capture ? 2 : 1) ||
    (!capture && (command === "probe" || values.out !== undefined))
  ) {
    return invalidArgs(runtime);
  }
  if (values.help || args.length === 0) {
    runtime.stdout(help);
    return 0;
  }

  if (command === "doctor") {
    const status = await getDoctorStatus(runtime.env, runtime.nodeVersion, {
      homeDir: runtime.homeDir,
      clock: runtime.clock,
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
  if (
    command === "mcp" &&
    values.config === undefined &&
    values.product === undefined
  ) {
    await startMcpServer();
    return 0;
  }
  return invalidArgs(runtime);
}
