import { describe, expect, it, vi } from "vitest";
// @ts-expect-error The packaged portal is a native browser module.
import { renderWorkbench } from "../../web/workbench-page.js";

class ElementStub {
  readonly children: ElementStub[] = [];
  readonly attributes = new Map<string, string>();
  private readonly listeners = new Map<string, () => void>();
  private content = "";
  className = "";
  value = "";
  style = {
    setProperty: (name: string, value: string) =>
      this.attributes.set(name, value),
  };
  ownerDocument = { createElement: (tag: string) => new ElementStub(tag) };

  constructor(readonly tag: string) {}

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
    throw new Error("必须以文本节点渲染禅道数据。");
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

  addEventListener(event: string, listener: () => void) {
    this.listeners.set(event, listener);
  }

  submit() {
    const listener = this.listeners.get("submit");
    if (!listener) throw new Error("缺少提交入口");
    Reflect.apply(listener, this, [{ preventDefault() {} }]);
  }

  click() {
    const listener = this.listeners.get("click");
    if (!listener) throw new Error("缺少点击入口");
    listener();
  }

  edit(value: string) {
    this.value = value;
    for (const event of ["input", "change"])
      Reflect.apply(this.listeners.get(event) ?? (() => {}), this, [
        { target: this },
      ]);
  }

  descendants(match: (node: ElementStub) => boolean): ElementStub[] {
    return this.children.flatMap((child) => [
      ...(match(child) ? [child] : []),
      ...child.descendants(match),
    ]);
  }
}

const person = { account: "operator", realname: "本人" };
const story = {
  id: 37,
  title: "<b>权限筛选</b>",
  url: "https://zentao.example/story/37",
  category: "feature",
  status: "active",
  product: { id: 9, name: "工作台" },
  module: { id: 12, path: "权限管理" },
  maintainer: { account: "designer", realname: "状态维护人" },
  currentOwner: person,
  receiver: person,
  feedbackBy: "业务同事",
  progress: { value: "待测试", level: "inferred" },
};
const task = {
  id: 11,
  name: "校验部门筛选",
  url: "https://zentao.example/task/11",
  deadline: "2026-11-26",
  estStarted: "2026-11-24",
  timeState: "due_today",
  story: { id: story.id, title: story.title },
  isParent: false,
};

function data(value: unknown, extra = {}) {
  return {
    ok: true,
    data: value,
    scope: {
      asOf: "2026-11-26T05:20:00.000Z",
      filters: { month: "2026-11" },
    },
    completeness: "complete",
    gaps: [],
    inferences: [],
    ...extra,
  };
}

function page(
  id: string,
  label: string,
  actions: string[],
  responses: Record<string, unknown>,
  options: {
    mode?: "meridian" | "hybrid" | "zentao";
    designMaintainers?: { account: string; realname?: string; lead: boolean }[];
    displayName?: string;
    releaseCalendar?: { product: number; version: string; date: string }[];
  } = {},
) {
  const root = new ElementStub("div");
  const ctx = {
    role: { id, label, actions },
    account: person.account,
    mode: "meridian",
    ...options,
    setMode: vi.fn(),
    call: vi.fn<(tool: string, input: unknown) => Promise<unknown>>(
      async (tool) => {
        if (!actions.includes(tool)) throw new Error("调用了无权访问的工具");
        const response = responses[tool];
        if (response instanceof Error) throw response;
        return response;
      },
    ),
    current: vi.fn(() => true),
    navigate: vi.fn(),
    openTool: vi.fn(),
    openStory: vi.fn(),
  };
  return { root, ctx };
}

function find(root: ElementStub, tag: string, label?: string) {
  const node = root.descendants(
    (entry) => entry.tag === tag && (!label || entry.textContent === label),
  )[0];
  if (!node) throw new Error(`找不到 ${tag} ${label ?? ""}`);
  return node;
}

function metric(root: ElementStub, label: string) {
  const node = root.descendants(
    (entry) =>
      /(?:^|\s)kpi-card(?:\s|$)/u.test(entry.className) &&
      entry.children.some((child) => child.textContent === label),
  )[0];
  if (!node) throw new Error(`找不到指标 ${label}`);
  return node.descendants((entry) => entry.className.includes("kpi-num"))[0]
    ?.textContent;
}

function shows(root: ElementStub, ...labels: string[]) {
  for (const label of labels) expect(root.textContent).toContain(label);
}

describe("WEB-03 原型角色工作台", () => {
  it("设计主管全封装档的两个面板和底部 R04 提醒使用真实工作范围", async () => {
    const teammate = { account: "teammate", realname: "同组设计" };
    const personal = { ...story, maintainer: person, riskCodes: ["R04"] };
    const managed = {
      ...story,
      id: 52,
      title: "同组维护的需求",
      maintainer: teammate,
    };
    const outside = { ...story, id: 53, title: "其他团队需求" };
    const { root, ctx } = page(
      "DM",
      "设计主管",
      [
        "get_my_work",
        "query_stories",
        "scan_workflow_risks",
        "get_story_progress",
      ],
      {},
      {
        displayName: "登录姓名",
        designMaintainers: [
          { ...person, lead: true },
          { ...teammate, lead: false },
        ],
      },
    );
    ctx.call.mockImplementation(async (tool, input) => {
      if (tool === "get_my_work") return data({ maintained: [personal] });
      if (tool === "scan_workflow_risks") return data({ hits: [] });
      if (
        tool === "query_stories" &&
        (input as { type?: string }).type === "story"
      )
        return data({ items: [personal, managed, outside] });
      return data({ items: [] });
    });
    await renderWorkbench(root, ctx);
    shows(
      root,
      "登录姓名（设计主管）",
      "三档·全封装",
      "现在需要您处理的事项",
      "团队与我维护的需求（按维护人筛选）",
      "全部设计团队",
      "本人（设计主管）",
      managed.title,
      "规范提示",
      "R04",
    );
    find(root, "button", "查看 R04").click();
    expect(ctx.openStory).toHaveBeenCalledWith(personal.id, "full");
    expect(
      root.descendants((node) => node.className.includes("vp-grid-2")),
    ).toHaveLength(1);
    expect(root.textContent).not.toContain(outside.title);
    find(root, "button", "同组设计").click();
    expect(root.textContent).not.toContain(personal.title);
    find(root, "button", "转发进度卡").click();
    expect(ctx.openStory).toHaveBeenCalledWith(managed.id, "card");
    find(root, "button", "二档·融合增强").click();
    expect(ctx.setMode).toHaveBeenCalledWith("hybrid");
    expect(ctx.call).toHaveBeenCalledWith("scan_workflow_risks", {
      scope: { mine: true },
      rules: ["R04"],
    });
  });

  it("融合增强档用真实字段筛选待处理事项和团队维护列表", async () => {
    const requirement = { ...story, id: 54, title: "组织权限调整" };
    const personal = { ...story, maintainer: person };
    const { root, ctx } = page(
      "DM",
      "设计主管",
      ["get_my_work", "query_stories"],
      {
        get_my_work: data({ maintained: [personal] }),
        query_stories: data({ items: [requirement] }),
      },
      { mode: "hybrid" },
    );
    await renderWorkbench(root, ctx);
    const keywords = root.descendants(
      (node) => node.tag === "input" && node.className.includes("hybrid-input"),
    );
    expect(keywords).toHaveLength(2);
    shows(root, "全部事项类型", "全部产品", "全部模块", "全部版本");
    keywords[0]?.edit("没有匹配项");
    expect(root.textContent).not.toContain(requirement.title);
    keywords[1]?.edit("#37");
    shows(root, personal.title);
    expect(root.textContent).toContain("当前筛选条件下暂无待处理事项。");
  });

  it("禅道原生档用两张真实台账保留设计需求进度及来源关联", async () => {
    const requirement = { ...story, id: 54, title: "待关联的用户诉求" };
    const { root, ctx } = page(
      "DM",
      "设计主管",
      ["get_my_work", "query_stories", "create_story", "get_story_progress"],
      {},
      { mode: "zentao" },
    );
    ctx.call.mockImplementation(async (tool, input) => {
      if (tool === "get_my_work") return data({ maintained: [story] });
      return data({
        items: [
          (input as { type?: string }).type === "requirement"
            ? requirement
            : story,
        ],
      });
    });
    await renderWorkbench(root, ctx);
    shows(
      root,
      "一档·禅道原生",
      "研发需求列表",
      "用户需求池",
      "阶段进展",
      story.title,
    );
    expect(
      root.descendants((node) => node.className.includes("kpi-grid-3")),
    ).toHaveLength(0);
    const requirementsTab = root.descendants(
      (node) =>
        node.tag === "button" && node.textContent.startsWith("用户需求池"),
    )[0];
    requirementsTab?.click();
    shows(root, "来源反馈", requirement.title);
    find(root, "button", "一键生成研发需求").click();
    expect(ctx.navigate).toHaveBeenCalledWith(
      "intake",
      expect.objectContaining({ requirementId: requirement.id }),
    );
  });

  it("业务反馈显示本人诉求的四步进度，带着原话进入预览流程", async () => {
    const { root, ctx } = page(
      "FB",
      "业务反馈者",
      ["get_my_work", "create_story", "get_story_progress"],
      { get_my_work: data({ raised: [story] }) },
    );
    await renderWorkbench(root, ctx);
    shows(
      root,
      "业务反馈者工作台",
      "一句话提出新诉求",
      "我反馈的需求进展",
      "已受理",
      "设计方案",
      "研发测试中",
      "验收上线",
      story.title,
      "推测",
    );
    expect(root.descendants((entry) => entry.tag === "b")).toHaveLength(0);
    find(root, "button", "查看进度卡片").click();
    expect(ctx.openStory).toHaveBeenCalledWith(story.id, "card");
    find(root, "input").value = "角色列表加部门筛选";
    find(root, "form").submit();
    expect(ctx.navigate).toHaveBeenCalledWith("intake", {
      title: "角色列表加部门筛选",
      spec: { background: "角色列表加部门筛选" },
    });
    expect(ctx.call).toHaveBeenCalledExactlyOnceWith("get_my_work", {
      groups: ["raised"],
      markSeen: false,
    });
  });

  it.each([
    ["DM", "设计主管"],
    ["DS", "设计人员"],
  ])("%s 显示设计移交、收尾、未关联来源和维护列表", async (id, label) => {
    const requirement = { ...story, id: 54, title: "关联这个来源" };
    const handoff = {
      ...story,
      category: "design",
      progress: { value: "待移交" },
    };
    const close = {
      ...story,
      id: 38,
      title: "可关闭的事项",
      progress: { value: "可关闭" },
    };
    const { root, ctx } = page(
      id,
      label,
      [
        "get_my_work",
        "query_stories",
        "handoff_story",
        "create_story",
        "get_story_progress",
      ],
      {
        query_stories: data({
          items: [requirement],
          countsByProgress: { 用户诉求: 1 },
        }),
        get_my_work: data({ maintained: [handoff, close], action: {} }),
      },
    );
    await renderWorkbench(root, ctx);
    shows(
      root,
      `${label}工作台`,
      "待关联用户需求",
      "设计完成待移交",
      "待验收与可关闭",
      "现在需要您处理的事项",
      id === "DM"
        ? "团队与我维护的需求（按维护人筛选）"
        : "我维护的需求（移交研发后仍可持续跟进）",
    );
    expect(metric(root, "设计完成待移交")).toBe("1");
    find(root, "button", "一键生成研发需求").click();
    expect(ctx.navigate).toHaveBeenCalledWith("intake", {
      requirementId: requirement.id,
      title: requirement.title,
      category: "feature",
      product: "9",
      module: "12",
      feedbackBy: story.feedbackBy,
    });
    find(root, "button", "一键移交研发").click();
    expect(ctx.openTool).toHaveBeenCalledWith("handoff_story", {
      storyId: story.id,
      mode: "from_design",
    });
    expect(find(root, "a", "在禅道关闭收尾").attributes.get("href")).toBe(
      story.url,
    );
    expect(ctx.openTool).not.toHaveBeenCalledWith(
      "close_stories",
      expect.anything(),
    );
  });

  it("研发主管区分未就绪和待接收，并进入对应的指派和拆解表单", async () => {
    const waiting = {
      ...story,
      id: 99,
      title: "需要完善的草稿",
      status: "draft",
      waitingFor: story.maintainer,
    };
    const { root, ctx } = page(
      "RM",
      "研发主管",
      [
        "get_my_work",
        "get_team_work",
        "get_monthly_dev_queue",
        "assign_story",
        "decompose_stories",
        "get_story_progress",
      ],
      {
        get_my_work: data({
          new: [story],
          waiting_ready: [waiting],
          action: { toReceive: [story, story] },
        }),
        get_team_work: data(
          { totals: { overdue: 4 } },
          { scope: { filters: { teams: ["fe"] } } },
        ),
        get_monthly_dev_queue: data(
          { counts: { inDev: 2 } },
          { scope: { filters: { teamIds: ["fe"] } } },
        ),
      },
    );
    await renderWorkbench(root, ctx);
    expect(metric(root, "待接收并拆解")).toBe("1");
    expect(metric(root, "组内在研需求")).toBe("2");
    expect(metric(root, "团队逾期任务（仅叶子）")).toBe("4");
    shows(
      root,
      "未就绪草稿已自动隔离",
      waiting.title,
      "新到的待接收需求（拆解即接收）",
    );
    find(root, "button", "退回状态维护人").click();
    expect(ctx.openTool).toHaveBeenCalledWith("assign_story", {
      storyIds: [waiting.id],
      to: story.maintainer.account,
    });
    find(root, "button", "一键建齐阶段任务").click();
    expect(ctx.openTool).toHaveBeenCalledWith("decompose_stories", {
      storyIds: [story.id],
      template: "feature",
    });
    find(root, "button", "去批量拆解 →").click();
    expect(ctx.navigate).toHaveBeenCalledWith("schedule", { tab: "queue" });
  });

  it("研发人员区分今日到期与逾期，跳转范围和补录，隐藏未授权写入", async () => {
    const { root, ctx } = page(
      "RD",
      "研发人员",
      ["get_my_work", "create_story", "get_story_progress"],
      {
        get_my_work: data({
          action: {
            overdue: [{ ...task, id: 13, isParent: true }],
            dueToday: [task],
            unscheduled: [],
          },
          new: [
            task,
            story,
            {
              ...task,
              id: 21,
              name: "新分配的正常任务",
              timeState: "on_track",
              url: "javascript:void(0)",
            },
            { ...story, id: 21 },
          ],
        }),
      },
    );
    await renderWorkbench(root, ctx);
    expect(metric(root, "当前逾期")).toBe("0");
    expect(metric(root, "今日到期")).toBe("1");
    expect(metric(root, "临近截止 / 未排期")).toBe("0");
    expect(root.textContent.split(task.name)).toHaveLength(2);
    find(root, "button", "看范围与章节").click();
    expect(ctx.openStory).toHaveBeenCalledWith(story.id, "dev");
    find(root, "button", "急事补录草稿").click();
    expect(ctx.navigate).toHaveBeenCalledWith("intake", { mode: "backfilled" });
    expect(find(root, "a", "在禅道查看或拆子任务").attributes.get("href")).toBe(
      task.url,
    );
    shows(root, "新分配的正常任务");
    expect(root.descendants((entry) => entry.tag === "a")).toHaveLength(1);
    expect(ctx.openTool).not.toHaveBeenCalled();
  });

  it("测试人员只依真实就绪分组展示两个任务栏，并选择实际发布版本", async () => {
    const { root, ctx } = page(
      "QA",
      "测试人员",
      [
        "get_my_work",
        "scan_workflow_risks",
        "get_story_progress",
        "get_plan_progress",
      ],
      {
        get_my_work: data({
          can_start: {
            tests: [task],
            upcomingTests: [{ ...task, id: 12, name: "下一项测试" }],
          },
        }),
      },
    );
    await renderWorkbench(root, ctx);
    shows(
      root,
      "现在就能测（研发已完成）",
      "即将转测（可提前排期）",
      task.name,
      "下一项测试",
      "版本发布体检",
    );
    find(root, "button", "查看完整门禁与 Bug →").click();
    expect(ctx.navigate).toHaveBeenCalledWith("release-risks", { tab: "gate" });
    expect(ctx.call).not.toHaveBeenCalledWith(
      "get_plan_progress",
      expect.anything(),
    );
  });

  it.each(["meridian", "zentao"] as const)(
    "测试人员的 %s 首页用已配置产品版本回查门禁与活跃 Bug",
    async (mode) => {
      const release = { product: 9, version: "V2.4.1", date: "2026-11-30" };
      const bug = {
        id: 77,
        title: "正式发布阻断问题",
        severity: 1,
        url: "https://zentao.example/bug/77",
      };
      const { root, ctx } = page(
        "QA",
        "测试人员",
        ["get_my_work", "get_plan_progress"],
        {
          get_my_work: data({ can_start: { tests: [task] } }),
          get_plan_progress: data({
            view: "release",
            productId: release.product,
            version: release.version,
            releaseDate: release.date,
            gate: "blocked",
            testIncompleteStoryIds: [story.id],
            openSeriousBugs: [bug],
            openBugs: [bug],
          }),
        },
        { mode, releaseCalendar: [release] },
      );
      await renderWorkbench(root, ctx);
      expect(ctx.call).toHaveBeenCalledWith("get_plan_progress", {
        view: "release",
        product: String(release.product),
        version: release.version,
      });
      if (mode === "zentao") {
        root
          .descendants(
            (node) =>
              node.tag === "button" &&
              node.textContent.startsWith("活跃 Bug 列表"),
          )[0]
          ?.click();
        shows(root, bug.title);
        expect(find(root, "a", bug.title).attributes.get("href")).toBe(bug.url);
      } else {
        shows(root, release.version, "发布阻断", "1 条");
      }
    },
  );

  it("产品管理使用计划真实月份与不同分母，选择版本后查询发布门禁", async () => {
    const storyDeliveryRate = { numerator: 1, denominator: 2, rate: 0.5 };
    const taskCompletionRate = { numerator: 3, denominator: 4, rate: 0.75 };
    const { root, ctx } = page(
      "PM",
      "产品管理",
      ["get_plan_progress", "scan_workflow_risks", "set_story_meta"],
      {
        get_plan_progress: data({
          view: "plan",
          storyDeliveryRate,
          taskCompletionRate,
          groups: [{ key: 12, storyDeliveryRate }],
        }),
      },
    );
    await renderWorkbench(root, ctx);
    shows(
      root,
      "11 月各模块 L3 计划完成度",
      "需求交付率 50%（1/2）",
      "叶子任务完成率 75%（3/4）",
      "模块 #12",
      "发布门禁",
    );
    find(root, "button", "查看发布门禁").click();
    expect(ctx.navigate).toHaveBeenCalledWith("release-risks", { tab: "gate" });
    expect(ctx.call).toHaveBeenCalledExactlyOnceWith("get_plan_progress", {
      view: "plan",
      month: "本月",
      groupBy: "module",
    });
  });

  it("项目管理去重快照基线，只数有原因的顺延并将真实风险链接到详情", async () => {
    const { root, ctx } = page(
      "PJ",
      "项目管理",
      ["scan_workflow_risks", "get_plan_progress", "get_story_progress"],
      {
        scan_workflow_risks: data({
          hits: [
            {
              rule: "R02",
              severity: "high",
              level: "inferred",
              object: { ...story, type: "story" },
              owner: person,
              reason: "缺测试任务",
            },
          ],
          summary: [{ rule: "R02", name: "研发完成测试未接续", count: 1 }],
        }),
        get_plan_progress: data({
          view: "commitment",
          snapshotAvailable: true,
          snapshots: [{ productId: 9, takenAt: 1793520000000 }],
          missingSnapshotProductIds: [],
          fulfilled: [37],
          pendingStoryIds: [38, 38],
          cancelledStoryIds: [],
          unknownStoryIds: [],
          carriedOver: [
            { id: 41, reason: "等待接口" },
            { id: 42, reason: null },
          ],
        }),
      },
    );
    await renderWorkbench(root, ctx);
    expect(metric(root, "高危阻断卡点")).toBe("1");
    expect(metric(root, "11 月承诺基线")).toBe("4 条");
    expect(metric(root, "已留痕顺延 / 挪月")).toBe("1 条");
    shows(
      root,
      "最值得现在推动的 5 个卡点",
      "研发完成测试未接续",
      "缺测试任务",
      "推测",
    );
    find(root, "button", "查看详情").click();
    expect(ctx.openStory).toHaveBeenCalledWith(story.id, "full");
  });

  it("来源失败或数据不全时保留缺口，避免把缺失计成零", async () => {
    const { root, ctx } = page(
      "PJ",
      "项目管理",
      ["scan_workflow_risks", "get_plan_progress"],
      {
        scan_workflow_risks: data(
          { hits: [], summary: [] },
          {
            completeness: "partial",
            gaps: [{ source: "迭代 3", reason: "任务读取超时" }],
          },
        ),
        get_plan_progress: Object.assign(new Error("读取快照失败"), {
          status: 503,
        }),
      },
    );
    await renderWorkbench(root, ctx);
    expect(metric(root, "高危阻断卡点")).toBe("—");
    expect(metric(root, "本月承诺基线")).toBe("—");
    shows(root, "数据不完整", "任务读取超时", "读取快照失败");
  });

  it("职责切换后忽略旧工作台返回的结果", async () => {
    const { root, ctx } = page("FB", "业务反馈者", ["get_my_work"], {});
    let finish: (value: unknown) => void = () => {};
    ctx.call.mockImplementationOnce(
      () =>
        new Promise((resolve) => {
          finish = resolve;
        }),
    );
    const loading = renderWorkbench(root, ctx);
    ctx.current.mockReturnValue(false);
    root.replaceChildren();
    finish(data({ raised: [story] }));
    await loading;
    expect(root.textContent).toBe("");
  });
});
