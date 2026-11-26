import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const management = "../../web/management-pages.js";
const { renderSchedule, renderReleaseRisks } = (await import(management)) as {
  renderSchedule: Renderer;
  renderReleaseRisks: Renderer;
};
const review = "../../web/review-page.js";
const { renderShortcuts } = (await import(review)) as {
  renderShortcuts: Renderer;
};

type Renderer = (
  root: ElementStub,
  ctx: ReturnType<typeof context>,
  initial?: Record<string, unknown>,
) => void;

class ElementStub {
  readonly attributes = new Map<string, string>();
  readonly children: ElementStub[] = [];
  readonly style: Record<string, string> = {};
  readonly ownerDocument = {
    createElement: (tag: string) => new ElementStub(tag),
    createElementNS: (_namespace: string, tag: string) => new ElementStub(tag),
  };
  private readonly handlers = new Map<
    string,
    (event: { preventDefault: () => void }) => void
  >();
  private text = "";
  parentNode: ElementStub | null = null;
  className = "";
  value = "";
  disabled = false;

  constructor(readonly tag: string) {}

  get textContent(): string {
    return [this.text, ...this.children.map((child) => child.textContent)]
      .filter(Boolean)
      .join(" ");
  }

  set textContent(value: string) {
    this.replaceChildren();
    this.text = value;
  }

  set innerHTML(_: string) {
    throw new Error("请使用文本节点渲染。");
  }

  append(...children: Array<ElementStub | string>) {
    for (const child of children) {
      const node = typeof child === "string" ? new ElementStub("#text") : child;
      if (typeof child === "string") node.textContent = child;
      node.remove();
      node.parentNode = this;
      this.children.push(node);
    }
  }

  remove() {
    this.parentNode?.removeChild(this);
  }

  removeChild(child: ElementStub) {
    const index = this.children.indexOf(child);
    if (index >= 0) this.children.splice(index, 1);
    child.parentNode = null;
  }

  replaceChildren(...children: ElementStub[]) {
    for (const child of this.children) child.parentNode = null;
    this.children.length = 0;
    this.text = "";
    this.append(...children);
  }

  setAttribute(name: string, value: string) {
    this.attributes.set(name, value);
  }

  getAttribute(name: string) {
    return this.attributes.get(name) ?? null;
  }

  removeAttribute(name: string) {
    this.attributes.delete(name);
  }

  addEventListener(
    type: string,
    handler: (event: { preventDefault: () => void }) => void,
  ) {
    this.handlers.set(type, handler);
  }

  emit(type: string) {
    if (type === "click" && this.disabled) return;
    this.handlers.get(type)?.({ preventDefault: () => {} });
  }

  all(predicate: (node: ElementStub) => boolean): ElementStub[] {
    return [
      ...(predicate(this) ? [this] : []),
      ...this.children.flatMap((child) => child.all(predicate)),
    ];
  }

  withClass(name: string) {
    return this.all((node) => node.className.split(" ").includes(name));
  }

  button(label: string) {
    const node = this.all(
      (node) => node.tag === "button" && node.textContent.includes(label),
    )[0];
    if (!node) throw new Error(`未找到按钮 ${label}`);
    return node;
  }
}

function context(role: string, actions: string[]) {
  const controller = new AbortController();
  const requests: Array<ReturnType<typeof Promise.withResolvers<unknown>>> = [];
  const call = vi.fn((_tool: string, _input: Record<string, unknown>) => {
    const request = Promise.withResolvers<unknown>();
    requests.push(request);
    return request.promise;
  });
  return {
    role: { id: role, actions },
    account: "test-account",
    developmentTeams: [{ id: "test-team", name: "测试研发组", members: [] }],
    controller,
    signal: controller.signal,
    current: () => !controller.signal.aborted,
    call,
    requests,
    navigate: vi.fn(),
    openStory: vi.fn(),
    openTool: vi.fn(),
  };
}

const report = (data: unknown) => ({
  ok: true,
  completeness: "complete",
  scope: { filters: {} },
  data,
});

const queueReport = report({
  buckets: {
    toReceive: [],
    inDev: [],
    carriedOver: [],
    planNoIteration: [],
    iterationNoPlan: [],
  },
  counts: { mainPool: 0 },
});

const showPlaceholders = () => vi.advanceTimersByTimeAsync(120);
const finishRequests = () => vi.advanceTimersByTimeAsync(0);
const busy = (root: ElementStub) =>
  root.all((node) => node.getAttribute("aria-busy") === "true");

describe("本地门户管理页异步占位", () => {
  beforeEach(() => vi.useFakeTimers());
  afterEach(() => vi.useRealTimers());

  it("排期队列保留真实筛选和五桶标题，旧请求无法覆盖新版空态", async () => {
    const root = new ElementStub("main");
    const ctx = context("RM", ["get_monthly_dev_queue", "decompose_stories"]);
    renderSchedule(root, ctx);
    const team = root.button("测试研发组");
    expect(root.textContent).toContain("本月待研发与批量拆解");
    expect(root.textContent).toContain("上月遗留");
    expect(root.withClass("management-skel-queue-table")).toHaveLength(0);
    await showPlaceholders();
    expect(root.withClass("management-skel-queue-table")).toHaveLength(1);
    expect(root.withClass("management-skel-bucket-value")).toHaveLength(5);
    expect(root.button("一键建齐阶段任务").disabled).toBe(true);

    team.emit("click");
    expect(root.button("测试研发组")).toBe(team);
    ctx.requests[0]?.reject(new Error("旧查询已失败"));
    await showPlaceholders();
    expect(root.withClass("management-skel-queue-table")).toHaveLength(1);
    expect(root.textContent).not.toContain("旧查询已失败");
    ctx.requests[1]?.resolve(queueReport);
    await finishRequests();
    expect(root.textContent).toContain("该分组当前为空");
    expect(root.withClass("management-skel-queue-table")).toHaveLength(0);
    expect(busy(root)).toHaveLength(0);
  });

  it("四周矩阵与试算人选各自占位，失败后清理两个区域", async () => {
    const root = new ElementStub("main");
    const ctx = context("RM", ["get_member_schedule"]);
    renderSchedule(root, ctx, {
      tab: "matrix",
      newTask: { estimateHours: 5 },
    });
    expect(root.textContent).toContain("未来 4 周成员工时热力矩阵");
    expect(root.button("试算人选").disabled).toBe(false);
    await showPlaceholders();
    const matrix = root.withClass("management-skel-matrix")[0];
    expect(matrix?.all((node) => node.tag === "th")).toHaveLength(7);
    expect(root.withClass("management-skel-recommendations")).toHaveLength(1);
    ctx.requests[0]?.reject(new Error("成员排期查询超时"));
    await finishRequests();
    expect(root.textContent).toContain("成员排期查询超时");
    expect(root.withClass("management-skel-matrix")).toHaveLength(0);
    expect(root.withClass("management-skel-recommendations")).toHaveLength(0);
    expect(busy(root)).toHaveLength(0);
  });

  it("门禁保留固定卡片和审批入口，快速失败不会出现占位", async () => {
    const root = new ElementStub("main");
    const ctx = context("PM", ["get_plan_progress", "set_story_meta"]);
    renderReleaseRisks(root, ctx, { version: "V1.0" });
    expect(root.textContent).toContain("未完成测试的需求");
    expect(root.textContent).toContain("阻断发布的 1–2 级未关闭 Bug");
    expect(root.button("批准例外放行").disabled).toBe(true);
    ctx.requests[0]?.reject(new Error("暂无可读取版本"));
    await showPlaceholders();
    expect(root.textContent).toContain("暂无可读取版本");
    expect(root.withClass("management-skel-gate-copy")).toHaveLength(0);
    expect(busy(root)).toHaveLength(0);
  });

  it("风险清单和计划面板并行保留各自的筛选和布局，切页后丢弃结果", async () => {
    const root = new ElementStub("main");
    const ctx = context("PJ", ["scan_workflow_risks", "get_plan_progress"]);
    renderReleaseRisks(root, ctx, { tab: "risks" });
    expect(root.button("高危阻断").disabled).toBe(true);
    await showPlaceholders();
    expect(root.withClass("management-skel-risk-list")).toHaveLength(1);
    root.button("L3 计划与承诺").emit("click");
    expect(root.textContent).toContain("月度模块计划（L3）进度");
    expect(root.textContent).toContain("迭代过程指标");
    expect(root.button("月初承诺基线").disabled).toBe(true);
    await showPlaceholders();
    expect(root.withClass("management-skel-l3")).toHaveLength(1);
    expect(root.withClass("management-skel-commitment")).toHaveLength(1);
    ctx.controller.abort();
    for (const request of ctx.requests) request.resolve(report({}));
    await finishRequests();
    expect(busy(root)).toHaveLength(0);
    expect(root.withClass("management-skel-l3")).toHaveLength(0);
    expect(root.withClass("management-skel-commitment")).toHaveLength(0);
    expect(root.textContent).not.toContain("查询失败");
  });

  it("助手只给远程请求显示占位，较早回复不会清掉另一条消息", async () => {
    const root = new ElementStub("div");
    const ctx = context("PM", [
      "get_story_progress",
      "scan_workflow_risks",
      "get_plan_progress",
    ]);
    renderShortcuts(root, ctx);
    const form = root.withClass("agent-composer")[0];
    const input = form?.children[0];
    if (!form || !input) throw new Error("未找到助手输入框");
    input.value = "查看发布门禁";
    form.emit("submit");
    await showPlaceholders();
    expect(ctx.call).not.toHaveBeenCalled();
    expect(root.textContent).toContain("在版本发布门禁核对");
    expect(root.withClass("management-skel-reply")).toHaveLength(0);

    input.value = "风险";
    form.emit("submit");
    input.value = "查看 #72";
    form.emit("submit");
    await showPlaceholders();
    expect(root.withClass("management-skel-reply")).toHaveLength(2);
    ctx.requests[0]?.resolve(report({ hits: [] }));
    await finishRequests();
    expect(root.textContent).toContain("已读取 0 项卡点");
    expect(root.withClass("management-skel-reply")).toHaveLength(1);
    ctx.requests[1]?.reject(new Error("需求进展查询失败"));
    await finishRequests();
    expect(root.textContent).toContain("需求进展查询失败");
    expect(root.withClass("management-skel-reply")).toHaveLength(0);
    expect(busy(root)).toHaveLength(0);
  });
});
