import { expect, it, vi } from "vitest";
import {
  resolveContextInputSchema,
  resolveContextOutputSchema,
} from "../../src/contracts/tools/resolve_context.ts";
import { teamConfigSchema } from "../../src/core/config.ts";
import { DirectoryService } from "../../src/services/directory.ts";
import { mockReadClient } from "../contract/read-fixture.ts";

const me = {
  id: 1,
  account: "acct_pm",
  realname: "人员甲",
  dept: 0,
  role: "po",
};
const sameName = [
  {
    id: 2,
    account: "acct_dev_a",
    realname: "同名人员",
    dept: 0,
    role: "dev",
    pinyin: "tong ming",
    deleted: false,
  },
  {
    id: 3,
    account: "acct_dev_b",
    realname: "同名人员",
    dept: 0,
    role: null,
    pinyin: "tb",
    deleted: false,
  },
  {
    id: 4,
    account: "acct_deleted",
    realname: "人员甲",
    dept: 0,
    role: null,
    deleted: true,
  },
];
const child = {
  id: 6,
  product: 42,
  parent: 5,
  title: "【负责人】权限管理-2026年12月",
  begin: "2026-11-30",
  end: "2026-12-31",
  status: "wait",
  deleted: false,
};
const config = teamConfigSchema.parse({
  products: { 42: { name: "示例平台", state: "design", projects: [8] } },
  modules: { "42:2": { name: "权限管理", devLead: "acct_dev_a", team: "be" } },
  moduleDefaults: { 42: { devLead: "acct_pm", designLead: "acct_pm" } },
  teams: {
    be: { name: "后端", lead: "acct_dev_a", members: ["acct_dev_b"] },
    fe: { name: "前端", lead: "acct_pm", members: [] },
  },
  roles: { PM: ["acct_pm"], RM: ["acct_dev_a"] },
  aliases: { "研发主管（后端）": "acct_dev_a" },
});

function setup(
  overrides: Readonly<Record<string, () => Response>> = {},
  cache?: ConstructorParameters<typeof DirectoryService>[0]["cache"],
) {
  const bodies: Record<string, unknown> = {
    "/api.php/v1/user": { profile: me },
    "/api.php/v2/users": {
      users: [...sameName, { ...me, deleted: false }],
      total: 4,
    },
    "/api.php/v1/products": {
      products: [
        { id: 42, name: "示例平台正式", status: "normal", deleted: false },
      ],
    },
    "/api.php/v1/products/42": {
      id: 42,
      moduleOptionMenu: [
        { id: 0, name: "/" },
        { id: 2, name: "/基础/权限管理" },
      ],
    },
    "/api.php/v1/products/42/plans": {
      plans: [
        { ...child, id: 5, parent: -1, title: "建设目标", children: [child] },
      ],
    },
    "/api.php/v1/executions": {
      executions: [
        {
          id: 7,
          project: 8,
          name: "【示例平台】【研发】2026年12月迭代",
          type: "sprint",
          status: "closed",
          begin: "2026-12-01",
          end: "2026-12-31",
        },
        {
          id: 9,
          project: 10,
          name: "【示例平台】【研发】2026年12月迭代",
          type: "sprint",
          status: "wait",
          begin: "2026-12-01",
          end: "2026-12-31",
        },
      ],
    },
  };
  const { client, fetch } = mockReadClient((url) => {
    const path = url.pathname.replace(/^\/zentao/u, "");
    return (
      overrides[path]?.() ??
      (Object.hasOwn(bodies, path)
        ? Response.json(bodies[path])
        : new Response(null, { status: 404 }))
    );
  });
  const service = new DirectoryService({
    client,
    config,
    clock: () => Date.UTC(2026, 10, 30, 17),
    cache,
  });
  return { service, fetch };
}

it("AC-02 返回两个同名候选，保留账号供用户选择", async () => {
  const { service } = setup();
  await expect(
    service.resolveContext({ people: ["同名人员"] }),
  ).rejects.toMatchObject({
    code: "AMBIGUOUS_ENTITY",
    retryable: false,
    details: {
      candidates: [
        { account: "acct_dev_a", realname: "同名人员", team: "be" },
        { account: "acct_dev_b", realname: "同名人员", team: "be" },
      ],
    },
  });
});

it("解析账号、配置称呼、拼音、限定产品的模块与迭代，以及按月份重叠的 L3", async () => {
  const { service } = setup();
  const result = await service.resolveContext({
    people: ["acct_pm", "研发主管（后端）", "TONGMING"],
    module: "示例平台/基础/权限管理",
    plan: "L3 12月 权限管理",
    execution: "【示例平台】【研发】2026年12月迭代",
    month: "本月",
  });
  expect(resolveContextOutputSchema.parse(result)).toEqual(result);
  expect(result).toMatchObject({
    ok: true,
    completeness: "complete",
    gaps: [],
    scope: { asOf: "2026-11-30T17:00:00.000Z", filters: { month: "2026-12" } },
    data: {
      product: { id: 42, name: "示例平台正式", state: "design" },
      module: {
        id: 2,
        path: "/基础/权限管理",
        devLead: "acct_dev_a",
        designLead: "acct_pm",
      },
      plan: { id: 6, level: "L3", begin: "2026-11-30", end: "2026-12-31" },
      execution: { id: 7, kind: "dev", month: "2026-12" },
      people: [
        {
          input: "acct_pm",
          account: "acct_pm",
          realname: "人员甲",
          team: "fe",
          roles: ["PM", "po"],
        },
        {
          input: "研发主管（后端）",
          account: "acct_dev_a",
          roles: ["RM", "dev"],
        },
        { input: "TONGMING", account: "acct_dev_a" },
      ],
      me: { account: "acct_pm", realname: "人员甲", roles: ["PM", "po"] },
    },
  });
  expect(service.resolveTeam("后端")).toEqual({
    id: "be",
    name: "后端",
    lead: "acct_dev_a",
    members: ["acct_dev_b"],
  });
});

it("分页截断后单个姓名不能证明唯一，保留明确账号和其他已确认字段", async () => {
  const { service } = setup({
    "/api.php/v2/users": () =>
      Response.json({ users: [sameName[0]], total: 2 }),
  });
  const result = await service.resolveContext({
    people: ["同名人员", "acct_dev_a"],
    product: "42",
    module: "2",
  });
  expect(result).toMatchObject({
    completeness: "partial",
    truncated: true,
    gaps: [{ source: "users", reason: expect.any(String) }],
    data: {
      people: [{ account: "acct_dev_a", input: "acct_dev_a" }],
      module: { id: 2 },
    },
  });
});

it("独立目录读取失败时保留可用结果，且不传播 API 返回正文", async () => {
  const { service } = setup({
    "/api.php/v1/products/42/plans": () =>
      Response.json({ secret: "never-in-output" }, { status: 403 }),
  });
  const result = await service.resolveContext({
    product: "42",
    plan: "6",
    execution: "7",
  });
  expect(result).toMatchObject({
    completeness: "partial",
    gaps: [{ source: "plans:42", reason: expect.any(String) }],
    data: { product: { id: 42 }, execution: { id: 7 } },
  });
  expect(result.data).not.toHaveProperty("plan");
  expect(JSON.stringify(result)).not.toContain("never-in-output");
});

it("只缓存通过输出契约的完整结果，并使用配置有效期", async () => {
  const entries = new Map<string, unknown>();
  const cache = {
    get: vi.fn((key: string) => entries.get(key)),
    set: vi.fn((key: string, value: unknown) => {
      entries.set(key, value);
    }),
  };
  const { service, fetch } = setup({}, cache);
  const first = await service.resolveContext({ product: "42" });
  const count = fetch.mock.calls.length;
  await expect(service.resolveContext({ product: "42" })).resolves.toEqual(
    first,
  );
  expect(fetch.mock.calls).toHaveLength(count);
  expect(cache.set).toHaveBeenCalledWith(
    expect.any(String),
    first,
    30 * 60_000,
  );
});

it("工具拒绝未知字段、数字 ID、无效月份和带额外字段的输出", async () => {
  expect(resolveContextInputSchema.safeParse({ team: "后端" }).success).toBe(
    false,
  );
  expect(resolveContextInputSchema.safeParse({ product: 42 }).success).toBe(
    false,
  );
  const { service, fetch } = setup();
  await expect(
    service.resolveContext({ month: "2026-13" }),
  ).rejects.toMatchObject({ code: "INVALID_INPUT" });
  expect(fetch).not.toHaveBeenCalled();
  const result = await service.resolveContext({});
  expect(
    resolveContextOutputSchema.safeParse({
      ...result,
      data: { ...result.data, password: "bad" },
    }).success,
  ).toBe(false);
});

it("模块简称撞名时返回两个路径，完整路径可以消歧", async () => {
  const { service } = setup({
    "/api.php/v1/products/42": () =>
      Response.json({
        id: 42,
        moduleOptionMenu: [
          { id: 2, name: "权限管理" },
          { id: 3, name: "/基础/权限管理" },
        ],
      }),
  });
  await expect(
    service.resolveContext({ product: "42", module: "权限管理" }),
  ).rejects.toMatchObject({
    code: "AMBIGUOUS_ENTITY",
    details: {
      candidates: [
        { id: 2, path: "权限管理" },
        { id: 3, path: "/基础/权限管理" },
      ],
    },
  });
  await expect(
    service.resolveContext({ module: "基础/权限管理" }),
  ).resolves.toMatchObject({
    data: { module: { id: 3 }, product: { id: 42 } },
  });
});

it("同名迭代和同月 L3 返回候选，可用 ID 指定", async () => {
  const { service } = setup({
    "/api.php/v1/products/42/plans": () =>
      Response.json({ plans: [child, { ...child, id: 11 }] }),
  });
  const execution = "【示例平台】【研发】2026年12月迭代";
  await expect(service.resolveContext({ execution })).rejects.toMatchObject({
    code: "AMBIGUOUS_ENTITY",
    details: { candidates: [{ id: 7 }, { id: 9 }] },
  });
  await expect(service.resolveContext({ plan: "12月" })).rejects.toMatchObject({
    code: "AMBIGUOUS_ENTITY",
    details: { candidates: [{ id: 6 }, { id: 11 }] },
  });
  await expect(
    service.resolveContext({ plan: "11", execution: "7" }),
  ).resolves.toMatchObject({
    data: { plan: { id: 11 }, execution: { id: 7 } },
  });
});

it("同名产品返回候选，显式 ID 仍可解析", async () => {
  const product = { name: "示例平台正式", status: "normal", deleted: false };
  const { service } = setup({
    "/api.php/v1/products": () =>
      Response.json({
        products: [
          { ...product, id: 42 },
          { ...product, id: 43 },
        ],
      }),
  });
  await expect(
    service.resolveContext({ product: product.name }),
  ).rejects.toMatchObject({
    code: "AMBIGUOUS_ENTITY",
    details: { candidates: [{ id: 42 }, { id: 43 }] },
  });
  await expect(
    service.resolveContext({ product: "42" }),
  ).resolves.toMatchObject({
    data: { product: { id: 42 } },
  });
});

it("已读同名候选和分页缺口可以同时返回", async () => {
  const { service } = setup({
    "/api.php/v2/users": () => Response.json({ users: sameName, total: 4 }),
  });
  await expect(
    service.resolveContext({ people: ["同名人员"] }),
  ).rejects.toMatchObject({
    code: "AMBIGUOUS_ENTITY",
    details: {
      completeness: "partial",
      truncated: true,
      gaps: [{ source: "users" }],
      candidates: [{ account: "acct_dev_a" }, { account: "acct_dev_b" }],
    },
  });
});

it("当前用户不可读时返回带缺口的工具错误", async () => {
  const { service } = setup({
    "/api.php/v1/user": () => new Response(null, { status: 403 }),
  });
  await expect(service.resolveContext({})).rejects.toMatchObject({
    code: "PERMISSION_DENIED",
    details: { completeness: "partial", gaps: [{ source: "me" }] },
  });
});

it("完整目录内未匹配和缺日期的计划有不同结果", async () => {
  const { service } = setup({
    "/api.php/v1/products/42/plans": () =>
      Response.json({ plans: [{ ...child, begin: null }] }),
  });
  await expect(service.resolveContext({ plan: "6" })).resolves.toMatchObject({
    completeness: "partial",
    gaps: [{ source: "plans:42" }],
  });
  await expect(
    service.resolveContext({ plan: "不存在的计划" }),
  ).rejects.toMatchObject({ code: "NOT_FOUND" });
});

it("缓存读写失败时从目录返回结果，部分结果不写缓存", async () => {
  const cache = {
    get: vi.fn(async () => {
      throw new Error("offline cache");
    }),
    set: vi.fn(async () => {
      throw new Error("offline cache");
    }),
  };
  const { service } = setup(
    {
      "/api.php/v2/users": () => new Response(null, { status: 403 }),
    },
    cache,
  );
  await expect(
    service.resolveContext({ product: "42" }),
  ).resolves.toMatchObject({ completeness: "complete" });
  await expect(
    service.resolveContext({ people: ["同名人员"] }),
  ).resolves.toMatchObject({
    completeness: "partial",
    gaps: [{ source: "users" }],
  });
  expect(cache.set).toHaveBeenCalledTimes(1);
});

it("模块目录失败时，不把该模块的月计划请求改成全产品查询", async () => {
  const { service } = setup({
    "/api.php/v1/products/42": () => new Response(null, { status: 403 }),
  });
  const result = await service.resolveContext({
    product: "42",
    module: "另一个模块",
    plan: "本月",
  });
  expect(result).toMatchObject({
    completeness: "partial",
    gaps: [{ source: "modules:42" }],
    data: { product: { id: 42 } },
  });
  expect(result.data).not.toHaveProperty("plan");
});

it("按月和模块查计划时，相似的模块名不会匹配", async () => {
  const { service } = setup({
    "/api.php/v1/products/42/plans": () =>
      Response.json({
        plans: [
          { ...child, id: 11, title: "【负责人】高级权限管理-2026年12月" },
        ],
      }),
  });
  await expect(
    service.resolveContext({ product: "42", plan: "L3 12月 权限管理" }),
  ).rejects.toMatchObject({
    code: "NOT_FOUND",
  });
});
