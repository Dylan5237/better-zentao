import { expect, it } from "vitest";
import { z } from "zod";
import { decodeStoryResponse } from "../../src/api/internal/story-response.ts";
import { getStoryDetail, getStoryDetailV2 } from "../../src/api/story.ts";
import { assertNoSensitiveData } from "../helpers/assert-no-sensitive-data.ts";
import { mockReadFixture, readFixture } from "./read-fixture.ts";

it("ADR-18 内部 Response 解码入口投影真实 v1 需求", async () => {
  const { body, status } = readFixture("story-detail");

  const detail = await decodeStoryResponse(Response.json(body, { status }));

  expect(detail).toMatchObject({
    id: 4837,
    assignedTo: "acct_068",
    executions: [{ id: 189 }],
  });
  expect(Object.getOwnPropertySymbols(detail)).toHaveLength(1);
});

it("ADR-18 内部 Response 解码入口安全处理 HTTP 错误和不可读取的正文", async () => {
  const secret = "synthetic-private-context";
  const rejected = decodeStoryResponse(new Response(secret, { status: 400 }));
  await expect(rejected).rejects.toMatchObject({
    code: "ZENTAO_BUSINESS_ERROR",
    details: { status: 400 },
  });
  await rejected.catch((error: unknown) =>
    assertNoSensitiveData(error, [secret]),
  );

  const { body, status } = readFixture("story-detail");
  const response = Response.json(body, { status });
  await response.text();
  await expect(decodeStoryResponse(response)).rejects.toHaveProperty(
    "code",
    "ZENTAO_UNAVAILABLE",
  );
});

it("Q4 投影真实 v1 需求的数字键执行索引和精简任务", async () => {
  const { client } = mockReadFixture("story-detail", {
    path: "/api.php/v1/stories/4837",
  });
  const detail = await getStoryDetail(client, 4837);

  expect(detail).toMatchObject({
    id: 4837,
    assignedTo: "acct_068",
    openedBy: "acct_068",
    closedBy: null,
    lastEditedBy: "acct_068",
    openedDate: Date.parse("2026-11-23T01:51:50Z"),
    plan: [674],
    spec: "<p><span>示例文本</span></p>",
  });
  expect(detail.executions).toEqual([
    {
      id: 189,
      project: 179,
      name: "示例文本",
      status: "doing",
      type: "sprint",
    },
  ]);
  expect(detail.tasks).toEqual([
    {
      id: 4830,
      name: "示例文本",
      assignedTo: "acct_068",
      type: "devel",
      status: "done",
    },
  ]);
  expect(detail.actions).toHaveLength(7);
});

it("Q4 v2 需求从内层提取实际关联执行和任务，从外层投影数字键动作", async () => {
  const { client } = mockReadFixture("story-detail-v2", {
    path: "/api.php/v2/story/view",
    query: { storyID: 4837 },
  });

  const detail = await getStoryDetailV2(client, 4837);

  expect(detail.story).toMatchObject({
    id: 4837,
    type: "story",
    openedBy: "acct_068",
    openedDate: Date.parse("2026-11-23T01:51:50Z"),
    executions: [{ id: 189 }],
    tasks: [{ id: 4830, assignedTo: "acct_068" }],
  });
  expect(detail.story.executions).toHaveLength(1);
  expect(detail.actions).toHaveLength(7);
  expect(detail.actions).toContainEqual({
    id: 115168,
    actor: "acct_068",
    action: "opened",
    date: Date.parse("2026-11-23T01:51:50Z"),
    comment: "",
  });
  expect(detail.bugs).toEqual([]);
  expect(detail.relations).toEqual([]);
});

it("Q4 v2 动作列表同时兼容数组", async () => {
  const { client } = mockReadFixture("story-detail-v2", {
    path: "/api.php/v2/story/view",
    transform(body) {
      const view = z
        .looseObject({ actions: z.record(z.string(), z.json()) })
        .parse(body);
      return { ...view, actions: Object.values(view.actions) };
    },
  });

  const detail = await getStoryDetailV2(client, 4837);

  expect(detail.actions.map(({ id }) => id)).toEqual([
    115166, 115167, 115168, 115169, 115171, 115174, 115233,
  ]);
});
