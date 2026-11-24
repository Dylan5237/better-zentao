import { expect, it } from "vitest";
import { z } from "zod";
import { listProductRequirements } from "../../src/api/requirement.ts";
import { listProductStories } from "../../src/api/story.ts";
import { mockReadFixture } from "./read-fixture.ts";

it("Q3 研发需求列表接受实采的 201，具体状态和类型留给客户端过滤", async () => {
  const feedbackBy = "示例甲、示例乙";
  const { client, fetch } = mockReadFixture("product-stories", {
    path: "/api.php/v1/products/42/stories",
    query: { status: "all", limit: 100, page: 1 },
    transform(body) {
      const page = z
        .looseObject({ stories: z.array(z.record(z.string(), z.json())) })
        .parse(body);
      const first = page.stories[0];
      return {
        ...page,
        stories: [
          ...page.stories.slice(1),
          { ...first, feedbackBy },
          { ...first, type: "requirement", id: 9999 },
        ],
      };
    },
  });

  const page = await listProductStories(client, 42, "active");

  const request = new URL(String(fetch.mock.calls[1]?.[0]));
  expect(Object.fromEntries(request.searchParams)).toEqual({
    status: "all",
    limit: "100",
    page: "1",
  });
  expect(page.items).toContainEqual(
    expect.objectContaining({ id: 4843, feedbackBy }),
  );
  expect(
    page.items.every(
      ({ type, status }) => type === "story" && status === "active",
    ),
  ).toBe(true);
  expect(page.truncated).toBe(true);
});

it("Q3 未关闭口径过滤掉源响应里的关闭项", async () => {
  const { client } = mockReadFixture("product-stories", {
    path: "/api.php/v1/products/42/stories",
    query: { status: "unclosed", limit: 100, page: 1 },
  });

  const page = await listProductStories(client, 42, "unclosed");

  expect(page.items).toContainEqual(expect.objectContaining({ id: 4843 }));
  expect(page.items.some(({ status }) => status === "closed")).toBe(false);
});

it.each(["", " ", "done"])(
  "Q3 研发需求拒绝无效查询状态 %j 且不会发请求",
  async (status) => {
    const { client, fetch } = mockReadFixture("product-stories");
    // @ts-expect-error 模拟未经 TypeScript 检查的调用方。
    const result = listProductStories(client, 42, status);
    await expect(result).rejects.toHaveProperty("code", "INVALID_INPUT");
    expect(fetch).not.toHaveBeenCalled();
  },
);

it("Q3 研发需求空页且 total 仍为正数时标记截断", async () => {
  const { client } = mockReadFixture("product-stories.empty", {
    path: "/api.php/v1/products/42/stories",
    query: { status: "all", limit: 100, page: 1 },
  });

  await expect(listProductStories(client, 42)).resolves.toEqual({
    items: [],
    truncated: true,
  });
});

it("Q3 用户需求用 v2 列表且只保留用户需求", async () => {
  const { client } = mockReadFixture("product-requirements", {
    path: "/api.php/v2/product/browse",
    query: {
      productID: 42,
      storyType: "requirement",
      recPerPage: 100,
      pageID: 1,
    },
  });

  const page = await listProductRequirements(client, 42);

  expect(page.items).toContainEqual(
    expect.objectContaining({ id: 4845, type: "requirement" }),
  );
  expect(page.items.every(({ type }) => type === "requirement")).toBe(true);
  expect(page.truncated).toBe(true);
});

it("Q3 用户需求空页按 pager.recTotal 标记截断", async () => {
  const { client } = mockReadFixture("product-requirements.empty", {
    path: "/api.php/v2/product/browse",
    query: {
      productID: 42,
      storyType: "requirement",
      recPerPage: 100,
      pageID: 1,
    },
  });

  await expect(listProductRequirements(client, 42)).resolves.toEqual({
    items: [],
    truncated: true,
  });
});
