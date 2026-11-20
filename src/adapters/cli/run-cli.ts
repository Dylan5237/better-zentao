import { parseArgs } from "node:util";
import { getDoctorStatus } from "../../services/doctor.ts";
import { startMcpServer } from "../mcp/server.ts";

interface CliRuntime {
  readonly stdout: (text: string) => void;
  readonly stderr: (text: string) => void;
  readonly env: Readonly<Record<string, string | undefined>>;
  readonly nodeVersion: string;
}

const help =
  "用法\n  bzt --help\n  bzt doctor    本地环境自检\n  bzt mcp       启动 stdio 服务\n";

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
      options: { help: { type: "boolean", short: "h" } },
      allowPositionals: true,
      strict: true,
    });
  } catch {
    return invalidArgs(runtime);
  }

  const { values, positionals } = parsed;
  const [command] = positionals;
  if (positionals.length > 1) return invalidArgs(runtime);
  if (values.help || command === undefined) {
    runtime.stdout(help);
    return 0;
  }

  if (command === "doctor") {
    const status = await getDoctorStatus(runtime.env, runtime.nodeVersion);
    runtime.stdout(
      JSON.stringify({ node: runtime.nodeVersion, ...status }) + "\n",
    );
    return status.ok ? 0 : 1;
  }
  if (command === "mcp") {
    await startMcpServer();
    return 0;
  }
  return invalidArgs(runtime);
}
