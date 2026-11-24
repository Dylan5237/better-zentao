import { describe, expect, it } from "vitest";
import {
  createWorkCalendar,
  deadlineEndOfDayMs,
} from "../../src/core/calendar.ts";
import type { Task } from "../../src/core/dto/task.ts";
import { taskTimeStatus, summarizeLeafWork } from "../../src/domain/task.ts";

const calendar = createWorkCalendar({
  holidays: ["2026-11-30"],
  extraWorkdays: ["2026-11-29"],
});
const time = { today: "2026-11-27", calendar };

describe("docs/04 §4.2 时间状态", () => {
  it.each([
    ["pause", "2026-11-26", "overdue"],
    ["changed", "2026-11-26", "overdue"],
    ["wait", "2026-11-27", "due_today"],
    ["doing", "2026-12-02", "due_soon"],
    ["doing", "2026-12-03", "normal"],
    ["wait", null, "unscheduled"],
    ["doing", "0000-00-00", "unscheduled"],
    ["doing", "2026-02-30", "unscheduled"],
    ["done", null, "completed"],
    ["closed", "2026-11-26", "completed"],
    ["cancel", "2026-11-26", "completed"],
  ] as const)("任务 %s 截止 %s → %s", (status, deadline, expected) => {
    expect(taskTimeStatus({ status, deadline }, time)).toEqual({
      status: expected,
      historicallyLate: false,
    });
  });

  it("历史延期按业务时区截止日最后一秒计算，支持零天临期阈值", () => {
    const deadline = "2026-11-26";
    const end = deadlineEndOfDayMs(deadline, "America/New_York");
    const options = { ...time, timezone: "America/New_York" };
    expect(
      taskTimeStatus({ status: "done", deadline, finishedDate: end }, options)
        .historicallyLate,
    ).toBe(false);
    expect(
      taskTimeStatus(
        { status: "closed", deadline, finishedDate: end + 1 },
        options,
      ).historicallyLate,
    ).toBe(true);
    expect(
      taskTimeStatus(
        { status: "cancel", deadline, finishedDate: end + 1 },
        options,
      ).historicallyLate,
    ).toBe(true);
    expect(
      taskTimeStatus(
        { status: "wait", deadline: "2026-11-28" },
        { ...time, dueSoonWorkdays: 0 },
      ).status,
    ).toBe("normal");
  });
});

function task(id: number, fields: Partial<Task> = {}) {
  return {
    id,
    parent: null,
    isParent: false,
    status: "doing",
    deadline: "2026-11-26",
    mode: null,
    assignedTo: "li",
    ...fields,
  } satisfies Pick<
    Task,
    "id" | "parent" | "isParent" | "status" | "deadline" | "mode" | "assignedTo"
  >;
}

describe("docs/04 §4.3 父子与多人任务", () => {
  it("去重、按账号查姓名且区分任务数与人次，单列父级风险", () => {
    const linear = task(3, { mode: "linear", assignedTo: "wang" });
    const summary = summarizeLeafWork(
      [
        task(1, { isParent: true }),
        task(2, { parent: 1, status: "done" }),
        linear,
        linear,
        {
          ...task(4, { mode: "multi" }),
          team: [
            { account: "li", status: "doing" },
            { account: "wang", status: "pause" },
            { account: "wang", status: "pause" },
            { account: "ignored", status: "done" },
          ],
        },
        task(5, { status: "doing", deadline: null, mode: "single" }),
        task(6, { assignedTo: null, deadline: null }),
        task(7, { isParent: true, deadline: null, status: "closed" }),
        task(8, { parent: 7, status: "cancel" }),
      ],
      { ...time, directory: new Map([["wang", "王"]]) },
    );
    expect(summary).toMatchObject({
      completeness: "complete",
      gaps: [],
      overdueTaskCount: 2,
      workload: { taskCount: 3, assignments: 4 },
      parentRisks: [{ taskId: 1, allChildrenFinished: true }],
    });
    expect(
      summary.leaves.find((leaf) => leaf.taskId === 3)?.participants,
    ).toEqual([{ account: "wang", name: "王", active: true }]);
    expect(
      summary.leaves.find((leaf) => leaf.taskId === 4)?.participants,
    ).toEqual([
      { account: "li", name: undefined, active: true },
      { account: "wang", name: "王", active: true },
      { account: "ignored", name: undefined, active: false },
    ]);
  });

  it("子任务或成员状态缺失时保留可见证据，省略不完整的精确计数", () => {
    const summary = summarizeLeafWork(
      [
        task(1, { isParent: true }),
        {
          ...task(2, { mode: "multi" }),
          team: [{ account: "li", status: null }, { account: "wang" }],
        },
        task(3, { mode: "multi" }),
        { ...task(4, { mode: "multi", status: "closed" }), team: [] },
      ],
      time,
    );
    expect(summary).toMatchObject({
      completeness: "partial",
      gaps: [
        { kind: "children", taskId: 1 },
        { kind: "team", taskId: 2 },
        { kind: "team", taskId: 3 },
      ],
      overdueTaskCount: null,
      workload: null,
      parentRisks: [{ taskId: 1, allChildrenFinished: null }],
    });
    expect(summary.leaves[0]?.participants).toEqual([
      { account: "li", name: undefined, active: null },
      { account: "wang", name: undefined, active: null },
    ]);
    expect(summary.leaves[1]?.participants).toEqual([
      { account: "li", name: undefined, active: null },
    ]);
  });

  it("循环父子关系无法确认后代都已完成", () => {
    const summary = summarizeLeafWork(
      [
        task(1, { parent: 2, isParent: true }),
        task(2, { parent: 1, isParent: true }),
      ],
      time,
    );
    expect(summary.parentRisks).toEqual([
      { taskId: 1, allChildrenFinished: null },
      { taskId: 2, allChildrenFinished: null },
    ]);
  });

  it("已知父子关系优先于父标志，分页缺口不发布精确总数", () => {
    const summary = summarizeLeafWork([task(1), task(2, { parent: 1 })], {
      ...time,
      tasksComplete: false,
    });
    expect(summary).toMatchObject({
      completeness: "partial",
      gaps: [{ kind: "task_list" }],
      overdueTaskCount: null,
      workload: null,
      parentRisks: [{ taskId: 1, allChildrenFinished: null }],
    });
    expect(summary.leaves.map(({ taskId }) => taskId)).toEqual([2]);
    expect(
      summarizeLeafWork([task(1), task(2, { parent: 1 })], time).parentRisks,
    ).toEqual([{ taskId: 1, allChildrenFinished: false }]);
    expect(
      summarizeLeafWork([task(3, { mode: "multi" })], time).overdueTaskCount,
    ).toBe(1);
  });
});

it("嵌套父级只按后代叶子判断，忽略已删除的任务", () => {
  const summary = summarizeLeafWork(
    [
      task(1, { isParent: true }),
      task(2, { parent: 1, isParent: true }),
      task(3, { parent: 2, mode: "multi", status: "closed", deadline: null }),
      {
        ...task(4, { mode: "multi", status: "done", deadline: null }),
        team: [{ account: "li", status: null }],
      },
      task(5, { parent: 1, deleted: true }),
      task(6, { mode: "multi", assignedTo: null }),
      task(7, { parent: 2, status: "closed" }),
    ],
    time,
  );
  expect(summary.leaves.map(({ taskId }) => taskId)).toEqual([3, 4, 6, 7]);
  expect(summary.leaves[0]?.participants).toEqual([
    { account: "li", name: undefined, active: false },
  ]);
  expect(summary.leaves[1]?.participants).toEqual([
    { account: "li", name: undefined, active: false },
  ]);
  expect(summary.leaves[2]?.participants).toEqual([]);
  expect(summary.parentRisks).toEqual([
    { taskId: 1, allChildrenFinished: true },
    { taskId: 2, allChildrenFinished: true },
  ]);
  expect(summary.gaps).toEqual([{ kind: "team", taskId: 6 }]);
});
