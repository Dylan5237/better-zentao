import { z } from "zod";
import {
  taskDetailDtoFor,
  taskDtoFor,
  type Task,
  type TaskDetail,
} from "../core/dto/task.ts";
import { BztError } from "../core/errors.ts";
import type { ZentaoReadClient } from "./client.ts";
import { paginate } from "./internal/paginate.ts";
import { getReadClient } from "./internal/read-client.ts";
import { pageSchema } from "./internal/read-page.ts";

const executionTaskFilter = z.enum([
  "all",
  "undone",
  "delayed",
  "wait",
  "doing",
]);

export type ExecutionTaskFilter = z.infer<typeof executionTaskFilter>;

export async function listExecutionTasks(
  client: ZentaoReadClient,
  executionId: number,
  status: ExecutionTaskFilter = "all",
): Promise<{ items: Task[]; truncated: boolean }> {
  if (!executionTaskFilter.safeParse(status).success) {
    throw new BztError("INVALID_INPUT", "执行任务查询状态不合法。");
  }
  const { http, timezone } = getReadClient(client);
  return paginate(
    http,
    {
      pathTemplate: "/api.php/v1/executions/{id}/tasks",
      params: { id: executionId },
      query: { status },
      schemaFields: ["tasks", "total", "pager"],
    },
    {
      mode: "v1",
      pageSize: 100,
      schema: pageSchema("tasks", taskDtoFor(timezone)),
    },
  );
}

export async function getTaskDetail(
  client: ZentaoReadClient,
  taskId: number,
): Promise<TaskDetail> {
  const { http, timezone } = getReadClient(client);
  const schema = taskDetailDtoFor(timezone);
  return http.read(
    {
      pathTemplate: "/api.php/v1/tasks/{id}",
      params: { id: taskId },
      schemaFields: Object.keys(schema.in.shape),
    },
    schema,
  );
}
