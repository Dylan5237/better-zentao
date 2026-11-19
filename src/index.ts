import { ExecutionApi } from "./api/execution.api.js";
import { MyApi } from "./api/my.api.js";
import { OrgApi } from "./api/org.api.js";
import { ProductApi } from "./api/product.api.js";
import { StoryApi } from "./api/story.api.js";
import { resolveConfig, type ConfigOptions } from "./core/config.js";
import { ZentaoHttp } from "./core/http.js";
import { DirectoryService } from "./services/directory.service.js";
import { IntakeService } from "./services/intake.service.js";
import { TrackingService } from "./services/tracking.service.js";

export interface BetterZentaoOptions extends ConfigOptions {
  fetchImpl?: typeof fetch;
  now?: () => Date;
}

export function createBetterZentao(options: BetterZentaoOptions = {}) {
  const config = resolveConfig(options);
  const http = new ZentaoHttp(config, options.fetchImpl);
  const org = new OrgApi(http);
  const products = new ProductApi(http, config.baseUrl);
  const stories = new StoryApi(http, config.baseUrl);
  const executions = new ExecutionApi(http, config.baseUrl);
  const my = new MyApi(http, config.baseUrl);
  const directory = new DirectoryService(org, products, executions, config, options.now);
  return {
    api: { org, products, stories, executions, my },
    directory,
    tracking: new TrackingService(directory, my, executions, stories, config, options.now),
    intake: new IntakeService(directory, products, stories, config, options.now),
    redactText: (value: string) => http.redactText(value),
  };
}

export type BetterZentaoClient = ReturnType<typeof createBetterZentao>;
export * from "./api/types.js";
export * from "./core/config.js";
export * from "./core/errors.js";
export { DirectoryService, IntakeService, TrackingService };
