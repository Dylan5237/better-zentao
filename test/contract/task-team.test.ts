import { expect, it } from "vitest";
import { z } from "zod";
import { getTaskDetail } from "../../src/api/task.ts";
import { assertNoSensitiveData } from "../helpers/assert-no-sensitive-data.ts";
import { mockReadFixture, readFixture } from "./read-fixture.ts";

it("Q6 多人串行任务保留账号、工时、状态与顺位", async () => {
  const { client } = mockReadFixture("task-detail", {
    path: "/api.php/v1/tasks/4324",
    query: {},
  });

  const detail = await getTaskDetail(client, 4324);
  expect(detail).toMatchObject({
    id: 4324,
    assignedTo: "acct_076",
    mode: "linear",
    estimate: 22,
    story: null,
    children: [],
    actions: [
      {
        id: 105176,
        actor: "acct_2100",
        action: "opened",
        date: Date.parse("2026-11-10T12:12:59Z"),
      },
    ],
  });
  expect(detail.team).toEqual([
    {
      account: "acct_076",
      estimate: 11,
      consumed: 0,
      left: 11,
      status: "wait",
      order: 1,
    },
    {
      account: "acct_2067",
      estimate: 11,
      consumed: 0,
      left: 11,
      status: "wait",
      order: 2,
    },
  ]);
  expect(detail).not.toHaveProperty("members");
  assertNoSensitiveData(detail);
});

it("任务详情逐层投影团队、动作和子任务", async () => {
  const row = z.looseObject({});
  const taskFixture = z.object({ tasks: z.array(row).nonempty() });
  const task = taskFixture.parse(readFixture("execution-tasks").body).tasks[0];
  const detailFixture = z.looseObject({
    team: z.array(row),
    actions: z.array(row),
  });
  const secret = "opaque-nested-task-value";
  const { client } = mockReadFixture("task-detail", {
    transform(body) {
      const detail = detailFixture.parse(body);
      return {
        ...detail,
        children: [{ ...task, apiToken: secret }],
        team: detail.team.map((member) => ({ ...member, mobile: secret })),
        actions: detail.actions.map((action) => ({
          ...action,
          password: secret,
        })),
      };
    },
  });

  const detail = await getTaskDetail(client, 4324);
  expect(detail.children).toMatchObject([
    { id: 4836, parent: 4832, isParent: false },
  ]);
  assertNoSensitiveData(detail, [secret]);
  for (const item of [...detail.children, ...detail.team, ...detail.actions]) {
    expect(Object.getOwnPropertySymbols(item)).toHaveLength(1);
    expect(Object.getOwnPropertySymbols({ ...item })).toHaveLength(0);
  }
});
