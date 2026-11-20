import { expect, it, vi } from "vitest";
import * as internalStory from "../../src/api/internal/story-response.ts";
import { decodeStoryResponse } from "../../src/api/internal/story-response.ts";
import { getStoryDetail } from "../../src/api/story.ts";
import type { StoryDetail } from "../../src/core/dto/story.ts";
import { assertNoSensitiveData } from "../helpers/assert-no-sensitive-data.ts";

const expected = {
  id: 11,
  product: 29,
  type: "story",
  title: "测试需求",
  status: "draft",
  executions: [{ id: 42, name: "合成执行" }],
};

it("ADR-18 需求门面调用内部读取与解码，只返回白名单 DTO", async () => {
  const transport = vi.spyOn(internalStory, "readStoryResponse");
  try {
    transport.mockResolvedValueOnce(
      Response.json({ ...expected, apiToken: "synthetic" }),
    );
    const detail = await getStoryDetail(11);
    expect(transport).toHaveBeenCalledExactlyOnceWith(11);
    expect(detail).toEqual(expected);
    assertNoSensitiveData(detail);
  } finally {
    transport.mockRestore();
  }
});

it("WP-04 需求门面的离线读取桩保持断开", async () => {
  await expect(getStoryDetail(11)).rejects.toHaveProperty(
    "code",
    "ZENTAO_UNAVAILABLE",
  );
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

  const story = await decodeStoryResponse(response);
  expect(story).toEqual(expected);

  const cache = new Map<number, StoryDetail>([[story.id, story]]);
  const output = {
    id: story.id,
    title: { value: story.title, untrusted: true },
  };
  assertNoSensitiveData(JSON.stringify(cache.get(story.id)));
  assertNoSensitiveData(output);
});

it("Q1 DTO 拒绝非法 ID，并只带白名单字段路径报错", async () => {
  const result = decodeStoryResponse(
    Response.json({ ...expected, id: "secret-value" }),
  );
  await expect(result).rejects.toMatchObject({
    code: "ZENTAO_SCHEMA_MISMATCH",
    details: { fields: ["id"] },
  });
  await expect(result).rejects.not.toThrow("secret-value");
});

it.each([
  [new Response("sensitive raw text", { status: 502 }), "ZENTAO_UNAVAILABLE"],
  [new Response("sensitive raw text"), "ZENTAO_SCHEMA_MISMATCH"],
  [
    Response.json({ result: "fail", message: "sensitive raw text" }),
    "ZENTAO_BUSINESS_ERROR",
  ],
])("Q1 不传播 HTTP 失败的响应正文", async (response, code) => {
  const result = decodeStoryResponse(response);
  await expect(result).rejects.toMatchObject({ code });
  await expect(result).rejects.not.toThrow("sensitive raw text");
});

it("Q1 缺省执行列表被规范化为空数组", async () => {
  const { executions: _executions, ...withoutExecutions } = expected;
  await expect(
    decodeStoryResponse(Response.json(withoutExecutions)),
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
    decodeStoryResponse(Response.json({ ...expected, ...metadata })),
  ).resolves.toEqual(expected);
});

it.each([
  { result: "fail", error: null, message: "" },
  { error: "标题不能为空。" },
  { message: "标题不能为空。" },
])("Q1 仅有明确失败标记或非空错误文本时报业务错误 %#", async (metadata) => {
  await expect(
    decodeStoryResponse(Response.json({ ...expected, ...metadata })),
  ).rejects.toHaveProperty("code", "ZENTAO_BUSINESS_ERROR");
});

it.each([
  ["error 字段校验对象", { error: { title: ["标题不能为空"] } }],
  ["message 字段校验数组", { message: ["标题不能为空"] }],
  ["error 字段校验数组", { error: ["标题不能为空"] }],
  ["message 字段校验对象", { message: { title: ["标题不能为空"] } }],
] as const)("Q1 无合法需求主体时将%s识别为业务错误", async (_name, payload) => {
  await expect(
    decodeStoryResponse(Response.json(payload)),
  ).rejects.toMatchObject({
    code: "ZENTAO_BUSINESS_ERROR",
    message: "标题不能为空",
  });
});

it("Q1 空错误容器且无合法主体时报结构不匹配", async () => {
  await expect(
    decodeStoryResponse(Response.json({ error: {}, message: [] })),
  ).rejects.toHaveProperty("code", "ZENTAO_SCHEMA_MISMATCH");
});

it("Q1 / S01 message 无白名单短句时继续从 error 提取", async () => {
  const secret = "synthetic-private-context";
  const result = decodeStoryResponse(
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
    decodeStoryResponse(
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
    await decodeStoryResponse(Response.json({ result: "fail", message }));
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
    decodeStoryResponse(Response.json({ status: "success", data: expected })),
  ).rejects.toHaveProperty("code", "ZENTAO_SCHEMA_MISMATCH");
});
