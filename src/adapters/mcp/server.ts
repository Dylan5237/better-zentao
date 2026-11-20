import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";

export async function startMcpServer(): Promise<void> {
  const server = new McpServer({ name: "better-zentao", version: "0.0.0" });
  await server.connect(new StdioServerTransport());
}
