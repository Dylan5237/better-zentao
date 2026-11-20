import { $brand } from "zod";
import type { StoryDetail } from "../../src/core/dto/story.ts";
import { storyDetailDto } from "../../src/core/dto/story.ts";

const unprojected = {
  id: 11,
  product: 29,
  type: "story" as const,
  title: "测试需求",
  status: "draft",
  executions: [],
};

declare const fromHttp: unknown;
declare function cacheStory(story: StoryDetail): void;

// @ts-expect-error 未解析的未知响应无法进入 DTO 缓存。
cacheStory(fromHttp);
// @ts-expect-error 即使字段完全匹配，也必须经由白名单获得品牌。
cacheStory(unprojected);
const forged = {
  ...unprojected,
  password: "synthetic",
  [$brand]: { StoryDetail: true },
} as const;
// @ts-expect-error Zod 的公开品牌不能给原始对象签发 DTO 品牌。
cacheStory(forged);
cacheStory(storyDetailDto.parse(unprojected));
