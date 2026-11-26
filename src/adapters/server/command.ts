import { parseArgs } from "node:util";
import { loadServerConfig } from "../../services/server-runtime.ts";
import type { WorkbenchRuntime } from "../../services/workbench.ts";
import { startServer } from "./http.ts";

export async function runServeCommand(
  args: string[],
  runtime: WorkbenchRuntime & {
    stdout: (text: string) => void;
    stderr: (text: string) => void;
  },
): Promise<number> {
  let parsed;
  try {
    parsed = parseArgs({
      args,
      options: { "server-config": { type: "string" } },
      strict: true,
      allowPositionals: false,
      tokens: true,
    });
  } catch {
    runtime.stderr("用法：bzt serve --server-config 路径\n");
    return 2;
  }
  const optionTokens = parsed.tokens.filter((token) => token.kind === "option");
  if (
    new Set(optionTokens.map((token) => token.name)).size !==
    optionTokens.length
  ) {
    runtime.stderr("参数重复，请仅传入一次 --server-config。\n");
    return 2;
  }
  const flagPath = parsed.values["server-config"];
  if (flagPath !== undefined && flagPath.trim() === "") {
    runtime.stderr("集中服务配置路径不能为空。\n");
    return 2;
  }
  const configPath = flagPath?.trim() || runtime.env.BZT_SERVER_CONFIG?.trim();
  if (!configPath) {
    runtime.stderr(
      "缺少集中服务配置路径，请传入 --server-config 路径或设置 BZT_SERVER_CONFIG。\n",
    );
    return 2;
  }
  let config;
  try {
    config = await loadServerConfig(configPath, runtime.env);
  } catch {
    runtime.stderr(
      "无法加载集中服务配置，请检查文件路径、JSON 格式与安全规则。\n",
    );
    return 1;
  }
  let server;
  try {
    server = await startServer({
      config,
      clock: runtime.clock,
      env: runtime.env,
      logSink: runtime.stderr,
    });
  } catch {
    runtime.stderr("无法启动集中服务，请检查端口占用与数据目录锁。\n");
    return 1;
  }
  if (config.allowInsecureHttp) {
    runtime.stderr(
      "警告：当前处于显式 HTTP 调试模式，请勿在不可信网络中使用真实凭据。\n",
    );
  }
  runtime.stdout(
    `better-zentao 集中服务已启动：${server.url}（外部源 ${server.externalOrigin}，只读=${String(config.readOnly)}）\n`,
  );
  return 0;
}
