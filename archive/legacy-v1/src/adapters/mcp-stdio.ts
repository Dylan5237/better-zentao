#!/usr/bin/env node
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { createBetterZentaoMcpServer } from "./mcp-factory.js";

try {
  await createBetterZentaoMcpServer().connect(new StdioServerTransport());
  process.stderr.write("better-zentao-mcp 已启动\n");
} catch {
  process.stderr.write("better-zentao-mcp 启动失败\n");
  process.exitCode = 1;
}
