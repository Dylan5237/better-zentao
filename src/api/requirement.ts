import { requirementDetailDtoFor, storyDtoFor } from "../core/dto/story.ts";
import type { RequirementDetail, Story } from "../core/dto/story.ts";
import type { ZentaoReadClient } from "./client.ts";
import { paginate } from "./internal/paginate.ts";
import { getReadClient } from "./internal/read-client.ts";
import { pageSchema } from "./internal/read-page.ts";

export async function listProductRequirements(
  client: ZentaoReadClient,
  productId: number,
): Promise<{ items: Story[]; truncated: boolean }> {
  const { http, timezone } = getReadClient(client);
  const result = await paginate(
    http,
    {
      pathTemplate: "/api.php/v2/product/browse",
      query: { productID: productId, storyType: "requirement" },
      objectId: productId,
    },
    {
      mode: "v2",
      pageSize: 100,
      schema: pageSchema("stories", storyDtoFor(timezone)),
    },
  );

  return {
    items: result.items.filter((item) => item.type === "requirement"),
    truncated: result.truncated,
  };
}

export function getRequirementDetail(
  client: ZentaoReadClient,
  requirementId: number,
): Promise<RequirementDetail> {
  const { http, timezone } = getReadClient(client);
  return http.read(
    {
      pathTemplate: "/api.php/v2/requirement/view",
      query: { storyID: requirementId },
      objectId: requirementId,
    },
    requirementDetailDtoFor(timezone),
  );
}
