import { expect, it } from "vitest";
import { z } from "zod";
import { listExecutionTasks } from "../../src/api/task.ts";
import { assertNoSensitiveData } from "../helpers/assert-no-sensitive-data.ts";
import { mockReadFixture } from "./read-fixture.ts";

const fixturePage = z.looseObject({ tasks: z.array(z.looseObject({})) });
const statuses = [
  "wait",
  "doing",
  "pause",
  "changed",
  "done",
  "closed",
  "cancel",
];

it("Q7 同一执行保留 wait、doing、pause、changed、done、closed、cancel 七态", async () => {
  const { client } = mockReadFixture("execution-tasks", {
    transform(body) {
      const page = fixturePage.parse(body);
      return {
        ...page,
        total: statuses.length,
        tasks: page.tasks.slice(0, statuses.length).map((task, index) => ({
          ...task,
          status: statuses[index],
        })),
      };
    },
  });
  const result = await listExecutionTasks(client, 189);
  expect(result.items.map(({ status }) => status)).toEqual(statuses);
  expect(result.truncated).toBe(false);
});

it("Q7 非法任务状态报结构错且不回显原始值", async () => {
  const secret = "opaque-status-value";
  const { client } = mockReadFixture("execution-tasks", {
    transform(body) {
      const page = fixturePage.parse(body);
      return { ...page, tasks: [{ ...page.tasks[0], status: secret }] };
    },
  });
  const result = listExecutionTasks(client, 189);
  await expect(result).rejects.toMatchObject({
    code: "ZENTAO_SCHEMA_MISMATCH",
    details: { fields: ["tasks"] },
  });
  await result.catch((error: unknown) =>
    assertNoSensitiveData(error, [secret]),
  );
});

it("执行任务拒绝无效查询状态且不会发请求", async () => {
  const { client, fetch } = mockReadFixture("execution-tasks");
  // @ts-expect-error closed 是任务状态，禅道执行任务查询不接受它。
  const result = listExecutionTasks(client, 189, "closed");
  await expect(result).rejects.toHaveProperty("code", "INVALID_INPUT");
  expect(fetch).not.toHaveBeenCalled();
});
