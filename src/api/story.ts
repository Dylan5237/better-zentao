import { z } from "zod";
import { storyCreateMetadataDto } from "../core/dto/metadata.ts";
import type { StoryCreateMetadata } from "../core/dto/metadata.ts";
import { storyDetailV2DtoFor, storyDtoFor } from "../core/dto/story.ts";
import type { Story, StoryDetail, StoryDetailV2 } from "../core/dto/story.ts";
import { BztError } from "../core/errors.ts";
import type { ZentaoReadClient } from "./client.ts";
import { paginate } from "./internal/paginate.ts";
import { getReadClient } from "./internal/read-client.ts";
import { pageSchema } from "./internal/read-page.ts";
import { readStoryDetail } from "./internal/story-response.ts";

const storyStatusFilter = z.enum([
  "all",
  "unclosed",
  "draft",
  "reviewing",
  "active",
  "changing",
  "closed",
]);

export type StoryStatusFilter = z.infer<typeof storyStatusFilter>;

export async function listProductStories(
  client: ZentaoReadClient,
  productId: number,
  status: StoryStatusFilter = "all",
): Promise<{ items: Story[]; truncated: boolean }> {
  if (!storyStatusFilter.safeParse(status).success) {
    throw new BztError("INVALID_INPUT", "研发需求查询状态不合法。");
  }
  const { http, timezone } = getReadClient(client);
  const result = await paginate(
    http,
    {
      pathTemplate: "/api.php/v1/products/{id}/stories",
      params: { id: productId },
      query: { status: status === "unclosed" ? "unclosed" : "all" },
      objectId: productId,
      schemaFields: ["stories", "total", "pager"],
    },
    {
      mode: "v1",
      pageSize: 100,
      schema: pageSchema("stories", storyDtoFor(timezone)),
    },
  );

  // docs/06 Q3：先完整计算分页边界，具体状态和类型按客户端口径筛选。
  return {
    items: result.items.filter(
      (item) =>
        item.type === "story" &&
        (status === "all" ||
          (status === "unclosed"
            ? item.status !== "closed"
            : item.status === status)),
    ),
    truncated: result.truncated,
  };
}

export function getStoryDetail(
  client: ZentaoReadClient,
  storyId: number,
): Promise<StoryDetail> {
  return readStoryDetail(client, storyId);
}

export function getStoryDetailV2(
  client: ZentaoReadClient,
  storyId: number,
): Promise<StoryDetailV2> {
  const { http, timezone } = getReadClient(client);
  return http.read(
    {
      pathTemplate: "/api.php/v2/story/view",
      query: { storyID: storyId },
      objectId: storyId,
      schemaFields: ["story", "actions", "bugs", "relations"],
    },
    storyDetailV2DtoFor(timezone),
  );
}

export function getStoryCreateMetadata(
  client: ZentaoReadClient,
  productId: number,
): Promise<StoryCreateMetadata> {
  const { http } = getReadClient(client);
  return http.read(
    {
      pathTemplate: "/api.php/v2/story/create",
      query: { productID: productId },
      objectId: productId,
      schemaFields: Object.keys(storyCreateMetadataDto.in.shape),
    },
    storyCreateMetadataDto,
  );
}
