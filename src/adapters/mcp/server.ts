import { Server } from "@modelcontextprotocol/sdk/server/index.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import {
  CallToolRequestSchema,
  ListToolsRequestSchema,
  ToolSchema,
} from "@modelcontextprotocol/sdk/types.js";
import type { CallToolResult } from "@modelcontextprotocol/sdk/types.js";
import { randomUUID } from "node:crypto";
import { mkdir, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import { z } from "zod";
import { allTools } from "../../contracts/tools/index.ts";
import { createWorkbench, projectToolError } from "../../services/workbench.ts";
import type { Workbench, WorkbenchRuntime } from "../../services/workbench.ts";
import { renderScheduleHtml } from "../cli/render/schedule-html.ts";

function jsonResult(payload: unknown, isError = false): CallToolResult {
  return {
    ...(isError ? { isError: true } : {}),
    content: [{ type: "text", text: JSON.stringify(payload) }],
  };
}

function register<Input extends z.ZodType>(
  contract: { input: Input; output: z.ZodType; description: string },
  run: (services: Workbench, input: z.output<Input>, raw: unknown) => unknown,
) {
  const inputSchema = ToolSchema.shape.inputSchema.parse({
    ...z.toJSONSchema(contract.input, {
      io: "input",
      target: "draft-07",
      unrepresentable: "any",
    }),
    // MCP requires an object at the root, including for unions of strict objects.
    type: "object",
  });
  return {
    description: contract.description,
    inputSchema,
    async call(workbench: ReturnType<typeof createWorkbench>, raw: unknown) {
      const input = contract.input.safeParse(raw);
      if (!input.success)
        return jsonResult(
          {
            ok: false,
            code: "INVALID_INPUT",
            message: "工具参数不合法，请检查输入字段。",
            retryable: false,
          },
          true,
        );
      return jsonResult(
        contract.output.parse(
          await run(await workbench.get(), input.data, raw),
        ),
      );
    },
  };
}

const tools = {
  resolve_context: register(
    allTools.resolve_context,
    ({ directory }, _input, raw) => directory.resolveContext(raw),
  ),
  get_my_work: register(allTools.get_my_work, ({ tracking }, _input, raw) =>
    tracking.getMyWork(raw),
  ),
  get_team_work: register(allTools.get_team_work, ({ tracking }, _input, raw) =>
    tracking.getTeamWork(raw),
  ),
  get_member_schedule: register(
    allTools.get_member_schedule,
    async ({ schedule, reportDir }, input, raw) => {
      const result = allTools.get_member_schedule.output.parse(
        await schedule.getMemberSchedule(raw),
      );
      if (input.format !== "html") return result;
      try {
        await mkdir(reportDir, { recursive: true, mode: 0o700 });
        const stamp = result.scope.asOf.replaceAll(/[^\d]/gu, "");
        const file = join(reportDir, `schedule-${stamp}-${randomUUID()}.html`);
        await writeFile(file, renderScheduleHtml(result), {
          encoding: "utf8",
          mode: 0o600,
          flag: "wx",
        });
        return {
          ...result,
          links: [
            ...(result.links ?? []),
            { label: "本地成员排期报告", url: pathToFileURL(file).href },
          ],
          hints: [...(result.hints ?? []), "可打开本地成员排期报告查看 HTML。"],
        };
      } catch {
        return {
          ...result,
          hints: [
            ...(result.hints ?? []),
            "本地排期 HTML 报告写入失败，已返回表格数据。",
          ],
        };
      }
    },
  ),
  query_stories: register(allTools.query_stories, ({ tracking }, _input, raw) =>
    tracking.queryStories(raw),
  ),
  get_story_progress: register(
    allTools.get_story_progress,
    ({ tracking }, _input, raw) => tracking.getStoryProgress(raw),
  ),
  create_story: register(allTools.create_story, (services, _input, raw) =>
    services.createStory(raw),
  ),
  import_stories: register(allTools.import_stories, (services, _input, raw) =>
    services.importStories(raw),
  ),
  assign_story: register(allTools.assign_story, (services, _input, raw) =>
    services.assignStory(raw),
  ),
  scan_workflow_risks: register(
    allTools.scan_workflow_risks,
    ({ risk }, _input, raw) => risk.scanWorkflowRisks(raw),
  ),
  confirm_operation: register(allTools.confirm_operation, (services, input) =>
    services.confirmOperation(input),
  ),
  get_operation: register(allTools.get_operation, (services, input) =>
    services.getOperation(input),
  ),
  get_plan_progress: register(
    allTools.get_plan_progress,
    ({ management }, _input, raw) => management.getPlanProgress(raw),
  ),
  get_monthly_dev_queue: register(
    allTools.get_monthly_dev_queue,
    ({ management }, _input, raw) => management.getMonthlyDevQueue(raw),
  ),
  decompose_stories: register(
    allTools.decompose_stories,
    (services, _input, raw) => services.decomposeStories(raw),
  ),
  handoff_story: register(allTools.handoff_story, (services, _input, raw) =>
    services.handoffStory(raw),
  ),
  reschedule_story: register(
    allTools.reschedule_story,
    (services, _input, raw) => services.rescheduleStory(raw),
  ),
  close_stories: register(allTools.close_stories, (services, _input, raw) =>
    services.closeStories(raw),
  ),
  set_story_meta: register(allTools.set_story_meta, (services, _input, raw) =>
    services.setStoryMeta(raw),
  ),
} satisfies Record<keyof typeof allTools, unknown>;

function isDeleteToolRequest(name: string): boolean {
  return /(?:^|[._-])delete(?:$|[._-])|delete_story/iu.test(name);
}

function isToolName(name: string): name is keyof typeof tools {
  return Object.hasOwn(tools, name);
}

export function createMcpServer(runtime?: WorkbenchRuntime): Server {
  const workbench = createWorkbench(runtime);
  const server = new Server(
    { name: "better-zentao", version: "0.0.0" },
    { capabilities: { tools: {} } },
  );
  server.onclose = () => workbench.close();
  server.setRequestHandler(ListToolsRequestSchema, () => ({
    tools: Object.entries(tools).map(
      ([name, { description, inputSchema }]) => ({
        name,
        description,
        inputSchema,
      }),
    ),
  }));
  server.setRequestHandler(CallToolRequestSchema, async ({ params }) => {
    try {
      if (!isToolName(params.name))
        return jsonResult(
          isDeleteToolRequest(params.name)
            ? {
                ok: false,
                code: "CAPABILITY_CLI_ONLY",
                message:
                  "删除操作属于 W3 高危能力，不开放给 MCP，请改用 CLI（bzt delete）。",
                retryable: false,
              }
            : {
                ok: false,
                code: "INVALID_INPUT",
                message: "当前没有此 MCP 工具。",
                retryable: false,
              },
          true,
        );
      return await tools[params.name].call(workbench, params.arguments ?? {});
    } catch (error) {
      return jsonResult(projectToolError(error, runtime?.env), true);
    }
  });
  return server;
}

export async function startMcpServer(
  runtime?: WorkbenchRuntime,
): Promise<void> {
  await createMcpServer(runtime).connect(new StdioServerTransport());
}
