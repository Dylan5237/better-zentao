import { expect, it } from "vitest";
import { z } from "zod";
import {
  hasProbeOwnership,
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
        children: row.children.map((child) => ({
          ...z.looseObject({}).parse(child),
          product: childProduct,
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
