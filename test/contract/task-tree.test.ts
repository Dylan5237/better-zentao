import { expect, it } from "vitest";
import { listExecutionTasks } from "../../src/api/task.ts";
import { mockReadFixture } from "./read-fixture.ts";

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
    mode: null,
    estStarted: "2026-11-23",
    deadline: "2026-11-27",
    estimate: 0,
    consumed: 0,
    left: 7,
    assignedTo: "acct_780",
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
