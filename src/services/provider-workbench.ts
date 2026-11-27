import type { Clock } from "../core/clock.ts";
import type { TeamConfig } from "../core/config.ts";
import { BztError } from "../core/errors.ts";
import type { ConfirmOperation, GetOperation } from "../contracts/operation.ts";
import { DirectoryService } from "./directory.ts";
import { FlowService } from "./flow.ts";
import { OperationExecutor } from "./operation.ts";
import type { BusinessProvider } from "./ports/business-provider.ts";
import type { OperationStateStore } from "./ports/operation-store.ts";
import { TrackingService } from "./tracking.ts";
import type { TargetWriteCoordinator } from "./write-coordinator.ts";

/**
 * CR-009 §4.1：纯 BusinessProvider + OperationStateStore 组装的工作台。
 * 零 `src/api/*` 依赖：MemoryBusinessProvider 垂直切片（PC-01/PC-02）经此入口
 * 运行与禅道工作台完全一致的上层业务服务。
 */
export interface ProviderWorkbenchOptions {
  readonly provider: BusinessProvider;
  readonly config: TeamConfig;
  readonly clock: Clock;
  readonly store: OperationStateStore;
  readonly writeCoordinator?: TargetWriteCoordinator;
  readonly assertBeforeDispatch?: () => void | Promise<void>;
}

export function createProviderWorkbench(options: ProviderWorkbenchOptions) {
  const { provider, config, clock, store } = options;
  if (provider.instanceHash !== store.location.instanceHash)
    throw new BztError("INVALID_INPUT", "业务底座与本地状态库实例不一致。");
  if (provider.baseUrl && provider.formatObjectUrl("story", 0) === "")
    throw new BztError("CONFIG_MISSING", "业务底座未提供对象链接格式。");

  const directory = new DirectoryService({
    // Provider 工作台不落目录查询缓存：内存底座自身即是数据源。
    provider,
    config,
    clock,
  });
  // 保留 store.cache 接收者，防止 SQLite LocalStore 类方法解构后丢失 this 绑定。
  const hasFullCache =
    store.cache.get !== undefined &&
    store.cache.set !== undefined &&
    store.cache.setPermanent !== undefined;
  const cacheAdapter = hasFullCache
    ? {
        get: (key: string) => store.cache.get?.(key),
        set: (key: string, value: string, ttlMs: number) => {
          store.cache.set?.(key, value, ttlMs);
        },
        setPermanent: (key: string, value: string) => {
          store.cache.setPermanent?.(key, value);
        },
        delete: (key: string) => store.cache.delete(key),
      }
    : undefined;
  const common = {
    provider,
    config,
    clock,
    store: {
      ...store,
      cache: cacheAdapter,
    },
    baseUrl: provider.baseUrl,
  };
  const tracking = new TrackingService(common);

  const createExecutor = (instanceVersion?: string) =>
    new OperationExecutor({
      store,
      baseUrl: provider.baseUrl,
      config,
      gateway: provider.createOperationGateway({
        account: store.location.account,
        instanceVersion,
        storyRoles: store.storyRoles,
      }),
      clock,
      channel: "mcp",
      instanceVersion,
      checkCapability: (id, capabilityOptions) =>
        provider.checkCapability(id, capabilityOptions),
      formatObjectUrl: (type, id) => provider.formatObjectUrl(type, id),
      writeCoordinator: options.writeCoordinator,
      assertBeforeDispatch: options.assertBeforeDispatch,
    });

  function flowStoreView() {
    const links = store.sourceLinks;
    // FlowStore 要求 find/upsert 必在；端口将其声明为可选，
    // 内存实现恒提供，SQLite LocalStore 同样满足。
    const find: NonNullable<typeof links.find> = (key) =>
      links.find?.(key) ?? undefined;
    const upsert: NonNullable<typeof links.upsert> = (input) => {
      links.upsert?.(input);
    };
    return { ...store, sourceLinks: { ...links, find, upsert } };
  }

  const readExecutor = createExecutor();

  /** 每次生成或确认写入计划前均实时核验底座实例版本，严禁绕过版本门禁（PC-02）。 */
  async function forWrite() {
    const instanceVersion = await provider.resolveInstanceVersion();
    const executor = createExecutor(instanceVersion);
    const flow = new FlowService({
      provider,
      executor,
      config,
      store: flowStoreView(),
      directory,
      clock,
      baseUrl: provider.baseUrl,
    });
    return { executor, flow };
  }

  return {
    directory,
    tracking,
    async assignStory(input: unknown) {
      return (await forWrite()).flow.assignStory(input);
    },
    async confirmOperation(input: ConfirmOperation) {
      return (await forWrite()).executor.confirm(input);
    },
    getOperation(input: GetOperation) {
      return readExecutor.getOperation(input);
    },
  };
}

export type ProviderWorkbench = ReturnType<typeof createProviderWorkbench>;
