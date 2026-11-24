import { describe, expect, it } from "vitest";
import {
  createWorkCalendar,
  deadlineEndOfDayMs,
} from "../../src/core/calendar.ts";
import { rules, evaluateRules } from "../../src/rules/index.ts";
import * as overdue from "../../src/rules/r01-overdue.ts";
import * as testing from "../../src/rules/r02-test-handoff.ts";
import * as acceptance from "../../src/rules/r03-receipt-timeout.ts";
import * as assignment from "../../src/rules/r04-premature-assignment.ts";
import * as scope from "../../src/rules/r05-missing-scope.ts";

type Category = "hit" | "non-hit" | "boundary";
const covered = new Map<string, Set<Category>>();

function ruleCase(
  rule: string,
  category: Category,
  name: string,
  check: () => void,
) {
  const categories = covered.get(rule) ?? new Set<Category>();
  categories.add(category);
  covered.set(rule, categories);
  it(`${rule} [${category}] ${name}`, check);
}

const friday = "2026-11-20";
const started = deadlineEndOfDayMs(friday);
const context = {
  calendar: createWorkCalendar({
    holidays: ["2026-11-23"],
    extraWorkdays: ["2026-11-22"],
  }),
  today: "2026-11-25",
};
const task = {
  id: 1,
  status: "pause" as const,
  deadline: friday,
  isParent: false,
  parent: null,
  mode: "single" as const,
};
const story = { id: 2, category: "feature", status: "active" };
const dev = {
  id: 11,
  name: "【研发】实现",
  status: "done" as const,
  finishedDate: started,
};
const test = { id: 12, name: "【测试】验证", status: "wait" as const };
const roleStory = {
  ...story,
  status: "draft",
  assignedTo: "dev",
  openedBy: "designer",
};
const roleContext = { developmentAccounts: new Set(["dev"]) };
const fullSpec =
  "## 本次实现范围\n- 支持导出\n## 设计文档\n- 链接：https://example.test/design  章节：2.1";

describe("WP-12 风险规则", () => {
  ruleCase("R01", "hit", "只报告当前逾期的叶子任务", () => {
    expect(
      overdue.evaluate(
        {
          tasks: [
            { ...task, id: 9, isParent: true },
            { ...task, parent: 9 },
          ],
        },
        context,
      ),
    ).toEqual([
      expect.objectContaining({
        ruleId: "R01",
        objectType: "task",
        objectId: 1,
        severity: "high",
        since: friday,
      }),
    ]);
  });
  ruleCase("R01", "non-hit", "已完成、已删除、无排期均不告警", () => {
    expect(
      overdue.evaluate(
        {
          tasks: [
            { ...task, status: "done" as const, finishedDate: started + 1 },
            { ...task, id: 3, deleted: true },
            { ...task, id: 4, deadline: null },
          ],
        },
        context,
      ),
    ).toEqual([]);
  });
  ruleCase("R01", "boundary", "截止日当天不逾期，次日逾期", () => {
    expect(
      overdue.evaluate({ tasks: [task] }, { ...context, today: friday }),
    ).toEqual([]);
    expect(
      overdue.evaluate({ tasks: [task] }, { ...context, today: "2026-11-21" }),
    ).toHaveLength(1);
  });

  ruleCase(
    "R02",
    "hit",
    "AC-53 缺口可升级为滞留，按最晚的上游阶段完成日起算",
    () => {
      const input = {
        story,
        tasks: [
          dev,
          {
            ...dev,
            id: 14,
            name: "【接口】联调",
            finishedDate: deadlineEndOfDayMs("2026-11-24"),
          },
        ],
      };
      expect(testing.evaluate(input, context)).toMatchObject([
        { state: "gap", since: "2026-11-24" },
      ]);
      expect(
        testing.evaluate(input, { ...context, today: "2026-11-26" }),
      ).toMatchObject([
        { state: "stalled", threshold: { workdays: 1, source: "default" } },
      ]);
      expect(
        testing.evaluate(
          { story, tasks: [{ ...dev, finishedDate: undefined }] },
          context,
        ),
      ).toMatchObject([
        {
          state: "gap",
          since: null,
          evidence: expect.arrayContaining(["起点未知"]),
        },
      ]);
    },
  );
  ruleCase("R02", "non-hit", "需求有效、必需且上游完成才检查接续", () => {
    const input = { story, tasks: [dev] };
    for (const change of [
      { story: { ...story, status: "closed" } },
      { story: { ...story, category: "design" } },
      { story: { ...story, deleted: true } },
      { required: { test: false } },
      { required: { interface: true } },
      { tasksComplete: false },
      { tasks: [{ ...dev, status: "doing" as const }] },
      { tasks: [dev, { ...test, status: "doing" as const }] },
      { tasks: [dev, { ...test, status: "done" as const }] },
      {
        tasks: [
          dev,
          { ...test, status: "cancel" as const, closedReason: "不适用" },
        ],
      },
      { tasks: [dev, { ...test, name: "未分类工作" }] },
    ])
      expect(testing.evaluate({ ...input, ...change }, context)).toEqual([]);
  });
  ruleCase(
    "R02",
    "boundary",
    "等待分支严格超过配置阈值，识别继承父阶段的叶子",
    () => {
      const input = {
        story,
        tasks: [
          dev,
          { ...test, isParent: true, status: "doing" as const },
          { ...test, id: 13, name: "子任务", parent: 12 },
        ],
      };
      const thresholds = {
        R02: { waitAfter: { workdays: 2, source: "configured" as const } },
      };
      expect(
        testing.evaluate(input, {
          ...context,
          thresholds,
          today: "2026-11-24",
        }),
      ).toEqual([]);
      expect(testing.evaluate(input, { ...context, thresholds })).toMatchObject(
        [
          {
            state: "stalled",
            threshold: { workdays: 2, source: "configured" },
          },
        ],
      );
      expect(
        testing.evaluate(
          { ...input, tasks: [{ ...dev, finishedDate: undefined }, test] },
          context,
        ),
      ).toEqual([]);
    },
  );

  ruleCase("R03", "hit", "仅凭移交动作日期与待接收进展判断", () => {
    expect(
      acceptance.evaluate(
        { story, handoffAt: started },
        { ...context, today: "2026-11-26" },
      ),
    ).toMatchObject([
      {
        ruleId: "R03",
        since: friday,
        state: "stalled",
        threshold: { workdays: 3, source: "default" },
      },
    ]);
  });
  ruleCase(
    "R03",
    "non-hit",
    "已拆解、未就绪、已取消、证据不全、没有移交记录均不报超时",
    () => {
      const ctx = { ...context, today: "2026-11-26" };
      const input = { story, handoffAt: started };
      for (const change of [
        { tasks: [dev] },
        { tasks: [{ ...test, name: "未分类工作" }] },
        { tasksComplete: false },
        { story: { ...story, status: "draft" } },
        { story: { ...story, status: "closed", closedReason: "cancel" } },
        { story: { ...story, category: "design" } },
        { handoffAt: null },
      ])
        expect(acceptance.evaluate({ ...input, ...change }, ctx)).toEqual([]);
    },
  );
  ruleCase("R03", "boundary", "恰好三个工作日仍在时限内", () => {
    expect(acceptance.evaluate({ story, handoffAt: started }, context)).toEqual(
      [],
    );
    expect(
      acceptance.evaluate(
        { story, handoffAt: started },
        {
          ...context,
          thresholds: { R03: { after: { workdays: 2, source: "configured" } } },
        },
      ),
    ).toMatchObject([
      { state: "stalled", threshold: { workdays: 2, source: "configured" } },
    ]);
  });

  ruleCase("R04", "hit", "AC-22 草稿和评审中提前指派研发侧人员", () => {
    for (const status of ["draft", "reviewing"]) {
      expect(
        assignment.evaluate({ story: { ...roleStory, status } }, roleContext),
      ).toMatchObject([
        {
          ruleId: "R04",
          state: "gap",
          severity: "medium",
          confidence: "recorded",
        },
      ]);
    }
  });
  ruleCase("R04", "non-hit", "非研发指派、已就绪和无人指派不告警", () => {
    for (const change of [
      { assignedTo: "qa" },
      { status: "active" },
      { assignedTo: null },
    ]) {
      expect(
        assignment.evaluate(
          { story: { ...roleStory, ...change } },
          roleContext,
        ),
      ).toEqual([]);
    }
  });
  ruleCase("R04", "boundary", "研发人员本人是状态维护人时不告警", () => {
    expect(
      assignment.evaluate(
        { story: { ...roleStory, spec: "<!-- bzt:v1 maintainer=dev -->" } },
        roleContext,
      ),
    ).toEqual([]);
    expect(
      assignment.evaluate(
        { story: roleStory, roles: { stored: { maintainer: "dev" } } },
        roleContext,
      ),
    ).toEqual([]);
  });

  ruleCase("R05", "hit", "缺范围和缺设计引用定位均告警", () => {
    for (const spec of [
      null,
      "这里提到本次实现范围，但没有单独段落。",
      "<!-- <h3>本次实现范围</h3><p>导出</p> -->",
      "## 本次实现范围\n## 设计文档\nhttps://example.test/design",
      fullSpec.replace("章节：2.1", "章节 / 版本：……"),
      fullSpec.replace("章节：2.1", "") + "\n## 来源\n版本：2.1",
    ])
      expect(scope.evaluate({ story: { ...story, spec } })).toMatchObject([
        { ruleId: "R05", state: "gap", severity: "low" },
      ]);
  });
  ruleCase("R05", "non-hit", "设计类需求不适用，研发需求可独立说明范围", () => {
    expect(scope.evaluate({ story: { ...story, category: "design" } })).toEqual(
      [],
    );
    expect(
      scope.evaluate({ story: { ...story, spec: "本次实现范围：支持导出" } }),
    ).toEqual([]);
  });
  ruleCase(
    "R05",
    "boundary",
    "设计定位填写章节或版本之一即可，兼容 HTML 模板",
    () => {
      for (const spec of [
        fullSpec,
        fullSpec.replace("章节：2.1", "版本：V2"),
        "<h3>本次实现范围</h3><ul><li>支持导出</li></ul><h3>设计文档</h3><ul><li><a href='https://example.test/design'>设计稿</a> 章节：2</li></ul>",
      ])
        expect(scope.evaluate({ story: { ...story, spec } })).toEqual([]);
    },
  );

  it("按注册顺序评估，豁免仅标记指定对象与规则", () => {
    const result = evaluateRules(
      {
        tasks: [{ ...task, name: "测试任务" }],
        story: roleStory,
        waivers: [
          {
            ruleId: "R04",
            objectType: "story",
            objectId: 2,
            by: "pm",
            reason: "试点",
          },
        ],
      },
      { ...context, ...roleContext, disabledRules: new Set(["R05"]) },
    );
    expect(result.hits.map(({ ruleId }) => ruleId)).toEqual(["R01"]);
    expect(result.waived).toMatchObject([
      { ruleId: "R04", objectId: 2, waived: { by: "pm", reason: "试点" } },
    ]);
  });

  it("注册表覆盖 WP-12 的每条规则，且每条均有三类实际执行的测试", () => {
    expect(rules.map(({ id }) => id)).toEqual([
      "R01",
      "R02",
      "R03",
      "R04",
      "R05",
    ]);
    expect([...covered.keys()].sort()).toEqual(
      rules.map(({ id }) => id).sort(),
    );
    for (const { id } of rules) {
      expect(covered.get(id), id).toEqual(
        new Set(["hit", "non-hit", "boundary"]),
      );
    }
  });

  it("保留推测证据，并在缺少接口完成时间时保留缺口", () => {
    const tasks = [
      { ...dev, id: 99, deleted: true },
      { ...dev, name: "研发工作" },
      { ...dev, id: 14, name: "【接口】联调", finishedDate: undefined },
    ];
    expect(
      testing.evaluate(
        { story, tasks, required: { interface: true } },
        context,
      ),
    ).toMatchObject([{ state: "gap", since: null, confidence: "inferred" }]);
    expect(
      testing.evaluate(
        { story, tasks: [dev], required: { interface: false } },
        {
          ...context,
          thresholds: {
            R02: { missingAfter: { workdays: 4, source: "configured" } },
          },
        },
      ),
    ).toMatchObject([
      { state: "gap", threshold: { workdays: 4, source: "configured" } },
    ]);
  });

  it("注册表支持仅带任务的扫描，且豁免不能跨对象类型或 ID 生效", () => {
    const waivers = [
      {
        ruleId: "R01",
        objectType: "story",
        objectId: 1,
        by: "pm",
        reason: "试点",
      },
      {
        ruleId: "R01",
        objectType: "task",
        objectId: 2,
        by: "pm",
        reason: "试点",
      },
    ] as const;
    expect(
      evaluateRules(
        { tasks: [{ ...task, name: "测试任务" }], waivers },
        context,
      ),
    ).toMatchObject({
      hits: [{ ruleId: "R01", objectId: 1 }],
      waived: [],
    });
    expect(evaluateRules({ story: roleStory }, context)).toMatchObject({
      hits: [{ ruleId: "R05", objectId: 2 }],
      waived: [],
    });
  });
});
