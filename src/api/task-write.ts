import { z } from "zod";
import { civilDate } from "../core/calendar.ts";
import { probeProjectViewDto } from "../core/dto/execution.ts";
import {
  storyLinkExecutionReceiptDto,
  taskActionReceiptDto,
  taskCreateReceiptDto,
  taskExecutionTeamDto,
} from "../core/dto/task-write.ts";
import { BztError } from "../core/errors.ts";
import { assertCapabilityExecutable } from "./capabilities.ts";
import type { ZentaoReadClient } from "./client.ts";
import { getReadClient } from "./internal/read-client.ts";
import { getStoryDetail } from "./story.ts";
import { getTaskDetail } from "./task.ts";

const id = z.int().positive();
const text = z.string().refine((value) => value.trim() !== "");
const taskCreateBody = z.strictObject({
  execution: id,
  module: id,
  story: id,
  name: text,
  type: z.enum([
    "design",
    "devel",
    "request",
    "test",
    "study",
    "discuss",
    "ui",
    "affair",
    "misc",
  ]),
  assignedTo: text.regex(/^[^\s,，、;；]+$/u),
  pri: z.int().min(1).max(4),
  estStarted: civilDate,
  deadline: civilDate,
  desc: text,
  estimate: z.number().nonnegative().optional(),
});

type WriteOptions = Readonly<{ opId?: string; instanceVersion?: string }>;
type TaskWriteReceipt =
  { status: "accepted"; data: { id: number } } | { status: "unknown" };

function parse<T>(schema: z.ZodType<T>, input: unknown): T {
  const result = schema.safeParse(input);
  if (!result.success)
    throw new BztError("INVALID_INPUT", "任务或执行写入字段不符合已验证配方。");
  return result.data;
}

function writeClient(
  client: ZentaoReadClient,
  action: string,
  options?: WriteOptions,
) {
  assertCapabilityExecutable(action, {
    channel: "mcp",
    instanceVersion: options?.instanceVersion,
  });
  const { http } = getReadClient(client, "write");
  const opLog = options?.opId === undefined ? {} : { opId: options.opId };
  return { http, opLog };
}

export async function linkStoryToExecution(
  client: ZentaoReadClient,
  executionId: number,
  product: number,
  storyId: number,
  options?: WriteOptions,
): Promise<TaskWriteReceipt> {
  const { http, opLog } = writeClient(client, "story.linkExecution", options);
  const execution = parse(id, executionId);
  const objectId = parse(id, storyId);
  const productId = parse(id, product);
  const story = await getStoryDetail(client, objectId);
  if (story.id !== objectId || story.product !== productId || story.deleted)
    throw new BztError("NOT_FOUND", "未找到目标产品内的需求。");
  if (story.status !== "active")
    throw new BztError(
      "RULE_VIOLATION",
      "需求需先通过 handoff_story 激活移交。",
    );
  if (!story.executions.some(({ id }) => id === execution)) {
    const receipt = await http.write(
      {
        ...opLog,
        method: "POST",
        pathTemplate: "/api.php/v2/execution/linkStory",
        objectId,
        query: { objectID: execution },
        body: { stories: [objectId] },
        allowReceiptMessage: true,
      },
      storyLinkExecutionReceiptDto,
    );
    if (receipt.status === "unknown") return { status: "unknown" };
  }
  return { status: "accepted", data: { id: objectId } };
}

export async function createTask(
  client: ZentaoReadClient,
  executionId: number,
  body: Readonly<Record<string, z.infer<z.ZodJSONSchema>>>,
  options?: WriteOptions,
): Promise<TaskWriteReceipt> {
  const { http, opLog } = writeClient(client, "task.create", options);
  const execution = parse(id, executionId);
  const fields = parse(taskCreateBody, body);
  if (fields.execution !== execution || fields.estStarted > fields.deadline)
    throw new BztError(
      "INVALID_INPUT",
      "执行编号不一致或任务的截止日期早于开始日期。",
    );
  const receipt = await http.write(
    {
      ...opLog,
      method: "POST",
      pathTemplate: "/api.php/v1/executions/{id}/tasks",
      params: { id: execution },
      objectId: execution,
      body: fields,
      allowReceiptMessage: true,
    },
    taskCreateReceiptDto,
  );
  return receipt.status === "accepted" ? receipt : { status: "unknown" };
}

export async function closeTask(
  client: ZentaoReadClient,
  taskId: number,
  options?: WriteOptions,
): Promise<TaskWriteReceipt> {
  const { http, opLog } = writeClient(client, "task.close", options);
  const objectId = parse(id, taskId);
  async function readStatus() {
    const task = await getTaskDetail(client, objectId);
    if (task.id !== objectId || task.deleted)
      throw new BztError("NOT_FOUND", "未找到待关闭的任务。");
    return task.status;
  }

  async function apply(pathTemplate: string) {
    try {
      await http.write(
        {
          ...opLog,
          method: "POST",
          pathTemplate,
          query: { taskID: objectId },
          objectId,
          body: {},
          allowReceiptMessage: true,
        },
        taskActionReceiptDto,
      );
    } catch (error) {
      // A 2xx business refusal can race with another change. Read the current
      // state before deciding whether the next transition is applicable.
      if (
        !(error instanceof BztError) ||
        error.code !== "ZENTAO_BUSINESS_ERROR" ||
        error.details?.status !== undefined
      )
        throw error;
    }
    try {
      // A missing receipt can still be resolved by reading the persisted state.
      return await readStatus();
    } catch (error) {
      if (!(error instanceof BztError)) throw error;
      return undefined;
    }
  }

  let status: Awaited<ReturnType<typeof readStatus>> | undefined =
    await readStatus();
  if (status !== "closed" && status !== "cancel" && status !== "done") {
    status = await apply("/api.php/v2/task/cancel");
    if (status !== "cancel" && status !== "closed")
      return { status: "unknown" };
  }
  if (status === "cancel" || status === "done")
    status = await apply("/api.php/v2/task/close");
  return status === "closed"
    ? { status: "accepted", data: { id: objectId } }
    : { status: "unknown" };
}

// docs/06 §6.3: the v1 project list does not expose a reliable product relation.
export async function getTaskProjectProducts(
  client: ZentaoReadClient,
  projectId: number,
): Promise<number[]> {
  const view = await getReadClient(client).http.read(
    {
      pathTemplate: "/api.php/v2/project/view",
      query: { projectID: projectId },
      objectId: projectId,
    },
    probeProjectViewDto,
  );
  const products = view.products ?? view.project.products;
  if (view.project.id !== projectId || products === undefined)
    throw new BztError(
      "ZENTAO_SCHEMA_MISMATCH",
      "无法核对目标执行所属项目的产品。",
    );
  if (
    !view.project.multiple ||
    view.project.deleted ||
    !["wait", "doing"].includes(view.project.status)
  )
    return [];
  return products;
}

export async function getTaskExecutionTeam(
  client: ZentaoReadClient,
  executionId: number,
): Promise<string[]> {
  const team = await getReadClient(client).http.read(
    {
      pathTemplate: "/api.php/v1/executions/{id}",
      params: { id: executionId },
      objectId: executionId,
    },
    taskExecutionTeamDto,
  );
  if (team.id !== executionId)
    throw new BztError(
      "ZENTAO_SCHEMA_MISMATCH",
      "禅道返回的执行团队归属与请求不一致。",
    );
  return team.accounts;
}
