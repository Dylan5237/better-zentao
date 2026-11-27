/**
 * CR-009 §11.2 / ADR-28：better-zentao 2.0 原位协作前端控制器（In-context Copilot）。
 * - 人工表单与 AI 助手共享同一份表单 draftBridge，绝不维护两套草稿；
 * - AI 仅返回受控 FormPatchProposal JSON，绝不直接操作 DOM 或执行任意脚本；
 * - 已有手工输入（含主动清空）字段永不静默覆盖，生成显式对比建议卡（采纳/忽略）并支持精细撤销；
 * - 上下文切换/手工编辑即时取消在途请求、复位 busy 并清理失效待采纳建议；
 * - 双视图切换使用独立 #ai-workspace-container，绝不销毁人工工作台活跃表单与草稿；
 * - 个人大模型 Token 仅通过密码框提交至服务端加密存储，绝不写入 localStorage/sessionStorage；
 *   所有设置异步请求绑定会话代次与 AbortController，防止跨账号/职责回填界面。
 */

function el(doc, tag, className, text) {
  const node = doc.createElement(tag);
  if (className) node.className = className;
  if (text != null) node.textContent = String(text);
  return node;
}

function btn(doc, className, label, onClick) {
  const node = el(doc, "button", className, label);
  node.type = "button";
  node.addEventListener("click", onClick);
  return node;
}

function renderToolSummary(doc, tool, toolResult) {
  const box = el(doc, "div", "ai-tool-summary");
  const meta = el(doc, "div", "ai-card-head");
  meta.append(
    el(doc, "span", "bzt-badge", tool || "业务查询"),
    el(
      doc,
      "span",
      "bzt-badge",
      toolResult?.completeness === "partial" ? "部分数据" : "完整数据",
    ),
  );
  box.append(meta);
  const data = toolResult?.data;
  if (data && typeof data === "object") {
    const facts = [];
    if (typeof data.story?.id === "number") {
      facts.push(
        `需求 #${data.story.id}：${data.story.title ?? ""}（${data.progress ?? data.story.status ?? ""}）`,
      );
    }
    if (Array.isArray(data.hits)) {
      facts.push(`扫描命中风险：${data.hits.length} 条`);
      if (Array.isArray(data.summary) && data.summary.length > 0) {
        facts.push(
          "规则分布：" +
            data.summary
              .slice(0, 4)
              .map((s) => `${s.rule}(${s.count})`)
              .join("、"),
        );
      }
      for (const hit of data.hits.slice(0, 3)) {
        if (hit?.rule && hit?.object?.id) {
          facts.push(
            `· [${hit.rule}] #${hit.object.id} ${hit.object.title ?? ""} — ${hit.reason ?? ""}`,
          );
        }
      }
    }
    if (Array.isArray(data.items)) {
      facts.push(`命中记录：${data.items.length} 条`);
      for (const item of data.items.slice(0, 3)) {
        if (item?.id && item?.title) {
          facts.push(`· #${item.id} ${item.title}`);
        } else if (item?.rule && item?.message) {
          facts.push(`· [${item.rule}] ${item.message}`);
        }
      }
    }
    if (Array.isArray(data.risks)) {
      facts.push(`风险项：${data.risks.length} 条`);
      for (const r of data.risks.slice(0, 3)) {
        if (r?.rule && r?.message) facts.push(`· [${r.rule}] ${r.message}`);
      }
    }
    // 适配 get_my_work 真实契约结构（action 对象、can_start 对象与 waiting_ready/new/maintained/raised 数组）。
    if (
      data.action &&
      typeof data.action === "object" &&
      !Array.isArray(data.action)
    ) {
      for (const [subKey, label] of [
        ["overdue", "已逾期任务"],
        ["dueToday", "今日到期"],
        ["dueSoon", "临期任务"],
        ["toReceive", "待接收需求"],
        ["toReview", "待评审需求"],
        ["unscheduled", "未排期任务"],
      ]) {
        const list = data.action[subKey];
        if (Array.isArray(list) && list.length > 0) {
          facts.push(`${label}：${list.length} 项`);
        }
      }
    }
    if (
      data.can_start &&
      typeof data.can_start === "object" &&
      !Array.isArray(data.can_start)
    ) {
      for (const [subKey, label] of [
        ["tests", "可开测"],
        ["upcomingTests", "即将开测"],
        ["acceptDeliver", "可验收/交付"],
      ]) {
        const list = data.can_start[subKey];
        if (Array.isArray(list) && list.length > 0) {
          facts.push(`${label}：${list.length} 项`);
        }
      }
    }
    for (const [key, label] of [
      ["waiting_ready", "等待就绪"],
      ["new", "新分配"],
      ["raised", "我提出的"],
      ["maintained", "我维护的"],
    ]) {
      const group = data[key];
      if (Array.isArray(group) && group.length > 0) {
        facts.push(`${label}：${group.length} 项`);
      }
    }
    if (facts.length > 0) {
      const list = el(doc, "ul", "ai-summary-list");
      for (const line of facts) list.append(el(doc, "li", "", line));
      box.append(list);
    }
  }
  if (Array.isArray(toolResult?.gaps) && toolResult.gaps.length > 0) {
    box.append(
      el(
        doc,
        "p",
        "bzt-alert tone-warn",
        `数据缺口（${toolResult.gaps.length}）：${toolResult.gaps.map((g) => g.source).join("、")}`,
      ),
    );
  }
  return box;
}

/**
 * 纯可测原位协作状态控制器：协调活跃表单桥接、受控补丁应用、待采纳冲突、撤销、取消在途请求与防迟到覆盖。
 */
export function createInContextCopilotController({
  invokeCopilot,
  openFormalIntake,
  getContextMeta,
  onUpdate,
}) {
  let boundBridge = null;
  let unsubscribeBridge = null;
  let activeAbort = null;
  let pendingConflicts = [];
  let lastTurn = null;
  let lastError = "";
  let busy = false;
  let requestSeq = 0;

  function notify() {
    onUpdate?.(snapshot());
  }

  function cancelInflight() {
    requestSeq += 1;
    if (activeAbort) {
      activeAbort.abort();
      activeAbort = null;
    }
    busy = false;
  }

  function detachBridge() {
    unsubscribeBridge?.();
    unsubscribeBridge = null;
    boundBridge = null;
  }

  function snapshot() {
    const draft = boundBridge?.getDraftSnapshot?.() ?? null;
    return {
      boundForm: draft,
      hasUndo: Boolean(boundBridge?.hasAiUndo?.()),
      pendingConflicts: [...pendingConflicts],
      lastTurn,
      lastError,
      busy,
    };
  }

  function bindForm(bridge) {
    cancelInflight();
    detachBridge();
    boundBridge = bridge ?? null;
    pendingConflicts = [];
    lastError = "";
    if (boundBridge?.subscribe) {
      unsubscribeBridge = boundBridge.subscribe((_snap, changedField) => {
        if (pendingConflicts.length > 0) {
          pendingConflicts = changedField
            ? pendingConflicts.filter((item) => item.field !== changedField)
            : [];
        }
        notify();
      });
    }
    notify();
  }

  function clearContext() {
    cancelInflight();
    detachBridge();
    pendingConflicts = [];
    lastError = "";
    notify();
  }

  function resetSession() {
    cancelInflight();
    detachBridge();
    pendingConflicts = [];
    lastTurn = null;
    lastError = "";
    notify();
  }

  function applyExternalProposal(
    proposal,
    summary = "已按自然语言预填正式表单",
  ) {
    if (!boundBridge || !proposal) return null;
    const snap = boundBridge.getDraftSnapshot();
    if (!snap || snap.tool !== proposal.tool) return null;
    const applied = boundBridge.applyAiPatch({
      ...proposal,
      formId: snap.formId,
      ...(snap.targetObjectId === undefined
        ? {}
        : { targetObjectId: snap.targetObjectId }),
      baseRevision: snap.revision,
    });
    if (applied.stale) return { stale: true };
    pendingConflicts = applied.conflicts;
    lastError = "";
    lastTurn = {
      ok: true,
      kind: "form_patch",
      routeSource: "in_context",
      untrusted: true,
      summary,
      proposal,
      appliedCount: applied.applied,
      conflictCount: applied.conflicts.length,
    };
    notify();
    return lastTurn;
  }

  async function sendPrompt(rawPrompt) {
    const prompt = String(rawPrompt ?? "").trim();
    if (!prompt || busy) return null;
    const mySeq = ++requestSeq;
    const abort = new AbortController();
    activeAbort = abort;
    const meta = getContextMeta();
    const formSnapshot = boundBridge?.getDraftSnapshot?.() ?? undefined;
    const baseRevision = formSnapshot?.revision;
    const baseFormId = formSnapshot?.formId;
    const baseTargetId = formSnapshot?.targetObjectId;
    busy = true;
    lastError = "";
    notify();
    try {
      const response = await invokeCopilot(
        {
          role: meta.role,
          prompt,
          ...(meta.month ? { month: meta.month } : {}),
          context: {
            view: meta.view,
            ...(typeof meta.selectedStoryId === "number" &&
            Number.isInteger(meta.selectedStoryId) &&
            meta.selectedStoryId > 0
              ? { selectedStoryId: meta.selectedStoryId }
              : {}),
            ...(formSnapshot ? { form: formSnapshot } : {}),
          },
        },
        { signal: abort.signal },
      );
      // 上下文已切换或已有新请求发起时，丢弃迟到响应。
      if (mySeq !== requestSeq || abort.signal.aborted) return null;

      if (response.kind === "form_patch" && response.proposal) {
        const current = boundBridge?.getDraftSnapshot?.();
        if (
          !boundBridge ||
          !current ||
          current.formId !== baseFormId ||
          current.targetObjectId !== baseTargetId ||
          current.revision !== baseRevision
        ) {
          lastError =
            "在等待 AI 响应期间您修改了表单或切换了页面，已自动拦截迟到建议，未覆盖您的输入。";
          lastTurn = null;
          return { stale: true };
        }
        const applied = boundBridge.applyAiPatch(response.proposal);
        if (applied.stale) {
          lastError = "草稿版本已更新，已拦截过期建议。";
          return { stale: true };
        }
        pendingConflicts = applied.conflicts;
        lastTurn = {
          ...response,
          appliedCount: applied.applied,
          conflictCount: applied.conflicts.length,
        };
        return lastTurn;
      }

      if (
        response.kind === "open_form_patch" &&
        response.openForm &&
        response.proposal
      ) {
        // 自然语言发起业务工作：打开同一正式业务表单并注入受控草稿。
        openFormalIntake?.(response.proposal, response.summary);
        lastTurn = response;
        return response;
      }

      lastTurn = response;
      return response;
    } catch (error) {
      if (mySeq !== requestSeq || abort.signal.aborted) return null;
      lastError = error?.message || "AI 助手请求失败，请稍后重试。";
      return null;
    } finally {
      if (activeAbort === abort) activeAbort = null;
      if (mySeq === requestSeq) {
        busy = false;
        notify();
      }
    }
  }

  function acceptConflict(index) {
    const item = pendingConflicts[index];
    if (!item || !boundBridge) return false;
    // P1-7：传入原始类型值（如复选框的 boolean true/false），绝不把展示文案写回控件。
    const writeVal = Object.hasOwn(item, "rawProposedValue")
      ? item.rawProposedValue
      : item.proposedValue;
    const ok = boundBridge.acceptAiSuggestion(
      item.field,
      writeVal,
      item.rationale,
    );
    if (ok) {
      pendingConflicts = pendingConflicts.filter((entry) => entry !== item);
      notify();
    }
    return ok;
  }

  function ignoreConflict(index) {
    pendingConflicts = pendingConflicts.filter((_, i) => i !== index);
    notify();
  }

  function undoLastAiPatch() {
    if (!boundBridge) return false;
    const ok = boundBridge.undoLastAiPatch();
    if (ok) {
      pendingConflicts = [];
      notify();
    }
    return ok;
  }

  return {
    snapshot,
    bindForm,
    clearContext,
    resetSession,
    applyExternalProposal,
    sendPrompt,
    acceptConflict,
    ignoreConflict,
    undoLastAiPatch,
  };
}

/**
 * 挂载 2.0 原位协作 UI：顶部双视图切换、可折叠右侧 AI 助手抽屉、个人 AI 设置弹窗与独立 AI 协作视图。
 * 仅在服务端 `identity.ai?.enabled === true` 时显示；未启用时保持全部元素隐藏（零假按钮）。
 */
export function mountInContextCopilot({
  byId,
  session,
  getCurrentSection,
  getSelectedMonth,
  getActiveStoryId,
  openSection,
  onApplyFilters,
  toast,
}) {
  const viewSwitch = byId("ai-view-switch");
  const drawerToggle = byId("ai-assistant-toggle");
  const drawer = byId("ai-copilot-drawer");
  const drawerBody = byId("ai-copilot-body");
  const drawerClose = byId("ai-copilot-close");
  const drawerStatus = byId("ai-copilot-status");
  const settingsBtn = byId("ai-settings-button");
  const settingsDialog = byId("ai-settings-dialog");
  const workspace = byId("workspace");
  const aiWorkspaceContainer = byId("ai-workspace-container");
  if (
    !viewSwitch ||
    !drawerToggle ||
    !drawer ||
    !drawerBody ||
    !settingsBtn ||
    !settingsDialog ||
    !workspace ||
    !aiWorkspaceContainer
  ) {
    return {
      syncIdentity: () => {},
      bindForm: () => {},
      unbindOverlayForm: () => {},
      clearForm: () => {},
      openSettings: () => {},
      isAiWorkspaceActive: () => false,
    };
  }

  const doc = drawer.ownerDocument;
  let aiMeta = {
    enabled: false,
    available: false,
    configured: false,
    verified: false,
  };
  let aiConfigDetail = null;
  let drawerOpen = false;
  let activeMode = "human";
  let pendingOpenProposal = null;
  let lastPrincipalKey = "";
  let lastSessionKey = "";
  let settingsGen = 0;
  let settingsAbort = null;
  let pageFormBridge = null;
  let overlayFormBridge = null;

  function activeHumanBridge() {
    return overlayFormBridge ?? pageFormBridge;
  }

  function syncActiveFormBinding() {
    if (activeMode === "ai") {
      // P1-9：切入独立 AI 协作工作台时暂停表单绑定，避免全局提问误发给隐藏的正式表单，同时保留人工表单实例不销毁。
      controller.clearContext();
      return;
    }
    const bridge = activeHumanBridge();
    if (bridge) controller.bindForm(bridge);
    else controller.clearContext();
  }

  const controller = createInContextCopilotController({
    invokeCopilot: (payload, opts) => session.invokeCopilot(payload, opts),
    openFormalIntake: (proposal, summary) => {
      pendingOpenProposal = { proposal, summary };
      activeMode = "human";
      updateViewTabs();
      openSection("intake");
    },
    getContextMeta: () => ({
      role: session.role?.id ?? "",
      view: activeMode === "ai" ? "ai-workspace" : getCurrentSection(),
      month: getSelectedMonth(),
      selectedStoryId: getActiveStoryId(),
    }),
    onUpdate: () => {
      renderDrawer();
      if (activeMode === "ai") renderAiWorkspace();
    },
  });

  function updateViewTabs() {
    for (const tab of viewSwitch.querySelectorAll("[data-ai-view]")) {
      const isActive = tab.dataset.aiView === activeMode;
      tab.classList.toggle("is-active", isActive);
      tab.setAttribute("aria-pressed", String(isActive));
    }
    const showAiWorkspace = aiMeta.enabled && activeMode === "ai";
    workspace.hidden = showAiWorkspace;
    aiWorkspaceContainer.hidden = !showAiWorkspace;
    drawer.hidden = !aiMeta.enabled || !drawerOpen || activeMode === "ai";
  }

  function renderDrawer() {
    if (!aiMeta.enabled) {
      drawer.hidden = true;
      return;
    }
    const ready = aiMeta.available && aiMeta.configured && aiMeta.verified;
    if (drawerStatus) {
      drawerStatus.textContent = !aiMeta.available
        ? "未就绪"
        : ready
          ? "已验证"
          : "需配置";
    }
    drawerBody.replaceChildren();

    if (!aiMeta.available) {
      const card = el(doc, "div", "ai-card");
      card.append(
        el(doc, "strong", "", "服务尚未配置个人凭据主密钥"),
        el(
          doc,
          "p",
          "page-sub",
          "管理员配置主密钥后即可启用内置 AI 助手；人工业务工作台不受任何影响。",
        ),
      );
      drawerBody.append(card);
      return;
    }

    if (!ready) {
      const card = el(doc, "div", "ai-card");
      card.append(
        el(doc, "strong", "", "启用个人 AI 原位助手"),
        el(
          doc,
          "p",
          "page-sub",
          "请先配置您本人的企业大模型网关与个人 Token 并完成连接测试。未配置时人工工作台完全可用，绝不共享或回退他人凭据。",
        ),
        btn(
          doc,
          "btn-primary btn-sm",
          "配置个人 AI 网关",
          () => void openSettings(),
        ),
      );
      drawerBody.append(card);
      return;
    }

    const snap = controller.snapshot();
    const storyId = getActiveStoryId();
    const strip = el(doc, "div", "ai-context-strip");
    strip.append(
      el(doc, "span", "", "当前现场："),
      el(
        doc,
        "strong",
        "",
        snap.boundForm
          ? `${snap.boundForm.tool === "create_story" ? "提出需求表单" : snap.boundForm.tool} · r${snap.boundForm.revision}`
          : `${getCurrentSection()}${storyId ? " · #" + storyId : ""}`,
      ),
      el(doc, "span", "bzt-badge", session.role?.id ?? ""),
    );
    drawerBody.append(strip);

    const promptCard = el(doc, "div", "ai-card");
    const textarea = el(doc, "textarea", "bzt-input ai-prompt-input");
    textarea.placeholder = snap.boundForm
      ? "描述需求或修改意见，例如：帮我按描述补全实现范围与可测验收标准…"
      : "用自然语言查进展、扫风险，或说“帮我提一个需求：…”直接打开正式表单预填…";
    const row = el(doc, "div", "ai-actions-row");
    const submitBtn = btn(
      doc,
      "btn-primary btn-sm",
      snap.busy ? "处理中…" : snap.boundForm ? "辅助填表" : "发送给 AI",
      () => {
        const text = textarea.value.trim();
        if (!text) return;
        void controller.sendPrompt(text);
      },
    );
    submitBtn.disabled = snap.busy;
    row.append(submitBtn);

    if (snap.boundForm) {
      const verifyBtn = btn(doc, "btn-secondary btn-sm", "补全验收标准", () => {
        void controller.sendPrompt(
          "请结合当前草稿补全清晰可测量的验收标准，不要覆盖我已写好的其他字段。",
        );
      });
      verifyBtn.disabled = snap.busy;
      row.append(verifyBtn);
      if (snap.hasUndo) {
        row.append(
          btn(doc, "btn-secondary btn-sm", "撤销上次 AI 修改", () => {
            if (controller.undoLastAiPatch())
              toast?.("已撤销上次 AI 表单修改（已保留后续手工编辑）", "info");
          }),
        );
      }
    } else {
      row.append(
        btn(
          doc,
          "btn-secondary btn-sm",
          "扫本月风险",
          () => void controller.sendPrompt("扫一下本月流程风险"),
        ),
        btn(
          doc,
          "btn-secondary btn-sm",
          "查我的工作",
          () => void controller.sendPrompt("查看我的待办工作"),
        ),
      );
    }

    promptCard.append(textarea, row);
    drawerBody.append(promptCard);

    if (snap.lastError) {
      drawerBody.append(el(doc, "p", "bzt-alert tone-danger", snap.lastError));
    }

    if (snap.lastTurn) {
      const resCard = el(doc, "div", "ai-card");
      const head = el(doc, "div", "ai-card-head");
      head.append(
        el(doc, "strong", "", "AI 助手反馈"),
        el(doc, "span", "bzt-badge", snap.lastTurn.routeSource),
      );
      resCard.append(head, el(doc, "p", "page-sub", snap.lastTurn.summary));
      if (snap.lastTurn.proposal?.warnings?.length) {
        for (const w of snap.lastTurn.proposal.warnings) {
          resCard.append(el(doc, "p", "bzt-alert tone-warn", w));
        }
      }
      if (
        snap.lastTurn.kind === "filter_suggestion" &&
        snap.lastTurn.filters &&
        Object.keys(snap.lastTurn.filters).length > 0
      ) {
        const filterRow = el(doc, "div", "ai-actions-row");
        filterRow.append(
          btn(doc, "btn-primary btn-sm", "应用到需求台账", () => {
            onApplyFilters?.(snap.lastTurn.filters);
            toast?.("已应用原位筛选条件", "info");
          }),
        );
        resCard.append(filterRow);
      }
      if (snap.lastTurn.kind === "tool_result" && snap.lastTurn.toolResult) {
        resCard.append(
          renderToolSummary(doc, snap.lastTurn.tool, snap.lastTurn.toolResult),
        );
      }
      drawerBody.append(resCard);
    }

    for (const [idx, conflict] of snap.pendingConflicts.entries()) {
      const card = el(doc, "div", "ai-card ai-conflict-card");
      card.append(
        el(
          doc,
          "strong",
          "",
          `待采纳建议 · ${conflict.label || conflict.field}（已保护手工输入）`,
        ),
        el(doc, "div", "ai-diff-current", `当前值：${conflict.currentValue}`),
        el(doc, "div", "ai-diff-proposed", `建议值：${conflict.proposedValue}`),
        el(doc, "div", "page-sub", conflict.rationale),
      );
      const actions = el(doc, "div", "ai-actions-row");
      actions.append(
        btn(doc, "btn-primary btn-sm", "采纳该建议", () =>
          controller.acceptConflict(idx),
        ),
        btn(doc, "btn-secondary btn-sm", "保留手工内容", () =>
          controller.ignoreConflict(idx),
        ),
      );
      card.append(actions);
      drawerBody.append(card);
    }

    drawerBody.append(
      el(
        doc,
        "p",
        "page-sub",
        "安全提示：AI 助手使用您本人的模型网关 Token，仅提供分析与受控填表建议，绝不代为确认任何禅道写入。",
      ),
    );
  }

  function renderAiWorkspace() {
    aiWorkspaceContainer.replaceChildren();
    const wrap = el(doc, "section", "ai-workspace-view");
    const head = el(doc, "header", "page-head");
    const intro = el(doc, "div");
    intro.append(
      el(doc, "h1", "page-title", "AI 协作工作台"),
      el(
        doc,
        "p",
        "page-sub",
        "面向跨需求分析、流程风险研判与多步骤协作；返回人工工作台时保留未提交表单与撤销栈。",
      ),
    );
    const backBtn = btn(
      doc,
      "btn-secondary btn-sm",
      "返回人工业务工作台",
      () => {
        activeMode = "human";
        updateViewTabs();
        syncActiveFormBinding();
      },
    );
    head.append(intro, backBtn);
    wrap.append(head);

    const ready = aiMeta.available && aiMeta.configured && aiMeta.verified;
    if (!ready) {
      const card = el(doc, "div", "ai-card");
      card.append(
        el(doc, "strong", "", "请先完成个人企业大模型网关配置与连接测试"),
        el(
          doc,
          "p",
          "page-sub",
          "配置仅归当前登录账号独占，未配置时人工业务工作台仍可正常使用。",
        ),
        btn(
          doc,
          "btn-primary btn-sm",
          "打开个人 AI 设置",
          () => void openSettings(),
        ),
      );
      wrap.append(card);
      aiWorkspaceContainer.append(wrap);
      return;
    }

    const composer = el(doc, "div", "ai-card");
    const input = el(doc, "textarea", "bzt-input ai-prompt-input");
    input.placeholder =
      "例如：扫一下本月流程风险 / 查看 #101 进展 / 帮我提一个需求：审批清单按二级部门导出…";
    const row = el(doc, "div", "ai-actions-row");
    row.append(
      btn(doc, "btn-primary btn-sm", "发送", () => {
        const text = input.value.trim();
        if (text) void controller.sendPrompt(text);
      }),
      btn(
        doc,
        "btn-secondary btn-sm",
        "扫描本月风险",
        () => void controller.sendPrompt("扫一下本月流程风险"),
      ),
      btn(doc, "btn-secondary btn-sm", "打开正式提需求表单", () => {
        activeMode = "human";
        updateViewTabs();
        openSection("intake");
      }),
    );
    composer.append(input, row);
    wrap.append(composer);

    const snap = controller.snapshot();
    if (snap.lastError) {
      wrap.append(el(doc, "p", "bzt-alert tone-danger", snap.lastError));
    }
    if (snap.lastTurn) {
      const card = el(doc, "div", "ai-card");
      card.append(el(doc, "strong", "", snap.lastTurn.summary));
      if (snap.lastTurn.kind === "tool_result" && snap.lastTurn.toolResult) {
        card.append(
          renderToolSummary(doc, snap.lastTurn.tool, snap.lastTurn.toolResult),
        );
      }
      wrap.append(card);
    }
    aiWorkspaceContainer.append(wrap);
  }

  function renderSettingsDialog(statusMessage = "") {
    const body = byId("ai-settings-body");
    if (!body) return;
    body.replaceChildren();
    const detail = aiConfigDetail;
    const masked = detail?.masked ?? { configured: false, verified: false };
    const status = el(
      doc,
      "div",
      "ai-settings-status",
      statusMessage ||
        (masked.lastErrorCode === "MASTER_KEY_MISMATCH"
          ? "服务端主密钥已变更，现有加密凭据无法解开，请重新输入个人 Token 并保存。"
          : masked.configured && masked.verified
            ? `已验证可用 · 脱敏 Token ${masked.tokenHint || "••••"} · 模型 ${masked.modelId || ""}`
            : masked.configured
              ? `已保存（${masked.tokenHint || "••••"}），请点击「测试连接」完成验证。`
              : "尚未配置个人企业大模型网关（人工工作台不受影响）。"),
    );

    const form = el(doc, "form", "ai-settings-form");
    const allowHint =
      detail?.allowedGateways?.length > 0
        ? "管理员允许网关：" +
          detail.allowedGateways
            .map((g) => g.origin + (g.pathPrefix ?? ""))
            .join("、")
        : "管理员尚未配置允许的大模型网关白名单。";

    const urlField = el(doc, "label", "field");
    const urlInput = el(doc, "input", "bzt-input mono");
    urlInput.type = "url";
    urlInput.required = true;
    urlInput.value =
      masked.baseUrl ||
      (detail?.allowedGateways?.[0]
        ? detail.allowedGateways[0].origin +
          (detail.allowedGateways[0].pathPrefix ?? "/v1")
        : "");
    urlField.append(
      el(doc, "span", "", "企业大模型网关地址（Base URL）"),
      urlInput,
      el(doc, "span", "page-sub", allowHint),
    );

    const protoField = el(doc, "label", "field");
    const protoSelect = el(doc, "select", "bzt-input");
    for (const [val, label] of [
      ["openai-compatible", "OpenAI 兼容协议"],
      ["anthropic-compatible", "Anthropic 兼容协议"],
    ]) {
      const opt = el(doc, "option", "", label);
      opt.value = val;
      if ((masked.protocol || "openai-compatible") === val) opt.selected = true;
      protoSelect.append(opt);
    }
    protoField.append(el(doc, "span", "", "网关协议"), protoSelect);

    const modelField = el(doc, "label", "field");
    const modelInput = el(doc, "input", "bzt-input mono");
    modelInput.type = "text";
    modelInput.required = true;
    modelInput.value = masked.modelId || "";
    modelInput.placeholder = "例如：gpt-4o-mini / enterprise-model";
    modelField.append(el(doc, "span", "", "模型标识（Model ID）"), modelInput);

    const tokenField = el(doc, "label", "field");
    const tokenInput = el(doc, "input", "bzt-input mono");
    tokenInput.type = "password";
    tokenInput.autocomplete = "off";
    tokenInput.placeholder = masked.configured
      ? "仅改模型时可留空；更换地址或协议须重新输入 Token"
      : "请输入您的个人企业大模型 Token";
    tokenField.append(
      el(
        doc,
        "span",
        "",
        "个人模型 Token（服务端 AES-256-GCM 加密，绝不回显明文）",
      ),
      tokenInput,
    );

    const beginSettingsCall = () => {
      settingsAbort?.abort();
      const abort = new AbortController();
      settingsAbort = abort;
      return {
        myGen: settingsGen,
        myKey: lastSessionKey,
        signal: abort.signal,
      };
    };
    const isStale = ({ myGen, myKey, signal }) =>
      signal.aborted || myGen !== settingsGen || myKey !== lastSessionKey;

    const actions = el(doc, "div", "ai-settings-actions");
    const delBtn = btn(doc, "btn-secondary btn-sm", "删除配置", async () => {
      const guard = beginSettingsCall();
      try {
        const res = await session.deleteAiConfig({ signal: guard.signal });
        if (isStale(guard)) return;
        aiConfigDetail = { ...aiConfigDetail, masked: res.masked };
        aiMeta = { ...aiMeta, configured: false, verified: false };
        renderSettingsDialog("已删除个人模型配置与加密凭据。");
        renderDrawer();
      } catch (error) {
        if (isStale(guard)) return;
        renderSettingsDialog(error.message || "删除失败。");
      }
    });
    delBtn.disabled = !masked.configured;

    const right = el(doc, "div", "ai-actions-row");
    const testBtn = btn(doc, "btn-secondary btn-sm", "测试连接", async () => {
      const guard = beginSettingsCall();
      try {
        const res = await session.testAiConfig({ signal: guard.signal });
        if (isStale(guard)) return;
        aiConfigDetail = { ...aiConfigDetail, masked: res.masked };
        aiMeta = {
          ...aiMeta,
          configured: res.masked.configured,
          verified: res.masked.verified,
        };
        renderSettingsDialog(
          res.ok
            ? "连接测试通过，已启用个人 AI 助手。"
            : `连接测试未通过（${res.masked.lastErrorCode || "GATEWAY_ERROR"}）。`,
        );
        renderDrawer();
      } catch (error) {
        if (isStale(guard)) return;
        renderSettingsDialog(error.message || "连接测试失败。");
      }
    });
    testBtn.disabled = !masked.configured;

    const saveBtn = el(doc, "button", "btn-primary btn-sm", "保存配置");
    saveBtn.type = "submit";
    right.append(testBtn, saveBtn);
    actions.append(delBtn, right);

    form.addEventListener("submit", async (event) => {
      event.preventDefault();
      const guard = beginSettingsCall();
      try {
        const res = await session.saveAiConfig(
          {
            baseUrl: urlInput.value.trim(),
            protocol: protoSelect.value,
            modelId: modelInput.value.trim(),
            ...(tokenInput.value.trim()
              ? { token: tokenInput.value.trim() }
              : {}),
          },
          { signal: guard.signal },
        );
        if (isStale(guard)) return;
        tokenInput.value = "";
        aiConfigDetail = { ...aiConfigDetail, masked: res.masked };
        aiMeta = {
          ...aiMeta,
          configured: res.masked.configured,
          verified: res.masked.verified,
        };
        renderSettingsDialog("配置已加密保存，请点击「测试连接」验证。");
        renderDrawer();
      } catch (error) {
        if (isStale(guard)) return;
        renderSettingsDialog(error.message || "保存配置失败。");
      }
    });

    form.append(urlField, protoField, modelField, tokenField, actions);
    body.append(status, form);
  }

  async function openSettings() {
    settingsAbort?.abort();
    const abort = new AbortController();
    settingsAbort = abort;
    const myGen = settingsGen;
    const myKey = lastSessionKey;
    try {
      const detail = await session.aiConfig({ signal: abort.signal });
      if (
        abort.signal.aborted ||
        myGen !== settingsGen ||
        myKey !== lastSessionKey
      )
        return;
      aiConfigDetail = detail;
      aiMeta = {
        enabled: detail.enabled,
        available: detail.available,
        configured: detail.masked.configured,
        verified: detail.masked.verified,
      };
      renderSettingsDialog();
    } catch (error) {
      if (
        abort.signal.aborted ||
        myGen !== settingsGen ||
        myKey !== lastSessionKey
      )
        return;
      renderSettingsDialog(error.message || "无法读取个人 AI 设置。");
    }
    if (myGen === settingsGen && myKey === lastSessionKey) {
      settingsDialog.showModal?.();
    }
  }

  for (const tab of viewSwitch.querySelectorAll("[data-ai-view]")) {
    tab.addEventListener("click", () => {
      const next = tab.dataset.aiView;
      if (!aiMeta.enabled || next === activeMode) return;
      activeMode = next;
      updateViewTabs();
      syncActiveFormBinding();
      if (activeMode === "ai") renderAiWorkspace();
      else if (drawerOpen) renderDrawer();
    });
  }

  drawerToggle.addEventListener("click", () => {
    if (!aiMeta.enabled) return;
    if (activeMode === "ai") {
      activeMode = "human";
      updateViewTabs();
      syncActiveFormBinding();
    }
    drawerOpen = !drawerOpen;
    updateViewTabs();
    if (drawerOpen) renderDrawer();
  });

  drawerClose?.addEventListener("click", () => {
    drawerOpen = false;
    updateViewTabs();
  });

  settingsBtn.addEventListener("click", () => {
    byId("account-dialog")?.close?.();
    void openSettings();
  });
  byId("ai-settings-close")?.addEventListener("click", () =>
    settingsDialog.close?.(),
  );

  return {
    syncIdentity(identity) {
      aiMeta = identity?.ai ?? {
        enabled: false,
        available: false,
        configured: false,
        verified: false,
      };
      // P1-10：区分主体变更（账号/实例/职责/开关）与同账号会话轮换（仅 csrfToken 变更）：
      // 两者均取消在途设置与 Copilot 请求；同账号换会话后保留仍打开的正式表单并重新绑定到新会话。
      const nextPrincipalKey = identity
        ? `${identity.instanceId ?? ""}\0${identity.account ?? ""}\0${session.role?.id ?? ""}\0${Boolean(aiMeta.enabled)}`
        : "";
      const nextSessionKey = identity
        ? `${nextPrincipalKey}\0${identity.csrfToken ?? ""}`
        : "";
      const principalChanged = nextPrincipalKey !== lastPrincipalKey;
      const sessionChanged = nextSessionKey !== lastSessionKey;
      if (principalChanged || sessionChanged) {
        lastPrincipalKey = nextPrincipalKey;
        lastSessionKey = nextSessionKey;
        settingsGen += 1;
        settingsAbort?.abort();
        settingsAbort = null;
        aiConfigDetail = null;
        pendingOpenProposal = null;
        if (principalChanged) {
          pageFormBridge = null;
          overlayFormBridge = null;
          activeMode = "human";
          aiWorkspaceContainer.replaceChildren();
        }
        controller.resetSession();
        if (settingsDialog.open) settingsDialog.close?.();
        if (!principalChanged && aiMeta.enabled) {
          syncActiveFormBinding();
        }
      }
      if (!aiMeta.enabled) {
        activeMode = "human";
        drawerOpen = false;
      }
      viewSwitch.hidden = !aiMeta.enabled;
      drawerToggle.hidden = !aiMeta.enabled;
      settingsBtn.hidden = !aiMeta.enabled;
      updateViewTabs();
      if (aiMeta.enabled && drawerOpen) renderDrawer();
    },
    bindForm(bridge, { inModal = false } = {}) {
      if (inModal) overlayFormBridge = bridge ?? null;
      else pageFormBridge = bridge ?? null;
      if (activeMode !== "ai") {
        controller.bindForm(activeHumanBridge());
      }
      if (!inModal && pendingOpenProposal && bridge) {
        const { proposal, summary } = pendingOpenProposal;
        const snap = bridge.getDraftSnapshot();
        if (snap && snap.tool === proposal.tool) {
          pendingOpenProposal = null;
          controller.applyExternalProposal(
            proposal,
            summary ||
              "已按自然语言为您打开正式表单并预填草稿，请核对后预览提交。",
          );
          drawerOpen = true;
          updateViewTabs();
          renderDrawer();
        }
      }
    },
    unbindOverlayForm() {
      if (!overlayFormBridge) return;
      overlayFormBridge = null;
      syncActiveFormBinding();
    },
    clearForm() {
      pageFormBridge = null;
      overlayFormBridge = null;
      controller.clearContext();
    },
    openSettings,
    isAiWorkspaceActive: () => aiMeta.enabled && activeMode === "ai",
  };
}
