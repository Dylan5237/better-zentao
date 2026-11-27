import { assertCapabilityExecutable } from "../../api/capabilities.ts";
import type { ZentaoReadClient } from "../../api/client.ts";
import { listProductBugs } from "../../api/bug.ts";
import { listExecutionsIncludingClosed } from "../../api/execution.ts";
import { getCurrentUser, getInstanceConfig, listUsers } from "../../api/org.ts";
import { listProductPlans } from "../../api/plan.ts";
import { getProductModules, listProducts } from "../../api/product.ts";
import {
  getRequirementDetail,
  listProductRequirements,
} from "../../api/requirement.ts";
import {
  getStoryDetail,
  getStoryDetailV2,
  listProductStories,
} from "../../api/story.ts";
import { getTaskDetail, listExecutionTasks } from "../../api/task.ts";
import { checkZentaoVersion } from "../../core/config.ts";
import { normalizeZentaoBaseUrl } from "../../core/base-url.ts";
import { BztError } from "../../core/errors.ts";
import { instanceHashOf } from "../../core/store/location.ts";
import type { BusinessProvider } from "../ports/business-provider.ts";
import { createZentaoGateway } from "../zentao-gateway.ts";

export interface ZentaoBusinessProviderOptions {
  readonly client: ZentaoReadClient;
  readonly baseUrl: string;
  readonly instanceHash?: string | undefined;
}

/**
 * CR-009 §4.1：基于现有 src/api/* 的 BusinessProvider 适配器。
 * 原始响应仍严格经 src/core/dto 白名单投影（SEC-02 红线）。
 */
export function createZentaoBusinessProvider(
  options: ZentaoBusinessProviderOptions,
): BusinessProvider {
  const { client } = options;
  // baseUrl 可延迟到首次使用（formatObjectUrl / instanceHash）再校验：
  // 只读目录链路可能只有 client 而没有显式 baseUrl。
  const resolveUrl = () => {
    const url = normalizeZentaoBaseUrl(options.baseUrl);
    if (!url)
      throw new BztError("INVALID_INPUT", "禅道基础地址不合法。", {
        fields: ["baseUrl"],
      });
    return url;
  };

  return {
    providerId: "zentao",
    get baseUrl() {
      return resolveUrl().href;
    },
    get instanceHash() {
      return options.instanceHash ?? instanceHashOf(resolveUrl().href);
    },
    getCurrentUser: () => getCurrentUser(client),
    listUsers: () => listUsers(client),
    listProducts: () => listProducts(client),
    listProductModules: (productId) => getProductModules(client, productId),
    listProductPlans: (productId) => listProductPlans(client, productId),
    listExecutions: () => listExecutionsIncludingClosed(client),
    listExecutionTasks: (executionId) =>
      listExecutionTasks(client, executionId),
    getTaskDetail: (taskId) => getTaskDetail(client, taskId),
    listProductBugs: (productId) => listProductBugs(client, productId),
    getStoryDetail: (storyId) => getStoryDetail(client, storyId),
    listProductStories: (productId) => listProductStories(client, productId),
    getStoryDetailV2: (storyId) => getStoryDetailV2(client, storyId),
    listProductRequirements: (productId) =>
      listProductRequirements(client, productId),
    getRequirementDetail: (requirementId) =>
      getRequirementDetail(client, requirementId),
    createOperationGateway: (gatewayOptions) =>
      createZentaoGateway({
        client,
        account: gatewayOptions.account,
        instanceVersion: gatewayOptions.instanceVersion,
        storyRoles: gatewayOptions.storyRoles,
        ...(gatewayOptions.readStepId === undefined
          ? {}
          : { readStepId: gatewayOptions.readStepId }),
      }),
    async resolveInstanceVersion() {
      const instance = await getInstanceConfig(client);
      return checkZentaoVersion(instance).ok ? instance.version : "unverified";
    },
    checkCapability: (id, capabilityOptions) => {
      assertCapabilityExecutable(id, capabilityOptions);
    },
    formatObjectUrl: (type, id) =>
      new URL(`${type}-view-${id}.html`, resolveUrl()).href,
  };
}
