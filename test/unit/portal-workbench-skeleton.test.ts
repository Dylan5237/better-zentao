import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
// @ts-expect-error The packaged portal is a native browser module.
import { renderWorkbench } from "../../web/workbench-page.js";

class ElementStub {
  readonly children: ElementStub[] = [];
  readonly attributes = new Map<string, string>();
  readonly dataset: Record<string, string> = {};
  readonly ownerDocument = { createElement: (tag: string) => new ElementStub(tag) };
  readonly classList = {
    add: (...names: string[]) => {
      this.className = [...this.className.split(/\s+/u), ...names].join(" ");
    },
    contains: (name: string) => this.hasClass(name),
  };
  readonly style = {
    setProperty: (name: string, value: string) => this.attributes.set(name, value),
  };
  private readonly listeners = new Map<string, () => void>();
  private text = "";
  parentElement: ElementStub | null = null;
  className = "";
  value = "";

  constructor(readonly tag: string) {}

  get textContent(): string {
    return this.text + this.children.map((child) => child.textContent).join("");
  }

  set textContent(text: string) {
    this.replaceChildren();
    this.text = text;
  }

  append(...children: ElementStub[]) {
    for (const child of children) {
      child.remove();
      child.parentElement = this;
      this.children.push(child);
    }
  }

  replaceChildren(...children: ElementStub[]) {
    for (const child of this.children) child.parentElement = null;
    this.children.length = 0;
    this.text = "";
    this.append(...children);
  }

  remove() {
    const parent = this.parentElement;
    if (!parent) return;
    parent.children.splice(parent.children.indexOf(this), 1);
    this.parentElement = null;
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

  addEventListener(event: string, listener: () => void) {
    this.listeners.set(event, listener);
  }

  click() {
    this.listeners.get("click")?.();
  }

  hasClass(name: string) {
    return this.className.split(/\s+/u).includes(name);
  }

  descendants(match: (node: ElementStub) => boolean): ElementStub[] {
    return this.children.flatMap((child) => [
      ...(match(child) ? [child] : []),
      ...child.descendants(match),
    ]);
  }
}

const roles = [
  { id: "FB", tabs: 3, columns: 8, nativeFields: 2, fields: [3], kpis: 0, panels: 1, row: "fb-story-card" },
  { id: "DM", tabs: 2, columns: 11, nativeFields: 7, fields: [1, 5], kpis: 3, panels: 2, row: "item-row" },
  { id: "DS", tabs: 2, columns: 11, nativeFields: 7, fields: [1, 5], kpis: 3, panels: 2, row: "item-row" },
  { id: "RM", tabs: 2, columns: 11, nativeFields: 5, fields: [2, 2], kpis: 3, panels: 2, row: "item-row" },
  { id: "RD", tabs: 3, columns: 12, nativeFields: 4, fields: [3], kpis: 4, panels: 1, row: "item-row" },
  { id: "QA", tabs: 2, columns: 12, nativeFields: 4, fields: [3, 3], kpis: 0, panels: 2, row: "item-row" },
  { id: "PM", tabs: 2, columns: 7, nativeFields: 0, fields: [1], kpis: 0, panels: 1, row: "l3-tile" },
  { id: "PJ", tabs: 2, columns: 7, nativeFields: 3, fields: [3], kpis: 3, panels: 1, row: "item-row" },
];

type Mode = "meridian" | "hybrid" | "zentao";

const modes: Mode[] = ["meridian", "hybrid", "zentao"];
const actions = [
  "get_my_work",
  "query_stories",
  "get_team_work",
  "get_monthly_dev_queue",
  "get_plan_progress",
  "scan_workflow_risks",
  "create_story",
];

function data(value: unknown = {}) {
  return { ok: true, completeness: "complete", data: value };
}

function setup(id: string, mode: Mode) {
  const root = new ElementStub("div");
  const response = Promise.withResolvers<unknown>();
  const controller = new AbortController();
  const ctx = {
    role: { id, label: id, actions },
    mode,
    account: "test",
    developmentTeams: [
      { id: "front", name: "前端" },
      { id: "back", name: "后端" },
      { id: "mobile", name: "移动端" },
    ],
    releaseCalendar: [{ product: 1, version: "v1", date: "2026-12-01" }],
    signal: controller.signal,
    current: () => !controller.signal.aborted,
    call: vi.fn<(tool: string, input: Record<string, unknown>) => Promise<unknown>>(
      () => response.promise,
    ),
  };
  return { root, ctx, response, controller };
}

function nodes(root: ElementStub, name: string) {
  return root.descendants((node) => node.hasClass(name));
}

function first(root: ElementStub, name: string) {
  const node = nodes(root, name)[0];
  if (!node) throw new Error(`找不到 ${name}`);
  return node;
}

describe("WEB-03 工作台按角色与档位加载", () => {
  beforeEach(() => vi.useFakeTimers());
  afterEach(() => vi.useRealTimers());

  it.each(roles.flatMap((role) => modes.map((mode) => [role.id, mode, role] as const)))(
    "%s %s 的骨架复用就绪结构和滚动容器",
    async (id, mode, role) => {
      const { root, ctx, response } = setup(id, mode);
      const loading = renderWorkbench(root, ctx);
      const body = first(root, "workbench-body");
      const pageHead = first(root, "page-head");
      const feedbackForm = nodes(root, "fb-quick-bar")[0];
      expect(body.children).toHaveLength(0);
      vi.advanceTimersByTime(120);
      expect(body.getAttribute("aria-busy")).toBe("true");
      const scene = body.children[0]!;
      expect(scene.getAttribute("aria-hidden")).toBe("true");
      if (mode === "zentao") {
        expect(nodes(scene, "zt-tab-btn")).toHaveLength(role.tabs);
        expect(nodes(scene, "zt-select")).toHaveLength(role.nativeFields);
        const table = first(first(scene, "vp-table-scroll"), "zt-table");
        expect(table.descendants(({ tag }) => tag === "th")).toHaveLength(role.columns);
        const tableRows = table.descendants(({ tag }) => tag === "tbody")[0]!.children;
        expect(tableRows.length).toBeGreaterThan(1);
        expect(tableRows.every(({ children }) => children.length === role.columns)).toBe(true);
      } else {
        expect(nodes(scene, "kpi-card")).toHaveLength(role.kpis);
        expect(nodes(scene, "vp-card")).toHaveLength(role.panels);
        expect(nodes(scene, "vp-scroll")).toHaveLength(role.panels);
        expect(nodes(scene, role.row).length).toBeGreaterThan(1);
        expect(
          nodes(scene, "hybrid-filter-bar").map((bar) => nodes(bar, "hybrid-select").length),
        ).toEqual(mode === "hybrid" ? role.fields : []);
        if (id === "QA" || id === "PM") expect(nodes(scene, "gate-hero")).toHaveLength(1);
        if (id === "PM") expect(nodes(scene, "l3-dist-wrap")).toHaveLength(1);
        if (id === "FB") expect(nodes(scene, "viz-stepper").length).toBeGreaterThan(0);
      }
      response.resolve(data());
      await loading;
      expect(first(root, "page-head")).toBe(pageHead);
      expect(nodes(root, "fb-quick-bar")[0]).toBe(feedbackForm);
      expect(body.children).not.toContain(scene);
      expect(body.getAttribute("aria-busy")).toBeNull();
      expect(nodes(body, mode === "zentao" ? "zt-table" : "vp-card")).toHaveLength(mode === "zentao" ? 1 : role.panels);
    },
  );

  it("120 毫秒内完成时直接显示结果", async () => {
    const { root, ctx, response } = setup("FB", "meridian");
    const loading = renderWorkbench(root, ctx);
    const body = first(root, "workbench-body");
    vi.advanceTimersByTime(119);
    expect(body.children).toHaveLength(0);
    response.resolve(data());
    await loading;
    vi.advanceTimersByTime(1);
    expect(body.children.some((child) => child.getAttribute("aria-hidden") === "true")).toBe(false);
    expect(body.getAttribute("aria-busy")).toBeNull();
    expect(body.textContent).toContain("暂无需求记录");
  });

  it("读失败进入数据缺口终态，离开职责时立即清除本次骨架", async () => {
    const failing = setup("RD", "meridian");
    const failed = renderWorkbench(failing.root, failing.ctx);
    const body = first(failing.root, "workbench-body");
    vi.advanceTimersByTime(120);
    expect(body.children[0]?.getAttribute("aria-hidden")).toBe("true");
    failing.response.reject(new Error("offline"));
    await failed;
    expect(body.textContent).toContain("查询暂时失败");
    expect(body.getAttribute("aria-busy")).toBeNull();

    const leaving = setup("QA", "hybrid");
    const abandoned = renderWorkbench(leaving.root, leaving.ctx);
    const departingBody = first(leaving.root, "workbench-body");
    vi.advanceTimersByTime(120);
    expect(departingBody.children[0]?.getAttribute("aria-hidden")).toBe("true");
    leaving.controller.abort();
    expect(departingBody.children).toHaveLength(0);
    expect(departingBody.getAttribute("aria-busy")).toBeNull();
    leaving.response.resolve(data());
    await abandoned;
    expect(departingBody.children).toHaveLength(0);
  });

  it.each(modes)("RM %s 换组保留工具栏，旧组不覆盖新骨架和新结果", async (mode) => {
    const { root, ctx } = setup("RM", mode);
    const back = Promise.withResolvers<unknown>();
    const mobile = Promise.withResolvers<unknown>();
    ctx.call.mockImplementation((tool, input) => {
      if (tool !== "get_monthly_dev_queue" || input.team === "front")
        return Promise.resolve(data());
      return input.team === "back" ? back.promise : mobile.promise;
    });
    await renderWorkbench(root, ctx);
    const body = first(root, "workbench-body");
    const toolbar = first(root, "toolbar-row");
    const note = first(toolbar, "toolbar-note");
    const [frontButton, backButton, mobileButton] = nodes(toolbar, "seg-tab");
    expect(frontButton?.getAttribute("aria-pressed")).toBe("true");

    backButton!.click();
    await vi.advanceTimersByTimeAsync(120);
    const backScene = body.children[0];
    expect(backScene?.getAttribute("aria-hidden")).toBe("true");
    mobileButton!.click();
    await vi.advanceTimersByTimeAsync(120);
    const mobileScene = body.children[0];
    expect(mobileScene?.getAttribute("aria-hidden")).toBe("true");
    expect(mobileScene).not.toBe(backScene);
    expect(first(root, "toolbar-row")).toBe(toolbar);
    expect(note.textContent).toBe("当前视角：移动端");
    expect(mobileButton?.getAttribute("aria-pressed")).toBe("true");

    back.resolve(data({ buckets: { toReceive: [{ id: 9, title: "旧组需求" }] } }));
    await vi.advanceTimersByTimeAsync(0);
    expect(body.children[0]).toBe(mobileScene);
    expect(body.getAttribute("aria-busy")).toBe("true");
    mobile.resolve(data({ buckets: { toReceive: [{ id: 10, title: "新组需求" }] } }));
    await vi.advanceTimersByTimeAsync(0);
    expect(body.children).not.toContain(mobileScene);
    expect(body.getAttribute("aria-busy")).toBeNull();
    expect(body.textContent).toContain("新组需求");
    expect(body.textContent).not.toContain("旧组需求");
  });
});
