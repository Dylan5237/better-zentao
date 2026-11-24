import { bugDtoFor, type Bug } from "../core/dto/bug.ts";
import type { ZentaoReadClient } from "./client.ts";
import { paginate } from "./internal/paginate.ts";
import { getReadClient } from "./internal/read-client.ts";
import { pageSchema } from "./internal/read-page.ts";

export async function listProductBugs(
  client: ZentaoReadClient,
  productId: number,
): Promise<{ items: Bug[]; truncated: boolean }> {
  const { http, timezone } = getReadClient(client);
  const result = await paginate(
    http,
    {
      pathTemplate: "/api.php/v1/products/{id}/bugs",
      params: { id: productId },
      query: { status: "unclosed" },
      schemaFields: ["bugs", "total", "pager"],
    },
    {
      mode: "v1",
      pageSize: 100,
      schema: pageSchema("bugs", bugDtoFor(timezone)),
    },
  );
  // 先按服务端的总数判断分页完成，再剔除服务端可能混返的关闭项。
  return {
    ...result,
    items: result.items.filter(({ status }) => status !== "closed"),
  };
}

export async function listProjectBugs(
  client: ZentaoReadClient,
  projectId: number,
): Promise<{ items: Bug[]; truncated: boolean }> {
  const { http, timezone } = getReadClient(client);
  return paginate(
    http,
    {
      pathTemplate: "/api.php/v1/projects/{id}/bugs",
      params: { id: projectId },
      schemaFields: ["bugs", "total", "pager"],
    },
    {
      mode: "v1",
      pageSize: 100,
      schema: pageSchema("bugs", bugDtoFor(timezone)),
    },
  );
}
