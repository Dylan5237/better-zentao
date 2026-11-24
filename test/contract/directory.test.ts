import { expect, it } from "vitest";
import { z } from "zod";
import {
  getCurrentUser,
  getDepartments,
  listUsers,
  listUsersByDepartment,
} from "../../src/api/org.ts";
import { assertNoSensitiveData } from "../helpers/assert-no-sensitive-data.ts";
import { mockReadFixture } from "./read-fixture.ts";

const user = z.looseObject({ id: z.int().positive() });
const userList = z.looseObject({
  users: z.array(user),
  pager: z.looseObject({ recTotal: z.int().nonnegative() }),
});

it("Q2 当前用户读取 profile 并投影角色码", async () => {
  const { client } = mockReadFixture("current-user", {
    path: "/api.php/v1/user",
  });
  const current = await getCurrentUser(client);
  expect(current).toMatchObject({
    id: 426,
    account: "acct_001",
    realname: "人员001",
    dept: 11111311,
    role: "po",
  });
  expect(current).not.toHaveProperty("view");
  assertNoSensitiveData(current);
});

it("Q2 当前用户兼容字符串角色以及值为 0 的部门", async () => {
  const { client } = mockReadFixture("current-user", {
    transform: (body) => {
      const base = z.looseObject({ profile: z.looseObject({}) }).parse(body);
      return { ...base, profile: { ...base.profile, dept: "0", role: "dev" } };
    },
  });
  await expect(getCurrentUser(client)).resolves.toMatchObject({
    account: "acct_001",
    dept: null,
    role: "dev",
  });
});

it("Q2 部门树按 items 递归解码并清除各层的附带字段", async () => {
  const { client } = mockReadFixture("departments", {
    path: "/api.php/v1/departments",
  });
  const departments = await getDepartments(client);
  const root = departments[0];
  expect(root).toMatchObject({ id: 2, parent: null });
  expect(root?.items[0]).toMatchObject({ id: 258, parent: 2 });
  expect(root?.items[0]?.items[0]?.items[0]).toMatchObject({
    id: 266,
    parent: 3,
    items: [],
  });
  expect(root?.items[0]).not.toHaveProperty("url");
  assertNoSensitiveData(departments);
});

it("Q2 全量用户走 v2 并透传 pager.recTotal", async () => {
  const { client } = mockReadFixture("users", {
    path: "/api.php/v2/users",
    query: { recPerPage: "3000", pageID: "1" },
  });
  const result = await listUsers(client);
  expect(result.truncated).toBe(true);
  expect(result.items).toHaveLength(32);
  expect(result.items[0]).toMatchObject({
    id: 1,
    account: "acct_002",
    dept: null,
    role: null,
    pinyin: "示例文本",
    deleted: false,
  });
  assertNoSensitiveData(result);
});

it("Q2 正整数键用户集合兼容 deleted 的数字、字符串和布尔形式", async () => {
  const deleted = [0, "0", false, 1, "1", true] as const;
  const { client } = mockReadFixture("users", {
    transform: (body) => {
      const base = userList.parse(body);
      return {
        ...base,
        users: Object.fromEntries(
          base.users.slice(0, deleted.length).map((row, index) => [
            row.id,
            {
              ...row,
              deleted: deleted[index],
              email: "directory-test@example.test",
              mobile: "directory-test-sensitive",
            },
          ]),
        ),
        pager: { ...base.pager, recTotal: deleted.length },
      };
    },
  });
  const result = await listUsers(client);
  expect(result.items.map((item) => item.deleted)).toEqual([
    false,
    false,
    false,
    true,
    true,
    true,
  ]);
  expect(result.truncated).toBe(false);
  assertNoSensitiveData(result, ["directory-test-sensitive"]);
});

it("Q2 按部门读取使用 param 和 type=bydept", async () => {
  const { client, fetch } = mockReadFixture("users-by-department", {
    path: "/api.php/v2/company/browse",
    query: {
      param: "11111311",
      type: "bydept",
      recPerPage: "200",
      pageID: "1",
    },
  });
  const result = await listUsersByDepartment(client, 11111311);
  expect(result.items).toHaveLength(32);
  expect(result.items[0]).toMatchObject({ id: 4, dept: 11111311, role: "td" });
  expect(result.truncated).toBe(true);
  const [request] = fetch.mock.calls[1] ?? [];
  expect(Object.fromEntries(new URL(String(request)).searchParams)).toEqual({
    param: "11111311",
    type: "bydept",
    recPerPage: "200",
    pageID: "1",
  });
  assertNoSensitiveData(result);
});

it.each(["users", "users-by-department"] as const)(
  "Q2 %s 空页仍如实报告已知总数未达到",
  async (endpoint) => {
    const { client } = mockReadFixture(`${endpoint}.empty`);
    const result =
      endpoint === "users"
        ? await listUsers(client)
        : await listUsersByDepartment(client, 11111311);
    expect(result).toEqual({ items: [], truncated: true });
  },
);
