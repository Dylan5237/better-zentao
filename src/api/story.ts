import type { StoryDetail } from "../core/dto/story.ts";
import {
  decodeStoryResponse,
  readStoryResponse,
} from "./internal/story-response.ts";

export async function getStoryDetail(storyId: number): Promise<StoryDetail> {
  return decodeStoryResponse(await readStoryResponse(storyId));
}
