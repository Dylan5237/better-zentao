import { expect } from "vitest";
import {
  createWorkCalendar,
  deadlineEndOfDayMs,
} from "../../src/core/calendar.ts";
import {
  evaluateRules,
  type RuleContext,
  type RuleId,
  type RuleInput,
} from "../../src/rules/index.ts";

type RuleCase = (
  rule: RuleId,
  category: "hit" | "non-hit" | "boundary",
  name: string,
  check: () => void,
) => void;

const context: RuleContext = {
  today: "2026-11-25",
  calendar: createWorkCalendar({
    holidays: ["2026-11-23"],
    extraWorkdays: ["2026-11-22"],
  }),
};
const started = deadlineEndOfDayMs("2026-11-20");
const story = { id: 1, status: "active", category: "feature" };
const task = {
  id: 2,
  status: "done",
  name: "【研发】实现",
  story: 1,
  deadline: null,
  isParent: false,
  parent: null,
  mode: "single",
  finishedDate: started,
} as const;
const test = { ...task, id: 3, name: "【测试】验证" };
const acceptance = { ...task, id: 4, name: "【验收】验收" };
const designStory = { ...story, category: "design" };
const completedDesign = [
  { ...task, id: 4, name: "【评审】设计评审" },
  { ...task, id: 5, name: "【传递】传递设计" },
];
const enabled = (id: RuleId) =>
  new Set<RuleId>(
    Array.from(
      { length: 14 },
      (_, index) => ("R" + String(index + 1).padStart(2, "0")) as RuleId,
    ).filter((candidate) => candidate !== id),
  );

function hits(
  id: RuleId,
  input: RuleInput,
  overrides: Partial<RuleContext> = {},
) {
  return evaluateRules(input, {
    ...context,
    ...overrides,
    disabledRules: enabled(id),
  }).hits;
}

const configured = { workdays: 3, source: "configured" } as const;
const requirement = { id: 7, openedDate: started };
const bug = { id: 8, status: "active", severity: 3, story: 1, execution: null };
const releaseStory = {
  ...story,
  product: 29,
  keywords: "版本:V1",
  progress: "测试中",
  tasks: [test],
  stages: {},
  bugs: [],
} as const;
const release = {
  product: 29,
  version: "V1",
  releases: [{ product: 29, name: "V1", date: "2026-11-30" }],
  stories: [releaseStory],
};
const old = deadlineEndOfDayMs("2026-10-25");
const r14Task = { ...task, lastEditedDate: old };
const structureContext = { systemStartDate: "2026-11-20" };

export function registerP2Cases(ruleCase: RuleCase) {
  ruleCase("R06", "hit", "集中报告同一对象的结构违规", () => {
    expect(
      hits(
        "R06",
        {
          story: { ...story, openedDate: started },
          plan: {
            kind: "legacyRelease",
            begin: "2026-11-01",
            end: "2026-11-30",
          },
          tasks: [
            task,
            {
              ...task,
              id: 9,
              story: null,
              mode: "linear",
              openedDate: started,
            },
          ],
        },
        structureContext,
      ),
    ).toMatchObject([
      {
        objectType: "story",
        objectId: 1,
        severity: "medium",
        evidence: [
          "研发需求未挂 L3 计划",
          "已拆解的研发需求缺少必需阶段：测试、验收",
        ],
      },
      {
        objectType: "task",
        objectId: 9,
        since: "2026-11-20",
        evidence: ["任务未关联需求", "系统上线后新建了多人任务"],
      },
    ]);
  });
  ruleCase("R06", "non-hit", "区分未拆解、读取不完整和明确挂 L3", () => {
    const input = { story: { ...story, openedDate: started }, hasL3Plan: true };
    expect(hits("R06", input, structureContext)).toEqual([]);
    expect(
      hits(
        "R06",
        { ...input, tasks: [task], tasksComplete: false },
        structureContext,
      ),
    ).toEqual([]);
    expect(
      hits(
        "R06",
        {
          ...input,
          tasks: [task],
          required: { test: false, acceptance: false },
        },
        structureContext,
      ),
    ).toEqual([]);
    expect(
      hits(
        "R06",
        {
          story: { ...story, status: "draft" },
          hasL3Plan: false,
          tasks: [{ ...task, deleted: true, story: null }],
        },
        structureContext,
      ),
    ).toEqual([]);
  });
  ruleCase("R06", "boundary", "仅从上线当天起严格检查多人任务和缺阶段", () => {
    const before = started - 86_400_000;
    const input = {
      story: { ...story, openedDate: before },
      tasks: [{ ...task, mode: "multi" as const, openedDate: before }],
    };
    expect(hits("R06", input, structureContext)).toEqual([]);
    const newInput = {
      story: { ...story, openedDate: started },
      tasks: [{ ...task, mode: "multi" as const, openedDate: started }],
    };
    expect(hits("R06", newInput)).toEqual([]);
    expect(hits("R06", newInput, structureContext)).toHaveLength(2);
    expect(hits("R06", { story, plan: null })).toMatchObject([
      { since: null, state: "gap" },
    ]);
    expect(hits("R06", { story: { ...story, plan: [] } })).toHaveLength(1);
    expect(hits("R06", { story: { ...story, plan: [29] } })).toEqual([]);
  });

  ruleCase("R07", "hit", "评审和传递均完成后以较晚的完成日计时", () => {
    expect(
      hits(
        "R07",
        {
          story: designStory,
          tasks: [
            ...completedDesign,
            {
              ...task,
              id: 6,
              name: "【传递】补充",
              finishedDate: deadlineEndOfDayMs("2026-11-22"),
            },
          ],
          linkedStories: [],
        },
        { today: "2026-11-26" },
      ),
    ).toMatchObject([
      {
        since: "2026-11-22",
        state: "stalled",
        confidence: "inferred",
        threshold: { workdays: 2, source: "default" },
      },
    ]);
  });
  ruleCase("R07", "non-hit", "关系未读取或已有关联研发需求时不提示", () => {
    const input = { story: designStory, tasks: completedDesign };
    expect(hits("R07", input)).toEqual([]);
    for (const relation of ["derives", "pairs"] as const)
      expect(
        hits("R07", { ...input, linkedStories: [{ ...story, relation }] }),
      ).toEqual([]);
    expect(
      hits("R07", {
        ...input,
        tasks: completedDesign.slice(0, 1),
        linkedStories: [],
      }),
    ).toEqual([]);
    expect(
      hits("R07", { ...input, tasksComplete: false, linkedStories: [] }),
    ).toEqual([]);
  });
  ruleCase(
    "R07",
    "boundary",
    "调休计入工作日，未拿到两段实际完成日只报缺口",
    () => {
      const input = {
        story: designStory,
        tasks: completedDesign,
        linkedStories: [],
      };
      expect(hits("R07", input, { today: "2026-11-24" })).toMatchObject([
        { state: "gap" },
      ]);
      expect(
        hits("R07", input, { thresholds: { R07: { after: configured } } }),
      ).toMatchObject([{ state: "gap", threshold: configured }]);
      expect(
        hits("R07", {
          ...input,
          tasks: completedDesign.map((row) => ({ ...row, finishedDate: null })),
        }),
      ).toMatchObject([
        {
          state: "gap",
          since: null,
          evidence: expect.arrayContaining(["起点未知"]),
        },
      ]);
    },
  );

  ruleCase("R08", "hit", "独立报告未关联研发需求的用户需求", () => {
    expect(
      hits("R08", { requirement, linkedStories: [] }, { today: "2026-11-30" }),
    ).toMatchObject([
      {
        objectType: "requirement",
        objectId: 7,
        severity: "low",
        state: "stalled",
        threshold: { workdays: 5, source: "default" },
      },
    ]);
    expect(
      hits("R08", {
        requirement,
        linkedStories: [
          { ...story, category: "design" },
          { ...story, deleted: true },
        ],
      }),
    ).toHaveLength(1);
  });
  ruleCase("R08", "non-hit", "已关联研发需求、关系未知或已删除时不提示", () => {
    expect(hits("R08", { requirement, linkedStories: [story] })).toEqual([]);
    expect(hits("R08", { requirement })).toEqual([]);
    expect(
      hits("R08", {
        requirement: { ...requirement, deleted: true },
        linkedStories: [],
      }),
    ).toEqual([]);
  });
  ruleCase("R08", "boundary", "等于阈值或没有创建时间均只提示缺口", () => {
    const input = { requirement, linkedStories: [] };
    expect(hits("R08", input, { today: "2026-11-27" })).toMatchObject([
      { state: "gap" },
    ]);
    expect(
      hits("R08", input, { thresholds: { R08: { after: configured } } }),
    ).toMatchObject([{ state: "gap", threshold: configured }]);
    expect(hits("R08", { ...input, requirement: { id: 7 } })).toMatchObject([
      { state: "gap", since: null },
    ]);
  });

  const closable = { story, tasks: [task, test, acceptance] };
  ruleCase("R09", "hit", "需求可关闭后以实际阶段完成时间计时", () => {
    expect(hits("R09", closable, { today: "2026-11-30" })).toMatchObject([
      {
        state: "stalled",
        since: "2026-11-20",
        confidence: "inferred",
        threshold: { workdays: 5, source: "default" },
      },
    ]);
    expect(
      hits("R09", {
        ...closable,
        bugs: [
          {
            ...bug,
            status: "closed",
            severity: 2,
            closedDate: deadlineEndOfDayMs("2026-11-24"),
          },
        ],
      }),
    ).toMatchObject([{ state: "gap", since: "2026-11-24" }]);
  });
  ruleCase(
    "R09",
    "non-hit",
    "已关闭、仍待验收、严重 Bug 未关闭、任务读取不完整时不提示",
    () => {
      for (const change of [
        { story: { ...story, status: "closed" } },
        { tasks: [task, test] },
        { bugs: [{ ...bug, severity: 2 }] },
        { tasksComplete: false },
      ])
        expect(hits("R09", { ...closable, ...change })).toEqual([]);
    },
  );
  ruleCase(
    "R09",
    "boundary",
    "按配置阈值区分滞留，完成日缺失时保留缺口",
    () => {
      expect(hits("R09", closable, { today: "2026-11-27" })).toMatchObject([
        { state: "gap" },
      ]);
      expect(
        hits("R09", closable, {
          today: "2026-11-26",
          thresholds: { R09: { after: configured } },
        }),
      ).toMatchObject([{ state: "stalled", threshold: configured }]);
      expect(
        hits("R09", {
          ...closable,
          tasks: [task, test, { ...acceptance, finishedDate: null }],
        }),
      ).toMatchObject([{ state: "gap", since: null }]);
    },
  );

  const planned = {
    story,
    plan: { kind: "l3" as const, begin: "2026-10-25", end: "2026-11-03" },
    inMonthDevExecution: false,
  };
  ruleCase("R10", "hit", "WP-31 的跨月 L3 计划归入本月", () => {
    expect(hits("R10", planned)).toMatchObject([
      {
        state: "gap",
        severity: "medium",
        since: null,
        threshold: { workdays: 5, source: "default" },
      },
    ]);
  });
  ruleCase(
    "R10",
    "non-hit",
    "研发迭代关联未知或已存在，或计划不属于当前月时不提示",
    () => {
      for (const value of [true, undefined])
        expect(hits("R10", { ...planned, inMonthDevExecution: value })).toEqual(
          [],
        );
      expect(hits("R10", planned, { month: "2026-10" })).toEqual([]);
      expect(
        hits("R10", {
          ...planned,
          plan: { ...planned.plan, kind: "legacyRelease" },
        }),
      ).toEqual([]);
    },
  );
  ruleCase(
    "R10",
    "boundary",
    "从第 5 个工作日当天起触发，适用调休和阈值配置",
    () => {
      const input = { story, inMonthL3Plan: true, inMonthDevExecution: false };
      expect(hits("R10", input, { today: "2026-11-05" })).toEqual([]);
      expect(hits("R10", input, { today: "2026-11-06" })).toHaveLength(1);
      expect(
        hits("R10", input, {
          monthWorkdayIndex: 3,
          thresholds: { R10: { fromWorkday: configured } },
        }),
      ).toMatchObject([{ state: "gap", threshold: configured }]);
    },
  );

  ruleCase("R11", "hit", "测试完成且验收或必需交付缺失时提示", () => {
    expect(hits("R11", { story, tasks: [test] })).toMatchObject([
      {
        state: "stalled",
        since: "2026-11-20",
        confidence: "recorded",
        threshold: { workdays: 1, source: "default" },
        evidence: ["测试已完成", "缺少必需的验收任务"],
      },
    ]);
    expect(
      hits("R11", {
        story,
        tasks: [{ ...test, name: "功能测试" }, acceptance],
        required: { delivery: true },
      }),
    ).toMatchObject([
      {
        confidence: "inferred",
        evidence: ["测试已完成", "缺少必需的交付任务"],
      },
    ]);
  });
  ruleCase(
    "R11",
    "non-hit",
    "测试未完成、任务读取不完整或下游阶段已有任务时不提示",
    () => {
      expect(
        hits("R11", { story, tasks: [{ ...test, status: "doing" }] }),
      ).toEqual([]);
      expect(
        hits("R11", { story, tasks: [test], tasksComplete: false }),
      ).toEqual([]);
      expect(
        hits("R11", {
          story,
          tasks: [test, { ...acceptance, status: "wait" }],
        }),
      ).toEqual([]);
      expect(
        hits("R11", { story, tasks: [test], required: { acceptance: false } }),
      ).toEqual([]);
    },
  );
  ruleCase(
    "R11",
    "boundary",
    "阈值当天仍为缺口，测试完成时间未知时不升级",
    () => {
      expect(
        hits("R11", { story, tasks: [test] }, { today: "2026-11-22" }),
      ).toMatchObject([{ state: "gap" }]);
      expect(
        hits(
          "R11",
          { story, tasks: [test] },
          { thresholds: { R11: { after: configured } } },
        ),
      ).toMatchObject([{ state: "gap", threshold: configured }]);
      expect(
        hits("R11", { story, tasks: [{ ...test, finishedDate: null }] }),
      ).toMatchObject([{ state: "gap", since: null }]);
      expect(
        hits("R11", {
          story,
          tasks: [test, { ...test, id: 9, finishedDate: null }],
        }),
      ).toMatchObject([{ state: "gap", since: null }]);
    },
  );

  ruleCase("R12", "hit", "AC-64 未挂需求与测试期未挂执行分别报告", () => {
    expect(
      hits("R12", {
        bugs: [
          { ...bug, story: null, openedDate: started },
          { ...bug, id: 9, openedDuringTest: true },
        ],
      }),
    ).toMatchObject([
      {
        objectType: "bug",
        objectId: 8,
        severity: "medium",
        since: "2026-11-20",
        state: "gap",
        evidence: ["Bug 未关联需求"],
      },
      {
        objectType: "bug",
        objectId: 9,
        since: null,
        state: "gap",
        evidence: ["测试期间创建的 Bug 未关联执行"],
      },
    ]);
  });
  ruleCase("R12", "non-hit", "已挂执行及已删除的 Bug 不提示", () => {
    expect(
      hits("R12", {
        bugs: [
          { ...bug, execution: 2, openedDuringTest: true },
          { ...bug, story: null, deleted: true },
        ],
      }),
    ).toEqual([]);
  });
  ruleCase("R12", "boundary", "缺执行只有在已知创建于测试期间时才提示", () => {
    expect(
      hits("R12", { bugs: [bug, { ...bug, openedDuringTest: false }] }),
    ).toEqual([]);
    expect(
      hits("R12", {
        bugs: [{ ...bug, openedDuringTest: true, status: "closed" }],
      }),
    ).toHaveLength(1);
  });

  ruleCase(
    "R13",
    "hit",
    "按被阻塞需求汇报，发布后区分测试未完成和读取不完整",
    () => {
      const result = hits(
        "R13",
        {
          release: {
            ...release,
            stories: [
              releaseStory,
              { ...releaseStory, id: 2, progress: "已取消" },
              { ...releaseStory, id: 3, tasksComplete: false },
              {
                ...releaseStory,
                id: 4,
                stages: { test: { status: "completed" } },
                bugs: [{ id: 4, severity: 1, status: "active" }],
              },
            ],
          },
        },
        { today: "2026-12-01" },
      );
      expect(result).toMatchObject([
        {
          objectType: "story",
          objectId: 1,
          severity: "high",
          state: "gap",
          evidence: expect.arrayContaining(["已发布·测试未完成"]),
        },
        { objectId: 3, confidence: "inferred", since: null },
        {
          objectId: 4,
          confidence: "recorded",
          evidence: ["关联的严重 Bug 尚未关闭"],
        },
      ]);
      expect(result[1]?.evidence).not.toContain("已发布·测试未完成");
    },
  );
  ruleCase("R13", "non-hit", "门禁已满足、未到窗口或已登记例外时不提示", () => {
    expect(hits("R13", { release }, { today: "2026-11-24" })).toEqual([]);
    expect(hits("R13", { release: { ...release, releases: [] } })).toEqual([]);
    expect(
      hits("R13", {
        release: {
          ...release,
          stories: [
            { ...releaseStory, stages: { test: { status: "completed" } } },
          ],
        },
      }),
    ).toEqual([]);
    expect(
      hits("R13", {
        release: {
          ...release,
          waivers: [
            { storyId: 1, version: "V1", approvedBy: "pm", reason: "有例外" },
          ],
        },
      }),
    ).toEqual([]);
  });
  ruleCase(
    "R13",
    "boundary",
    "发布前恰好三个工作日触发，发布当天不提前加发布后标记",
    () => {
      expect(hits("R13", { release })).toMatchObject([
        { threshold: { workdays: 3, source: "default" } },
      ]);
      expect(
        hits(
          "R13",
          { release },
          {
            thresholds: {
              R13: { beforeRelease: { workdays: 2, source: "configured" } },
            },
          },
        ),
      ).toEqual([]);
      expect(
        hits(
          "R13",
          { release },
          {
            today: "2026-11-30",
            thresholds: { R13: { beforeRelease: configured } },
          },
        ),
      ).toMatchObject([
        { threshold: configured, evidence: ["发布门禁要求测试完成"] },
      ]);
    },
  );

  ruleCase("R14", "hit", "AC-52 分别报告 A/B/C 类历史任务", () => {
    expect(
      hits("R14", {
        story: { ...story, status: "closed" },
        tasks: [
          r14Task,
          { ...r14Task, id: 3, status: "doing" },
          { ...r14Task, id: 4, story: null },
        ],
      }),
    ).toMatchObject([
      {
        objectId: 2,
        cleanupClass: "A",
        state: "stalled",
        since: "2026-10-25",
        threshold: { days: 30, unit: "calendarDays", source: "default" },
      },
      { objectId: 3, cleanupClass: "B" },
      { objectId: 4, cleanupClass: "C", objectType: "task", severity: "low" },
    ]);
    expect(
      hits("R14", {
        ...closable,
        tasks: closable.tasks.map((row) => ({ ...row, lastEditedDate: old })),
      }),
    ).toHaveLength(3);
  });
  ruleCase(
    "R14",
    "non-hit",
    "已收尾、取消、关联对象未知或尚在进行的任务不提示",
    () => {
      expect(hits("R14", { tasks: [r14Task] })).toEqual([]);
      expect(
        hits("R14", {
          story,
          tasks: [
            { ...r14Task, status: "doing" },
            { ...r14Task, story: null, status: "closed" },
            { ...r14Task, story: null, status: "cancel" },
          ],
        }),
      ).toEqual([]);
    },
  );
  ruleCase(
    "R14",
    "boundary",
    "超过自然日阈值才滞留，结转日期和创建时间可作为起点",
    () => {
      const input = {
        tasks: [{ ...task, story: null, finishedDate: null, openedDate: old }],
      };
      expect(hits("R14", input, { today: "2026-11-24" })).toEqual([]);
      const limit = {
        days: 31,
        unit: "calendarDays",
        source: "configured",
      } as const;
      expect(
        hits("R14", input, { thresholds: { R14: { olderThanDays: limit } } }),
      ).toEqual([]);
      expect(
        hits(
          "R14",
          {
            tasks: [
              {
                ...r14Task,
                story: null,
                lastEditedDate: started,
                carriedSince: "2026-10-25",
              },
            ],
          },
          {
            today: "2026-11-26",
            thresholds: { R14: { olderThanDays: limit } },
          },
        ),
      ).toMatchObject([{ since: "2026-10-25", threshold: limit }]);
      expect(
        hits("R14", { tasks: [{ ...task, story: null, finishedDate: null }] }),
      ).toMatchObject([{ since: null, state: "gap" }]);
    },
  );

  const inputs: readonly [
    RuleId,
    RuleInput,
    "story" | "task" | "bug" | "requirement",
    number,
  ][] = [
    ["R06", { story, hasL3Plan: false }, "story", 1],
    [
      "R07",
      { story: designStory, tasks: completedDesign, linkedStories: [] },
      "story",
      1,
    ],
    ["R08", { requirement, linkedStories: [] }, "requirement", 7],
    ["R09", closable, "story", 1],
    ["R10", planned, "story", 1],
    ["R11", { story, tasks: [test] }, "story", 1],
    ["R12", { bugs: [{ ...bug, story: null }] }, "bug", 8],
    ["R13", { release }, "story", 1],
    ["R14", { tasks: [{ ...r14Task, story: null }] }, "task", 2],
  ];
  for (const [id, input, objectType, objectId] of inputs)
    ruleCase(id, "hit", "禁用优先，豁免严格匹配规则和对象并保留原因", () => {
      const waiver = {
        ruleId: id,
        objectType,
        objectId,
        by: "pm",
        reason: "试点例外",
      };
      const disabledRules = enabled(id);
      expect(
        evaluateRules(
          {
            ...input,
            waivers: [
              { ...waiver, objectId: objectId + 1 },
              {
                ...waiver,
                objectType: objectType === "story" ? "bug" : "story",
              },
              { ...waiver, ruleId: "R01" },
            ],
          },
          { ...context, disabledRules },
        ).hits,
      ).toHaveLength(1);
      expect(
        evaluateRules(
          { ...input, waivers: [waiver] },
          { ...context, disabledRules },
        ),
      ).toMatchObject({
        hits: [],
        waived: [
          {
            ruleId: id,
            objectType,
            objectId,
            waived: { by: "pm", reason: "试点例外" },
          },
        ],
      });
      disabledRules.add(id);
      expect(
        evaluateRules(
          { ...input, waivers: [waiver] },
          { ...context, disabledRules },
        ),
      ).toEqual({ hits: [], waived: [] });
    });
}
