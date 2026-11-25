import { expect, it } from "vitest";
import { z } from "zod";
import {
  getProbeOwnershipOptions,
  hasProbeOwnership,
  readProbeExecutions,
  readProbeOwnership,
  readProbeStoryLinks,
} from "../../src/api/internal/probe-scope.ts";
import { mockReadClient, readFixture } from "./read-fixture.ts";

const baseUrl = "https://zentao.fixture.test/zentao/";
const plansPage = z.looseObject({
  plans: z.array(z.unknown()),
  total: z.int(),
});
const planRow = z.looseObject({ children: z.array(z.unknown()).optional() });

function plansForProbe(rows: unknown[], childProduct: number): unknown[] {
  return rows.map((value) => {
    const row = planRow.parse(value);
    return {
      ...row,
      product: 29,
      ...(row.children && {
        children: row.children.map((child, index) => ({
          ...z.looseObject({}).parse(child),
          product: childProduct,
          ...(index === 1 && { status: "closed" }),
          ...(index === 2 && { deleted: true }),
        })),
      }),
    };
  });
}

function mockProbeRead(
  moduleProduct: number,
  childProduct: number,
  omittedPlans = 0,
) {
  const modules = readFixture("product-modules");
  const plans = readFixture("product-plans");
  const page = plansPage.parse(plans.body);
  return mockReadClient((url) => {
    if (url.pathname === "/zentao/api.php/v1/products/29") {
      expect(Object.fromEntries(url.searchParams)).toEqual({
        fields: "moduleOptionMenu",
      });
      return Response.json(
        {
          ...z.looseObject({}).parse(modules.body),
          id: moduleProduct,
        },
        { status: modules.status },
      );
    }
    expect(url.pathname).toBe("/zentao/api.php/v1/products/29/plans");
    expect(Object.fromEntries(url.searchParams)).toEqual({
      limit: "100",
      page: "1",
    });
    return Response.json(
      {
        ...page,
        total: page.total + omittedPlans,
        plans: plansForProbe(page.plans, childProduct),
      },
      { status: plans.status },
    );
  });
}

it("WP-05 归属证据由只读模块和计划端点签发，并保留子计划归属", async () => {
  const { client, fetch } = mockProbeRead(29, 29);
  const evidence = await readProbeOwnership(client);
  const origin = new URL(baseUrl);
  expect(fetch).toHaveBeenCalledTimes(3);
  expect(hasProbeOwnership(evidence, origin, 546, 707)).toBe(true);
  expect(hasProbeOwnership(evidence, origin, 0, 707)).toBe(false);
  expect(hasProbeOwnership(evidence, origin, 546, 29)).toBe(false);
  expect(
    hasProbeOwnership(evidence, new URL("https://other.test/"), 546, 707),
  ).toBe(false);
  const scope = getProbeOwnershipOptions(evidence);
  expect(scope.modules).toContain(546);
  expect(scope.modules).not.toContain(0);
  expect(scope.openPlans).toContain(707);
  expect(scope.openPlans).not.toContain(669);
  expect(scope.openPlans).not.toContain(682);
});

it.each([
  [42, 29],
  [29, 42],
] as const)(
  "WP-05 拒绝模块产品 %i 或子计划产品 %i 的跨产品回读",
  async (moduleProduct, childProduct) => {
    const { client } = mockProbeRead(moduleProduct, childProduct);
    await expect(readProbeOwnership(client)).rejects.toHaveProperty(
      "code",
      "ZENTAO_SCHEMA_MISMATCH",
    );
  },
);

it("WP-05 计划回读截断时不签发归属证据", async () => {
  const { client } = mockProbeRead(29, 29, 1);
  await expect(readProbeOwnership(client)).rejects.toHaveProperty(
    "code",
    "ZENTAO_SCHEMA_MISMATCH",
  );
});

it("WP-30 只返回可用多迭代项目中经详情核对的未关闭执行", async () => {
  const { client, fetch } = mockReadClient((url) => {
    switch (url.pathname) {
      case "/zentao/api.php/v1/products/29/projects":
        return Response.json({
          projects: [
            {
              id: "1",
              multiple: "1",
              status: "doing",
              products: [{ id: "29" }],
            },
            { id: 2, multiple: true, status: "closed" },
            { id: 3, multiple: false, status: "doing" },
          ],
          total: 3,
        });
      case "/zentao/api.php/v1/projects/1/executions":
        return Response.json({
          executions: [
            { id: "61", project: "1", status: "wait" },
            { id: 62, project: 1, status: "closed" },
            { id: 63, project: 1, status: "doing", deleted: "1" },
          ],
        });
      case "/zentao/api.php/v1/executions/61":
        return Response.json({
          id: 61,
          project: 1,
          status: "wait",
          products: ["29"],
        });
      default:
        throw new Error("Unexpected fixture path");
    }
  });
  await expect(readProbeExecutions(client)).resolves.toEqual({
    projectsCount: 3,
    executions: [{ id: 61, project: 1 }],
  });
  expect(fetch).toHaveBeenCalledTimes(4);
});

it("WP-30 产品无项目时返回空集，不读取其他产品或执行", async () => {
  const { client, fetch } = mockReadClient((url) => {
    expect(url.pathname).toBe("/zentao/api.php/v1/products/29/projects");
    return Response.json({ projects: [], total: 0 });
  });
  await expect(readProbeExecutions(client)).resolves.toEqual({
    projectsCount: 0,
    executions: [],
  });
  expect(fetch).toHaveBeenCalledTimes(2);
});

it("WP-30 22.6 项目列表缺少 multiple/products 时回读 v2/project/view 验证归属", async () => {
  const { client, fetch } = mockReadClient((url) => {
    if (url.pathname === "/zentao/api.php/v1/products/29/projects") {
      return Response.json({
        total: 1,
        projects: [{ id: 314, status: "wait" }],
      });
    }
    if (url.pathname === "/zentao/api.php/v2/project/view") {
      expect(url.searchParams.get("projectID")).toBe("314");
      return Response.json({
        project: { id: 314, status: "wait", deleted: 0, multiple: 1 },
        products: { "29": { id: 29, name: "示例产品" } },
      });
    }
    if (url.pathname === "/zentao/api.php/v1/projects/314/executions") {
      return Response.json({
        executions: [{ id: 315, project: 314, status: "wait" }],
      });
    }
    if (url.pathname === "/zentao/api.php/v1/executions/315") {
      return Response.json({
        id: 315,
        project: 314,
        status: "wait",
        deleted: false,
        products: [{ id: 29, name: "示例产品" }],
      });
    }
    throw new Error(`Unexpected fixture path: ${url.pathname}`);
  });
  await expect(readProbeExecutions(client)).resolves.toEqual({
    projectsCount: 1,
    executions: [{ id: 315, project: 314 }],
  });
  expect(fetch).toHaveBeenCalledTimes(5);
});

it.each([
  {
    name: "包含非 29 产品",
    body: {
      project: { id: 314, status: "wait", deleted: 0, multiple: 1 },
      products: { "29": { id: 29 }, "42": { id: 42 } },
    },
  },
  {
    name: "缺少 products 字段",
    body: {
      project: { id: 314, status: "wait", deleted: 0, multiple: 1 },
    },
  },
  {
    name: "详情 project.id 不匹配",
    body: {
      project: { id: 999, status: "wait", deleted: 0, multiple: 1 },
      products: { "29": { id: 29 } },
    },
  },
])("WP-30 v2/project/view 异常（$name）时拒绝放行", async ({ body }) => {
  const { client } = mockReadClient((url) => {
    if (url.pathname === "/zentao/api.php/v1/products/29/projects") {
      return Response.json({
        total: 1,
        projects: [{ id: 314, status: "wait" }],
      });
    }
    if (url.pathname === "/zentao/api.php/v2/project/view") {
      return Response.json(body);
    }
    throw new Error(`Unexpected fixture path: ${url.pathname}`);
  });
  await expect(readProbeExecutions(client)).rejects.toHaveProperty(
    "code",
    "PERMISSION_DENIED",
  );
});

it.each([
  { multiple: 0, status: "wait" },
  { multiple: 1, status: "closed" },
])(
  "WP-30 v2/project/view 为非多迭代或已关闭项目（%o）时直接跳过",
  async ({ multiple, status }) => {
    const { client, fetch } = mockReadClient((url) => {
      if (url.pathname === "/zentao/api.php/v1/products/29/projects") {
        return Response.json({
          total: 1,
          projects: [{ id: 314, status: "wait" }],
        });
      }
      if (url.pathname === "/zentao/api.php/v2/project/view") {
        return Response.json({
          project: { id: 314, status, deleted: 0, multiple },
          products: { "29": { id: 29 } },
        });
      }
      throw new Error(`Unexpected fixture path: ${url.pathname}`);
    });
    await expect(readProbeExecutions(client)).resolves.toEqual({
      projectsCount: 1,
      executions: [],
    });
    expect(fetch).toHaveBeenCalledTimes(3);
  },
);

it("WP-30 readProbeStoryLinks 从 v2 relations.story 字典提取关联故事编号", async () => {
  const { client } = mockReadClient((url) => {
    expect(url.pathname).toBe("/zentao/api.php/v2/story/view");
    expect(url.searchParams.get("storyID")).toBe("4876");
    return Response.json({
      story: {
        id: 4876,
        type: "story",
        product: 29,
        title: "需求A",
        status: "draft",
        deleted: 0,
        linkStories: "",
      },
      relations: {
        story: {
          "4877": { id: 4877, title: "需求B" },
        },
      },
    });
  });
  await expect(readProbeStoryLinks(client, 4876, "story")).resolves.toEqual([
    4877,
  ]);
});
