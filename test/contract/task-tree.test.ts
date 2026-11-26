import { expect, it } from "vitest";
import { listExecutionTasks } from "../../src/api/task.ts";
import { mockReadFixture } from "./read-fixture.ts";

it("Q5 迭代拒绝访问后拼接了任务对象时，只报告权限失败", async () => {
  const { client, fetch } = mockReadFixture("execution-tasks");
  fetch.mockResolvedValueOnce(
    Response.json({ token: "fixture-session" }, { status: 201 }),
  );
  fetch.mockResolvedValueOnce(
    new Response(
      JSON.stringify({ status: "fail", message: "您无权访问该迭代！" }) +
        JSON.stringify({ tasks: [], total: 0 }),
    ),
  );
  await expect(listExecutionTasks(client, 189)).rejects.toMatchObject({
    code: "PERMISSION_DENIED",
  });
});

it("Q5 执行任务保留扁平父子、父任务截止日和子任务工时", async () => {
  const { client } = mockReadFixture("execution-tasks", {
    path: "/api.php/v1/executions/189/tasks",
    query: { status: "all", limit: 100, page: 1 },
  });

  const result = await listExecutionTasks(client, 189);
  expect(result.truncated).toBe(true);
  expect(result.items).toHaveLength(32);
  const parent = result.items.find(({ id }) => id === 4832);
  expect(parent).toMatchObject({
    parent: null,
    isParent: true,
    deadline: "2026-11-27",
  });
  expect(result.items[0]).toMatchObject({
    id: 4836,
    parent: 4832,
    isParent: false,
    execution: 189,
    story: 4651,
    status: "wait",
    pri: 3,
    mode: null,
    estStarted: "2026-11-23",
    deadline: "2026-11-27",
    estimate: 0,
    consumed: 0,
    left: 7,
    assignedTo: "acct_780",
  });
});

it("执行任务将实采的完成人对象投影为账号", async () => {
  const { client } = mockReadFixture("execution-tasks");
  const result = await listExecutionTasks(client, 189);
  expect(result.items.find(({ id }) => id === 4830)).toMatchObject({
    finishedBy: "acct_329",
  });
});

it("Q5 执行空页保留总数尚未取完的信号并转发状态参数", async () => {
  const { client } = mockReadFixture("execution-tasks.empty", {
    path: "/api.php/v1/executions/189/tasks",
    query: { status: "undone", limit: 100, page: 1 },
  });
  await expect(listExecutionTasks(client, 189, "undone")).resolves.toEqual({
    items: [],
    truncated: true,
  });
});
