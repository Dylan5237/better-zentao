import { expect, it } from "vitest";
import { getStoryDetail, getStoryDetailV2 } from "../../src/api/story.ts";
import {
  requirementDetailDtoFor,
  storyDtoFor,
} from "../../src/core/dto/story.ts";
import type { StoryDetail } from "../../src/core/dto/story.ts";
import { assertNoSensitiveData } from "../helpers/assert-no-sensitive-data.ts";
import { mockReadFixture } from "./read-fixture.ts";

const expected = {
  id: 11,
  product: 29,
  type: "story",
  title: "测试需求",
  status: "draft",
  executions: [{ id: 42, name: "合成执行" }],
};

function readStoryDetailWithResponse(response: Response): Promise<StoryDetail> {
  const { client, fetch } = mockReadFixture("story-detail", {
    path: "/api.php/v1/stories/11",
  });
  fetch.mockResolvedValueOnce(
    Response.json({ token: "fixture-session" }, { status: 201 }),
  );
  fetch.mockImplementation(() => Promise.resolve(response.clone()));
  return getStoryDetail(client, 11);
}

it("ADR-18 需求门面调用 v1 详情端点，只返回白名单 DTO", async () => {
  const { client, fetch } = mockReadFixture("story-detail", {
    path: "/api.php/v1/stories/4837",
  });
  const detail = await getStoryDetail(client, 4837);
  expect(fetch).toHaveBeenCalledTimes(2);
  expect(detail).toMatchObject({ id: 4837, type: "story" });
  assertNoSensitiveData(detail);
});

it("Q1 / S01 在 HTTP 边界投影 DTO，清除根层与嵌套凭据", async () => {
  const response = Response.json(
    {
      ...expected,
      id: "11",
      password: "a8d4fa71ec2d4913e40cd3216789abcd",
      users: { acct_a: { token: "synthetic" } },
      executions: [{ id: "42", name: "合成执行", secret: "synthetic" }],
      email: "synthetic@example.test",
    },
    { status: 201 },
  );

  const story = await readStoryDetailWithResponse(response);
  expect(story).toMatchObject(expected);

  const cache = new Map<number, StoryDetail>([[story.id, story]]);
  const output = {
    id: story.id,
    title: { value: story.title, untrusted: true },
  };
  assertNoSensitiveData(JSON.stringify(cache.get(story.id)));
  assertNoSensitiveData(output);
});

it("Q1 DTO 拒绝非法 ID，并只带白名单字段路径报错", async () => {
  const result = readStoryDetailWithResponse(
    Response.json({ ...expected, id: "secret-value" }),
  );
  await expect(result).rejects.toMatchObject({
    code: "ZENTAO_SCHEMA_MISMATCH",
    details: { fields: ["id"] },
  });
  await expect(result).rejects.not.toThrow("secret-value");
});

it("Q1 / S01 非法集合键不会出现在需求结构报错中", async () => {
  const secret = "synthetic-unsafe-collection-key";
  const result = readStoryDetailWithResponse(
    Response.json({
      ...expected,
      executions: { [secret]: { id: "42", name: "合成执行" } },
    }),
  );
  await expect(result).rejects.toMatchObject({
    code: "ZENTAO_SCHEMA_MISMATCH",
    details: { fields: ["executions"] },
  });
  await result.catch((error: unknown) =>
    assertNoSensitiveData(error, [secret]),
  );
});

it("Q1 / S01 不合法的计划编号只报告白名单路径", async () => {
  const secret = "synthetic-unsafe-plan-value";
  const result = readStoryDetailWithResponse(
    Response.json({ ...expected, plan: `,674,${secret},` }),
  );

  await expect(result).rejects.toMatchObject({
    code: "ZENTAO_SCHEMA_MISMATCH",
    details: { fields: ["plan"] },
  });
  await result.catch((error: unknown) =>
    assertNoSensitiveData(error, [secret]),
  );
});

it.each([
  [674, [674]],
  [0, []],
  [" ,674, 0, 675, ", [674, 675]],
] as const)(
  "Q4 计划和关联编号兼容单个数字与逗号分隔串 %s",
  async (value, ids) => {
    await expect(
      readStoryDetailWithResponse(
        Response.json({
          ...expected,
          plan: value,
          linkStories: value,
          linkRequirements: value,
        }),
      ),
    ).resolves.toMatchObject({
      plan: ids,
      linkStories: ids,
      linkRequirements: ids,
    });
  },
);

it.each([-1, 1.5, Number.MAX_SAFE_INTEGER + 1])(
  "Q4 拒绝无效的数字计划编号 %s",
  async (plan) => {
    await expect(
      readStoryDetailWithResponse(Response.json({ ...expected, plan })),
    ).rejects.toMatchObject({
      code: "ZENTAO_SCHEMA_MISMATCH",
      details: { fields: ["plan"] },
    });
  },
);

it.each([
  [new Response("sensitive raw text", { status: 502 }), "ZENTAO_UNAVAILABLE"],
  [new Response("sensitive raw text"), "ZENTAO_SCHEMA_MISMATCH"],
  [
    Response.json({ result: "fail", message: "sensitive raw text" }),
    "ZENTAO_BUSINESS_ERROR",
  ],
])("Q1 不传播 HTTP 失败的响应正文", async (response, code) => {
  const result = readStoryDetailWithResponse(response);
  await expect(result).rejects.toMatchObject({ code });
  await expect(result).rejects.not.toThrow("sensitive raw text");
});

it("Q1 缺省执行列表被规范化为空数组", async () => {
  const { executions: _executions, ...withoutExecutions } = expected;
  await expect(
    readStoryDetailWithResponse(Response.json(withoutExecutions)),
  ).resolves.toMatchObject({
    executions: [],
  });
});

it.each([
  ["error 为 null", { error: null }],
  ["message 为空串", { message: "" }],
  ["error 对象和 message 纯空白", { error: { code: 11 }, message: "  " }],
  [
    "result 为 success 且有成功提示",
    { result: "success", message: "保存成功" },
  ],
])("Q1 %s 仍是合法需求响应", async (_name, metadata) => {
  await expect(
    readStoryDetailWithResponse(Response.json({ ...expected, ...metadata })),
  ).resolves.toMatchObject(expected);
});

it.each([
  { result: "fail", error: null, message: "" },
  { error: "标题不能为空。" },
  { message: "标题不能为空。" },
])("Q1 仅有明确失败标记或非空错误文本时报业务错误 %#", async (metadata) => {
  await expect(
    readStoryDetailWithResponse(Response.json({ ...expected, ...metadata })),
  ).rejects.toHaveProperty("code", "ZENTAO_BUSINESS_ERROR");
});

it.each([
  ["error 字段校验对象", { error: { title: ["标题不能为空"] } }],
  ["message 字段校验数组", { message: ["标题不能为空"] }],
  ["error 字段校验数组", { error: ["标题不能为空"] }],
  ["message 字段校验对象", { message: { title: ["标题不能为空"] } }],
] as const)("Q1 无合法需求主体时将%s识别为业务错误", async (_name, payload) => {
  await expect(
    readStoryDetailWithResponse(Response.json(payload)),
  ).rejects.toMatchObject({
    code: "ZENTAO_BUSINESS_ERROR",
    message: "标题不能为空",
  });
});

it("Q1 空错误容器且无合法主体时报结构不匹配", async () => {
  await expect(
    readStoryDetailWithResponse(Response.json({ error: {}, message: [] })),
  ).rejects.toHaveProperty("code", "ZENTAO_SCHEMA_MISMATCH");
});

it("Q1 / S01 message 无白名单短句时继续从 error 提取", async () => {
  const secret = "synthetic-private-context";
  const result = readStoryDetailWithResponse(
    Response.json({
      result: "fail",
      message: `内部字段 ${secret}`,
      error: { title: [`标题不能为空。内部字段 ${secret}`] },
    }),
  );
  await expect(result).rejects.toMatchObject({
    code: "ZENTAO_BUSINESS_ERROR",
    message: "标题不能为空",
  });
  await result.catch((error: unknown) =>
    assertNoSensitiveData(error, [secret]),
  );
});

it("Q1 / S01 同时转述 message 和 error 中的白名单短句", async () => {
  await expect(
    readStoryDetailWithResponse(
      Response.json({
        result: "fail",
        message: ["缺少必填字段"],
        error: { title: ["标题不能为空"] },
      }),
    ),
  ).rejects.toMatchObject({
    code: "ZENTAO_BUSINESS_ERROR",
    message: "缺少必填字段。标题不能为空",
  });
});

it("Q1 / S01 转述脱敏并截断的业务 message", async () => {
  const secret = "opaque-test-value";
  const message = `标题不能为空。Cookie zentaosid=${secret}。Bearer ${secret}。a8d4fa71ec2d4913e40cd3216789abcd。${"标题不能为空。".repeat(30)}`;
  try {
    await readStoryDetailWithResponse(
      Response.json({ result: "fail", message }),
    );
    expect.unreachable();
  } catch (error) {
    expect(error).toMatchObject({
      code: "ZENTAO_BUSINESS_ERROR",
      message: expect.stringContaining("标题不能为空"),
    });
    expect(String(error)).not.toContain(message);
    expect(String(error)).toMatch(/…$/u);
    expect(String(error).length).toBeLessThanOrEqual(130);
    assertNoSensitiveData(String(error), [secret]);
    assertNoSensitiveData(error, [secret]);
  }
});

it("Q1 等待夹具确认前拒绝推测的 v2 status/data 包装", async () => {
  await expect(
    readStoryDetailWithResponse(
      Response.json({ status: "success", data: expected }),
    ),
  ).rejects.toHaveProperty("code", "ZENTAO_SCHEMA_MISMATCH");
});

it("22.6 详情 requirements 空对象占位被过滤，非空非法项仍报结构不匹配", async () => {
  await expect(
    readStoryDetailWithResponse(
      Response.json({ ...expected, requirements: [{}] }),
    ),
  ).resolves.toMatchObject({ requirements: [] });

  await expect(
    readStoryDetailWithResponse(
      Response.json({ ...expected, requirements: [{ foo: 1 }] }),
    ),
  ).rejects.toMatchObject({
    code: "ZENTAO_SCHEMA_MISMATCH",
    details: { fields: ["requirements"] },
  });
});

it("22.6 v2 需求详情兼容按类型分组的 relations 字典并补齐类型", async () => {
  const { client } = mockReadFixture("story-detail-v2", {
    path: "/api.php/v2/story/view",
  });
  const detail = await getStoryDetailV2(client, 4876);
  expect(detail.relations).toEqual([]);

  const groupedPayload = {
    story: {
      id: 4876,
      type: "requirement",
      product: 29,
      title: "用户需求",
      status: "active",
    },
    relations: {
      story: {
        "4877": { id: 4877, title: "显式类型", type: "story" },
        "4878": { id: 4878, title: "缺省类型" },
      },
    },
  };
  const parsedReq =
    requirementDetailDtoFor("Asia/Shanghai").parse(groupedPayload);
  expect(parsedReq.relations).toEqual([
    { id: 4877, title: "显式类型", type: "story" },
    { id: 4878, title: "缺省类型", type: "story" },
  ]);

  const { client: mockV2Client, fetch } = mockReadFixture("story-detail-v2", {
    path: "/api.php/v2/story/view",
  });
  fetch.mockResolvedValueOnce(
    Response.json({ token: "fixture-session" }, { status: 201 }),
  );
  fetch.mockResolvedValueOnce(
    Response.json({
      ...groupedPayload,
      story: { ...groupedPayload.story, type: "story" },
    }),
  );
  const v2Detail = await getStoryDetailV2(mockV2Client, 4876);
  expect(v2Detail.relations).toEqual([
    { id: 4877, title: "显式类型", type: "story" },
    { id: 4878, title: "缺省类型", type: "story" },
  ]);
});

it.each([
  [[], null],
  [0, null],
  ["-1", null],
  ["33", 33],
  [[33], 33],
])("WP-38 需求列表投影父 ID %j", (parent, projected) => {
  const parsed = storyDtoFor("Asia/Shanghai").parse({
    ...expected,
    parent,
    isParent: 1,
  });
  expect(parsed).toMatchObject({ parent: projected, isParent: true });
});
