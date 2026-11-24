import { releaseDto, type Release } from "../core/dto/release.ts";
import type { ZentaoReadClient } from "./client.ts";
import { getReadClient } from "./internal/read-client.ts";
import { pageSchema } from "./internal/read-page.ts";

const releases = pageSchema("releases", releaseDto);

export async function listReleases(
  client: ZentaoReadClient,
  productId: number,
): Promise<{ items: Release[]; truncated: boolean }> {
  const { items, total } = await getReadClient(client).http.read(
    {
      pathTemplate: "/api.php/v1/products/{id}/releases",
      params: { id: productId },
      schemaFields: ["releases", "total", "pager"],
    },
    releases,
  );
  return { items, truncated: total !== undefined && items.length < total };
}
