import { expect, it } from "vitest";
import { z } from "zod";
import { getPlanDetail, listProductPlans } from "../../src/api/plan.ts";
import { assertNoSensitiveData } from "../helpers/assert-no-sensitive-data.ts";
import { mockReadFixture, readFixture } from "./read-fixture.ts";

it("Q11 两端均为待定的计划保留记录，但不推断日期", async () => {
  const { client } = mockReadFixture("product-plans", {
    transform: (body) => {
      const page = z
        .looseObject({ plans: z.array(z.looseObject({})) })
        .parse(body);
      return {
        ...page,
        plans: [
          { ...page.plans[0], begin: "待定", end: "待定" },
          ...page.plans.slice(1),
        ],
      };
    },
  });
  expect((await listProductPlans(client, 42)).items[0]).toMatchObject({
    begin: null,
    end: null,
  });
});

it("Q11 计划保留 L2 和 L3 层级、状态与日期，分页总数覆盖子计划", async () => {
  const { client } = mockReadFixture("product-plans", {
    path: "/api.php/v1/products/42/plans",
    query: { limit: "100", page: "1" },
  });
  const result = await listProductPlans(client, 42);
  expect(result.truncated).toBe(false);
  expect(result.items).toHaveLength(6);
  const first = result.items[0];
  expect(first).toMatchObject({
    id: 668,
    product: 42,
    parent: -1,
    status: "wait",
    begin: "2026-11-01",
    end: "2027-10-31",
    deleted: false,
  });
  expect(first?.children).toHaveLength(2);
  expect(first?.children[0]).toMatchObject({
    id: 707,
    parent: 668,
    status: "wait",
    begin: "2026-11-02",
    end: "2026-11-30",
    deleted: false,
    children: [],
  });
  assertNoSensitiveData(result);
});

it("Q11 计划空页不会掩盖仍有未读取的计划", async () => {
  const { client } = mockReadFixture("product-plans.empty");
  await expect(listProductPlans(client, 42)).resolves.toEqual({
    items: [],
    truncated: true,
  });
});

it("Q11 计划详情把数字键需求投影为数组，保留模块 ID 字典", async () => {
  const { client } = mockReadFixture("plan-detail", {
    path: "/api.php/v2/productplan/view",
    query: { planID: "707" },
  });
  const result = await getPlanDetail(client, 707);
  expect(result.plan).toMatchObject({ id: 707, product: 42, parent: 668 });
  expect(result.planStories).toMatchObject([
    { id: 3563, type: "story", status: "active" },
  ]);
  expect(result.modulePairs).toMatchObject({ "0": "/" });
  expect(result.modulePairs["546"]).toEqual(expect.any(String));
  expect(result.childrenPlans).toEqual([]);
  assertNoSensitiveData(result);
});

it("Q11 计划详情将 PHP 空模块数组投影为空字典", async () => {
  const { client } = mockReadFixture("plan-detail", {
    transform: (body) => ({
      ...z.looseObject({}).parse(body),
      modulePairs: [],
    }),
  });
  const result = await getPlanDetail(client, 707);
  expect(result.modulePairs).toStrictEqual({});
});

it("Q11 计划详情拒绝非空模块数组", async () => {
  const { client } = mockReadFixture("plan-detail", {
    transform: (body) => ({
      ...z.looseObject({}).parse(body),
      modulePairs: ["/"],
    }),
  });
  await expect(getPlanDetail(client, 707)).rejects.toHaveProperty(
    "code",
    "ZENTAO_SCHEMA_MISMATCH",
  );
});

it("Q11 计划详情兼容子计划和数组版需求集合", async () => {
  const { client } = mockReadFixture("plan-detail", {
    transform: (body) => {
      const detail = z
        .looseObject({
          planStories: z.record(z.string(), z.unknown()),
        })
        .parse(body);
      const { plans } = z
        .looseObject({ plans: z.array(z.unknown()) })
        .parse(readFixture("product-plans").body);
      const parent = z
        .looseObject({ children: z.array(z.looseObject({})) })
        .parse(plans[0]);
      return {
        ...detail,
        plan: parent,
        planStories: Object.values(detail.planStories),
        childrenPlans: parent.children.map((child) => ({
          ...child,
          status: "closed",
          deleted: "1",
        })),
      };
    },
  });
  await expect(getPlanDetail(client, 668)).resolves.toMatchObject({
    plan: { id: 668 },
    childrenPlans: [
      { id: 707, parent: 668, status: "closed", deleted: true },
      { id: 669, parent: 668, status: "closed", deleted: true },
    ],
    planStories: [{ id: 3563 }],
  });
});
