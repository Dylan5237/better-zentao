import { describe, expect, it } from "vitest";
import { detectStage, summarizeStages } from "../../src/domain/stage.ts";
import { featureProgress, designProgress } from "../../src/domain/progress.ts";

describe("docs/04 §3 阶段识别与完成", () => {
  it("描述标记优先于标准前缀，前缀优先于投票", () => {
    expect(
      detectStage({
        name: "【研发】原型",
        type: "design",
        desc: "<p>说明</p><!-- bzt:stage=test -->",
      }),
    ).toEqual({ stage: "test", confidence: "confirmed" });
    expect(
      detectStage({
        name: "【研发】测试",
        type: "test",
        desc: "<!-- bzt:stage=invalid -->",
      }),
    ).toEqual({ stage: "dev", confidence: "confirmed" });
    expect(
      detectStage(
        { name: "【前端测试】接口", type: "devel" },
        { prefixes: { test: "【前端测试】" } },
      ),
    ).toEqual({ stage: "test", confidence: "confirmed" });
    expect(
      detectStage({
        name: "【设计】实现",
        type: "devel",
        desc: "<p>任务说明</p>\n<p>[bzt:stage=dev]</p>",
      }),
    ).toEqual({ stage: "dev", confidence: "confirmed" });
    expect(
      detectStage({
        name: "【研发】核对",
        type: "devel",
        desc: '<p style="color:#999;font-size:12px">[bzt:stage=test]</p>',
      }),
    ).toEqual({ stage: "test", confidence: "confirmed" });
    expect(
      detectStage({
        name: "【设计】实现",
        type: "devel",
        desc: "<p>任务说明</p>\n[bzt:stage=dev]",
      }),
    ).toEqual({ stage: "dev", confidence: "confirmed" });
    expect(
      detectStage({
        name: "【研发】测试",
        type: "test",
        desc: "<p>[bzt:stage=unknown]</p>",
      }),
    ).toEqual({ stage: "dev", confidence: "confirmed" });
    expect(
      detectStage({
        name: "普通任务",
        type: "devel",
        desc: "<p>[bzt:stage=test]</p><!-- bzt:stage=dev -->",
      }),
    ).toEqual({ stage: "dev", confidence: "confirmed" });
  });

  it.each([
    ["调研概要概设原型UI", "design"],
    ["评审", "review"],
    ["传递", "handoff"],
    ["前端开发与研发", "dev"],
    ["接口联调", "interface"],
    ["测试用例", "test"],
    ["功能验收", "acceptance"],
    ["交付培训手册", "delivery"],
  ])("按存量标题识别 %s", (name, stage) => {
    expect(detectStage({ name, type: "devel" })).toEqual({
      stage,
      confidence: "inferred",
    });
  });

  it("使用子任务、迭代和负责人证据，允许注入权重", () => {
    expect(
      detectStage(
        { name: "综合", type: "devel" },
        { childTitles: ["编写测试用例"] },
      ),
    ).toEqual({ stage: "test", confidence: "inferred" });
    expect(
      detectStage(
        { name: "传递与研发", type: "devel" },
        { executionKind: "design" },
      ),
    ).toEqual({ stage: "handoff", confidence: "inferred" });
    expect(
      detectStage(
        { name: "综合", type: "design" },
        { assigneeGroup: "design" },
      ),
    ).toEqual({ stage: "design", confidence: "inferred" });
    expect(
      detectStage({ name: "综合", type: "test" }, { assigneeGroup: "test" }),
    ).toEqual({ stage: "test", confidence: "inferred" });
    expect(
      detectStage({ name: "研发", type: "test" }, { weights: { taskType: 4 } }),
    ).toEqual({ stage: "test", confidence: "inferred" });
  });

  it("排除低分、并列、非注释和示例中的标记", () => {
    for (const task of [
      { name: "综合", type: "test" },
      { name: "研发接口", type: "devel" },
      {
        name: "综合",
        type: "devel",
        desc: '<pre><!-- bzt:stage=test --></pre><p title="<!-- bzt:stage=dev -->">文案</p>',
      },
      {
        name: "综合",
        type: "devel",
        desc: "<!-- 外层注释 <!-- bzt:stage=test -->",
      },
    ])
      expect(detectStage(task)).toEqual({
        stage: "unknown",
        confidence: "unknown",
      });
    expect(
      detectStage({ name: "综合", type: "devel" }, { assigneeGroup: "design" })
        .stage,
    ).toBe("unknown");
  });

  it.each(["quick fix", "build", "guide"])(
    "不将 %s 中的 UI 片段认作设计",
    (name) => {
      expect(detectStage({ name, type: "devel" })).toEqual({
        stage: "unknown",
        confidence: "unknown",
      });
      expect(detectStage({ name: "调整 UI 布局" }).stage).toBe("design");
    },
  );

  it("将子任务归入最近可识别的祖先阶段，只汇总叶子状态", () => {
    expect(
      summarizeStages([
        { id: 3, parent: 2, name: "张三", status: "done" },
        { id: 4, parent: 2, name: "李四", status: "doing" },
        {
          id: 5,
          parent: 1,
          name: "【交付】王五",
          status: "done",
          finishedDate: 20,
        },
        { id: 2, parent: 1, name: "【测试】", status: "done", isParent: true },
        {
          id: 1,
          name: "【设计】",
          desc: "<!-- bzt:stage=dev -->",
          status: "doing",
          isParent: true,
        },
        { id: 6, parent: 1, name: "小组", status: "doing", isParent: true },
        { id: 7, parent: 6, name: "赵六", status: "done", finishedDate: 10 },
      ]),
    ).toEqual({
      stages: {
        test: { status: "in_progress" },
        dev: { status: "completed", finishedDate: 20 },
      },
      hasUnknownTasks: false,
    });
  });

  it.each([
    ["范围调整", "cancelled"],
    [undefined, "missing"],
  ])("子任务全部取消时按原因判断阶段状态 %#", (closedReason, status) => {
    expect(
      summarizeStages([
        { id: 1, name: "【研发】", status: "done", isParent: true },
        {
          id: 2,
          parent: 1,
          name: "张三",
          status: "closed",
          closedReason: "cancel",
        },
        { id: 3, parent: 1, name: "李四", status: "cancel", closedReason },
      ]),
    ).toEqual({ stages: { dev: { status } }, hasUnknownTasks: false });
  });

  it("父任务没有可见的后代叶子时标记未知，已删除的子任务不算证据", () => {
    expect(
      summarizeStages([
        { id: 1, name: "【研发】", status: "done", isParent: true },
        { id: 2, parent: 1, name: "小组", status: "done", isParent: true },
        { id: 3, parent: 2, name: "张三", status: "done", deleted: true },
      ]),
    ).toEqual({ stages: {}, hasUnknownTasks: true });
  });

  it("遇到循环或已删除的祖先时回退到叶子阶段", () => {
    expect(
      summarizeStages([
        { id: 1, parent: 2, name: "甲组", status: "doing", isParent: true },
        { id: 2, parent: 1, name: "乙组", status: "doing", isParent: true },
        { id: 3, parent: 1, name: "【研发】张三", status: "done" },
        {
          id: 4,
          name: "【测试】",
          status: "done",
          isParent: true,
          deleted: true,
        },
        { id: 5, parent: 4, name: "【验收】李四", status: "done" },
      ]),
    ).toEqual({
      stages: {
        dev: { status: "completed" },
        acceptance: { status: "completed" },
      },
      hasUnknownTasks: false,
    });
  });

  it("只看叶子，使用最晚实际完成时间，区分取消原因", () => {
    const summary = summarizeStages([
      { name: "【研发】父任务", isParent: true, status: "doing" },
      { name: "【研发】A", status: "done", finishedDate: 20 },
      { name: "【研发】B", status: "closed", finishedDate: 10 },
      { name: "【研发】C", status: "done" },
      { name: "【测试】", status: "closed", closedReason: "cancel" },
      { name: "【接口】", status: "cancel", closedReason: "范围调整" },
      { name: "【交付】", status: "cancel", closedReason: " " },
      { name: "【验收】", status: "doing", finishedDate: 15 },
      { name: "其他", status: "wait" },
    ]);
    expect(summary.stages).toEqual({
      dev: { status: "completed", finishedDate: 20 },
      test: { status: "cancelled" },
      interface: { status: "cancelled" },
      delivery: { status: "missing" },
      acceptance: { status: "in_progress" },
    });
    expect(summary.hasUnknownTasks).toBe(true);
    expect(
      summarizeStages([{ name: "【研发】", status: "done" }]).stages.dev,
    ).toEqual({ status: "completed" });
    expect(
      summarizeStages([
        { name: "【研发】", status: "done" },
        { name: "【研发】", status: "cancel", closedReason: "原因" },
      ]).stages.dev?.status,
    ).toBe("in_progress");
  });
});

const done = { status: "completed" } as const;
const working = { status: "in_progress" } as const;
const cancelled = { status: "cancelled" } as const;
const missing = { status: "missing" } as const;
const ready = { dev: done, test: done, acceptance: done };

describe("docs/04 §4.4–4.5 业务进展", () => {
  it.each([
    [{ status: "draft", stages: ready }, "未就绪"],
    [{ status: "reviewing", stages: {} }, "未就绪"],
    [{ status: "closed", closedReason: "willnotdo", stages: ready }, "已取消"],
    [{ status: "closed", closedReason: "duplicate", stages: {} }, "已取消"],
    [{ status: "closed", closedReason: "cancel", stages: {} }, "已取消"],
    [{ status: "closed", stages: ready }, "已完成"],
    [
      { status: "closed", stages: { ...ready, dev: cancelled } },
      "已关闭·证据缺失",
    ],
    [
      {
        status: "closed",
        stages: {},
        required: { dev: false, test: false, acceptance: false },
      },
      "已关闭·证据缺失",
    ],
    [{ status: "active", stages: {} }, "待接收"],
    [{ status: "active", stages: {}, hasUnknownTasks: true }, "无法判断"],
    [
      { status: "active", stages: { dev: cancelled }, hasUnknownTasks: true },
      "无法判断",
    ],
    [{ status: "active", stages: { dev: working } }, "研发中"],
    [{ status: "active", stages: { ...ready, interface: working } }, "研发中"],
    [{ status: "active", stages: { dev: done } }, "待测试"],
    [{ status: "active", stages: { dev: done, test: missing } }, "待测试"],
    [
      {
        status: "active",
        stages: { dev: cancelled, test: cancelled, acceptance: cancelled },
      },
      "测试中",
    ],
    [{ status: "active", stages: { ...ready, test: working } }, "测试中"],
    [
      {
        status: "active",
        stages: ready,
        bugs: [{ severity: 2, status: "resolved" }],
      },
      "测试中",
    ],
    [{ status: "active", stages: { dev: done, test: done } }, "待验收"],
    [{ status: "active", stages: { ...ready, acceptance: working } }, "待验收"],
    [
      { status: "active", stages: ready, required: { delivery: true } },
      "待交付",
    ],
    [
      {
        status: "active",
        stages: { ...ready, delivery: working },
        required: { delivery: true },
      },
      "待交付",
    ],
    [
      {
        status: "active",
        stages: ready,
        bugs: [
          { severity: 1, status: "closed" },
          { severity: 3, status: "active" },
          { severity: 0, status: "active" },
        ],
      },
      "可关闭",
    ],
    [
      {
        status: "active",
        stages: { dev: done, acceptance: done },
        required: { test: false },
      },
      "可关闭",
    ],
    [
      {
        status: "active",
        stages: { dev: done, test: done },
        required: { acceptance: false },
      },
      "可关闭",
    ],
    [
      {
        status: "active",
        stages: { dev: done, test: done },
        required: { acceptance: false, delivery: true },
      },
      "待交付",
    ],
    [
      {
        status: "active",
        stages: { ...ready, delivery: done },
        required: { delivery: true },
      },
      "可关闭",
    ],
  ] as const)("研发进展 %#", (input, expected) => {
    expect(featureProgress(input).progress).toBe(expected);
  });

  it("标记测试缺口与发布后测试未完成，发布当天是边界", () => {
    const input = {
      status: "active",
      stages: { dev: done },
      releaseDate: "2026-11-20",
    };
    expect(featureProgress({ ...input, today: "2026-11-20" })).toEqual({
      progress: "待测试",
      flags: ["R02"],
    });
    expect(featureProgress({ ...input, today: "2026-11-21" })).toEqual({
      progress: "待测试",
      flags: ["R02", "已发布·测试未完成"],
    });
    expect(
      featureProgress({ ...input, today: "2026-11-21", stages: ready }).flags,
    ).toEqual([]);
    expect(
      featureProgress({ ...input, today: "2026-11-21", releaseDate: "无日期" })
        .flags,
    ).toEqual(["R02"]);
  });

  it.each([
    [{ dev: cancelled }, "待测试", []],
    [{ test: missing }, "待测试", []],
    [{ dev: done, interface: missing }, "待测试", []],
    [{ dev: done, interface: working }, "研发中", []],
    [{ dev: done, interface: done }, "待测试", ["R02"]],
    [{ dev: done, interface: cancelled }, "待测试", ["R02"]],
  ] as const)("按研发和接口状态标记 R02 %#", (stages, progress, flags) => {
    expect(featureProgress({ status: "active", stages })).toEqual({
      progress,
      flags,
    });
  });

  it.each([
    [{ status: "draft", stages: {} }, "未就绪", []],
    [{ status: "reviewing", stages: {}, hasUnknownTasks: true }, "设计中", []],
    [{ status: "draft", stages: { design: working } }, "设计中", []],
    [{ status: "active", stages: {} }, "设计中", []],
    [{ status: "active", stages: { design: done } }, "待评审", []],
    [
      { status: "active", stages: { design: done, review: working } },
      "待评审",
      [],
    ],
    [
      { status: "active", stages: { design: done, review: done } },
      "待传递",
      [],
    ],
    [
      {
        status: "active",
        stages: { design: done, review: done, handoff: working },
      },
      "待传递",
      [],
    ],
    [
      {
        status: "active",
        stages: { design: done, review: done, handoff: done },
      },
      "待移交",
      ["R07"],
    ],
    [
      {
        status: "active",
        stages: { design: done, review: done, handoff: done },
        hasRelatedFeature: true,
      },
      "已移交",
      [],
    ],
  ] as const)("设计进展 %#", (input, progress, flags) => {
    expect(designProgress(input)).toEqual({ progress, flags });
  });
});

describe("进展数据缺口", () => {
  it("任务列表不完整时保留待核实结果，避免由缺失数据推断阶段", () => {
    expect(
      featureProgress({
        status: "active",
        stages: ready,
        tasksComplete: false,
        today: "2026-11-21",
        releaseDate: "2026-11-20",
      }),
    ).toEqual({ progress: "无法判断", flags: [] });
    expect(
      featureProgress({
        status: "active",
        stages: {},
        tasksComplete: false,
        today: "2026-11-21",
        releaseDate: "2026-11-20",
      }),
    ).toEqual({ progress: "无法判断", flags: [] });
    expect(
      featureProgress({ status: "closed", stages: ready, tasksComplete: false })
        .progress,
    ).toBe("已关闭·证据缺失");
    expect(
      featureProgress({
        status: "closed",
        closedReason: "postponed",
        stages: {},
        tasksComplete: false,
      }).progress,
    ).toBe("已取消");
    expect(
      designProgress({ status: "draft", stages: {}, tasksComplete: false }),
    ).toEqual({ progress: "无法判断", flags: [] });
  });

  it("全部裁剪且只有取消记录时没有关闭证据", () => {
    expect(
      featureProgress({
        status: "active",
        stages: { dev: cancelled },
        required: { dev: false, test: false, acceptance: false },
      }).progress,
    ).toBe("无法判断");
    expect(
      featureProgress({
        status: "active",
        stages: ready,
        bugs: [{ severity: 1, status: "active", deleted: true }],
      }).progress,
    ).toBe("可关闭");
  });
});
