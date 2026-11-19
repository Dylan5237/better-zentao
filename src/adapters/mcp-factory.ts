import { Server } from "@modelcontextprotocol/sdk/server/index.js";
import { CallToolRequestSchema, ListToolsRequestSchema, type Tool } from "@modelcontextprotocol/sdk/types.js";
import { z } from "zod";
import { InvalidParamError } from "../core/errors.js";
import { createBetterZentao, type BetterZentaoClient } from "../index.js";
import { publicError, safeOutput } from "./output.js";
import { TOOL_DEFS } from "./tools/index.js";

export interface McpOptions {
  remote?: boolean;
  redactSecrets?: readonly string[];
}

type ClientSource = BetterZentaoClient | (() => BetterZentaoClient | Promise<BetterZentaoClient>);

export function createBetterZentaoMcpServer(
  clientOrFactory: ClientSource = () => createBetterZentao(), options: McpOptions = {},
) {
  const server = new Server({ name: "better-zentao-mcp", version: "0.1.0" }, { capabilities: { tools: {} } });
  let pending: Promise<BetterZentaoClient> | undefined;
  function getClient() {
    pending ??= Promise.resolve().then(() => typeof clientOrFactory === "function" ? clientOrFactory() : clientOrFactory)
      .catch((error: unknown) => { pending = undefined; throw error; });
    return pending;
  }

  server.setRequestHandler(ListToolsRequestSchema, () => ({
    tools: TOOL_DEFS.map(tool => ({
      name: tool.name, description: tool.description,
      inputSchema: z.toJSONSchema(tool.schema, { io: "input" }) as Tool["inputSchema"],
      annotations: { readOnlyHint: tool.readOnly, destructiveHint: tool.name === "delete_story", openWorldHint: true },
    })),
  }));

  server.setRequestHandler(CallToolRequestSchema, async request => {
    let client: BetterZentaoClient | undefined;
    try {
      const tool = TOOL_DEFS.find(tool => tool.name === request.params.name);
      if (!tool) throw new InvalidParamError("未知的 better-zentao 工具");
      const execute = tool.prepare(request.params.arguments ?? {});
      client = await getClient();
      const data = safeOutput(await execute(client), client, options.redactSecrets);
      return { structuredContent: data, content: [{ type: "text", text: JSON.stringify(data) }] };
    } catch (error) {
      const data = safeOutput({ error: publicError(error, options.remote) }, client, options.redactSecrets);
      return { isError: true, structuredContent: data, content: [{ type: "text", text: JSON.stringify(data) }] };
    }
  });
  return server;
}
