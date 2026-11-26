import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { allTools } from "../../src/contracts/tools/index.ts";
// @ts-expect-error The packaged portal is a native browser module.
import { renderWrite } from "../../web/write-views.js";

type Call = (tool: string, input: Record<string, unknown>) => Promise<unknown>;
type Listener = (event: { preventDefault: () => void }) => void | Promise<void>;

class ElementStub {
  readonly children: ElementStub[] = [];
  readonly attributes = new Map<string, string>();
  readonly ownerDocument = {
    createElement: (tag: string) => new ElementStub(tag),
  };
  private readonly events = new Map<string, Listener[]>();
  private content = "";
  parent: ElementStub | undefined;
  value = "";
  name = "";
  checked = false;
  disabled = false;
  hidden = false;
  className = "";

  constructor(readonly tagName: string) {}

  get isConnected(): boolean {
    return this.tagName === "main" || this.parent?.isConnected === true;
  }

  get textContent(): string {
    return (
      this.content + this.children.map((child) => child.textContent).join(" ")
    );
  }

  set textContent(value: string) {
    this.replaceChildren();
    this.content = value;
  }

  set innerHTML(_: string) {
    throw new Error("写入预览与回执必须将业务内容渲染为文本。");
  }

  append(...children: ElementStub[]): void {
    for (const child of children) {
      child.parent = this;
      this.children.push(child);
    }
  }

  replaceChildren(...children: ElementStub[]): void {
    for (const child of this.children) child.parent = undefined;
    this.children.length = 0;
    this.content = "";
    this.append(...children);
  }

  contains(child: ElementStub): boolean {
    return this === child || this.children.some((item) => item.contains(child));
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

  async emit(type: string): Promise<void> {
    for (const listener of this.events.get(type) ?? []) {
      await listener({ preventDefault: () => {} });
    }
    await this.parent?.emit(type);
  }

  find(predicate: (element: ElementStub) => boolean): ElementStub {
    const found = this.findAll(predicate)[0];
    if (!found) throw new Error("测试找不到对应的表单控件。");
    return found;
  }

  findAll(predicate: (element: ElementStub) => boolean): ElementStub[] {
    return this.children.flatMap((child) => [
      ...(predicate(child) ? [child] : []),
      ...child.findAll(predicate),
    ]);
  }
}

const now = Date.parse("2026-11-25T08:00:00Z");
const storage = new Map<string, string>();
const prepared = (kind = "create_story", level = "W1") => ({
  ok: true,
  opId: "op-72",
  kind,
  level,
  expiresAt: "2026-11-25T08:15:00Z",
  requiresPreviewAck: level === "W2",
  preview: {
    summary: "准备处理 <img src=x> 筛选需求",
    affects: ["设计主管"],
    steps: [
      {
        seq: 1,
        action: "story.create",
        target: "product#4",
        fields: {
          title: { value: "<img src=x>", origin: "user" },
          pri: { value: 3, origin: "default" },
          category: { value: "feature", origin: "derived" },
        },
      },
    ],
  },
  warnings: [{ code: "R06", message: "等待挂接计划" }],
});

const confirmed = {
  ok: true,
  opId: "op-72",
  status: "confirmed",
  steps: [
    {
      seq: 1,
      action: "story.create",
      state: "done",
      zentaoId: 72,
      url: "https://zentao.example/story-view-72.html",
    },
  ],
  created: [
    { type: "story", id: 72, url: "https://zentao.example/story-view-72.html" },
  ],
};

function view(
  tool: string,
  call: Call,
  role: string,
  account = "user_demo",
  initial?: Record<string, unknown>,
  options?: Record<string, unknown>,
) {
  const root = new ElementStub("main");
  renderWrite(root, tool, call, role, account, initial, options);
  return root;
}

function control(root: ElementStub, name: string): ElementStub {
  return root.find((element) => element.name === name);
}

function button(root: ElementStub, label: string): ElementStub {
  return root.find(
    (element) =>
      element.tagName === "button" && element.textContent.trim() === label,
  );
}

function submit(root: ElementStub): Promise<void> {
  return root.find((element) => element.tagName === "form").emit("submit");
}

async function fill(
  root: ElementStub,
  values: Record<string, string>,
): Promise<void> {
  for (const [name, value] of Object.entries(values)) {
    const item = control(root, name);
    item.value = value;
    await item.emit("change");
  }
}

const intakeFields = {
  product: "4",
  module: "权限管理",
  title: "按部门筛选",
  "spec.background": "角色列表难定位",
  "spec.scope": "增加部门筛选",
  verify: "验证部门筛选结果",
};

async function acknowledge(root: ElementStub): Promise<void> {
  const field = control(root, "previewAck");
  field.checked = true;
  await field.emit("change");
}

beforeEach(() => {
  vi.useFakeTimers();
  vi.setSystemTime(now);
  storage.clear();
  vi.stubGlobal("sessionStorage", {
    getItem: (key: string) => storage.get(key) ?? null,
    setItem: (key: string, value: string) => storage.set(key, value),
    removeItem: (key: string) => storage.delete(key),
  });
});

afterEach(() => {
  vi.useRealTimers();
  vi.unstubAllGlobals();
});

describe("CR-002 WEB-04 门户写入", () => {
  it("预览和回执等待时只显示结果骨架，收到 W2 预览后才开始确认等待", async () => {
    const plan = Promise.withResolvers<unknown>();
    const receipt = Promise.withResolvers<unknown>();
    const call = vi
      .fn<Call>()
      .mockReturnValueOnce(plan.promise)
      .mockReturnValueOnce(receipt.promise);
    const root = view("assign_story", call, "DM");
    await fill(root, { storyIds: "72", to: "dev" });

    const previewing = submit(root);
    await vi.advanceTimersByTimeAsync(3000);
    expect(
      root.find((node) => node.className === "daily-preview-skeleton"),
    ).toBeTruthy();
    expect(() => control(root, "previewAck")).toThrow();

    plan.resolve(prepared("assign_story", "W2"));
    await previewing;
    expect(() =>
      root.find((node) => node.className === "daily-preview-skeleton"),
    ).toThrow();
    await acknowledge(root);
    const confirm = button(root, "确认执行");
    await confirm.emit("click");
    expect(call).toHaveBeenCalledTimes(1);
    await vi.advanceTimersByTimeAsync(3000);
    const executing = confirm.emit("click");
    await vi.advanceTimersByTimeAsync(120);
    expect(
      root.find((node) => node.className === "daily-receipt-skeleton"),
    ).toBeTruthy();
    expect(root.textContent).toContain("op-72");
    expect(() => control(root, "previewAck")).toThrow();

    receipt.resolve(confirmed);
    await executing;
    expect(root.textContent).toContain("已确认");
    expect(
      root.findAll((node) => node.attributes.has("aria-busy")),
    ).toHaveLength(0);
  });

  it("业务反馈保留原话并补齐必填内容后才生成真实草稿预览", async () => {
    const call = vi.fn<Call>().mockResolvedValue(prepared());
    const root = view(
      "create_story",
      call,
      "FB",
      "user_demo",
      {},
      { intakePage: true },
    );
    expect(root.textContent).toContain("一句话诉求简述");
    expect(root.textContent).not.toContain("设计态+运行态双建");
    await fill(root, {
      product: "4",
      module: "权限管理",
      title: "按部门筛选",
      "spec.background": "角色列表难定位",
      "intake.channel": "meeting",
    });
    await submit(root);
    expect(call).not.toHaveBeenCalled();
    await fill(root, {
      "spec.scope": "增加部门筛选",
      verify: "选择后只返回本部门",
    });
    await submit(root);
    const input = call.mock.calls[0]?.[1];
    expect(allTools.create_story.input.safeParse(input).success).toBe(true);
    expect(input).toMatchObject({
      feedbackBy: "user_demo",
      intake: { rawText: "按部门筛选\n角色列表难定位", channel: "meeting" },
      spec: { scope: "增加部门筛选" },
    });
  });

  it("批量录入送入同一操作预览并把坏行交给服务逐行判断", async () => {
    const call = vi
      .fn<Call>()
      .mockResolvedValue(prepared("import_stories", "W2"));
    const root = view("import_stories", call, "DM");
    await fill(root, {
      "row.0.product": "4",
      "row.0.module": "权限管理",
      "row.0.title": "筛选一",
      "row.0.scope": "按部门筛选",
      "row.0.verify": "筛选结果正确",
    });
    await button(root, "添加一行").emit("click");
    await fill(root, { "row.1.title": "缺少范围的需求" });
    await submit(root);
    const input = call.mock.calls[0]?.[1];
    expect(call).toHaveBeenCalledTimes(1);
    expect(call.mock.calls[0]?.[0]).toBe("import_stories");
    expect(allTools.import_stories.input.safeParse(input).success).toBe(true);
    expect(input).toMatchObject({
      source: {
        kind: "table",
        rows: [
          {
            title: "筛选一",
            spec: { scope: "按部门筛选" },
            verify: "筛选结果正确",
          },
          { title: "缺少范围的需求" },
        ],
      },
    });
    expect(root.textContent).toContain("操作预览");
  });

  it("用四种提需模式提交真实契约，切换时忽略其他模式的字段", async () => {
    const call = vi.fn<Call>().mockResolvedValue(prepared());
    const root = view("create_story", call, "DS");
    await fill(root, intakeFields);

    await button(root, "设计态+运行态双建").emit("click");
    await fill(root, { "pair.product": "42", "pair.module": "82" });
    await submit(root);
    expect(call).toHaveBeenLastCalledWith(
      "create_story",
      expect.objectContaining({ pair: { product: "42", module: "82" } }),
    );

    await button(root, "跨模块找后端").emit("click");
    await fill(root, { derivesFrom: "81" });
    await submit(root);
    const dependency = call.mock.calls.at(-1)?.[1];
    expect(dependency).toMatchObject({ crossModule: true, derivesFrom: 81 });
    expect(dependency).not.toHaveProperty("pair");

    await button(root, "急事先做后补录").emit("click");
    expect(control(root, "backfilled.actualStartedAt").value).toBe("");
    await submit(root);
    expect(call).toHaveBeenCalledTimes(2);
    await fill(root, { "backfilled.actualStartedAt": "2026-11-24" });
    await submit(root);
    const backfill = call.mock.calls.at(-1)?.[1];
    expect(backfill).toMatchObject({
      backfilled: { actualStartedAt: "2026-11-24" },
    });
    expect(backfill).not.toHaveProperty("crossModule");
    expect(backfill).not.toHaveProperty("derivesFrom");

    await button(root, "常规提需").emit("click");
    await submit(root);
    const standard = call.mock.calls.at(-1)?.[1];
    expect(standard).not.toHaveProperty("backfilled");
    expect(standard).not.toHaveProperty("intakeMode");
    for (const [, input] of call.mock.calls)
      expect(allTools.create_story.input.safeParse(input).success).toBe(true);
  });

  it("快捷入口按工具契约预填并生成真实预览，仍需明确确认", async () => {
    const call = vi
      .fn<Call>()
      .mockResolvedValue(prepared("decompose_stories", "W2"));
    const root = view(
      "decompose_stories",
      call,
      "RM",
      "user_demo",
      { storyIds: [72, 73], template: "design", notify: false },
      { preview: true },
    );
    await vi.advanceTimersByTimeAsync(0);
    expect(call).toHaveBeenCalledExactlyOnceWith("decompose_stories", {
      storyIds: [72, 73],
      template: "design",
      notify: false,
    });
    await vi.advanceTimersByTimeAsync(3000);
    await button(root, "确认执行").emit("click");
    expect(call).toHaveBeenCalledTimes(1);
  });

  it("配置过的产品与模块默认用选择器，手填与原型入口带入都提交真实字段", async () => {
    const call = vi.fn<Call>().mockResolvedValue(prepared());
    const root = view("create_story", call, "DM", "user_demo", undefined, {
      intakeCatalog: {
        products: [
          { id: 4, name: "业务平台", modules: [{ id: 81, path: "权限管理" }] },
        ],
      },
    });
    expect(control(root, "catalog").value).toBe("");
    expect(control(root, "product").parent?.hidden).toBe(true);
    await fill(root, { catalog: "manual" });
    expect(control(root, "product").parent?.hidden).toBe(false);
    await fill(root, {
      ...intakeFields,
      product: "其他产品",
      module: "其他模块",
    });
    await submit(root);
    expect(call).toHaveBeenLastCalledWith(
      "create_story",
      expect.objectContaining({ product: "其他产品", module: "其他模块" }),
    );
    await fill(root, { catalog: "4:81" });
    expect(control(root, "product").parent?.hidden).toBe(true);
    await submit(root);
    expect(call).toHaveBeenLastCalledWith(
      "create_story",
      expect.objectContaining({ product: "4", module: "81" }),
    );
  });

  it("将中文表单转换成原工具输入，保留八类操作的服务契约", async () => {
    const cases = [
      [
        "create_story",
        "FB",
        intakeFields,
        { product: "4", title: "按部门筛选" },
      ],
      [
        "create_story",
        "RD",
        { ...intakeFields, "backfilled.actualStartedAt": "2026-11-24" },
        { backfilled: { actualStartedAt: "2026-11-24" } },
      ],
      [
        "assign_story",
        "DM",
        { storyIds: "72、73, 72", to: "dev" },
        { storyIds: [72, 73], to: "dev" },
      ],
      [
        "handoff_story",
        "DS",
        { storyId: "72", mode: "from_design", "feature.scope": "筛选模块" },
        { storyId: 72, mode: "from_design", feature: { scope: "筛选模块" } },
      ],
      [
        "decompose_stories",
        "DM",
        { storyIds: "72" },
        { storyIds: [72], template: "design" },
      ],
      [
        "decompose_stories",
        "RM",
        {
          template: "subtasks",
          taskId: "21",
          "subtasks.0.name": "修正筛选",
          "subtasks.0.assignTo": "dev",
        },
        {
          template: "subtasks",
          taskId: 21,
          subtasks: [{ name: "修正筛选", assignTo: "dev" }],
        },
      ],
      [
        "reschedule_story",
        "RM",
        { storyIds: "72 73", toMonth: "下月", reason: "等设计评审" },
        { storyIds: [72, 73], toMonth: "下月", reason: "等设计评审" },
      ],
      [
        "close_stories",
        "RM",
        { storyIds: "72", closedReason: "cancel" },
        { mode: "story", storyIds: [72], closedReason: "cancel" },
      ],
      [
        "set_story_meta",
        "PM",
        { storyId: "72", "waiver.reason": "例外发布已评审" },
        { storyId: 72, waiver: { rule: "R13", reason: "例外发布已评审" } },
      ],
    ] as const;

    for (const [tool, role, values, expected] of cases) {
      const call = vi.fn<Call>().mockResolvedValue(prepared(tool));
      const root = view(tool, call, role);
      await fill(root, values);
      await submit(root);
      expect(call).toHaveBeenCalledExactlyOnceWith(
        tool,
        expect.objectContaining(expected),
      );
      const input = call.mock.calls[0]?.[1];
      expect(allTools[tool].input.safeParse(input).success).toBe(true);
      if (tool === "set_story_meta") expect(input).toEqual(expected);
      if (tool === "decompose_stories" && role === "DM") {
        expect(
          control(root, "template").children.map((option) => option.value),
        ).toEqual(["design"]);
      }
    }
  });

  it("显示预览与字段来源，W2 等待并勾选后只确认一次", async () => {
    let finish: (value: unknown) => void = () => {};
    const result = new Promise((resolve) => {
      finish = resolve;
    });
    const call = vi
      .fn<Call>()
      .mockResolvedValueOnce(prepared("assign_story", "W2"))
      .mockReturnValueOnce(result);
    const root = view("assign_story", call, "DM");
    await fill(root, { storyIds: "72", to: "dev" });
    await submit(root);

    for (const label of [
      "等待挂接计划",
      "设计主管",
      "product#4",
      "用户填写",
      "默认值",
      "规则推导",
      "<img src=x>",
    ]) {
      expect(root.textContent).toContain(label);
    }
    expect(root.findAll((element) => element.tagName === "img")).toHaveLength(
      0,
    );
    const confirm = button(root, "确认执行");
    await acknowledge(root);
    await confirm.emit("click");
    expect(call).toHaveBeenCalledTimes(1);
    await vi.advanceTimersByTimeAsync(3000);
    const first = confirm.emit("click");
    await confirm.emit("click");
    expect(call).toHaveBeenCalledTimes(2);
    expect(call).toHaveBeenLastCalledWith("confirm_operation", {
      opId: "op-72",
      previewAck: true,
    });
    finish(confirmed);
    await first;
    expect(root.textContent).toContain("已确认");
    expect(root.textContent).toContain("#72");
  });

  it("确认连接中断时锁住新预览，以同一个操作编号查询和恢复", async () => {
    const partial = {
      ...confirmed,
      ok: false,
      status: "partial",
      steps: [
        ...confirmed.steps,
        { seq: 2, action: "story.assign", state: "pending" },
      ],
      nextActions: ["confirm_operation(op-72, resume=true)"],
    };
    const call = vi
      .fn<Call>()
      .mockResolvedValueOnce(prepared())
      .mockRejectedValueOnce(new Error("连接中断"))
      .mockResolvedValueOnce({ ok: true, data: partial })
      .mockResolvedValueOnce(confirmed);
    const root = view("create_story", call, "FB");
    await fill(root, intakeFields);
    await submit(root);
    await acknowledge(root);
    await button(root, "确认执行").emit("click");
    await submit(root);
    expect(call).toHaveBeenCalledTimes(2);
    expect(root.textContent).toContain("op-72");

    await button(root, "查询回执").emit("click");
    expect(call).toHaveBeenLastCalledWith("get_operation", { opId: "op-72" });
    expect(root.textContent).toContain("部分完成");
    await acknowledge(root);
    await button(root, "恢复此操作").emit("click");
    expect(call).toHaveBeenLastCalledWith("confirm_operation", {
      opId: "op-72",
      previewAck: true,
      resume: true,
    });
    expect(root.textContent).toContain("已确认");
  });

  it("预览过期、表单变更和切换职责都使旧确认失效", async () => {
    const expiring = { ...prepared(), expiresAt: "2026-11-25T08:00:01Z" };
    const call = vi
      .fn<Call>()
      .mockResolvedValueOnce(expiring)
      .mockResolvedValue(prepared());
    const root = view("create_story", call, "FB");
    await fill(root, intakeFields);
    await submit(root);
    await acknowledge(root);
    const expiredButton = button(root, "确认执行");
    await vi.advanceTimersByTimeAsync(1001);
    await expiredButton.emit("click");
    expect(root.textContent).toContain("预览已过期");
    expect(call).toHaveBeenCalledTimes(1);

    await submit(root);
    await acknowledge(root);
    const changedButton = button(root, "确认执行");
    await fill(root, { title: "修改后的标题" });
    await changedButton.emit("click");
    expect(call).toHaveBeenCalledTimes(2);

    await submit(root);
    await acknowledge(root);
    const oldRoleButton = button(root, "确认执行");
    root.replaceChildren();
    await oldRoleButton.emit("click");
    expect(call).toHaveBeenCalledTimes(3);
  });

  it("确认前保存操作编号，重进同账号同职责的操作时以原编号继续", async () => {
    let finish: (value: unknown) => void = () => {};
    const pending = new Promise((resolve) => {
      finish = resolve;
    });
    const firstCall = vi
      .fn<Call>()
      .mockResolvedValueOnce(prepared())
      .mockReturnValueOnce(pending);
    const root = view("create_story", firstCall, "FB");
    await fill(root, intakeFields);
    await submit(root);
    await acknowledge(root);
    const previous = button(root, "确认执行").emit("click");
    expect([...storage.values()].map((value) => JSON.parse(value))).toEqual([
      { account: "user_demo", role: "FB", tool: "create_story", opId: "op-72" },
    ]);
    root.replaceChildren();

    const unrelated = vi.fn<Call>();
    view("create_story", unrelated, "FB", "someone_else");
    view("create_story", unrelated, "DM");
    view("assign_story", unrelated, "FB");
    expect(unrelated).not.toHaveBeenCalled();

    const pendingStep = { seq: 1, action: "story.create", state: "pending" };
    const call = vi
      .fn<Call>()
      .mockResolvedValueOnce({
        ok: true,
        data: {
          ...confirmed,
          ok: false,
          status: "not_executed",
          steps: [pendingStep],
          created: [],
        },
      })
      .mockResolvedValueOnce(confirmed);
    const returned = view("create_story", call, "FB");
    await vi.advanceTimersByTimeAsync(0);
    expect(call).toHaveBeenCalledExactlyOnceWith("get_operation", {
      opId: "op-72",
    });
    expect(returned.textContent).toContain("未执行");
    expect(returned.textContent).not.toContain("开始新操作");
    await submit(returned);
    expect(call).toHaveBeenCalledTimes(1);
    finish(confirmed);
    await previous;

    await acknowledge(returned);
    await button(returned, "恢复此操作").emit("click");
    expect(call).toHaveBeenLastCalledWith("confirm_operation", {
      opId: "op-72",
      previewAck: true,
      resume: true,
    });
    expect(returned.textContent).toContain("已确认");
    await button(returned, "开始新操作").emit("click");
    expect(storage.size).toBe(0);
  });

  it("操作编号跨登录拒绝时保留信息与人工核对入口", async () => {
    storage.set(
      `bzt.portal.operation.${JSON.stringify(["user_demo", "FB", "create_story"])}`,
      JSON.stringify({
        account: "user_demo",
        role: "FB",
        tool: "create_story",
        opId: "original-op",
      }),
    );
    const call = vi
      .fn<Call>()
      .mockRejectedValueOnce(
        Object.assign(new Error("没有查询权限"), { code: "PERMISSION_DENIED" }),
      );
    const root = view("create_story", call, "FB");
    await vi.advanceTimersByTimeAsync(0);
    expect(root.textContent).toContain("当前会话无法查询");
    expect(root.textContent).toContain("original-op");
    await button(root, "核对后开始新操作").emit("click");
    expect(storage.size).toBe(1);
    await acknowledge(root);
    await button(root, "核对后开始新操作").emit("click");
    expect(storage.size).toBe(0);
    expect(call).toHaveBeenCalledExactlyOnceWith("get_operation", {
      opId: "original-op",
    });
  });

  it("显示缺项、变更字段、候选与安全链接，业务值只渲染为文本", async () => {
    const call = vi.fn<Call>().mockRejectedValueOnce(
      Object.assign(new Error("请核对信息"), {
        details: {
          missing: ["spec.scope"],
          fields: ["product"],
          candidates: [{ id: 72, name: "<img src=x>", account: "candidate" }],
          links: [
            { label: "禅道候选", url: "https://zentao.example/story/72" },
            { label: "无效地址", url: "javascript:void(0)" },
          ],
        },
      }),
    );
    const root = view("create_story", call, "FB");
    await fill(root, intakeFields);
    await submit(root);
    for (const label of [
      "请核对信息",
      "本次实现范围",
      "产品名称或编号",
      "候选",
      "<img src=x>",
      "candidate",
    ]) {
      expect(root.textContent).toContain(label);
    }
    expect(root.findAll((element) => element.tagName === "img")).toHaveLength(
      0,
    );
    expect(
      root
        .findAll((element) => element.tagName === "a")
        .map((element) => element.attributes.get("href")),
    ).toEqual(["https://zentao.example/story/72"]);
  });
});
