import {
  executionDto,
  projectDto,
  type Execution,
  type Project,
} from "../core/dto/execution.ts";
import type { ZentaoReadClient } from "./client.ts";
import { paginate } from "./internal/paginate.ts";
import { getReadClient } from "./internal/read-client.ts";
import { pageSchema } from "./internal/read-page.ts";

const projects = pageSchema("projects", projectDto);
const executions = pageSchema("executions", executionDto);

export async function listProjects(
  client: ZentaoReadClient,
): Promise<{ items: Project[]; truncated: boolean }> {
  return paginate(
    getReadClient(client).http,
    {
      pathTemplate: "/api.php/v1/projects",
      schemaFields: ["projects", "total", "pager"],
    },
    { mode: "v1", pageSize: 100, schema: projects },
  );
}

export async function listExecutions(
  client: ZentaoReadClient,
): Promise<{ items: Execution[]; truncated: boolean }> {
  return paginate(
    getReadClient(client).http,
    {
      pathTemplate: "/api.php/v2/executions",
      schemaFields: ["executions", "total", "pager"],
    },
    { mode: "v2", pageSize: 200, schema: executions },
  );
}

export async function listExecutionsIncludingClosed(
  client: ZentaoReadClient,
): Promise<{ items: Execution[]; truncated: boolean }> {
  return paginate(
    getReadClient(client).http,
    {
      pathTemplate: "/api.php/v1/executions",
      schemaFields: ["executions", "total", "pager"],
    },
    { mode: "v1", pageSize: 200, schema: executions },
  );
}
