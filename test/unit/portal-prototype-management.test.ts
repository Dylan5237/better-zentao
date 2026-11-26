import { describe, expect, it, vi } from "vitest";

const managementModule = "../../web/management-pages.js";
const { renderReleaseRisks, renderSchedule } = (await import(
  managementModule
)) as {
  renderReleaseRisks: PageRenderer;
  renderSchedule: PageRenderer;
};

const reviewModule = "../../web/review-page.js";
const { sectionsFor, renderReview, renderGuide, renderShortcuts } =
  (await import(reviewModule)) as {
    sectionsFor: (role: { id: string; actions: string[] }) => {
      id: string;
      enabled: boolean;
      readOnly: boolean;
    }[];
    renderReview: (
      parent: ElementStub,
      ctx: ReturnType<typeof context>,
      records: Map<string, { status: string; note?: string }>,
    ) => void;
    renderGuide: PageRenderer;
    renderShortcuts: PageRenderer;
  };

type PageRenderer = (
  parent: ElementStub,
  ctx: ReturnType<typeof context>,
  initial?: Record<string, unknown>,
) => void;

type Listener = (event: { preventDefault: () => void }) => void;

class ElementStub {
  readonly children: ElementStub[] = [];
  readonly attributes = new Map<string, string>();
  readonly ownerDocument = {
    createElement: (tag: string) => new ElementStub(tag),
    createElementNS: (_namespace: string, tag: string) => new ElementStub(tag),
  };
  readonly style: Record<string, string> = {};
  private readonly listeners = new Map<string, Listener>();
  private content = "";
  className = "";
  name = "";
  value = "";
  checked = false;
  disabled = false;
  hidden = false;

  constructor(readonly tagName: string) {}

  get textContent(): string {
    return [this.content, ...this.children.map((child) => child.textContent)]
      .filter(Boolean)
      .join(" ");
  }

  set textContent(value: string) {
    this.content = value;
    this.children.length = 0;
  }

  set innerHTML(_: string) {
    throw new Error("需求与风险证据必须用安全的文本节点展示。");
  }

  append(...children: Array<ElementStub | string>) {
    for (const child of children) {
      if (typeof child !== "string") this.children.push(child);
      else {
        const node = new ElementStub("#text");
        node.textContent = child;
        this.children.push(node);
      }
    }
  }

  replaceChildren(...children: ElementStub[]) {
    this.textContent = "";
    this.append(...children);
  }

  setAttribute(name: string, value: string) {
    this.attributes.set(name, value);
  }

  addEventListener(type: string, listener: Listener) {
    this.listeners.set(type, listener);
  }

  emit(type: string) {
    if (type !== "click" || !this.disabled)
      this.listeners.get(type)?.({ preventDefault: () => {} });
  }

  find(predicate: (element: ElementStub) => boolean): ElementStub | undefined {
    if (predicate(this)) return this;
    for (const child of this.children) {
      const result = child.find(predicate);
      if (result) return result;
    }
  }

  button(label: string): ElementStub {
    return this.get(
      (node) => node.tagName === "button" && node.textContent.includes(label),
    );
  }

  get(predicate: (element: ElementStub) => boolean): ElementStub {
    const node = this.find(predicate);
    if (!node) throw new Error("未找到对应的管理页控件。");
    return node;
  }
}

function query(data: unknown, extras: object = {}) {
  return {
    ok: true,
    data,
    scope: {
      asOf: "2026-11-25T08:08:00.000Z",
      filters: { month: "2026-11" },
    },
    completeness: "complete",
    gaps: [],
    inferences: [],
    ...extras,
  };
}

function context(
  id: string,
  actions: string[],
  respond: (name: string, input: Record<string, unknown>) => unknown,
) {
  return {
    role: { id, label: id, actions },
    account: "signed-in",
    call: vi.fn(async (name: string, input: Record<string, unknown>) =>
      respond(name, input),
    ),
    current: () => true,
    navigate: vi.fn(),
    openTool: vi.fn(),
    openStory: vi.fn(),
    renderRead: vi.fn(),
    close: vi.fn(),
    canSwitchRole: (target: string) => target === id,
    switchRole: vi.fn(),
  };
}

function klass(node: ElementStub, name: string): boolean {
  return node.className.split(" ").includes(name);
}

const toReceive = {
  id: 72,
  title: "<img src=x> 排期优化",
  receiver: { account: "rm", realname: "研发主管" },
  progress: { value: "待接收", level: "inferred" },
  carriedOver: true,
};

describe("WEB-03 / WEB-04 原型管理页面", () => {
  it("v11 的拆解工作队列使用五项分桶样式，只读角色可进入并查看", async () => {
    const root = new ElementStub("main");
    const ctx = context("DM", ["get_monthly_dev_queue"], () =>
      query({
        buckets: {
          toReceive: [toReceive],
          inDev: [],
          carriedOver: [],
          planNoIteration: [],
          iterationNoPlan: [],
        },
        counts: { mainPool: 1 },
      }),
    );
    renderSchedule(root, ctx);
    await vi.waitFor(() => expect(root.textContent).toContain(toReceive.title));
    expect(
      root.get((node) => klass(node, "bucket-strip")).children,
    ).toHaveLength(5);
    expect(root.textContent).toContain("只读查看");
    expect(root.textContent).not.toContain("一键建齐阶段任务 (");
  });

  it("个人排期请求只读本人数据，无法提交团队临时指派试算", async () => {
    const root = new ElementStub("main");
    const ctx = context("RD", ["get_member_schedule"], () =>
      query({ members: [] }),
    );
    renderSchedule(root, ctx, {
      tab: "matrix",
      members: ["other"],
      newTask: { estimateHours: 10 },
    });
    await vi.waitFor(() => expect(ctx.call).toHaveBeenCalled());
    expect(ctx.call).toHaveBeenCalledWith("get_member_schedule", {
      members: ["signed-in"],
      bucket: "week",
    });
    expect(root.textContent).toContain("我的月度排期");
    expect(root.textContent).not.toContain("临时任务推荐谁");
  });

  it("AC-42 / AC-54 展示五桶和未就绪，所选需求进入一张真实批量预览", async () => {
    const root = new ElementStub("main");
    const ctx = context(
      "RM",
      ["get_monthly_dev_queue", "decompose_stories"],
      () =>
        query({
          buckets: {
            toReceive: [toReceive, { ...toReceive, id: 73 }],
            inDev: [],
            carriedOver: [],
            planNoIteration: [],
            iterationNoPlan: [],
          },
          counts: {
            mainPool: 2,
            toReceive: 2,
            inDev: 0,
            carriedOver: 0,
            planNoIteration: 0,
            iterationNoPlan: 0,
            notReady: 1,
            missing: 0,
            unbucketed: 0,
          },
          notReady: [{ ...toReceive, id: 75, title: "等待设计完成" }],
        }),
    );
    renderSchedule(root, ctx);
    await vi.waitFor(() => expect(root.textContent).toContain("等待设计完成"));
    expect(
      root.get((node) => klass(node, "bucket-strip")).children,
    ).toHaveLength(5);
    expect(root.textContent).toContain(toReceive.title);
    expect(ctx.call).toHaveBeenCalledWith("get_monthly_dev_queue", {
      includeNotReady: true,
    });
    for (const id of [72, 73]) {
      const pick = root.get(
        (node) => node.attributes.get("aria-label") === `选择需求 #${id}`,
      );
      pick.checked = true;
      pick.emit("change");
    }
    root.button("一键建齐阶段任务 (2)").emit("click");
    root.get((node) => node.name === "devAssignee").value = "rd-dev";
    root.get((node) => node.name === "devDeadline").value = "2026-12-03";
    root.get((node) => node.name === "testAssignee").value = "qa-member";
    root
      .get(
        (node) =>
          node.tagName === "form" && klass(node, "management-decompose"),
      )
      .emit("submit");
    expect(ctx.openTool).toHaveBeenCalledWith(
      "decompose_stories",
      {
        storyIds: [72, 73],
        template: "feature",
        assignees: { dev: "rd-dev", test: "qa-member" },
        dates: { dev: { deadline: "2026-12-03" } },
        notify: true,
      },
      { preview: true },
    );
    expect(ctx.call).toHaveBeenCalledTimes(1);
  });

  it("AC-40 / AC-41 从排期契约展示四周负荷，提交工时和日期试算", async () => {
    const root = new ElementStub("main");
    const ctx = context("PJ", ["get_member_schedule"], (_name, input) =>
      query({
        members: [
          {
            account: "rd-dev",
            realname: "研发同事",
            capacityHours: 42,
            buckets: [
              ["11-26", "12-02"],
              ["12-03", "12-09"],
              ["12-10", "12-16"],
              ["12-17", "12-23"],
            ].map(([start, end]) => ({
              start: `2026-${start}`,
              end: `2026-${end}`,
              leftHours: 4,
              taskCount: 2,
              missingEstimate: 1,
            })),
            overdue: [
              { id: 8, name: "逾期核对", deadline: "2026-11-23", left: 2 },
            ],
            unscheduled: [{ id: 9, name: "尚未排期" }],
          },
        ],
        suggestions: input.newTask
          ? [
              {
                account: "rd-dev",
                realname: "研发同事",
                suggestedDeadline: "2026-12-03",
                reason: "截至期望日期，已知剩余容量 10 小时。",
              },
            ]
          : undefined,
      }),
    );
    renderSchedule(root, ctx, { tab: "matrix" });
    await vi.waitFor(() =>
      expect(root.textContent).toContain("区间已排 16h / 总容量 58h"),
    );
    expect(root.textContent).toContain("缺工时 4");
    expect(root.textContent).toContain("逾期任务");
    expect(root.textContent).toContain("未排期任务");
    expect(root.textContent).toContain("12-17 ~ 12-23");
    expect(
      root.button("月度待研发与批量拆解").attributes.get("aria-pressed"),
    ).toBe("false");
    root.get((node) => node.name === "estimateHours").value = "5.5";
    root.get((node) => node.name === "deadline").value = "2026-12-04";
    root
      .get(
        (node) => node.tagName === "form" && klass(node, "management-suggest"),
      )
      .emit("submit");
    await vi.waitFor(() =>
      expect(root.textContent).toContain("已知剩余容量 10 小时"),
    );
    expect(ctx.call).toHaveBeenLastCalledWith("get_member_schedule", {
      bucket: "week",
      newTask: { estimateHours: 5.5, deadline: "2026-12-04" },
    });
  });

  it("AC-46 设计人员从拆解与排期进入设计模板，不读取研发队列", () => {
    const root = new ElementStub("main");
    const ctx = context("DS", ["decompose_stories"], () => {
      throw new Error("设计任务入口不应调用研发队列或成员排期。");
    });
    renderSchedule(root, ctx, { storyId: 72 });
    root.button("配置设计阶段任务").emit("click");
    expect(root.textContent).toContain("【设计】【评审】【传递】");
    expect(ctx.openTool).toHaveBeenCalledWith("decompose_stories", {
      template: "design",
      storyIds: [72],
    });
    expect(ctx.call).not.toHaveBeenCalled();
  });

  it("AC-62 / AC-63 门禁读实际版本，产品管理跳转关联需求的例外预览", async () => {
    const root = new ElementStub("main");
    const ctx = context(
      "PM",
      ["get_plan_progress", "set_story_meta", "get_story_progress"],
      () =>
        query({
          view: "release",
          version: "V7.1.0",
          productId: 29,
          releaseDate: "2026-12-08",
          workdaysUntilRelease: 2,
          gate: "blocked",
          storyIds: [72],
          progressGroups: [{ progress: "测试中", storyIds: [72] }],
          testCompletionRate: { numerator: 0, denominator: 1, rate: 0 },
          testIncompleteStoryIds: [72],
          testEvidenceMissingStoryIds: [],
          openSeriousBugs: [
            { id: 21, story: 72, severity: 1, title: "阻断下载" },
          ],
          waivers: [],
        }),
    );
    renderReleaseRisks(root, ctx, {
      tab: "release",
      version: "V7.1.0",
      product: "29",
    });
    await vi.waitFor(() => expect(root.textContent).toContain("红灯阻断"));
    expect(ctx.call).toHaveBeenCalledWith("get_plan_progress", {
      view: "release",
      version: "V7.1.0",
      product: "29",
    });
    expect(root.textContent).toContain("阻断下载");
    root.button("批准例外放行").emit("click");
    root.button("填写例外原因").emit("click");
    expect(ctx.openTool).toHaveBeenCalledWith("set_story_meta", {
      storyId: 72,
      waiver: { rule: "R13" },
    });
  });

  it("空版本保持待查询，QA 风险页显示真实缺口及其他视图的权限说明", async () => {
    const pm = new ElementStub("main");
    const pmCtx = context("PM", ["get_plan_progress"], () => {
      throw new Error("空版本不应调用查询");
    });
    renderReleaseRisks(pm, pmCtx);
    expect(pm.textContent).toContain("选择产品与发布版本");
    expect(pmCtx.call).not.toHaveBeenCalled();

    const qa = new ElementStub("main");
    const qaCtx = context("QA", ["scan_workflow_risks"], () =>
      query(
        { hits: [], summary: [] },
        {
          completeness: "partial",
          gaps: [{ source: "tasks:49", reason: "迭代读取超时" }],
        },
      ),
    );
    renderReleaseRisks(qa, qaCtx, { tab: "risks" });
    await vi.waitFor(() => expect(qa.textContent).toContain("迭代读取超时"));
    expect(qaCtx.call).toHaveBeenCalledWith("scan_workflow_risks", {
      scope: { mine: true },
    });
    expect(qa.textContent).toContain("无法确认全量风险");
    expect(qa.textContent).not.toContain("模拟");
    qa.button("版本发布门禁").emit("click");
    expect(qa.textContent).toContain("当前职责没有发布门禁读取权限");
    qa.button("L3 计划与承诺").emit("click");
    expect(qa.textContent).toContain(
      "L3 月度计划与承诺由产品管理和项目管理查询",
    );
    expect(qaCtx.call).toHaveBeenCalledTimes(1);
  });

  it("QA 可读取实际版本，部分数据不能给绿灯，切换风险标签保留版本查询", async () => {
    const root = new ElementStub("main");
    const ctx = context(
      "QA",
      ["get_plan_progress", "scan_workflow_risks"],
      (tool) => {
        if (tool === "scan_workflow_risks")
          return query({ hits: [], summary: [] });
        return query(
          {
            view: "release",
            version: "V7.1.1",
            gate: "ready",
            testCompletionRate: { numerator: 1, denominator: 1, rate: 1 },
            waivers: [],
          },
          {
            completeness: "partial",
            gaps: [{ source: "bugs:29", reason: "产品缺陷读取超时" }],
          },
        );
      },
    );
    renderReleaseRisks(root, ctx, { tab: "gate", version: "V7.1.1" });
    await vi.waitFor(() => expect(root.textContent).toContain("门禁待核实"));
    expect(root.textContent).toContain("产品缺陷读取超时");
    expect(root.textContent).not.toContain("绿灯通过");
    expect(root.button("仅产品管理可批准例外").disabled).toBe(true);
    expect(root.textContent).toContain("L3 计划与承诺");
    root.button("风险与卡点").emit("click");
    await vi.waitFor(() =>
      expect(root.textContent).toContain("当前筛选范围暂未发现卡点"),
    );
    root.button("版本发布门禁").emit("click");
    expect(root.get((node) => node.name === "version").value).toBe("V7.1.1");
    expect(root.textContent).toContain("门禁待核实");
    expect(ctx.call).toHaveBeenCalledTimes(2);
    expect(ctx.openTool).not.toHaveBeenCalled();
  });

  it("AC-53 / AC-69 巡检按严重程度筛选，研发主管可进入缺阶段补建预览", async () => {
    const root = new ElementStub("main");
    const ctx = context(
      "RM",
      ["scan_workflow_risks", "decompose_stories", "get_story_progress"],
      () =>
        query({
          hits: [
            {
              rule: "R02",
              severity: "high",
              level: "inferred",
              object: { type: "story", id: 72, title: "测试待接续" },
              reason: "研发已完成",
              suggestion: "补建测试任务",
            },
            {
              rule: "R05",
              severity: "medium",
              level: "recorded",
              object: { type: "story", id: 73, title: "验收范围待核对" },
              reason: "验收标准缺失",
            },
          ],
          summary: [
            { rule: "R02", name: "阶段缺口", count: 1 },
            { rule: "R05", name: "验收内容", count: 1 },
          ],
        }),
    );
    renderReleaseRisks(root, ctx, { tab: "risks", team: "fe", product: "29" });
    await vi.waitFor(() => expect(root.textContent).toContain("测试待接续"));
    expect(ctx.call).toHaveBeenCalledWith("scan_workflow_risks", {
      scope: { team: "fe", product: "29" },
    });
    root.button("高危阻断").emit("click");
    expect(root.textContent).toContain("推测");
    expect(root.textContent).not.toContain("验收范围待核对");
    root.button("补齐阶段任务").emit("click");
    expect(ctx.openTool).toHaveBeenCalledWith("decompose_stories", {
      storyIds: [72],
      template: "next_stage",
    });
  });

  it("AC-60 / AC-65 计划比率分开展示，无快照显示待补齐", async () => {
    const root = new ElementStub("main");
    const ctx = context("PJ", ["get_plan_progress"], (_, input) =>
      query(
        input.view === "plan"
          ? {
              view: "plan",
              groups: [],
              planIds: [1],
              storyDeliveryRate: { numerator: 2, denominator: 4, rate: 0.5 },
              taskCompletionRate: { numerator: 3, denominator: 4, rate: 0.75 },
            }
          : {
              view: "commitment",
              snapshots: [],
              snapshotAvailable: false,
              missingSnapshotProductIds: [29],
              carriedOver: [],
            },
      ),
    );
    renderReleaseRisks(root, ctx, { tab: "plans" });
    await vi.waitFor(() =>
      expect(root.textContent).toContain("缺少月初承诺快照"),
    );
    expect(root.textContent).toContain("50%（2 / 4）");
    expect(root.textContent).toContain("75%（3 / 4）");
    expect(root.textContent).toContain("#29");
  });
});

describe("v11 评审与说明抽屉", () => {
  it("业务反馈者只显示两个入口，其余职责按职责标记只读", () => {
    expect(
      sectionsFor({ id: "FB", actions: ["create_story"] }).map(({ id }) => id),
    ).toEqual(["workbench", "intake"]);
    const dm = sectionsFor({
      id: "DM",
      actions: ["query_stories", "create_story"],
    });
    expect(dm).toContainEqual(
      expect.objectContaining({
        id: "schedule",
        enabled: true,
        readOnly: true,
      }),
    );
    expect(dm).toContainEqual(
      expect.objectContaining({
        id: "release-risks",
        enabled: true,
        readOnly: true,
      }),
    );
    expect(dm).toContainEqual(
      expect.objectContaining({
        id: "review-board",
        enabled: true,
        readOnly: false,
      }),
    );
  });

  it("现场评审进度随获准角色表决更新，只读角色无法修改已有表决", () => {
    const records = new Map<string, { status: string; note?: string }>();
    const root = new ElementStub("main");
    renderReview(
      root,
      context("DM", [], () => undefined),
      records,
    );
    expect(
      root.get((node) => klass(node, "decisions-grid-2")).children,
    ).toHaveLength(5);
    root.button("✓ 通过").emit("click");
    expect(root.textContent).toContain("现场表决进度：1 / 16");
    expect(records.get("D-01")?.status).toBe("通过");
    const readonly = new ElementStub("main");
    renderReview(
      readonly,
      context("QA", [], () => undefined),
      records,
    );
    expect(readonly.button("需调整").disabled).toBe(true);
    readonly.button("需调整").emit("click");
    expect(records.get("D-01")?.status).toBe("通过");
    expect(readonly.textContent).toContain("17 条协作规范速查");
  });

  it("评审说明包含四段走查，一句话示例走真实入口而不执行写入", () => {
    const guide = new ElementStub("div");
    const ctx = context("FB", ["get_my_work", "create_story"], () => undefined);
    renderGuide(guide, ctx);
    expect(
      guide.get((node) => klass(node, "walkthrough-list")).children,
    ).toHaveLength(4);
    const assistant = new ElementStub("div");
    renderShortcuts(assistant, ctx);
    assistant.button("发送这句话").emit("click");
    expect(
      assistant.get((node) => klass(node, "chat-bubble")).textContent,
    ).toContain("我提的需求");
    expect(ctx.call).not.toHaveBeenCalled();
    expect(ctx.openTool).not.toHaveBeenCalled();
  });
});
