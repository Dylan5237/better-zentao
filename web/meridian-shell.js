import { icon } from "./meridian-icons.js";
import { roleGuide } from "./review-content.js";
import { beginSkeleton } from "./skeleton.js";
import { commandSkeleton } from "./portal-skeleton.js";

const groups = [
  ["biz", "业务", "业务侧", ["FB"]],
  ["design", "设计", "设计侧", ["DM", "DS"]],
  ["rd", "产研测", "产研测", ["RM", "RD", "QA"]],
  ["mgmt", "管理", "管理侧", ["PM", "PJ"]],
];
const modes = [
  ["zentao", "一·原生"],
  ["hybrid", "二·融合"],
  ["meridian", "三·封装"],
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
    "bzt.portal.mode/" +
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
  function drawModes() {
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
  function drawRoles(identity, role) {
    tabs.replaceChildren();
    for (const [key, label, , order] of groups) {
      const entries = order
        .map((id) => identity.roles.find((r) => r.id === id))
        .filter(Boolean);
      if (!entries.length) continue;
      const cluster = el("div", "role-group-cluster");
      if (tabs.childElementCount) cluster.append(el("span", "role-group-sep"));
      cluster.append(el("span", "role-group-tag grp-" + key, label));
      for (const entry of entries) {
        const active = entry.id === role?.id;
        const control = btn(
          "role-pill" + (active ? " is-active grp-" + key : ""),
          entry.label,
          () => {
            if (!active) selectRole(entry.id);
          },
        );
        control.dataset.role = entry.id;
        control.setAttribute("aria-pressed", String(active));
        control.title =
          entry.label + " · " + (identity.displayName || identity.account);
        cluster.append(control);
      }
      tabs.append(cluster);
    }
  }
  function drawSidebar(identity, role) {
    nav.replaceChildren();
    byId("nav-heading").textContent =
      role.id === "FB" ? "业务反馈入口" : "5 + 1 极简导航";
    byId("fb-perm-note").hidden = role.id !== "FB";
    const [key, , groupLabel] = groups.find((g) => g[3].includes(role.id));
    const chip = byId("role-group");
    chip.className = "role-chip grp-" + key;
    chip.textContent = groupLabel;
    byId("role-code").textContent = role.id;
    byId("account-menu").textContent =
      (identity.displayName || identity.account) + "（" + role.label + "）";
    byId("role-focus").textContent = roleGuide[role.id]?.focus || "";
    byId("as-of").textContent = "";
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
      document.querySelector(".bzt-topbar .bzt-brand-sub").textContent =
        "禅道 22.6 协作工作台 · " + asOf.slice(0, 7) + " 业务数据（本机门户）";
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
      ...toolsFor(session.role).map((t) => ({
        name: t.label,
        group: "操作",
        sym: "ArrowRight",
        run: () => openTool(t.tool),
      })),
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
          () => {
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
    ["guide-button", "BookOpen", 14],
    ["shortcuts-button", "Sparkles", 14],
    ["command-button", "Search", 13],
    ["reset-view", "RotateCcw", 14],
    ["key-guide", "Keyboard", 15],
    ["account-close", "X", 16],
  ])
    byId(id).prepend(icon(symbol, size));
  byId("account-menu").onclick = showAccount;
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
        ? tabs.querySelectorAll("button")[digit - 1]
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
    clear: () => activePopup?.close(),
  };
}
