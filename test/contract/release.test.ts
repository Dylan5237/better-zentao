import { expect, it } from "vitest";
import { z } from "zod";
import { listReleases } from "../../src/api/release.ts";
import { assertNoSensitiveData } from "../helpers/assert-no-sensitive-data.ts";
import { mockReadFixture } from "./read-fixture.ts";

it("发布列表实采为空，分页完成", async () => {
  const { client, fetch } = mockReadFixture("releases.empty", {
    path: "/api.php/v1/products/42/releases",
  });
  await expect(listReleases(client, 42)).resolves.toEqual({
    items: [],
    truncated: false,
  });
  const request = fetch.mock.calls.find(([, init]) => init?.method === "GET");
  expect(new URL(String(request?.[0])).search).toBe("");
});

it("发布列表声明总数大于返回行数时报告截断", async () => {
  const { client, fetch } = mockReadFixture("releases.empty", {
    transform: (body) => ({ ...z.looseObject({}).parse(body), total: 1 }),
  });
  await expect(listReleases(client, 42)).resolves.toEqual({
    items: [],
    truncated: true,
  });
  expect(
    fetch.mock.calls.filter(([, init]) => init?.method === "GET"),
  ).toHaveLength(1);
});

it("发布 DTO 投影空页夹具内注入的合成发布行", async () => {
  const { client } = mockReadFixture("releases.empty", {
    transform(body) {
      return {
        ...z.looseObject({}).parse(body),
        total: 1,
        releases: [
          {
            id: "1",
            name: "示例版本",
            date: "2026-11-30",
            product: 42,
            status: "normal",
            apiToken: "opaque-release-value",
          },
        ],
      };
    },
  });
  const result = await listReleases(client, 42);
  expect(result.truncated).toBe(false);
  expect(result.items).toEqual([
    {
      id: 1,
      name: "示例版本",
      date: "2026-11-30",
      product: 42,
      status: "normal",
    },
  ]);
  assertNoSensitiveData(result, ["opaque-release-value"]);
});
