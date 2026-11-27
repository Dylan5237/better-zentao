import { describe, expect, it, vi } from "vitest";
// @ts-expect-error The packaged portal is a native browser module.
import { createInContextCopilotController } from "../../web/ai-copilot.js";
// @ts-expect-error The packaged portal is a native browser module.
import { renderWrite } from "../../web/write-views.js";

/**
 * CR-009 §11.2 / ADR-28：前端原位协作（In-context Copilot）端到端交互单元测试。
 * 覆盖：
 * 1. 手工输入 → AI 填充空字段不覆盖手工内容 → 采纳建议 → 迟到响应拦截 → 精细撤销（不回滚后续人工编辑）；
 * 2. 主动清空字段保留手工标记（AI 不得静默填回）；
 * 3. 在途切页/切表单即时取消旧请求并复位 busy，不卡死助手；
 * 4. prefill() 推进 revision 且手工编辑自动清理对应待采纳冲突；
 * 5. 自然语言发起提需打开同一正式表单；跨账号/角色切换 resetSession 清空历史响应。
 */

function fakeDom() {
  class FakeClassList {
    #items = new Set<string>();
    add(...names: string[]) {
      for (const n of names) if (n) this.#items.add(n);
    }
    remove(...names: string[]) {
      for (const n of names) this.#items.delete(n);
    }
    toggle(name: string, force?: boolean) {
      if (force === undefined) {
        if (this.#items.has(name)) this.#items.delete(name);
        else this.#items.add(name);
      } else if (force) this.#items.add(name);
      else this.#items.delete(name);
    }
    contains(name: string) {
      return this.#items.has(name);
    }
  }

  class FakeElement {
    tagName: string;
    ownerDocument: FakeDocument;
    children: FakeElement[] = [];
    parentNode: FakeElement | null = null;
    classList = new FakeClassList();
    attributes = new Map<string, string>();
    dataset: Record<string, string> = {};
    listeners = new Map<string, ((event: unknown) => void)[]>();
    value = "";
    checked = false;
    disabled = false;
    hidden = false;
    open = false;
    required = false;
    type = "";
    name = "";
    placeholder = "";
    noValidate = false;
    private _text = "";

    constructor(tag: string, doc: FakeDocument) {
      this.tagName = tag.toUpperCase();
      this.ownerDocument = doc;
    }
    set className(v: string) {
      this.classList = new FakeClassList();
      for (const part of String(v).split(/\s+/u)) {
        if (part) this.classList.add(part);
      }
    }
    get textContent(): string {
      return this._text + this.children.map((c) => c.textContent).join("");
    }
    set textContent(v: string) {
      this._text = String(v);
      this.children = [];
    }
    get childElementCount() {
      return this.children.length;
    }
    get isConnected() {
      return true;
    }
    append(...nodes: (FakeElement | string)[]) {
      for (const node of nodes) {
        if (typeof node === "string") {
          this._text += node;
        } else if (node) {
          node.parentNode = this;
          this.children.push(node);
        }
      }
    }
    prepend(...nodes: (FakeElement | string)[]) {
      for (const node of [...nodes].reverse()) {
        if (typeof node === "string") this._text = node + this._text;
        else if (node) {
          node.parentNode = this;
          this.children.unshift(node);
        }
      }
    }
    replaceChildren(...nodes: (FakeElement | string)[]) {
      this._text = "";
      this.children = [];
      this.append(...nodes);
    }
    remove() {
      if (!this.parentNode) return;
      const idx = this.parentNode.children.indexOf(this);
      if (idx >= 0) this.parentNode.children.splice(idx, 1);
      this.parentNode = null;
    }
    setAttribute(k: string, v: string) {
      this.attributes.set(k, v);
    }
    removeAttribute(k: string) {
      this.attributes.delete(k);
    }
    addEventListener(type: string, fn: (event: unknown) => void) {
      const list = this.listeners.get(type) ?? [];
      list.push(fn);
      this.listeners.set(type, list);
    }
    dispatchEvent(event: { type: string; preventDefault?: () => void }) {
      for (const fn of this.listeners.get(event.type) ?? []) {
        fn({
          ...event,
          target: this,
          preventDefault: event.preventDefault ?? (() => {}),
        });
      }
      return true;
    }
    querySelector(selector: string): FakeElement | null {
      const match = (node: FakeElement): boolean => {
        if (selector.startsWith("."))
          return node.classList.contains(selector.slice(1));
        if (selector.startsWith("[name=")) {
          const wanted = selector.slice(7, -2);
          return node.name === wanted;
        }
        return node.tagName === selector.toUpperCase();
      };
      for (const child of this.children) {
        if (match(child)) return child;
        const found = child.querySelector(selector);
        if (found) return found;
      }
      return null;
    }
    showModal() {
      this.open = true;
    }
    close() {
      this.open = false;
    }
    reset() {
      const walk = (node: FakeElement) => {
        if (["INPUT", "TEXTAREA", "SELECT"].includes(node.tagName)) {
          node.value = "";
          node.checked = false;
        }
        for (const c of node.children) walk(c);
      };
      walk(this);
    }
  }

  class FakeDocument {
    createElement(tag: string) {
      return new FakeElement(tag, this);
    }
  }

  const doc = new FakeDocument();
  const root = doc.createElement("div");
  return { doc, root };
}

describe("ADR-28 前端原位协作共享草稿闭环", () => {
  it("手工填标题 → AI 填充空字段不覆盖手写标题 → 采纳建议 → 迟到响应拦截 → 精细撤销不丢失后续人工输入", async () => {
    const { root } = fakeDom();
    const call = vi.fn(async () => ({ ok: true }));
    const write = renderWrite(root, "create_story", call, "RD", "alice", {});
    expect(write?.draftBridge).toBeDefined();
    const bridge = write!.draftBridge!;
    const formId = bridge.getDraftSnapshot().formId;
    expect(formId).toMatch(/^create_story:\d+$/u);

    // 1. 用户直接在正式表单中手工输入标题。
    const titleInput = root.querySelector('[name="title"]')!;
    titleInput.value = "用户手写的审批导出标题";
    titleInput.dispatchEvent({ type: "input" });
    expect(bridge.getDraftSnapshot().userEditedFields).toContain("title");
    const revAfterHumanEdit = bridge.getDraftSnapshot().revision;

    // 2. 通过 In-Context Copilot 请求 AI 辅助填表。
    const invokeCopilot = vi.fn(async () => ({
      ok: true,
      turnId: "turn_1",
      kind: "form_patch",
      summary: "已填充 3 个空字段，标题生成对比建议",
      routeSource: "in_context",
      untrusted: true,
      proposal: {
        proposalId: "prop_1",
        formId,
        tool: "create_story",
        baseRevision: revAfterHumanEdit,
        patches: [
          {
            field: "product",
            value: "29",
            rationale: "产品",
            mode: "fill_empty",
          },
          {
            field: "module",
            value: "2",
            rationale: "模块",
            mode: "fill_empty",
          },
          {
            field: "spec.scope",
            value: "支持按二级部门筛选导出审批清单",
            rationale: "范围",
            mode: "fill_empty",
          },
          {
            field: "title",
            value: "AI 润色后的标题",
            rationale: "更清晰",
            mode: "propose_replace",
          },
        ],
        warnings: [],
        missingFields: [],
      },
    }));

    const openFormalIntake = vi.fn();
    const controller = createInContextCopilotController({
      invokeCopilot,
      openFormalIntake,
      getContextMeta: () => ({ role: "RD", view: "intake", month: "2026-11" }),
      onUpdate: () => {},
    });
    controller.bindForm(bridge);

    await controller.sendPrompt("帮我按描述补全表单");

    expect(root.querySelector('[name="spec.scope"]')?.value).toBe(
      "支持按二级部门筛选导出审批清单",
    );
    expect(titleInput.value).toBe("用户手写的审批导出标题");
    expect(controller.snapshot().pendingConflicts).toHaveLength(1);
    expect(controller.snapshot().hasUndo).toBe(true);

    // P1-7：AI 填充范围后，用户手工填写验收标准并修改标题，随后撤销上次 AI 修改：
    // 必须只回滚 AI 填的字段（product/module/spec.scope），绝不回滚用户后续手写的标题和验收标准！
    const verifyInput = root.querySelector('[name="verify"]')!;
    verifyInput.value = "人工后补的验收标准";
    verifyInput.dispatchEvent({ type: "input" });
    titleInput.value = "人工再次修改的标题";
    titleInput.dispatchEvent({ type: "input" });
    // 手工编辑标题后，原标题冲突建议应自动失效清理（P1-8）。
    expect(controller.snapshot().pendingConflicts).toHaveLength(0);

    expect(controller.undoLastAiPatch()).toBe(true);
    expect(root.querySelector('[name="spec.scope"]')?.value).toBe("");
    expect(titleInput.value).toBe("人工再次修改的标题");
    expect(verifyInput.value).toBe("人工后补的验收标准");

    // P1-7：用户主动清空标题后，title 必须仍留在 userEditedFields 中，AI 不可用 fill_empty 静默填回！
    titleInput.value = "";
    titleInput.dispatchEvent({ type: "input" });
    expect(bridge.getDraftSnapshot().userEditedFields).toContain("title");
    const revAfterClear = bridge.getDraftSnapshot().revision;
    const applyAfterClear = bridge.applyAiPatch({
      proposalId: "prop_clear",
      formId,
      tool: "create_story",
      baseRevision: revAfterClear,
      patches: [
        {
          field: "title",
          value: "AI 不应静默填回的标题",
          rationale: "r",
          mode: "fill_empty",
        },
      ],
    });
    expect(applyAfterClear.applied).toBe(0);
    expect(applyAfterClear.conflicts).toHaveLength(1);
    expect(titleInput.value).toBe("");

    // P1-8：在途请求期间用户手工修改验收标准 -> 迟到 AI 响应必须被拦截，零覆盖！
    const gate = Promise.withResolvers<void>();
    const revBeforeSlow = bridge.getDraftSnapshot().revision;
    invokeCopilot.mockImplementationOnce(async () => {
      await gate.promise;
      return {
        ok: true,
        turnId: "turn_late",
        kind: "form_patch",
        summary: "迟到响应",
        routeSource: "in_context",
        untrusted: true,
        proposal: {
          proposalId: "prop_late",
          formId,
          tool: "create_story",
          baseRevision: revBeforeSlow,
          patches: [
            {
              field: "verify",
              value: "迟到覆盖内容",
              rationale: "stale",
              mode: "propose_replace",
            },
          ],
          warnings: [],
          missingFields: [],
        },
      };
    });
    const slowPromise = controller.sendPrompt("再优化一下验收标准");
    verifyInput.value = "用户最新手写的验收标准";
    verifyInput.dispatchEvent({ type: "input" });
    gate.resolve();
    const lateOutcome = await slowPromise;
    expect(lateOutcome).toEqual({ stale: true });
    expect(verifyInput.value).toBe("用户最新手写的验收标准");
  });

  it("P1-8：发送后切页立即中止旧请求并复位 busy，新请求不被卡死；prefill 推进 revision", async () => {
    const { root } = fakeDom();
    const write = renderWrite(
      root,
      "create_story",
      vi.fn(async () => ({ ok: true })),
      "RD",
      "alice",
      {},
    );
    const bridge = write!.draftBridge!;
    const rev1 = bridge.getDraftSnapshot().revision;
    write!.prefill({ title: "从需求侧栏带入" });
    expect(bridge.getDraftSnapshot().revision).toBeGreaterThan(rev1);

    const gate = Promise.withResolvers<void>();
    let firstAborted = false;
    const invokeCopilot = vi
      .fn()
      .mockImplementationOnce(
        async (_payload: unknown, opts?: { signal?: AbortSignal }) => {
          opts?.signal?.addEventListener("abort", () => {
            firstAborted = true;
          });
          await gate.promise;
          return {
            ok: true,
            turnId: "old",
            kind: "clarification",
            summary: "旧响应",
            routeSource: "l1",
          };
        },
      )
      .mockImplementationOnce(async () => ({
        ok: true,
        turnId: "new",
        kind: "clarification",
        summary: "新页响应正常送达",
        routeSource: "l1",
      }));

    const controller = createInContextCopilotController({
      invokeCopilot,
      openFormalIntake: vi.fn(),
      getContextMeta: () => ({ role: "RD", view: "intake", month: "2026-11" }),
      onUpdate: () => {},
    });
    controller.bindForm(bridge);

    const first = controller.sendPrompt("在途请求");
    expect(controller.snapshot().busy).toBe(true);

    // 模拟切页：必须立即取消旧请求并复位 busy=false。
    controller.clearContext();
    expect(firstAborted).toBe(true);
    expect(controller.snapshot().busy).toBe(false);

    // 立刻发送新页请求必须被正常受理，不能被卡死。
    const second = await controller.sendPrompt("新页请求");
    expect(second).toMatchObject({
      turnId: "new",
      summary: "新页响应正常送达",
    });

    gate.resolve();
    expect(await first).toBeNull();
  });

  it("自然语言从台账发起提需打开正式表单，跨账号 resetSession 清空历史响应", async () => {
    const openFormalIntake = vi.fn();
    const controller = createInContextCopilotController({
      invokeCopilot: async () => ({
        ok: true,
        turnId: "turn_open",
        kind: "open_form_patch",
        summary: "已打开正式表单",
        routeSource: "in_context",
        untrusted: true,
        openForm: { section: "intake", tool: "create_story" },
        proposal: {
          proposalId: "prop_open",
          formId: "create_story",
          tool: "create_story",
          baseRevision: 0,
          patches: [
            {
              field: "title",
              value: "审批清单按二级部门导出",
              rationale: "提炼",
              mode: "fill_empty",
            },
          ],
          warnings: [],
          missingFields: [],
        },
      }),
      openFormalIntake,
      getContextMeta: () => ({
        role: "RD",
        view: "workbench",
        month: "2026-11",
      }),
      onUpdate: () => {},
    });

    await controller.sendPrompt("帮我提一个需求：审批清单按二级部门导出");
    expect(openFormalIntake).toHaveBeenCalledTimes(1);
    expect(controller.snapshot().lastTurn).not.toBeNull();

    controller.resetSession();
    expect(controller.snapshot().lastTurn).toBeNull();
    expect(controller.snapshot().pendingConflicts).toHaveLength(0);
    expect(controller.snapshot().boundForm).toBeNull();
  });

  it("P1-7：多条冲突采纳首条后保留其余待采纳建议，且复选框布尔值准确写回 checked", async () => {
    const { root } = fakeDom();
    const write = renderWrite(
      root,
      "reschedule_story",
      vi.fn(async () => ({ ok: true })),
      "RM",
      "alice",
      {
        storyIds: [101],
        toMonth: "2026-11",
        reason: "手工原原因",
        moveTasks: false,
      },
    );
    const bridge = write!.draftBridge!;
    const snap0 = bridge.getDraftSnapshot();
    const controller = createInContextCopilotController({
      invokeCopilot: async () => ({
        ok: true,
        turnId: "t_multi",
        kind: "form_patch",
        summary: "3 项挪月对比建议",
        routeSource: "in_context",
        untrusted: true,
        proposal: {
          proposalId: "p_multi",
          formId: snap0.formId,
          tool: "reschedule_story",
          targetObjectId: 101,
          baseRevision: snap0.revision,
          contextBinding: "a".repeat(32),
          patches: [
            {
              field: "moveTasks",
              value: true,
              rationale: "同步挪动未完成任务",
              mode: "propose_replace",
            },
            {
              field: "toMonth",
              value: "2026-12",
              rationale: "顺延至下月",
              mode: "propose_replace",
            },
            {
              field: "reason",
              value: "AI 建议的挪月说明",
              rationale: "说明更清晰",
              mode: "propose_replace",
            },
          ],
          warnings: [],
          missingFields: [],
        },
      }),
      openFormalIntake: vi.fn(),
      getContextMeta: () => ({
        role: "RM",
        view: "stories",
        selectedStoryId: 101,
        month: "2026-11",
      }),
      onUpdate: () => {},
    });
    controller.bindForm(bridge);
    await controller.sendPrompt("帮我填写挪月信息");

    expect(controller.snapshot().pendingConflicts).toHaveLength(3);
    // 采纳第 1 项布尔复选框建议：checked 必须变为 true，且其余 2 项建议必须保留！
    expect(controller.acceptConflict(0)).toBe(true);
    const moveTasksBox = root.querySelector('[name="moveTasks"]')!;
    expect(moveTasksBox.checked).toBe(true);
    expect(controller.snapshot().pendingConflicts).toHaveLength(2);
    expect(
      controller
        .snapshot()
        .pendingConflicts.map((c: { field: string }) => c.field),
    ).toEqual(["toMonth", "reason"]);

    // P2-1：目标绑定型表单缺少或传入非法格式 contextBinding 时直接拦截为 stale。
    const snap1 = bridge.getDraftSnapshot();
    expect(
      bridge.applyAiPatch({
        proposalId: "p_no_bind",
        formId: snap1.formId,
        tool: "reschedule_story",
        targetObjectId: 101,
        baseRevision: snap1.revision,
        patches: [
          { field: "reason", value: "x", rationale: "r", mode: "fill_empty" },
        ],
      }).stale,
    ).toBe(true);
    expect(
      bridge.applyAiPatch({
        proposalId: "p_bad_bind",
        formId: snap1.formId,
        tool: "reschedule_story",
        targetObjectId: 101,
        baseRevision: snap1.revision,
        contextBinding: "NOT-VALID-HEX-STRING!!",
        patches: [
          { field: "reason", value: "x", rationale: "r", mode: "fill_empty" },
        ],
      }).stale,
    ).toBe(true);
  });
});
