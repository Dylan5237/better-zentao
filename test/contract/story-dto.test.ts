import { expect, it } from "vitest";
import { decodeStoryResponse } from "../../src/api/internal/story-response.ts";
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
