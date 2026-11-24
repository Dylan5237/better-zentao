import {
  storyDetailDto,
  storyDetailDtoFor,
  storyDetailFields,
} from "../../core/dto/story.ts";
import type { StoryDetail } from "../../core/dto/story.ts";
import type { ZentaoReadClient } from "../client.ts";
import { decodeReadResponse } from "./http.ts";
import { getReadClient } from "./read-client.ts";

export function decodeStoryResponse(response: Response): Promise<StoryDetail> {
  return decodeReadResponse(response, storyDetailDto, storyDetailFields);
}

export function readStoryDetail(
  client: ZentaoReadClient,
  storyId: number,
): Promise<StoryDetail> {
  const { http, timezone } = getReadClient(client);
  return http.read(
    {
      pathTemplate: "/api.php/v1/stories/{id}",
      params: { id: storyId },
      objectId: storyId,
      schemaFields: storyDetailFields,
    },
    storyDetailDtoFor(timezone),
  );
}
