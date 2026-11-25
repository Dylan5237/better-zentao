import { expect, it } from "vitest";
import { z } from "zod";
import {
  getProbeOwnershipOptions,
  hasProbeOwnership,
  readProbeExecutions,
  readProbeOwnership,
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
