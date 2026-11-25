import { describe, expect, it } from "vitest";
import { createWorkCalendar } from "../../src/core/calendar.ts";
import {
  classifyMonthlyDevQueue,
  compareCommitmentSnapshot,
  summarizePlan,
  type PlanStory,
} from "../../src/domain/plan-summary.ts";

function story(
  id: number,
  progress: PlanStory["progress"],
  fields: Partial<PlanStory> = {},
): PlanStory {
  return { id, progress, tasks: [], ...fields };
}

const task = (id: number, status: PlanStory["tasks"][number]["status"]) => ({
  id,
  status,
  parent: null,
  isParent: false,
});

describe("docs/04 §4.7 L3 汇总（AC-60/61）", () => {
  const stories = [
    story(1, "已完成", {
      owner: "pm",
      module: 10,
      tasks: [
        task(1, "wait"),
        { ...task(2, "done"), parent: 1 },
        task(2, "done"),
        task(3, "closed"),
        { ...task(4, "closed"), closedReason: "cancel" },
        { ...task(5, "wait"), deleted: true },
        { ...task(6, "done"), isParent: true },
      ],
    }),
    story(1, "待接收", { owner: "other" }),
    story(2, "研发中", { module: 10, tasks: [task(7, "doing")] }),
    story(3, "待接收"),
    story(4, "未就绪"),
    story(5, "已取消"),
    story(6, "已关闭·证据缺失"),
    story(7, "已完成"),
    story(8, "已完成", { tasks: [task(8, "cancel")] }),
    story(9, "已完成", { planKind: "legacyRelease", tasks: [task(9, "done")] }),
  ];

  it("去重、排除存量版本计划、只按未取消叶子统计任务并分别给出分母", () => {
    expect(summarizePlan(stories, "2026-11-25", "owner")).toMatchObject({
      asOf: "2026-11-25",
      total: 8,
      counts: {
        completed: 1,
        inProgress: 1,
        toReceive: 1,
        notReady: 1,
        cancelled: 1,
        unknown: 3,
      },
      storyDeliveryRate: { numerator: 1, denominator: 7, rate: 1 / 7 },
      taskCompletionRate: { numerator: 2, denominator: 3, rate: 2 / 3 },
      groups: [
        { key: "pm", total: 1, counts: { completed: 1 } },
        { key: null, total: 7 },
      ],
    });
  });

  it("支持模块和汇总进展分组，保留可关闭到正式关闭的差别", () => {
    expect(summarizePlan(stories, "2026-11-25", "module").groups).toMatchObject(
      [
        { key: 10, total: 2 },
        { key: null, total: 6 },
      ],
    );
    const running = ["待测试", "测试中", "待验收", "待交付", "可关闭"] as const;
    expect(
      summarizePlan(
        running.map((state, id) => story(id, state)),
        "2026-11-25",
        "progress",
      ).groups,
    ).toMatchObject([
      { key: "inProgress", total: 5, counts: { completed: 0 } },
    ]);
  });

  it("全取消时分母为零，任务无有效分母时比率为空", () => {
    expect(summarizePlan([story(5, "已取消")], "2026-11-25")).toMatchObject({
      storyDeliveryRate: { numerator: 0, denominator: 0, rate: null },
      taskCompletionRate: { numerator: 0, denominator: 0, rate: null },
    });
  });

  it("汇总只计叶子需求，父需求已关闭也不抬高交付率", () => {
    expect(
      summarizePlan(
        [
          story(1, "已完成", {
            children: [{ id: 2 }],
            tasks: [task(1, "done")],
          }),
          story(2, "研发中", { children: [], tasks: [task(2, "wait")] }),
        ],
        "2026-11-25",
      ),
    ).toMatchObject({
      total: 1,
      storyDeliveryRate: { numerator: 0, denominator: 1 },
      taskCompletionRate: { numerator: 0, denominator: 1 },
    });
  });
});

describe("docs/04 §4.6 本月研发队列（AC-54）", () => {
  const calendar = createWorkCalendar({ holidays: ["2026-11-30"] });
  const monthly = {
    month: "2026-11",
    today: "2026-11-19",
    calendar,
    planStoryIds: [1, 2, 3, 4, 6, 7, 8, 10],
    iterationStoryIds: [1, 2, 3, 5, 6, 7, 8, 9, 10],
    previousSnapshotStoryIds: [1, 3, 3, 11, 12],
    stories: [
      story(1, "待接收"),
      story(2, "研发中", { tasks: [task(21, "wait"), task(22, "wait")] }),
      story(3, "待交付"),
      story(4, "已关闭·证据缺失"),
      story(5, "待验收"),
      story(6, "未就绪"),
      story(7, "已完成"),
      story(8, "测试中", { tasks: [task(81, "wait"), task(82, "doing")] }),
      story(9, "待验收", { planKind: "l3" }),
      story(10, "待测试", {
        tasks: [task(101, "wait"), { ...task(102, "done"), isParent: true }],
      }),
      story(11, "待验收"),
      story(12, "已取消"),
    ],
  };
  const ids = (rows: readonly { id: number }[]) => rows.map(({ id }) => id);

  it("五桶互斥，遗留标记与跨月需求不抬高主池计数", () => {
    const {
      buckets,
      notReady,
      mainPoolIds,
      unbucketedStoryIds,
      carryOverSource,
    } = classifyMonthlyDevQueue(monthly);
    expect(carryOverSource).toBe("snapshot");
    expect(buckets.toReceive).toMatchObject([{ id: 1, carriedOver: true }]);
    expect(ids(buckets.inDev)).toEqual([2, 8, 10]);
    expect(ids(buckets.carriedOver)).toEqual([3, 11]);
    expect(ids(buckets.planNoIteration)).toEqual([4]);
    expect(ids(buckets.iterationNoPlan)).toEqual([5]);
    expect(ids(notReady)).toEqual([6]);
    expect(unbucketedStoryIds).toEqual([7, 9]);
    const bucketIds = Object.values(buckets).flatMap(ids);
    expect(bucketIds).toHaveLength(new Set(bucketIds).size);
    expect(
      new Set([
        ...bucketIds.filter((id) => id !== 11),
        ...ids(notReady),
        ...unbucketedStoryIds,
      ]),
    ).toEqual(new Set(mainPoolIds));
    expect(mainPoolIds).toHaveLength(10);
  });

  it("只在最后七个工作日的窗口标出未拆解或阶段均未开始的需求", () => {
    expect(ids(classifyMonthlyDevQueue(monthly).monthEndWarnings)).toEqual([
      1, 2, 10,
    ]);
    for (const today of ["2026-11-18", "2026-12-01"])
      expect(
        classifyMonthlyDevQueue({ ...monthly, today }).monthEndWarnings,
      ).toEqual([]);
  });

  it("月底预警跳过取消的叶子，在研需求须有至少一个有效叶子", () => {
    const result = classifyMonthlyDevQueue({
      ...monthly,
      planStoryIds: [1, 2, 3, 4],
      iterationStoryIds: [1, 2, 3, 4],
      previousSnapshotStoryIds: [],
      stories: [
        story(1, "待接收", { tasks: [task(11, "cancel")] }),
        story(2, "研发中", {
          tasks: [
            task(21, "wait"),
            task(22, "cancel"),
            { ...task(23, "closed"), closedReason: "cancel" },
          ],
        }),
        story(3, "研发中", { tasks: [task(31, "cancel")] }),
        story(4, "待接收", { tasks: [task(41, "doing")] }),
      ],
    });
    expect(ids(result.monthEndWarnings)).toEqual([1, 2]);
  });

  it("保留结构缺口标记与主桶互斥，已完成和已取消需求仅保留在主池", () => {
    const result = classifyMonthlyDevQueue({
      ...monthly,
      planStoryIds: [1, 3, 4],
      iterationStoryIds: [2, 5, 6, 7],
      previousSnapshotStoryIds: [],
      stories: [
        story(1, "待接收"),
        story(2, "研发中", { planKind: "legacyRelease" }),
        story(3, "已完成"),
        story(4, "已取消"),
        story(5, "已完成"),
        story(6, "已取消"),
        story(7, "研发中", { planKind: "l3" }),
      ],
    });
    expect(result).toMatchObject({
      buckets: {
        toReceive: [{ id: 1, planNoIteration: true, iterationNoPlan: false }],
        inDev: [
          { id: 2, planNoIteration: false, iterationNoPlan: true },
          { id: 7, planNoIteration: false, iterationNoPlan: false },
        ],
        planNoIteration: [],
        iterationNoPlan: [],
      },
      unbucketedStoryIds: [3, 4, 5, 6],
      mainPoolIds: [1, 3, 4, 2, 5, 6, 7],
    });
  });

  it("缺快照时使用已还原的遗留 ID，有空快照时保留真实空集合", () => {
    const { previousSnapshotStoryIds: _, ...noSnapshot } = monthly;
    expect(classifyMonthlyDevQueue(noSnapshot).carryOverSource).toBeNull();
    const restored = { ...noSnapshot, historyCarryOverStoryIds: [2] };
    expect(classifyMonthlyDevQueue(restored)).toMatchObject({
      carryOverSource: "history",
      buckets: { inDev: [{ id: 2, carriedOver: true }, { id: 8 }, { id: 10 }] },
    });
    expect(
      classifyMonthlyDevQueue({ ...restored, previousSnapshotStoryIds: [] }),
    ).toMatchObject({
      carryOverSource: "snapshot",
      buckets: { carriedOver: [] },
    });
  });

  it("主池和上月快照引用的需求未读到时回传缺口", () => {
    expect(
      classifyMonthlyDevQueue({
        ...monthly,
        planStoryIds: [...monthly.planStoryIds, 100],
        previousSnapshotStoryIds: [101],
      }).missingStoryIds,
    ).toEqual([100, 101]);
  });
});

describe("docs/03 N13 承诺快照（AC-65）", () => {
  const current = [
    { id: 1, progress: "已完成", inCurrentMonth: true },
    { id: 2, progress: "研发中", inCurrentMonth: false },
    { id: 3, progress: "待接收", inCurrentMonth: true },
    { id: 4, progress: "测试中", inCurrentMonth: true },
    { id: 5, progress: "研发中", inCurrentMonth: false },
    { id: 8, progress: "已取消", inCurrentMonth: true },
    { id: 9, progress: "无法判断", inCurrentMonth: true },
  ] as const;

  it("以挪月记录或现有归属比较顺延，待完成、取消与证据缺口分别保留", () => {
    expect(
      compareCommitmentSnapshot(
        [1, 2, 2, 4, 5, 6, 7, 8, 9],
        current,
        new Map([
          [2, "等接口"],
          [6, "挪至下月"],
        ]),
      ),
    ).toEqual({
      snapshotAvailable: true,
      fulfilled: [1],
      carriedOver: [
        { id: 2, reason: "等接口" },
        { id: 5, reason: null },
        { id: 6, reason: "挪至下月" },
      ],
      inserted: [3],
      pendingStoryIds: [4],
      cancelledStoryIds: [8],
      unknownStoryIds: [7, 9],
    });
  });

  it("区分缺快照与存在但为空的快照", () => {
    expect(compareCommitmentSnapshot(undefined, current)).toEqual({
      snapshotAvailable: false,
    });
    expect(compareCommitmentSnapshot([], current)).toMatchObject({
      snapshotAvailable: true,
      inserted: [1, 3, 4, 8, 9],
    });
  });

  it("去除挪月原因首尾空白，空原因不作为挪月证据", () => {
    expect(
      compareCommitmentSnapshot(
        [1, 2, 5],
        current,
        new Map([
          [1, " \t "],
          [2, " 等接口 "],
          [5, ""],
        ]),
      ),
    ).toMatchObject({
      fulfilled: [1],
      carriedOver: [
        { id: 2, reason: "等接口" },
        { id: 5, reason: null },
      ],
    });
  });
});
