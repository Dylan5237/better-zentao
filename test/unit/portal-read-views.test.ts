import { beforeAll, describe, expect, it } from "vitest";

class ElementStub {
  readonly children: ElementStub[] = [];
  readonly attributes = new Map<string, string>();
  className = "";
  private content = "";

  constructor(readonly tagName: string) {}

  readonly ownerDocument = {
    createElement: (tag: string) => new ElementStub(tag),
  };

  get textContent(): string {
    return (
      this.content + this.children.map((child) => child.textContent).join("")
    );
  }

  set textContent(text: string) {
    this.content = text;
    this.children.length = 0;
  }

  set innerHTML(_: string) {
    throw new Error("门户结果只允许用文本与 DOM 节点渲染。");
  }

  append(...children: ElementStub[]) {
    this.children.push(...children);
  }

  replaceChildren(...children: ElementStub[]) {
    this.textContent = "";
    this.append(...children);
  }

  setAttribute(name: string, value: string) {
    this.attributes.set(name, value);
  }

  find(tag: string): ElementStub[] {
    return this.children.flatMap((child) => [
      ...(child.tagName === tag ? [child] : []),
      ...child.find(tag),
    ]);
  }
}

const asOf = "2026-11-25T08:08:00.000Z";
const story = {
  id: 72,
  title: "<b>权限筛选</b>",
  url: "https://zentao.example/story/72",
  product: { id: 1, name: "工作台" },
  module: { id: 12, path: "权限管理" },
  status: "active",
  progress: { value: "研发中", level: "inferred" },
  currentOwner: { realname: "研发成员", account: "dev" },
  nextStage: "test",
  nextDeadline: "2026-11-27",
  riskCodes: ["R02"],
  untrusted: true,
};
const task = {
  id: 13,
  name: "校验部门筛选",
  url: "https://zentao.example/task/13",
  stage: "test",
  status: "wait",
  deadline: "2026-11-26",
  timeState: "due_soon",
  execution: { id: 7, name: "11月迭代" },
  isParent: false,
};

let renderRead: (container: ElementStub, tool: string, result: unknown) => void;

beforeAll(async () => {
  const browserModule = "../../web/read-views.js";
  const module = (await import(browserModule)) as {
    renderRead: typeof renderRead;
  };
  renderRead = module.renderRead;
});

function render(tool: string, data: unknown, extras = {}) {
  const root = new ElementStub("div");
  renderRead(root, tool, {
    ok: true,
    data,
    scope: { asOf, filters: {}, timeBasis: "按截止日期" },
    completeness: "complete",
    gaps: [],
    inferences: [],
    ...extras,
  });
  return root;
}

function shows(root: ElementStub, ...labels: string[]) {
  for (const label of labels) expect(root.textContent).toContain(label);
}

describe("WEB-03 门户查询结果", () => {
  it("显示台账、口径、部分数据、截断与推测，并只生成安全 HTTP 链接", () => {
    const root = render(
      "query_stories",
      {
        items: [
          story,
          { ...story, id: 73, title: "非链接标题", url: "javascript:void(0)" },
        ],
        countsByProgress: { 研发中: 2 },
      },
      {
        scope: { asOf, filters: { month: "2026-11" }, timeBasis: "按截止日期" },
        completeness: "partial",
        gaps: [{ source: "执行 7", reason: "读取超时" }],
        truncated: true,
        inferences: [
          { field: "progress", level: "inferred", basis: "依据任务状态" },
        ],
        links: [
          { label: "无效协议", url: "javascript:void(0)" },
          { label: "嵌入数据", url: "data:text/plain,blocked" },
          { label: "相对外链", url: "//example.test/path" },
          { label: "含身份信息", url: "https://user@zentao.example/path" },
          { label: "合法链接", url: "http://zentao.example/catalog" },
        ],
      },
    );
    shows(
      root,
      asOf,
      "按截止日期",
      "2026-11",
      "数据不完整",
      "读取超时",
      "已截断",
      "推测",
      "依据任务状态",
      story.title,
      "非链接标题",
    );
    expect(root.find("b")).toHaveLength(0);
    expect(root.find("table")).toHaveLength(1);
    expect(root.find("a").map((a) => a.attributes.get("href"))).toEqual([
      story.url,
      "http://zentao.example/catalog",
    ]);
    expect(root.find("a")[0]?.attributes.get("rel")).toBe(
      "noopener noreferrer",
    );
  });

  it("保留空结果、研发详情和候选链接", () => {
    shows(
      render("query_stories", { items: [], countsByProgress: {} }),
      "暂无需求",
    );
    const dev = render("get_story_progress", {
      scope: "只改<权限>\n保留字段",
      designRef: "设计稿第 2 节",
      verify: "部门可以正确筛选",
      tasks: [task],
      untrusted: true,
    });
    shows(
      dev,
      "实现范围",
      "只改<权限>",
      "设计稿第 2 节",
      "部门可以正确筛选",
      task.name,
    );
    const candidates = render("get_story_progress", {
      candidates: [
        { id: 72, title: story.title, url: story.url, untrusted: true },
      ],
    });
    shows(candidates, "候选需求", story.title);
    expect(candidates.find("a")[0]?.attributes.get("href")).toBe(story.url);
  });

  it("展示完整进展详情中的阶段、进度联系人、关联号与业务卡片", () => {
    const root = render("get_story_progress", {
      story,
      progress: { ...story.progress, basis: "任务已接收" },
      stages: [
        {
          stage: "test",
          required: true,
          state: "not_started",
          tasks: [task],
          evidence: ["测试任务未开始"],
        },
      ],
      people: {
        raisedBy: "提出人",
        maintainer: "进度联系人甲",
        untrusted: true,
      },
      related: {
        requirement: 65,
        bugs: [
          {
            id: 21,
            title: "筛选缺陷",
            severity: 1,
            status: "active",
            url: "https://zentao.example/bug/21",
            untrusted: true,
          },
        ],
      },
      risks: [],
      card: "本次反馈的进度卡片",
    });
    shows(
      root,
      story.title,
      "研发中",
      "推测",
      "任务已接收",
      "测试任务未开始",
      task.name,
      "进度联系人甲",
      "#65",
      "筛选缺陷",
      "本次反馈的进度卡片",
    );
  });

  it("以计划分组和独立分母显示需求交付率与任务完成率", () => {
    const counts = {
      completed: 1,
      inProgress: 1,
      toReceive: 0,
      notReady: 0,
      cancelled: 0,
      unknown: 0,
    };
    const summary = {
      total: 2,
      counts,
      storyDeliveryRate: { numerator: 1, denominator: 2, rate: 0.5 },
      taskCompletionRate: { numerator: 3, denominator: 4, rate: 0.75 },
    };
    shows(
      render("get_plan_progress", {
        view: "plan",
        asOf,
        ...summary,
        groups: [{ key: "负责人甲", ...summary }],
        planIds: [88],
      }),
      "需求交付率",
      "50%（1/2）",
      "任务完成率",
      "75%（3/4）",
      "负责人甲",
      "#88",
    );
  });

  it("呈现发布门禁、未完成证据和例外原因", () => {
    shows(
      render("get_plan_progress", {
        view: "release",
        version: "V1.3",
        releaseDate: "2026-11-30",
        dateSource: "calendar",
        workdaysUntilRelease: 3,
        storyIds: [72],
        gate: "blocked",
        progressGroups: [{ progress: "待测试", storyIds: [72] }],
        testCompletionRate: { numerator: 0, denominator: 1, rate: 0 },
        testIncompleteStoryIds: [72],
        testEvidenceMissingStoryIds: [92],
        openSeriousBugs: [],
        openBugs: [],
        unlinkedSeriousBugs: [],
        unlinkedBugIds: [],
        lateLeafTasks: [{ storyId: 72, taskId: 51, deadline: "2026-12-01" }],
        waivers: [
          {
            storyId: 72,
            approvedBy: "产品负责人",
            reason: "补验接口",
            version: "V1.3",
          },
        ],
        flags: [],
        releaseWarningStoryIds: [72],
      }),
      "发布受阻",
      "配置发布日历",
      "证据缺失",
      "#92",
      "补验接口",
      "#51",
      "发布前门禁预警",
    );
  });

  it("标明承诺快照的缺失产品、顺延理由和插入需求", () => {
    shows(
      render("get_plan_progress", {
        view: "commitment",
        snapshots: [],
        snapshotAvailable: false,
        missingSnapshotProductIds: [29],
        fulfilled: [],
        carriedOver: [{ id: 63, reason: "等待依赖" }],
        inserted: [71],
        pendingStoryIds: [],
        cancelledStoryIds: [],
        unknownStoryIds: [],
      }),
      "缺少承诺快照",
      "#29",
      "顺延",
      "等待依赖",
      "插入",
      "#71",
    );
  });

  it("展示迭代指标的样本量、规则命中和禅道可见投入", () => {
    const emptyRate = { numerator: 0, denominator: 0, rate: null };
    shows(
      render("get_plan_progress", {
        view: "iteration",
        executionIds: [7],
        storyIds: [72],
        decompositionTimeliness: emptyRate,
        overdueRate: emptyRate,
        testCycleMedianWorkdays: 2,
        testCycleSampleSize: 3,
        visibleHours: {
          estimate: 17,
          consumed: 11,
          left: 6,
          leafTaskCount: 4,
          missingHoursTaskCount: 1,
        },
        snapshots: [],
        snapshotAvailable: false,
        missingSnapshotProductIds: [],
        complianceByOwner: [{ owner: "负责人甲", counts: { R05: 2, R06: 1 } }],
        crossProduct: [],
      }),
      "拆解及时性",
      "无可用分母",
      "2 工作日",
      "3 个样本",
      "禅道可见投入",
      "11 小时",
      "缺工时",
      "R05",
    );
  });

  it("呈现研发队列与我的工作中各自的等待和提醒", () => {
    shows(
      render("get_monthly_dev_queue", {
        buckets: {
          toReceive: [],
          inDev: [{ ...story, carriedOver: true }],
          carriedOver: [],
          planNoIteration: [],
          iterationNoPlan: [],
        },
        counts: {
          mainPool: 1,
          toReceive: 0,
          inDev: 1,
          carriedOver: 0,
          planNoIteration: 0,
          iterationNoPlan: 0,
          notReady: 0,
          unbucketed: 0,
          missing: 0,
        },
        monthEndWarnings: [story],
        unbucketedStoryIds: [],
        missingStoryIds: [],
        carryOverSource: "snapshot",
      }),
      "研发主池",
      "在研",
      "上月遗留",
      "月底提醒",
      story.title,
    );
    shows(
      render("get_my_work", {
        new: [],
        raised: [],
        maintained: [],
        action: {
          overdue: [],
          dueToday: [],
          dueSoon: [task],
          unscheduled: [],
          toReceive: [],
          toReview: [],
        },
        waiting_ready: [
          { ...story, waitingFor: { account: "design", realname: "设计同事" } },
        ],
        can_start: { tests: [task], upcomingTests: [], acceptDeliver: [] },
      }),
      "临期",
      "可开测",
      "未就绪",
      "等候",
      "设计同事",
      task.name,
    );
  });

  it("在团队与排期表显示日期区间、工时缺口和父级风险", () => {
    shows(
      render("get_team_work", {
        groups: [{ key: "dev", label: "研发小组", count: 1, items: [task] }],
        totals: { overdue: 1, dueSoon: 2, open: 3 },
        parentRisks: [
          { task, allChildrenFinished: true, reason: "子任务均完成" },
        ],
      }),
      "研发小组",
      "父级风险",
      "子任务均完成",
      task.name,
    );
    shows(
      render("get_member_schedule", {
        members: [
          {
            account: "dev",
            realname: "研发成员",
            capacityHours: 30,
            buckets: [
              {
                start: "2026-11-23",
                end: "2026-11-29",
                leftHours: 12,
                taskCount: 3,
                missingEstimate: 1,
              },
            ],
            overdue: [],
            unscheduled: [task],
          },
        ],
        suggestions: [
          {
            account: "dev",
            realname: "研发成员",
            suggestedDeadline: "2026-11-26",
            reason: "截止前还有容量",
          },
        ],
      }),
      "2026-11-23",
      "2026-11-29",
      "12 小时",
      "缺工时 1 项",
      "未排期",
      "截止前还有容量",
    );
  });

  it("将巡检的风险、豁免和操作回执按业务字段展示", () => {
    shows(
      render("scan_workflow_risks", {
        summary: [{ rule: "R02", name: "测试接续", count: 1 }],
        hits: [
          {
            rule: "R02",
            severity: "high",
            level: "inferred",
            object: {
              type: "story",
              id: story.id,
              title: story.title,
              url: story.url,
            },
            reason: "缺少测试任务",
            suggestion: "补齐测试任务",
            waived: { by: "测试负责人", reason: "已有联调" },
          },
        ],
      }),
      "测试接续",
      "缺少测试任务",
      "补齐测试任务",
      "推测",
      "豁免",
      "已有联调",
    );
    shows(
      render("get_operation", {
        opId: "op_test",
        status: "confirmed",
        steps: [],
        created: [],
      }),
      "op_test",
      "已确认",
    );
  });
});
