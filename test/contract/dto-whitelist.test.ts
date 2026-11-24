import { readdirSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { z } from "zod";
import { listProductBugs, listProjectBugs } from "../../src/api/bug.ts";
import type { ZentaoReadClient } from "../../src/api/client.ts";
import {
  listExecutions,
  listExecutionsIncludingClosed,
  listProjects,
} from "../../src/api/execution.ts";
import { listMyContributions, listMyWork } from "../../src/api/my.ts";
import {
  getCurrentUser,
  getDepartments,
  getInstanceConfig,
  getRequiredFields,
  listUsers,
  listUsersByDepartment,
} from "../../src/api/org.ts";
import { getPlanDetail, listProductPlans } from "../../src/api/plan.ts";
import { getProductModules, listProducts } from "../../src/api/product.ts";
import { listReleases } from "../../src/api/release.ts";
import {
  getRequirementDetail,
  listProductRequirements,
} from "../../src/api/requirement.ts";
import {
  getStoryCreateMetadata,
  getStoryDetail,
  getStoryDetailV2,
  listProductStories,
} from "../../src/api/story.ts";
import { getTaskDetail, listExecutionTasks } from "../../src/api/task.ts";
import { assertNoSensitiveData } from "../helpers/assert-no-sensitive-data.ts";
import { mockReadFixture, readFixture } from "./read-fixture.ts";

interface Endpoint {
  readonly path: string;
  readonly query?: Readonly<Record<string, string | number>>;
  readonly call: (client: ZentaoReadClient) => Promise<object>;
}

const endpoints: Readonly<Record<string, Endpoint>> = {
  "instance-config": {
    path: "/index.php",
    query: { mode: "getconfig" },
    call: getInstanceConfig,
  },
  "current-user": { path: "/api.php/v1/user", call: getCurrentUser },
  "required-fields": {
    path: "/api.php/v1/requiredFields",
    call: getRequiredFields,
  },
  departments: { path: "/api.php/v1/departments", call: getDepartments },
  users: { path: "/api.php/v2/users", query: { pageID: 1 }, call: listUsers },
  "users-by-department": {
    path: "/api.php/v2/company/browse",
    query: { param: 11111311, type: "bydept" },
    call: (client) => listUsersByDepartment(client, 11111311),
  },
  "my-work": {
    path: "/api.php/v2/my/work",
    query: { mode: "task", browseType: "assignedTo" },
    call: (client) =>
      listMyWork(client, { mode: "task", browseType: "assignedTo" }),
  },
  "my-contribute": {
    path: "/api.php/v2/my/contribute",
    query: { mode: "story", browseType: "openedBy" },
    call: (client) =>
      listMyContributions(client, { mode: "story", browseType: "openedBy" }),
  },
  products: {
    path: "/api.php/v1/products",
    query: { page: 1 },
    call: listProducts,
  },
  "product-modules": {
    path: "/api.php/v1/products/42",
    query: { fields: "moduleOptionMenu" },
    call: (client) => getProductModules(client, 42),
  },
  "product-plans": {
    path: "/api.php/v1/products/42/plans",
    call: (client) => listProductPlans(client, 42),
  },
  "plan-detail": {
    path: "/api.php/v2/productplan/view",
    query: { planID: 707 },
    call: (client) => getPlanDetail(client, 707),
  },
  "product-stories": {
    path: "/api.php/v1/products/42/stories",
    query: { status: "all" },
    call: (client) => listProductStories(client, 42),
  },
  "product-requirements": {
    path: "/api.php/v2/product/browse",
    query: { productID: 42, storyType: "requirement" },
    call: (client) => listProductRequirements(client, 42),
  },
  "story-detail": {
    path: "/api.php/v1/stories/4837",
    call: (client) => getStoryDetail(client, 4837),
  },
  "story-detail-v2": {
    path: "/api.php/v2/story/view",
    query: { storyID: 4837 },
    call: (client) => getStoryDetailV2(client, 4837),
  },
  "requirement-detail": {
    path: "/api.php/v2/requirement/view",
    query: { storyID: 4845 },
    call: (client) => getRequirementDetail(client, 4845),
  },
  projects: { path: "/api.php/v1/projects", call: listProjects },
  "executions-v2": { path: "/api.php/v2/executions", call: listExecutions },
  "executions-v1": {
    path: "/api.php/v1/executions",
    call: listExecutionsIncludingClosed,
  },
  "execution-tasks": {
    path: "/api.php/v1/executions/189/tasks",
    query: { status: "all" },
    call: (client) => listExecutionTasks(client, 189),
  },
  "task-detail": {
    path: "/api.php/v1/tasks/4324",
    call: (client) => getTaskDetail(client, 4324),
  },
  "product-bugs": {
    path: "/api.php/v1/products/42/bugs",
    query: { status: "unclosed" },
    call: (client) => listProductBugs(client, 42),
  },
  "project-bugs": {
    path: "/api.php/v1/projects/20/bugs",
    call: (client) => listProjectBugs(client, 20),
  },
  releases: {
    path: "/api.php/v1/products/42/releases",
    call: (client) => listReleases(client, 42),
  },
  "story-create-metadata": {
    path: "/api.php/v2/story/create",
    query: { productID: 42 },
    call: (client) => getStoryCreateMetadata(client, 42),
  },
};

const record = z.record(z.string(), z.unknown());
const secrets = {
  password: "0123456789abcdef0123456789abcdef",
  email: "private@example.test",
  mobile: "13900000000",
  token: "synthetic-private-response-token",
};

function injectSecrets(value: unknown): unknown {
  if (Array.isArray(value))
    return value.map((row: unknown) => injectSecrets(row));
  const body = record.parse(value);
  // 指定用户端点的 users 是合法实体集合，其他端点的 users 是应丢弃的全员字典。
  return { users: { privateAccount: "privateDirectory" }, ...body, ...secrets };
}

function objects(items: readonly unknown[]): object[] {
  return items.map((item) => {
    if (item === null || typeof item !== "object")
      throw new Error("Expected a projected object");
    return item;
  });
}

function dtoValues(result: object): readonly object[] {
  if (Array.isArray(result)) return objects(result);
  if (Object.getOwnPropertySymbols(result).length > 0) return [result];
  const items = record.parse(result).items;
  return Array.isArray(items) ? objects(items) : [result];
}

const fixtureNames = readdirSync(
  new URL("../fixtures/zentao-22.6/", import.meta.url),
);

describe("Q1/S01 WP-04 真实夹具门面白名单", () => {
  it("登记 26 个端点并使用全部 39 份真实夹具", () => {
    expect(Object.keys(endpoints)).toHaveLength(26);
    expect(fixtureNames).toHaveLength(39);
    expect(
      new Set(fixtureNames.map((name) => readFixture(name).endpoint)),
    ).toEqual(new Set(Object.keys(endpoints)));
  });

  it.each(fixtureNames)(
    "%s 原样状态码、请求边界、具品牌 DTO 与脱敏",
    async (name) => {
      const fixture = readFixture(name);
      const endpoint = endpoints[fixture.endpoint];
      if (!endpoint) throw new Error("Fixture endpoint has no read facade");
      const options = {
        path: endpoint.path,
        query: endpoint.query,
        transform: injectSecrets,
      };
      const { client, fetch } = mockReadFixture(name, options);
      const result = await endpoint.call(client);
      assertNoSensitiveData(result, Object.values(secrets));
      for (const dto of dtoValues(result)) {
        const symbols = Object.getOwnPropertySymbols(dto);
        expect(symbols.length).toBeGreaterThan(0);
        for (const brand of symbols) {
          expect(Object.getOwnPropertyDescriptor(dto, brand)).toMatchObject({
            value: true,
            enumerable: false,
            writable: false,
          });
        }
        expect(Object.getOwnPropertySymbols({ ...dto })).toHaveLength(0);
      }
      expect(fetch.mock.calls.map(([, init]) => init?.method)).toEqual([
        "POST",
        "GET",
      ]);
    },
  );

  it("关键字段畸形只报安全的结构错误", async () => {
    const { client } = mockReadFixture("story-detail", {
      transform: (body) => ({
        ...record.parse(body),
        id: { hidden: secrets.password },
      }),
    });
    const outcome = await getStoryDetail(client, 4837).catch(
      (error: unknown) => error,
    );
    expect(outcome).toMatchObject({
      code: "ZENTAO_SCHEMA_MISMATCH",
      details: { fields: ["id"] },
    });
    assertNoSensitiveData(outcome, Object.values(secrets));
  });

  it("Q12 保留任务原始类型供后续阶段识别", async () => {
    const { client } = mockReadFixture("execution-tasks");
    const page = await listExecutionTasks(client, 189);
    const raw = z.object({ tasks: z.array(z.object({ type: z.string() })) });
    const types = raw
      .parse(readFixture("execution-tasks").body)
      .tasks.map(({ type }) => type);
    expect(types).toContain("devel");
    expect(page.items.map(({ type }) => type)).toEqual(types);
    for (const item of page.items) expect(item).not.toHaveProperty("phase");
  });
});
