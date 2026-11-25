import { z } from "zod";
import { createZentaoReadClient } from "../api/client.ts";
import { getStoryDetail } from "../api/story.ts";
import { deleteStory } from "../api/story-write.ts";
import type { Clock } from "../core/clock.ts";
import { loadConfig } from "../core/config.ts";
import type { ConfigEnv } from "../core/config.ts";
import { BztError } from "../core/errors.ts";

interface DeleteOptions {
  readonly story?: string;
  readonly confirm?: boolean;
  readonly config?: string;
  readonly env: ConfigEnv;
  readonly homeDir?: string;
  readonly clock: Clock;
  readonly logSink?: (line: string) => void;
}

const storyIdInput = z
  .string()
  .regex(/^[1-9]\d*$/u)
  .transform(Number)
  .pipe(z.int().positive());

// docs/05 §5.2 W3 requires an explicit CLI confirmation.
export async function runDeleteStory(options: DeleteOptions) {
  const { env, homeDir, clock, logSink, confirm } = options;
  const parsed = storyIdInput.safeParse(options.story);
  if (
    !parsed.success ||
    (options.config !== undefined && !options.config.trim())
  ) {
    return {
      status: "not_executed",
      invalidArgs: true,
      code: "INVALID_INPUT",
      message: "--story 必须是正整数，--config 路径不能为空。",
    } as const;
  }
  const storyId = parsed.data;
  let deleting = false;
  try {
    const config = await loadConfig({
      env,
      homeDir,
      cli: { config: options.config },
    });
    if (config.write.disableCapabilities.includes("story.delete"))
      throw new BztError("CAPABILITY_DISABLED", "团队配置已禁用删除需求。");
    const client = createZentaoReadClient({
      ...config.zentao,
      password: env.ZENTAO_PASSWORD ?? "",
      timezone: config.timezone,
      clock,
      env: {
        ZENTAO_TIMEOUT_MS: String(config.zentao.timeoutMs),
        BZT_LOG_LEVEL: config.logLevel,
      },
      logSink,
    });
    const target = await getStoryDetail(client, storyId);
    if (
      target.id !== storyId ||
      target.type !== "story" ||
      target.deleted === true
    )
      throw new BztError("NOT_FOUND", "指定的研发需求不存在或不可见。");
    if (confirm !== true)
      return {
        status: "not_executed",
        preview: { storyId, productId: target.product },
        message: "核对目标需求后，请添加 --confirm 执行删除。",
      } as const;

    deleting = true;
    if ((await deleteStory(client, storyId)) === "confirmed")
      return { status: "confirmed", storyId } as const;
    return {
      status: "unknown",
      storyId,
      message: "未能确认需求已删除。请先到禅道核对结果。",
    } as const;
  } catch (error) {
    return {
      status: deleting ? "failed" : "not_executed",
      storyId,
      code: error instanceof BztError ? error.code : "ZENTAO_UNAVAILABLE",
      message:
        error instanceof BztError ? error.message : "无法完成需求删除操作。",
    } as const;
  }
}
