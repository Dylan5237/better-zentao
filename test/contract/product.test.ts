import { expect, it } from "vitest";
import { z } from "zod";
import { getInstanceConfig, getInstanceWebRoute } from "../../src/api/org.ts";
import { getProductModules, listProducts } from "../../src/api/product.ts";
import { assertNoSensitiveData } from "../helpers/assert-no-sensitive-data.ts";
import { mockReadFixture } from "./read-fixture.ts";

it("实例配置兼容夹具的字符串 1 并仅保留需要的字段", async () => {
  const { client } = mockReadFixture("instance-config", {
    path: "/index.php",
    query: { mode: "getconfig" },
  });
  const result = await getInstanceConfig(client);
  expect(result).toEqual({ version: "22.6", URAndSR: true });
  assertNoSensitiveData(result);
});

it.each([
  ["0", false],
  [false, false],
  [true, true],
] as const)("实例配置显式将 URAndSR %s 投影为 %s", async (raw, expected) => {
  const { client } = mockReadFixture("instance-config", {
    transform: (body) => ({ ...z.looseObject({}).parse(body), URAndSR: raw }),
  });
  await expect(getInstanceConfig(client)).resolves.toHaveProperty(
    "URAndSR",
    expected,
  );
});

it("产品列表投影 v1 total 和产品状态", async () => {
  const { client } = mockReadFixture("products", {
    path: "/api.php/v1/products",
    query: { limit: "100", page: "1" },
  });
  const result = await listProducts(client);
  expect(result.truncated).toBe(false);
  expect(result.items).toHaveLength(11);
  expect(result.items.find(({ id }) => id === 42)).toMatchObject({
    id: 42,
    name: "示例文本",
    status: "normal",
  });
  assertNoSensitiveData(result);
});

it("产品空页保留夹具中的已知总数语义", async () => {
  const { client } = mockReadFixture("products.empty");
  await expect(listProducts(client)).resolves.toEqual({
    items: [],
    truncated: true,
  });
});

it("产品模块投影根节点 0 和响应中声明的产品归属", async () => {
  const { client } = mockReadFixture("product-modules", {
    path: "/api.php/v1/products/42",
    query: { fields: "moduleOptionMenu" },
  });
  const modules = await getProductModules(client, 42);
  expect(modules).toHaveLength(18);
  expect(modules[0]).toEqual({ id: 0, name: "示例文本", productId: 42 });
  expect(modules.find(({ id }) => id === 546)).toMatchObject({ productId: 42 });
  assertNoSensitiveData(modules);
});

it("产品模块拒绝回读到其他产品", async () => {
  const { client } = mockReadFixture("product-modules", {
    path: "/api.php/v1/products/43",
  });
  await expect(getProductModules(client, 43)).rejects.toHaveProperty(
    "code",
    "ZENTAO_SCHEMA_MISMATCH",
  );
});
it("门户路由只读取网页跳转所需字段", async () => {
  const { client } = mockReadFixture("instance-config", {
    path: "/index.php",
    query: { mode: "getconfig" },
    transform: () => ({
      version: "22.6",
      URAndSR: true,
      requestType: "GET",
      moduleVar: "m",
      methodVar: "f",
      password: "synthetic-must-not-project",
    }),
  });
  await expect(getInstanceWebRoute(client)).resolves.toEqual({
    requestType: "GET",
    moduleVar: "m",
    methodVar: "f",
  });
});
