import { icon } from "./meridian-icons.js";
import { roleGuide } from "./review-content.js";
import { beginSkeleton } from "./skeleton.js";
import { commandSkeleton } from "./portal-skeleton.js";

const modes = [
  ["zentao", "表格台账"],
  ["hybrid", "混合视图"],
  ["meridian", "卡片概览"],
];
const navIcons = {
  workbench: "LayoutDashboard",
  intake: "CirclePlus",
  stories: "GitPullRequestDraft",
  schedule: "CalendarClock",
  "release-risks": "ShieldAlert",
  "review-board": "SquareCheckBig",
};

function el(tag, cls, text) {
  const element = document.createElement(tag);
  if (cls) element.className = cls;
  if (text != null) element.textContent = text;
  return element;
}
function btn(cls, label, click) {
  const b = el("button", cls, label);
  b.type = "button";
  b.addEventListener("click", click);
  return b;
}
function getPreference(key) {
  try {
    return localStorage.getItem(key);
  } catch {
    return null;
  }
}
function setPreference(key, value) {
  try {
    localStorage.setItem(key, value);
  } catch {
    /* Storage may be disabled in private browsing. */
  }
}

export function createMeridianShell({
  byId,
  session,
  sectionsFor,
  openSection,
  openStory,
  openTool,
  getCurrent,
  showAccount,
  selectRole,
  toolsFor,
  contextFor,
}) {
  const sidebar = byId("sidebar"),
    tabs = byId("role-tabs"),
    nav = byId("role-nav");
  const sideModes = byId("side-modes");
  const modeKey = () =>
    session.identity?.instanceId
      ? "bzt.portal.mode/" +
        encodeURIComponent(session.identity.instanceId) +
        "/" +
        encodeURIComponent(session.identity.account ?? "") +
        "/" +
        session.role?.id
      : "bzt.portal.mode/" +
        encodeURIComponent(session.identity?.account ?? "") +
        "/" +
        session.role?.id;
  let activePopup,
    collapsed = false;
  function mode() {
    const v = getPreference(modeKey());
    return modes.some(([id]) => id === v) ? v : "meridian";
  }
  function setMode(value) {
    if (!session.role || !modes.some(([id]) => id === value)) return;
    setPreference(modeKey(), value);
    drawModes();
    if (getCurrent() === "workbench") openSection("workbench");
  }
  let toastTimer;
  function toast(message, tone = "info") {
    const host = byId("portal-shell");
    if (!host || !message) return;
    let stack = host.querySelector(":scope > .toast-stack");
    if (!stack) {
      stack = el("div", "toast-stack");
      stack.setAttribute("role", "status");
      stack.setAttribute("aria-live", "polite");
      host.append(stack);
    }
    stack.replaceChildren();
    const item = el(
      "div",
      "toast-item" + (tone !== "info" ? " tone-" + tone : ""),
    );
    const sym = el("span", "toast-icon");
    sym.append(
      icon(
        tone === "success"
          ? "CircleCheck"
          : tone === "warning"
            ? "TriangleAlert"
            : "Info",
        15,
      ),
    );
    item.append(sym, el("span", "toast-message", message));
    stack.append(item);
    clearTimeout(toastTimer);
    toastTimer = setTimeout(() => stack.replaceChildren(), 3200);
  }
  function drawModes() {
    if (!sideModes) return;
    sideModes.replaceChildren();
    for (const [id, label] of modes) {
      const active = id === mode();
      const control = btn(
        "sidebar-mode-btn is-" + id + (active ? " is-active" : ""),
        label,
        () => setMode(id),
      );
      control.setAttribute("aria-pressed", String(active));
      sideModes.append(control);
    }
  }
  let closeRoleMenu;
  function drawRoles(identity, role) {
    closeRoleMenu?.();
    closeRoleMenu = undefined;
    tabs.replaceChildren();
    if ((identity.roles?.length ?? 0) === 1 && role) {
      tabs.classList.remove("is-compact");
      const badge = el("span", "role-pill is-active", role.label);
      badge.dataset.role = role.id;
      badge.title =
        role.label + " · " + (identity.displayName || identity.account);
      tabs.append(badge);
      return;
    }
    const compact = (identity.roles?.length ?? 0) > 3;
    tabs.classList.toggle("is-compact", compact);
    if (!compact) {
      for (const entry of identity.roles ?? []) {
        const active = entry.id === role?.id;
        const control = btn(
          "role-pill" + (active ? " is-active" : ""),
          entry.label,
          () => {
            if (!active) selectRole(entry.id);
          },
        );
        control.dataset.role = entry.id;
        control.setAttribute("aria-pressed", String(active));
        control.title =
          entry.label + " · " + (identity.displayName || identity.account);
        tabs.append(control);
      }
      return;
    }
    const trigger = btn("role-dropdown-trigger", null, (e) => {
      e.stopPropagation();
      const next = menu.hidden;
      menu.hidden = !next;
      trigger.setAttribute("aria-expanded", String(next));
    });
    trigger.setAttribute("aria-haspopup", "true");
    trigger.setAttribute("aria-expanded", "false");
    trigger.title = "切换已授权职责 (Alt+1–8)";
    trigger.append(
      el("span", null, role?.label || "选择职责"),
      icon("ChevronDown", 14),
    );
    const menu = el("div", "role-dropdown-menu");
    menu.hidden = true;
    const list = el("div", "role-dropdown-items");
    for (const entry of identity.roles ?? []) {
      const active = entry.id === role?.id;
      const control = btn(
        "role-pill" + (active ? " is-active" : ""),
        entry.label,
        () => {
          menu.hidden = true;
          trigger.setAttribute("aria-expanded", "false");
          if (!active) selectRole(entry.id);
        },
      );
      control.dataset.role = entry.id;
      control.setAttribute("aria-pressed", String(active));
      list.append(control);
    }
    menu.append(list);
    const onOutside = (e) => {
      if (!menu.hidden && !tabs.contains(e.target)) {
        menu.hidden = true;
        trigger.setAttribute("aria-expanded", "false");
      }
    };
    const onEsc = (e) => {
      if (e.key === "Escape" && !menu.hidden) {
        menu.hidden = true;
        trigger.setAttribute("aria-expanded", "false");
        trigger.focus();
      }
    };
    document.addEventListener("click", onOutside);
    document.addEventListener("keydown", onEsc);
    closeRoleMenu = () => {
      document.removeEventListener("click", onOutside);
      document.removeEventListener("keydown", onEsc);
    };
    tabs.append(trigger, menu);
  }
  function drawSidebar(identity, role) {
    nav.replaceChildren();
    byId("nav-heading").textContent =
      role.id === "FB" ? "业务反馈入口" : "工作导航";
    byId("fb-perm-note").hidden = role.id !== "FB";
    const displayName = identity.displayName || identity.account || "";
    const avatarEl = byId("account-avatar");
    if (avatarEl)
      avatarEl.textContent =
        displayName.trim().slice(0, 1).toUpperCase() || "U";
    const triggerName = byId("account-trigger-name");
    if (triggerName) triggerName.textContent = displayName;
    const roleMeta = byId("account-role-meta");
    if (roleMeta) {
      const modeLabel = identity.instanceId
        ? identity.readOnly
          ? "集中工作台（只读）"
          : "集中工作台"
        : "本机工作台";
      roleMeta.textContent = `${role.label} · ${modeLabel}`;
    }
    const focusText = roleGuide[role.id]?.focus || "";
    const focusEl = byId("role-focus");
    if (focusEl) {
      focusEl.textContent = focusText;
      focusEl.title = focusText;
    }
    const asOfEl = byId("as-of");
    if (asOfEl) asOfEl.textContent = "";
    drawModes();
    for (const [i, section] of sectionsFor(role).entries()) {
      if (section.id === "review-board") nav.append(el("div", "nav-divider"));
      const control = btn(
        "bzt-nav-item" + (section.recommended ? " is-recommended" : ""),
        null,
        () => openSection(section.id),
      );
      control.dataset.view = section.id;
      control.disabled = !section.enabled;
      control.title =
        section.label +
        " · 快捷键 " +
        (i + 1) +
        (section.readOnly ? " · 只读查看" : "");
      control.setAttribute("aria-label", section.label);
      const ico = el("span", "nav-item-icon");
      ico.append(icon(navIcons[section.id], 15));
      control.append(ico, el("span", "nav-item-label truncate", section.label));
      if (section.recommended) control.append(el("span", "rec-dot"));
      if (section.readOnly && role.id !== "FB")
        control.append(el("span", "nav-ro-tag", "只读"));
      nav.append(control);
    }
  }
  function date(asOf) {
    if (/^\d{4}-\d\d-\d\d/.test(asOf ?? "")) {
      byId("as-of").textContent = "基准 " + asOf.slice(5, 10);
      const modeLabel = session.identity?.instanceId
        ? session.identity.readOnly
          ? "集中工作台（只读）"
          : "集中工作台"
        : "本机工作台";
      const sub = document.querySelector(".bzt-topbar .bzt-brand-sub");
      if (sub) sub.textContent = modeLabel;
    }
  }
  function setTheme(theme) {
    document.documentElement.dataset.theme = theme;
    byId("theme-button").replaceChildren(
      icon(theme === "dark" ? "Sun" : "Moon", 15),
    );
  }
  function toggleTheme() {
    const t =
      document.documentElement.dataset.theme === "dark" ? "light" : "dark";
    setTheme(t);
    setPreference("bzt.portal.theme", t);
    toast(t === "dark" ? "已切换为深色主题" : "已切换为浅色主题");
  }
  function collapse(value) {
    collapsed = value;
    sidebar.classList.toggle("is-collapsed", collapsed);
    const b = byId("collapse-button");
    b.replaceChildren(icon(collapsed ? "PanelLeftOpen" : "PanelLeftClose", 15));
    b.setAttribute("aria-label", collapsed ? "展开导航栏" : "收起导航栏");
    b.title = b.getAttribute("aria-label");
    b.setAttribute("aria-expanded", String(!collapsed));
  }
  function popup(cls, label) {
    activePopup?.close();
    const dialog = el("dialog", cls + " portal-popup");
    dialog.setAttribute("aria-label", label);
    byId("portal-shell").append(dialog);
    activePopup = dialog;
    dialog.addEventListener("close", () => {
      dialog.remove();
      if (activePopup === dialog) activePopup = undefined;
    });
    dialog.addEventListener("click", (e) => {
      if (e.target !== dialog) return;
      const r = dialog.getBoundingClientRect();
      if (
        e.clientX < r.left ||
        e.clientX > r.right ||
        e.clientY < r.top ||
        e.clientY > r.bottom
      )
        dialog.close();
    });
    return dialog;
  }
  function commands() {
    if (!session.role) return;
    const dialog = popup("cmd-palette", "快速检索 / 命令"),
      bar = el("div", "cmd-search-bar"),
      input = el("input", "cmd-input");
    input.placeholder = "搜索页面、操作或需求…";
    input.setAttribute("aria-label", "搜索命令或需求");
    bar.append(icon("Search", 18), input, el("kbd", null, "Esc"));
    const list = el("div", "cmd-list");
    dialog.append(bar, list);
    const controller = new AbortController(),
      ctx = contextFor(controller.signal);
    let timer,
      finishSearch,
      revision = 0,
      focus = 0;
    dialog.addEventListener(
      "close",
      () => {
        clearTimeout(timer);
        controller.abort();
      },
      { once: true },
    );
    const collected = [
      ...sectionsFor(session.role)
        .filter((s) => s.enabled)
        .map((s) => ({
          name: s.label,
          group: "页面",
          sym: navIcons[s.id],
          run: () => openSection(s.id),
        })),
      ...toolsFor(session.role)
        .filter((t) => t.tool !== "create_story")
        .map((t) => ({
          name: t.label,
          group: "操作",
          sym: "ArrowRight",
          run: () => openTool(t.tool),
        })),
      ...(session.identity?.roles ?? [])
        .filter((r) => r.id !== session.role?.id)
        .map((r) => ({
          name: "切换角色：" + r.label,
          group: "视角与偏好",
          sym: "Users",
          run: () => selectRole(r.id),
        })),
      ...modes
        .filter(([id]) => id !== mode())
        .map(([id, label]) => ({
          name: "工作台模式：" + label,
          group: "视角与偏好",
          sym: "LayoutDashboard",
          run: () => {
            setMode(id);
            if (getCurrent() !== "workbench") openSection("workbench");
          },
        })),
      {
        name: "切换深浅主题",
        group: "视角与偏好",
        sym: "Sun",
        run: toggleTheme,
      },
      { name: "账号与职责", group: "账号", sym: "Users", run: showAccount },
    ];
    function paint(target, rows, { showEmpty, notice, offset = 0 } = {}) {
      target.replaceChildren();
      let lastGroup;
      for (const [i, item] of rows.entries()) {
        if (lastGroup !== item.group) {
          target.append(el("div", "cmd-group-label", item.group));
          lastGroup = item.group;
        }
        const b = btn(
          "cmd-item" + (i + offset === focus ? " is-active" : ""),
          null,
          (event) => {
            event.stopPropagation();
            dialog.close();
            item.run();
          },
        );
        const left = el("span", "cmd-item-left"),
          sym = el("span", "cmd-item-icon");
        sym.append(icon(item.sym, 15));
        left.append(sym, el("span", "cmd-item-label", item.name));
        b.append(left);
        target.append(b);
      }
      if (notice || (!rows.length && showEmpty))
        target.append(el("div", "cmd-empty", notice || "没有匹配结果"));
    }
    function update() {
      clearTimeout(timer);
      finishSearch?.();
      const request = ++revision;
      focus = 0;
      const q = input.value.trim(),
        rows = collected.filter((i) => i.name.includes(q));
      if (!q || !session.role.actions.includes("query_stories")) {
        paint(list, rows, { showEmpty: Boolean(q) });
        return;
      }
      const id = /^#?(\d+)$/.exec(q);
      if (id && Number.isSafeInteger(Number(id[1])) && Number(id[1]) > 0) {
        rows.push({
          name: "查看需求 #" + id[1],
          group: "需求",
          sym: "Layers",
          run: () => openStory(Number(id[1])),
        });
        paint(list, rows);
        return;
      }
      paint(list, rows);
      const remote = el("div");
      list.append(remote);
      const finish = beginSkeleton(remote, commandSkeleton, {
        signal: controller.signal,
      });
      finishSearch = finish;
      timer = setTimeout(async () => {
        try {
          const report = await ctx.call("query_stories", {
            keyword: q,
            limit: 8,
          });
          if (request !== revision || controller.signal.aborted) return;
          const hits = (report.data?.items ?? []).map((story) => ({
            name: "#" + story.id + " " + story.title,
            group: "需求",
            sym: "Layers",
            run: () => openStory(story.id),
          }));
          paint(remote, hits, {
            offset: rows.length,
            showEmpty: rows.length === 0,
            notice: report.completeness === "partial" ? "部分需求未能读取" : "",
          });
        } catch {
          if (request === revision && !controller.signal.aborted)
            paint(remote, [], { notice: "需求检索暂不可用" });
        } finally {
          finish();
        }
      }, 260);
    }
    input.addEventListener("input", update);
    input.addEventListener("keydown", (e) => {
      const buttons = [...list.querySelectorAll("button")];
      if (!buttons.length) return;
      if (e.key === "Enter") {
        e.preventDefault();
        buttons[focus]?.click();
        return;
      }
      if (e.key === "ArrowDown" || e.key === "ArrowUp") {
        e.preventDefault();
        focus =
          (focus + (e.key === "ArrowDown" ? 1 : -1) + buttons.length) %
          buttons.length;
        buttons.forEach((b, i) => b.classList.toggle("is-active", i === focus));
        buttons[focus].scrollIntoView({ block: "nearest" });
      }
    });
    update();
    dialog.showModal();
    input.focus();
  }
  function keys() {
    const dialog = popup("shortcuts-modal", "键盘快捷键"),
      head = el("div", "modal-head"),
      close = btn("icon-btn-subtle", null, () => dialog.close());
    close.append(icon("X", 16));
    close.setAttribute("aria-label", "关闭");
    head.append(el("strong", null, "键盘快捷键"), close);
    const body = el("div", "shortcuts-body");
    for (const [key, title] of [
      ["⌘ / Ctrl + K", "快速检索 / 命令"],
      ["1 – 6", "进入当前职责的导航页"],
      ["Alt + 1 – 8", "切换已分配的职责"],
      ["T", "切换深浅主题"],
      ["?", "打开快捷键指南"],
      ["Esc", "关闭弹窗"],
    ]) {
      const row = el("div", "shortcut-row");
      row.append(el("span", null, title), el("kbd", null, key));
      body.append(row);
    }
    dialog.append(head, body);
    dialog.showModal();
  }
  for (const [id, symbol, size] of [
    ["command-button", "Search", 13],
    ["reset-view", "RotateCcw", 14],
    ["key-guide", "Keyboard", 15],
    ["about-close", "X", 16],
  ])
    byId(id)?.prepend(icon(symbol, size));
  byId("key-guide").onclick = keys;
  byId("command-button").onclick = commands;
  byId("theme-button").onclick = toggleTheme;
  byId("collapse-button").onclick = () => {
    collapse(!collapsed);
    setPreference("bzt.portal.collapsed", collapsed ? "yes" : "no");
  };
  byId("reset-view").onclick = () => {
    collapse(false);
    setPreference("bzt.portal.collapsed", "no");
    setTheme("light");
    setPreference("bzt.portal.theme", "light");
    if (session.role) {
      setPreference(modeKey(), "meridian");
      drawModes();
      openSection("workbench");
    }
    toast("已恢复默认界面偏好", "success");
  };
  collapse(getPreference("bzt.portal.collapsed") === "yes");
  setTheme(getPreference("bzt.portal.theme") === "dark" ? "dark" : "light");
  window.addEventListener("keydown", (e) => {
    if (
      !session.role ||
      sidebar.hidden ||
      document.querySelector("dialog[open]") ||
      e.isComposing
    )
      return;
    if ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === "k") {
      e.preventDefault();
      commands();
      return;
    }
    if (
      e.target?.closest?.("input,textarea,select,[contenteditable=true]") ||
      e.ctrlKey ||
      e.metaKey
    )
      return;
    const digit = Number(e.key);
    if (digit >= 1 && digit <= 8) {
      const target = e.altKey
        ? tabs.querySelectorAll("button[data-role]")[digit - 1]
        : nav.querySelectorAll("button")[digit - 1];
      if (target && !target.disabled) {
        e.preventDefault();
        target.click();
      }
    } else if (!e.altKey && e.key.toLowerCase() === "t") {
      e.preventDefault();
      toggleTheme();
    } else if (e.key === "?") {
      e.preventDefault();
      keys();
    }
  });
  return {
    drawRoles,
    drawSidebar,
    date,
    mode,
    setMode,
    toast,
    clear: () => {
      closeRoleMenu?.();
      activePopup?.close();
    },
  };
}
