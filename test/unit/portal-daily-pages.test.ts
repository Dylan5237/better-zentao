import { afterEach, describe, expect, it, vi } from "vitest";
import { allTools } from "../../src/contracts/tools/index.ts";
// @ts-expect-error The packaged portal is a native browser module.
import * as dailyPages from "../../web/daily-pages.js";

const { renderIntake, renderStories, renderStoryDrawer } = dailyPages;

type Call = (tool: string, input: Record<string, unknown>) => Promise<unknown>;
type Listener = (event: Event) => void | Promise<void>;

class ElementStub {
  readonly children: ElementStub[] = [];
  readonly attributes = new Map<string, string>();
  readonly ownerDocument = {
    createElement: (tag: string) => new ElementStub(tag),
  };
  private readonly events = new Map<string, Listener[]>();
  private content = "";
  parent?: ElementStub;
  value = "";
  hidden = false;
  className = "";

  constructor(readonly tagName: string) {}

  get isConnected(): boolean {
    return this.tagName === "main" || this.parent?.isConnected === true;
  }

  get textContent(): string {
    return [
      this.content,
      ...this.children.map((child) => child.textContent),
    ].join(" ");
  }

  set textContent(value: string) {
    this.replaceChildren();
    this.content = value;
  }

  set innerHTML(_: string) {
    throw new Error("禅道内容必须作为文本展示。");
  }

  append(...children: ElementStub[]): void {
    for (const child of children) child.parent = this;
    this.children.push(...children);
  }

  replaceChildren(...children: ElementStub[]): void {
    for (const child of this.children) delete child.parent;
    this.children.length = 0;
    this.content = "";
    this.append(...children);
  }

  setAttribute(name: string, value: string): void {
    this.attributes.set(name, value);
  }

  removeAttribute(name: string): void {
    this.attributes.delete(name);
  }

  remove(): void {
    const parent = this.parent;
    if (parent)
      parent.replaceChildren(
        ...parent.children.filter((child) => child !== this),
      );
  }

  addEventListener(type: string, listener: Listener): void {
    this.events.set(type, [...(this.events.get(type) ?? []), listener]);
  }

  async emit(
    type: string,
    event = new Event(type, { bubbles: true }),
  ): Promise<void> {
    for (const listener of this.events.get(type) ?? []) await listener(event);
    if (!event.cancelBubble) await this.parent?.emit(type, event);
  }

  find(predicate: (node: ElementStub) => boolean): ElementStub {
    const nodes: ElementStub[] = [...this.children];
    for (const node of nodes) {
      if (predicate(node)) return node;
      nodes.push(...node.children);
    }
    throw new Error("测试找不到对应控件。");
  }
}

const date = "2026-11-26T01:02:03Z";
const story = {
  id: 72,
  title: "<img src=x> 部门筛选",
  url: "https://zentao.example/story-view-72.html",
  category: "design",
  status: "draft",
  product: { id: 4, name: "业务平台", untrusted: true },
  module: { id: 81, path: "组织管理", untrusted: true },
  progress: { value: "未就绪", level: "recorded" },
  maintainer: { account: "design", realname: "设计人员", untrusted: true },
  currentOwner: { account: "review", realname: "评审人员", untrusted: true },
  riskCodes: [],
  untrusted: true,
};

function result(data: object, partial = false) {
  return {
    ok: true,
    data,
    scope: { asOf: date, filters: {} },
    completeness: partial ? "partial" : "complete",
    gaps: partial ? [{ source: "story:82", reason: "读取超时" }] : [],
    inferences: [],
  };
}

function context(call: Call, actions: readonly string[] = []) {
  const prefill = vi.fn();
  return {
    role: { id: "DM", label: "设计主管", actions },
    account: "design",
    call,
    current: () => true,
    navigate: vi.fn(),
    openTool: vi.fn(),
    openStory: vi.fn(),
    close: vi.fn(),
    prefill,
    renderWrite: vi.fn(() => ({ prefill })),
  };
}

function button(root: ElementStub, text: string) {
  return root.find(
    (node) => node.tagName === "button" && node.textContent === text,
  );
}

afterEach(() => {
  vi.useRealTimers();
  vi.unstubAllGlobals();
});

describe("CR-002 WEB-03 原型需求工作流", () => {
  it("只在延迟读取的诉求列表显示卡片骨架，完成时进入空态", async () => {
    vi.useFakeTimers();
    const response = Promise.withResolvers<unknown>();
    const call = vi.fn<Call>().mockReturnValue(response.promise);
    const ctx = context(call, ["query_stories", "create_story"]);
    const root = new ElementStub("main");
    const loading = renderIntake(root, ctx);
    const list = root.find((node) =>
      node.className.includes("intake-req-list"),
    );
    expect(root.textContent).toContain("待关联的用户需求");
    expect(list.attributes.get("aria-busy")).toBe("true");
    await vi.advanceTimersByTimeAsync(119);
    expect(list.children).toHaveLength(0);
    await vi.advanceTimersByTimeAsync(1);
    expect(
      list.find((node) => node.className === "req-intake-card"),
    ).toBeTruthy();
    expect(() => list.find((node) => node.tagName === "button")).toThrow();

    response.resolve(result({ items: [], countsByProgress: {} }));
    await loading;
    expect(list.attributes.has("aria-busy")).toBe(false);
    expect(list.textContent).toContain("当前范围内没有待关联的用户需求");
  });

  it("看板保留列头，切换台账后旧请求不会移除台账骨架或覆盖失败提示", async () => {
    vi.useFakeTimers();
    const board = Promise.withResolvers<unknown>();
    const ledger = Promise.withResolvers<unknown>();
    const call = vi
      .fn<Call>()
      .mockReturnValueOnce(board.promise)
      .mockReturnValueOnce(ledger.promise);
    const root = new ElementStub("main");
    const loading = renderStories(root, context(call, ["query_stories"]));
    const firstColumn = root.find(
      (node) => node.className === "board-col-card",
    );
    expect(firstColumn.textContent).toContain("设计中");
    await vi.advanceTimersByTimeAsync(120);
    expect(
      firstColumn.find((node) => node.className === "story-board-card"),
    ).toBeTruthy();

    const change = button(root, "全部需求台账").emit("click");
    const table = root.find(
      (node) => node.className === "table-wrap vp-table-scroll",
    );
    expect(table.textContent).toContain("需求标题与归属");
    expect(root.find((node) => node.tagName === "select")).toBeTruthy();
    await vi.advanceTimersByTimeAsync(120);
    expect(table.find((node) => node.tagName === "td")).toBeTruthy();
    board.resolve(result({ items: [story], countsByProgress: { 未就绪: 1 } }));
    await loading;
    expect(table.find((node) => node.tagName === "td")).toBeTruthy();
    expect(root.textContent).not.toContain(story.title);
    ledger.reject(new Error("台账读取超时"));
    await change;
    expect(root.textContent).toContain("台账读取超时");
    expect(() => table.find((node) => node.tagName === "td")).toThrow();
    expect(table.attributes.has("aria-busy")).toBe(false);
  });

  it("详情抽屉按标签显示不同骨架，迟到的概览结果不覆盖研发范围", async () => {
    vi.useFakeTimers();
    const overview = Promise.withResolvers<unknown>();
    const dev = Promise.withResolvers<unknown>();
    const call = vi
      .fn<Call>()
      .mockReturnValueOnce(overview.promise)
      .mockReturnValueOnce(dev.promise);
    const root = new ElementStub("main");
    const loading = renderStoryDrawer(
      root,
      context(call, ["get_story_progress"]),
      72,
    );
    const content = root.find((node) =>
      node.className.includes("daily-drawer-content"),
    );
    await vi.advanceTimersByTimeAsync(120);
    expect(
      content.find((node) => node.className === "drawer-meta-card"),
    ).toBeTruthy();
    expect(button(root, "研发看范围")).toBeTruthy();

    const change = button(root, "研发看范围").emit("click");
    await vi.advanceTimersByTimeAsync(120);
    expect(
      content.find((node) => node.className.includes("daily-spec-card")),
    ).toBeTruthy();
    overview.resolve(result({ story }));
    await loading;
    expect(content.attributes.get("aria-busy")).toBe("true");
    expect(root.textContent).not.toContain(story.title);
    dev.resolve(result({ scope: "增加部门筛选", tasks: [] }));
    await change;
    expect(content.textContent).toContain("增加部门筛选");
    expect(content.attributes.has("aria-busy")).toBe(false);
  });

  it("按 v11 呈现业务反馈专用提需与本人进度", async () => {
    const call = vi
      .fn<Call>()
      .mockResolvedValue(result({ items: [], countsByProgress: {} }));
    const ctx = context(call, ["query_stories", "create_story"]);
    ctx.role.id = "FB";
    const root = new ElementStub("main");
    await renderIntake(root, ctx);
    expect(root.textContent).toContain("极简提诉求");
    expect(root.textContent).toContain("我反馈的诉求与进展");
    expect(
      root.find((node) => node.className === "intake-split vp-fill"),
    ).toBeTruthy();
    expect(call).toHaveBeenCalledWith(
      "query_stories",
      expect.objectContaining({
        type: "story",
        role: "raised",
        who: "design",
        limit: 100,
      }),
    );
  });

  it("P1-1 FB 提需求页超过 20 条记录时不静默缩减，全部可达", async () => {
    const manyStories = Array.from({ length: 25 }, (_, i) => ({
      ...story,
      id: 200 + i,
      title: `反馈需求 ${i + 1}`,
    }));
    const call = vi.fn<Call>().mockImplementation(async (_tool, input) => {
      if (input.type === "requirement")
        return result({ items: [], countsByProgress: {} });
      return result({
        items: manyStories,
        countsByProgress: { 未就绪: 25 },
        total: 25,
        hasMore: false,
      });
    });
    const ctx = context(call, ["query_stories", "create_story"]);
    ctx.role.id = "FB";
    const root = new ElementStub("main");
    await renderIntake(root, ctx);
    expect(call).toHaveBeenCalledWith("query_stories", {
      type: "requirement",
      unlinked: true,
      role: "raised",
      who: "design",
      limit: 100,
    });
    expect(call).toHaveBeenCalledWith("query_stories", {
      type: "story",
      status: ["all"],
      role: "raised",
      who: "design",
      limit: 100,
    });
    expect(root.textContent).toContain("反馈需求 1");
    expect(root.textContent).toContain("反馈需求 25");
  });

  it("按 v11 展示九步标准流转图并跳转实际业务入口", async () => {
    const call = vi.fn<Call>();
    const ctx = context(call, ["query_stories", "create_story"]);
    const root = new ElementStub("main");
    await renderStories(root, ctx, { tab: "flow" });
    expect(root.textContent).toContain("需求流转与阶段管线");
    expect(
      root.find((node) => node.className === "flow-grid").children,
    ).toHaveLength(9);
    await button(root, "前往对应视图").emit("click");
    expect(ctx.navigate).toHaveBeenCalledWith("intake");
    expect(call).not.toHaveBeenCalled();
  });

  it("从真实未关联清单带入当前提需表单并保留读取缺口", async () => {
    const requirement = { ...story, feedbackBy: "业务同事" };
    const call = vi
      .fn<Call>()
      .mockResolvedValue(
        result(
          { items: [requirement], countsByProgress: { 用户诉求: 1 } },
          true,
        ),
      );
    const ctx = context(call, ["query_stories", "create_story"]);
    const root = new ElementStub("main");
    await renderIntake(root, ctx, { mode: "backfilled" });

    expect(ctx.renderWrite).toHaveBeenCalledWith(
      expect.anything(),
      "create_story",
      {},
      expect.objectContaining({ intakeMode: "backfilled" }),
    );
    expect(call).toHaveBeenCalledExactlyOnceWith(
      "query_stories",
      expect.objectContaining({ type: "requirement", unlinked: true }),
    );
    expect(root.textContent).toContain("读取超时");
    expect(root.textContent).toContain("<img src=x>");
    expect(() => root.find((node) => node.tagName === "img")).toThrow();
    await button(root, "一键带入并关联").emit("click");
    expect(ctx.prefill).toHaveBeenCalledWith({
      requirementId: 72,
      product: "4",
      module: "81",
      title: story.title,
      feedbackBy: "业务同事",
    });
  });

  it("用已有查询服务显示看板、台账筛选和按行开详情，快捷操作受角色权限约束", async () => {
    const call = vi
      .fn<Call>()
      .mockResolvedValue(
        result({ items: [story], countsByProgress: { 未就绪: 1 } }),
      );
    const ctx = context(call, [
      "query_stories",
      "get_story_progress",
      "decompose_stories",
    ]);
    const root = new ElementStub("main");
    await renderStories(root, ctx);
    expect(call).toHaveBeenCalledExactlyOnceWith(
      "query_stories",
      expect.objectContaining({ category: "design", status: ["all"] }),
    );
    expect(root.textContent).toContain("评审与传递中");
    expect(root.textContent).toContain("已完待移交 / 已移交");
    await button(root, "生成三段任务").emit("click");
    expect(ctx.openTool).toHaveBeenCalledWith(
      "decompose_stories",
      { storyIds: [72], template: "design" },
      { preview: true },
    );
    expect(ctx.openStory).not.toHaveBeenCalled();
    await button(root, story.title).emit("click");
    expect(ctx.openStory).toHaveBeenCalledWith(72);

    await button(root, "全部需求台账").emit("click");
    expect(root.find((node) => node.tagName === "table")).toBeTruthy();
    const filter = root.find((node) => node.tagName === "select");
    filter.value = "未就绪";
    await filter.emit("change");
    expect(call).toHaveBeenLastCalledWith(
      "query_stories",
      expect.objectContaining({ progress: ["未就绪"], status: ["all"] }),
    );
    expect(() => button(root, "激活移交")).toThrow();
    for (const [, input] of call.mock.calls)
      expect(allTools.query_stories.input.safeParse(input).success).toBe(true);
  });

  it("从快捷入口直接打开全部研发需求及阶段筛选，并支持分页翻页", async () => {
    const call = vi.fn<Call>().mockResolvedValue(
      result({
        items: [story],
        countsByProgress: { 未就绪: 25 },
        page: 1,
        pageSize: 20,
        total: 25,
        hasMore: true,
      }),
    );
    const root = new ElementStub("main");
    await renderStories(root, context(call, ["query_stories"]), {
      tab: "all-stories",
    });
    expect(call).toHaveBeenCalledExactlyOnceWith("query_stories", {
      status: ["all"],
      page: 1,
      limit: 20,
    });
    expect(root.find((node) => node.tagName === "table")).toBeTruthy();
    expect(
      button(root, "全部需求台账 (25)").attributes.get("aria-pressed"),
    ).toBe("true");
    expect(
      root.find((node) => node.tagName === "select").parent?.parent?.hidden,
    ).toBe(false);
    await button(root, "下一页").emit("click");
    expect(call).toHaveBeenLastCalledWith("query_stories", {
      status: ["all"],
      page: 2,
      limit: 20,
    });

    // P1-2：关键词检索透传后端 query_stories.keyword 并重置到第 1 页（跨页命中）
    const searchInput = root.find(
      (node) =>
        node.tagName === "input" &&
        node.attributes.get("aria-label") === "检索当前台账结果",
    );
    call.mockResolvedValueOnce(
      result({
        items: [{ ...story, id: 99, title: "第2页目标需求" }],
        countsByProgress: { 未就绪: 1 },
        page: 1,
        pageSize: 20,
        total: 1,
        hasMore: false,
      }),
    );
    searchInput.value = "#99";
    await searchInput.emit("input");
    expect(call).toHaveBeenLastCalledWith("query_stories", {
      status: ["all"],
      keyword: "#99",
      page: 1,
      limit: 20,
    });
    expect(root.textContent).toContain("第2页目标需求");

    // 无结果空态与清空恢复
    call.mockResolvedValueOnce(
      result({
        items: [],
        countsByProgress: {},
        page: 1,
        pageSize: 20,
        total: 0,
        hasMore: false,
      }),
    );
    searchInput.value = "不存在的关键词";
    await searchInput.emit("input");
    expect(call).toHaveBeenLastCalledWith("query_stories", {
      status: ["all"],
      keyword: "不存在的关键词",
      page: 1,
      limit: 20,
    });

    const clearBtn = root.find((node) => node.className === "ledger-clear-btn");
    call.mockResolvedValueOnce(
      result({
        items: [story],
        countsByProgress: { 未就绪: 25 },
        page: 1,
        pageSize: 20,
        total: 25,
        hasMore: true,
      }),
    );
    await clearBtn.emit("click");
    expect(call).toHaveBeenLastCalledWith("query_stories", {
      status: ["all"],
      page: 1,
      limit: 20,
    });
  });

  it("设计人员（DS）打开提需求页时仅查询指派给自己的待关联用户需求", async () => {
    const call = vi
      .fn<Call>()
      .mockResolvedValue(result({ items: [], countsByProgress: {} }));
    const ctx = context(call, ["query_stories", "create_story"]);
    ctx.role.id = "DS";
    const root = new ElementStub("main");
    await renderIntake(root, ctx);
    expect(call).toHaveBeenCalledExactlyOnceWith(
      "query_stories",
      expect.objectContaining({
        type: "requirement",
        unlinked: true,
        role: "assigned",
        page: 1,
        limit: 20,
      }),
    );
  });

  it("详情抽屉展示服务端进度、实现范围和可复制的真实卡片", async () => {
    const card = "【需求进度】部门筛选\n当前：准备中（记录）";
    const call = vi
      .fn<Call>()
      .mockResolvedValueOnce(
        result({
          story,
          progress: {
            value: "未就绪",
            level: "recorded",
            basis: "需求尚为草稿。",
          },
          people: { raisedBy: "business" },
          stages: [],
          related: { bugs: [] },
          risks: [],
          card,
        }),
      )
      .mockResolvedValueOnce(
        result({
          scope: "增加筛选 不做 / 已实现：不做批量导出",
          designRef: "业务说明第 4 节",
          verify: "选择部门后结果正确",
          tasks: [],
        }),
      );
    const copy = vi.fn<(text: string) => Promise<void>>().mockResolvedValue();
    vi.stubGlobal("navigator", { clipboard: { writeText: copy } });
    const ctx = context(call, ["get_story_progress"]);
    const root = new ElementStub("main");
    await renderStoryDrawer(root, ctx, 72);
    expect(root.textContent).toContain("需求尚为草稿");
    await button(root, "研发看范围").emit("click");
    expect(root.textContent).toContain("不做批量导出");
    expect(root.textContent).toContain("业务说明第 4 节");
    expect(call).toHaveBeenLastCalledWith("get_story_progress", {
      storyId: 72,
      view: "dev",
    });
    await button(root, "转发给业务").emit("click");
    await button(root, "一键复制企微进度卡").emit("click");
    expect(copy).toHaveBeenCalledExactlyOnceWith(card);
    expect(root.textContent).toContain("进度卡片已复制");
    expect(call).toHaveBeenCalledTimes(2);
    expect(call).toHaveBeenNthCalledWith(1, "get_story_progress", {
      storyId: 72,
      format: "card",
    });
  });
});
