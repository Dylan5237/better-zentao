import { expect, it } from "vitest";
import { z } from "zod";
import { listProductBugs, listProjectBugs } from "../../src/api/bug.ts";
import { mockReadFixture } from "./read-fixture.ts";

const fixturePage = z.looseObject({
  bugs: z.array(z.looseObject({ status: z.string() })),
});

it("产品 Bug 转发 unclosed 并兜底过滤关闭项，保留 active 和 resolved", async () => {
  const { client } = mockReadFixture("product-bugs", {
    path: "/api.php/v1/products/42/bugs",
    query: { status: "unclosed", limit: 100, page: 1 },
    transform(body) {
      const page = fixturePage.parse(body);
      return {
        ...page,
        total: page.bugs.length + 1,
        bugs: [...page.bugs, { ...page.bugs[0], id: 6500, status: "closed" }],
      };
    },
  });
  const result = await listProductBugs(client, 42);
  expect(result.items).toHaveLength(14);
  expect(result.truncated).toBe(false);
  expect(new Set(result.items.map(({ status }) => status))).toEqual(
    new Set(["active", "resolved"]),
  );
  expect(result.items[0]).toMatchObject({
    id: 5827,
    product: 42,
    project: null,
    story: null,
    severity: 3,
    openedBy: "acct_017",
    assignedTo: "acct_068",
    openedDate: Date.parse("2026-11-23T09:24:28Z"),
  });
  expect(
    result.items.find(({ feedbackBy }) => feedbackBy === "人员058"),
  ).toBeDefined();
});

it("项目 Bug 保留已关闭记录，账号字符串不变", async () => {
  const { client } = mockReadFixture("project-bugs", {
    path: "/api.php/v1/projects/20/bugs",
    query: { limit: 100, page: 1 },
  });
  const result = await listProjectBugs(client, 20);
  expect(result.items).toHaveLength(32);
  expect(result.truncated).toBe(true);
  expect(result.items.some(({ status }) => status === "closed")).toBe(true);
  expect(result.items[0]).toMatchObject({
    id: 1699,
    project: 20,
    openedBy: "acct_022",
    assignedTo: "acct_017",
  });
});

it.each([
  ["product-bugs.empty", listProductBugs, 42],
  ["project-bugs.empty", listProjectBugs, 20],
] as const)("%s 空页保留未取完的总数", async (fixture, list, id) => {
  const { client } = mockReadFixture(fixture);
  await expect(list(client, id)).resolves.toEqual({
    items: [],
    truncated: true,
  });
});
