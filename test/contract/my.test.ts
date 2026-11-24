import { expect, it } from "vitest";
import { z } from "zod";
import { listMyContributions, listMyWork } from "../../src/api/my.ts";
import {
  mockReadClient,
  mockReadFixture,
  readFixture,
} from "./read-fixture.ts";

const myWork = { mode: "task", browseType: "assignedTo" } as const;
const myContributions = { mode: "story", browseType: "openedBy" } as const;
const zeroCounts = { task: 0, story: 0, bug: 0, requirement: 0, epic: 0 };

it("我的待办用 mode 和 browseType，空页保留待办数", async () => {
  const { client } = mockReadFixture("my-work.empty", {
    path: "/api.php/v2/my/work",
    query: { ...myWork, recPerPage: 100, pageID: 1 },
  });
  await expect(listMyWork(client, myWork)).resolves.toEqual({
    items: [],
    truncated: false,
    todoCount: zeroCounts,
  });
});

it("我的贡献投影数字键需求表，保留待办数", async () => {
  const { client } = mockReadFixture("my-contribute", {
    path: "/api.php/v2/my/contribute",
    query: { ...myContributions, recPerPage: 100, pageID: 1 },
  });
  const result = await listMyContributions(client, myContributions);
  expect(result.items).toHaveLength(14);
  expect(result.truncated).toBe(false);
  expect(result.todoCount).toEqual(zeroCounts);
  expect(result.items[0]).toMatchObject({
    id: 1495,
    product: 15,
    type: "story",
    status: "closed",
    openedBy: "acct_001",
    assignedTo: "closed",
  });
});

it("我的贡献空页仍透传 pager.recTotal 并报告截断", async () => {
  const { client } = mockReadFixture("my-contribute.empty");
  await expect(listMyContributions(client, myContributions)).resolves.toEqual({
    items: [],
    truncated: true,
    todoCount: zeroCounts,
  });
});

it("我的待办从空页夹具构造任务数字键对象与字符串计数", async () => {
  const tasks = z.object({ tasks: z.array(z.looseObject({})).nonempty() });
  const task = tasks.parse(readFixture("execution-tasks").body).tasks[0];
  const { client } = mockReadFixture("my-work.empty", {
    transform(body) {
      const page = z.looseObject({ pager: z.looseObject({}) }).parse(body);
      return {
        ...page,
        tasks: { "4836": task },
        todoCount: { ...zeroCounts, task: "2" },
        pager: { ...page.pager, recTotal: "2" },
      };
    },
  });
  await expect(listMyWork(client, myWork)).resolves.toMatchObject({
    items: [{ id: 4836, isParent: false, parent: 4832 }],
    truncated: true,
    todoCount: { ...zeroCounts, task: 2 },
  });
});

it("我的贡献合并两页，保留第一页的待办汇总", async () => {
  const fixture = readFixture("my-contribute");
  const page = z
    .looseObject({
      stories: z.record(z.string(), z.looseObject({})),
      pager: z.looseObject({}),
    })
    .parse(fixture.body);
  const pages: string[] = [];
  const { client } = mockReadClient((url) => {
    const pageId = url.searchParams.get("pageID") ?? "";
    pages.push(pageId);
    const firstPage = pageId === "1";
    const stories = Array.from({ length: firstPage ? 100 : 1 }, (_, index) => ({
      ...page.stories["1495"],
      id: (firstPage ? 1 : 101) + index,
    }));
    return Response.json(
      {
        ...page,
        stories,
        pager: { ...page.pager, recTotal: 101 },
        todoCount: { ...zeroCounts, story: firstPage ? 4 : 5 },
      },
      { status: fixture.status },
    );
  });

  const result = await listMyContributions(client, myContributions);
  expect(pages).toEqual(["1", "2"]);
  expect(result.items).toHaveLength(101);
  expect(result.truncated).toBe(false);
  expect(result.todoCount.story).toBe(4);
});

it("我的待办 Bug 模式对合成页投影对应集合", async () => {
  const bug = z
    .object({ bugs: z.array(z.looseObject({})).nonempty() })
    .parse(readFixture("product-bugs").body).bugs[0];
  const query = { mode: "bug", browseType: "assignedTo" } as const;
  const { client } = mockReadFixture("my-work.empty", {
    query,
    transform(body) {
      const page = z.looseObject({ pager: z.looseObject({}) }).parse(body);
      return { ...page, bugs: [bug], pager: { ...page.pager, recTotal: 1 } };
    },
  });
  await expect(listMyWork(client, query)).resolves.toMatchObject({
    items: [{ id: 5827, severity: 3, status: "active" }],
    truncated: false,
  });
});

it("我的待办拒绝错误模式集合并只报告白名单字段", async () => {
  const { client } = mockReadFixture("my-work.empty");
  await expect(
    listMyWork(client, { mode: "bug", browseType: "assignedTo" }),
  ).rejects.toMatchObject({
    code: "ZENTAO_SCHEMA_MISMATCH",
    details: { fields: ["bugs"] },
  });
});

it("个人列表拒绝传入其他人的账号且不会发请求", async () => {
  const { client, fetch } = mockReadFixture("my-work.empty");
  const anotherWork = { ...myWork, account: "acct_other" };
  const anotherContribution = { ...myContributions, account: "acct_other" };
  await expect(listMyWork(client, anotherWork)).rejects.toHaveProperty(
    "code",
    "INVALID_INPUT",
  );
  await expect(
    listMyContributions(client, anotherContribution),
  ).rejects.toHaveProperty("code", "INVALID_INPUT");
  expect(fetch).not.toHaveBeenCalled();
});
