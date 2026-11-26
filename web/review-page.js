import { assistantReply } from "./management-skeleton.js";
import { icon } from "./meridian-icons.js";
import {
  decisions,
  norms,
  parameters,
  roleGuide,
  steps,
  walkthrough,
} from "./review-content.js";
import { beginSkeleton } from "./skeleton.js";

const sections = [
  ["workbench", "工作台"],
  ["intake", "提需求"],
  ["stories", "需求流转", ["DM", "DS"]],
  ["schedule", "拆解与排期", ["RM"]],
  ["release-risks", "发布与风险", ["PM", "PJ"]],
  ["review-board", "评审拍板", ["DM", "RM", "PM", "PJ"]],
];
const voters = sections.find(([id]) => id === "review-board")[2];
const voteOptions = [
  ["通过", "✓ 通过", "pass", "success"],
  ["需调整", "✎ 需调整", "adjust", "warn"],
  ["暂不采纳", "✕ 暂不采纳", "reject", "danger"],
];

export function sectionsFor(role) {
  const external = role.id === "FB";
  return (external ? sections.slice(0, 2) : sections).map(
    ([id, label, editors]) => {
      const readOnly = editors
        ? !editors.includes(role.id)
        : id === "intake" && !role.actions.includes("create_story");
      return {
        id,
        label: external && id === "intake" ? "极简提诉求" : label,
        enabled: true,
        readOnly,
        access: readOnly ? "readonly" : "edit",
        recommended: roleGuide[role.id]?.recommendedViews.includes(id),
      };
    },
  );
}

function add(parent, tag, content, className) {
  const node = parent.ownerDocument.createElement(tag);
  if (content !== undefined) node.textContent = String(content);
  if (className) node.className = className;
  parent.append(node);
  return node;
}

function button(parent, text, className, click, glyph, glyphAfter = false) {
  const node = add(parent, "button", undefined, className);
  node.type = "button";
  if (glyph && !glyphAfter) node.append(icon(glyph, 14, node.ownerDocument));
  if (text) add(node, "span", text);
  if (glyph && glyphAfter) node.append(icon(glyph, 12, node.ownerDocument));
  node.addEventListener("click", click);
  return node;
}

function badge(parent, label, tone = "") {
  return add(
    parent,
    "span",
    label,
    "bzt-badge" + (tone ? " tone-" + tone : ""),
  );
}

export function permissionBanner(parent, text, label = "只读查看") {
  const banner = add(parent, "div", undefined, "perm-mode-banner");
  const copy = add(banner, "div", undefined, "perm-mode-banner-left");
  copy.append(icon("ShieldCheck", 14, copy.ownerDocument));
  add(copy, "span", text);
  add(banner, "span", label, "perm-badge-ro");
  return banner;
}

function accordion(parent, label, draw) {
  const section = add(parent, "section", undefined, "accordion-card");
  const title = button(section, label, "accordion-head", () => {
    panel.hidden = !panel.hidden;
    title.setAttribute("aria-expanded", String(!panel.hidden));
    glyph.replaceChildren(
      icon(panel.hidden ? "ChevronDown" : "ChevronUp", 15, glyph.ownerDocument),
    );
  });
  const glyph = add(title, "span");
  glyph.append(icon("ChevronDown", 15, glyph.ownerDocument));
  title.setAttribute("aria-expanded", "false");
  const panel = add(section, "div", undefined, "accordion-body");
  panel.hidden = true;
  draw(panel);
}

function table(parent, labels) {
  const table = add(
    add(parent, "div", undefined, "table-wrap"),
    "table",
    undefined,
    "bzt-table",
  );
  const headings = add(add(table, "thead"), "tr");
  for (const label of labels)
    add(headings, "th", label).setAttribute("scope", "col");
  return add(table, "tbody");
}

function markdownCell(value) {
  return value
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll("|", "\\|")
    .replace(/\r?\n/g, "<br>");
}

export function meetingMarkdown(records) {
  return [
    "# better-zentao 协作规范评审决议",
    "",
    "| 编号 | 议题 | 结论 | 备注 |",
    "| --- | --- | --- | --- |",
    ...decisions.map(({ id, topic }) => {
      const record = records.get(id);
      return `| ${id} | ${markdownCell(topic)} | **${record?.status || "待讨论"}** | ${markdownCell(record?.note || "—")} |`;
    }),
  ].join("\n");
}

export function renderReview(container, ctx, records) {
  const canVote = voters.includes(ctx.role.id);
  const page = add(container, "div", undefined, "bzt-page management-review");
  const header = add(page, "header", undefined, "page-head");
  const heading = add(header, "div");
  const titleRow = add(heading, "div", undefined, "page-title-row");
  const title = add(titleRow, "h1", undefined, "page-title");
  add(
    titleRow,
    "span",
    canVote ? "可表决与记录结论" : "只读查看",
    canVote ? "perm-badge-edit" : "perm-badge-ro",
  );
  add(
    heading,
    "p",
    "这 5 项改变现有团队习惯最多，建议评审会优先逐条确认。其余 11 项常规约定、17 条协作规范与 15 项参数可在下方按需核对。",
    "page-sub",
  );
  const actions = add(header, "div", undefined, "page-head-actions");
  const toasts = add(page, "div", undefined, "toast-stack");
  toasts.setAttribute("role", "status");
  let dismissFeedback;
  const publish = (text, status) => {
    markdown.textContent = text;
    preview.hidden = false;
    toasts.replaceChildren();
    add(toasts, "div", status, "toast-item");
    clearTimeout(dismissFeedback);
    dismissFeedback = setTimeout(() => toasts.replaceChildren(), 3200);
  };
  button(
    actions,
    "导出 .md",
    "btn-secondary btn-sm",
    () => {
      const text = meetingMarkdown(records);
      const url = URL.createObjectURL(
        new Blob([text], { type: "text/markdown;charset=utf-8" }),
      );
      const download = page.ownerDocument.createElement("a");
      download.href = url;
      download.download = "better-zentao-review-decisions.md";
      download.click();
      setTimeout(() => URL.revokeObjectURL(url), 0);
      publish(text, "已导出会议决议");
    },
    "Download",
  );
  button(
    actions,
    "复制会议决议",
    "btn-primary btn-sm",
    async () => {
      const text = meetingMarkdown(records);
      try {
        await navigator.clipboard.writeText(text);
        if (ctx.current()) publish(text, "已复制会议决议");
      } catch {
        if (!ctx.current()) return;
        publish(text, "可从决议预览手动复制");
        preview.scrollIntoView({ block: "nearest" });
      }
    },
    "Copy",
  );
  if (!canVote)
    permissionBanner(
      page,
      "当前角色为只读查阅模式，可浏览规范与导出会议决议。现场表决与意见录入开放给设计主管、研发主管、产品管理与项目管理。",
    );
  const progress = add(page, "div", undefined, "vote-progress-strip");
  const totals = add(progress, "div", undefined, "vote-progress-left");
  const tally = add(totals, "strong", undefined, "tabular");
  const percent = add(totals, "span", undefined, "vote-pct-badge");
  const counts = add(totals, "div", undefined, "vote-counts");
  const track = add(progress, "div", undefined, "vote-bar-track");
  track.setAttribute("aria-hidden", "true");
  const voteIndicators = voteOptions.map(([status, , color, tone]) => ({
    status,
    count: badge(counts, "", tone),
    meter: add(track, "div", undefined, "vote-seg is-" + color),
  }));
  function updateCount() {
    const remaining = decisions
      .slice(0, 5)
      .filter(({ id }) => !records.get(id)?.status).length;
    title.textContent = remaining
      ? `评审拍板：${remaining} 项核心分歧待定`
      : "评审拍板：核心分歧已记录";
    const votes = decisions
      .map(({ id }) => records.get(id)?.status)
      .filter(Boolean);
    tally.textContent = `现场表决进度：${votes.length} / ${decisions.length}`;
    percent.textContent = `${Math.round((votes.length / decisions.length) * 100)}%`;
    for (const { status, count, meter } of voteIndicators) {
      const total = votes.filter((vote) => vote === status).length;
      count.textContent = `${status} ${total}`;
      meter.style.width = `${(total / decisions.length) * 100}%`;
    }
    ctx.setBadge?.("review-board", decisions.length - votes.length);
  }
  function controls(pillContainer, noteContainer, id, compact = false) {
    const options = add(pillContainer, "div", undefined, "vote-pills");
    const buttons = [];
    const refresh = () => {
      for (const [node, status, color] of buttons) {
        const active = records.get(id)?.status === status;
        node.className = `vote-pill${compact ? " is-sm" : ""}${active ? " is-active tone-" + color : ""}`;
        node.setAttribute("aria-pressed", String(active));
      }
    };
    for (const [status, label, color] of voteOptions) {
      const entry = button(
        options,
        compact ? status : label,
        "vote-pill",
        () => {
          if (!canVote || !ctx.current()) return;
          records.set(id, { ...records.get(id), status });
          refresh();
          updateCount();
          preview.hidden = true;
        },
      );
      entry.disabled = !canVote;
      buttons.push([entry, status, color]);
    }
    refresh();
    const note = add(
      noteContainer,
      "input",
      undefined,
      compact ? "bzt-input" : "bzt-input decision-note-input",
    );
    note.placeholder = !canVote
      ? "只读查看"
      : compact
        ? "备注…"
        : "记录会议调整意见或前提…";
    note.setAttribute("aria-label", `${id} 会议意见`);
    note.disabled = !canVote;
    note.value = records.get(id)?.note ?? "";
    note.addEventListener("input", () => {
      if (!canVote || !ctx.current()) return;
      records.set(id, { ...records.get(id), note: note.value });
      preview.hidden = true;
    });
  }
  const body = add(page, "div", undefined, "review-body-scroll");
  const grid = add(body, "div", undefined, "decisions-grid-2");
  for (const { id, topic, decider, diff, newWay, cost } of decisions.slice(
    0,
    5,
  )) {
    const card = add(grid, "article", undefined, "decision-card");
    const head = add(card, "div", undefined, "decision-card-head");
    const topicRow = add(head, "div", undefined, "decision-card-title");
    add(topicRow, "span", id, "mono req-id");
    add(topicRow, "h3", topic);
    badge(head, `决策人：${decider}`, "primary");
    const compare = add(card, "div", undefined, "decision-compare-grid");
    for (const [tone, label, text] of [
      ["old", "现在各自的做法", diff],
      ["new", "建议统一的新做法", newWay],
    ]) {
      const box = add(compare, "div", undefined, "compare-box is-" + tone);
      add(box, "div", label, "compare-box-label");
      add(box, "p", text);
    }
    const costRow = add(card, "div", undefined, "decision-cost");
    add(costRow, "strong", "如果不统一会怎样：");
    add(costRow, "span", cost);
    const foot = add(card, "div", undefined, "decision-foot");
    controls(foot, foot, id);
  }
  accordion(
    body,
    "展开其余 11 项常规约定（D-06 ~ D-16）与 17 条规范总表",
    (panel) => {
      const rows = table(panel, ["约定事项", "决策人", "会议结论", "备注"]);
      for (const { id, topic, decider, newWay } of decisions.slice(5)) {
        const row = add(rows, "tr");
        const cell = add(row, "td");
        add(cell, "span", id, "mono req-id");
        add(cell, "strong", " " + topic);
        add(cell, "div", newWay, "ledger-sub");
        add(row, "td", decider);
        controls(add(row, "td"), add(row, "td"), id, true);
      }
      const section = add(panel, "section", undefined, "norms-mini-section");
      add(section, "h4", "17 条协作规范速查（N01 ~ N17）");
      const grid = add(section, "div", undefined, "norms-chip-grid");
      for (const [id, name, summary] of norms) {
        const card = add(grid, "div", undefined, "norm-card");
        const head = add(card, "div", undefined, "norm-card-head");
        add(head, "span", id, "mono req-id");
        add(head, "strong", name);
        add(card, "p", summary);
      }
    },
  );
  accordion(
    body,
    "展开 9 步标准流转图与 15 项待确认参数（P-01 ~ P-15）",
    (panel) => {
      const track = add(panel, "div", undefined, "flow-grid is-compact");
      const banner = add(panel, "div", undefined, "flow-detail-banner");
      function select(index) {
        const step = steps[index];
        Array.from(track.children).forEach((node, item) => {
          node.className =
            "flow-node-card" + (item === index ? " is-active" : "");
          node.setAttribute("aria-pressed", String(item === index));
        });
        banner.replaceChildren();
        const detail = add(banner, "div");
        add(detail, "div", `${step.title}：${step.desc}`, "flow-detail-title");
        add(
          detail,
          "p",
          `禅道指派规则：${step.assignedTo}`,
          "flow-detail-desc",
        );
        if (sectionsFor(ctx.role).some(({ id }) => id === step.targetView))
          button(
            banner,
            "前往体验",
            "btn-primary btn-xs",
            () => ctx.navigate(step.targetView),
            "ArrowRight",
            true,
          );
      }
      steps.forEach((step, index) => {
        const node = button(track, "", "flow-node-card", () => select(index));
        add(node, "div", step.title, "flow-node-title");
        add(node, "div", step.actor, "flow-node-actor");
      });
      select(0);
      const rows = table(panel, ["参数", "当前默认值", "用途", "确认角色"]);
      for (const [id, name, value, usage, owner] of parameters) {
        const row = add(rows, "tr");
        const cell = add(row, "td");
        add(cell, "span", id, "mono req-id");
        add(cell, "strong", " " + name);
        badge(add(row, "td"), value);
        add(row, "td", usage);
        add(row, "td", owner);
      }
    },
  );
  const preview = add(body, "section", undefined, "panel-card");
  preview.hidden = true;
  add(
    add(preview, "div", undefined, "panel-head"),
    "h2",
    "已生成的会议决议（Markdown 预览）",
    "panel-title",
  );
  const markdown = add(preview, "pre", undefined, "markdown-preview mono");
  updateCount();
}

export function renderGuide(container, ctx) {
  const guide = roleGuide[ctx.role.id];
  const scroll = add(container, "div", undefined, "drawer-scroll");
  const card = add(scroll, "section", undefined, "scope-card");
  const name = ctx.displayName
    ? `${ctx.displayName}（${ctx.role.label}）`
    : ctx.role.label;
  add(card, "h2", "当前视角：" + name, "scope-card-head");
  for (const [label, value] of [
    ["核心关注", guide.focus],
    ["解决痛点", guide.painPoints],
    ["对应故事", guide.stories.join("、")],
    ["相关规范", guide.norms.join("、")],
    ["本次待拍板", guide.decisions.join("、")],
  ]) {
    const line = add(card, "div", undefined, "help-kv");
    add(line, "strong", label + "：");
    add(line, "span", value);
  }
  const meeting = add(scroll, "section", undefined, "scope-card");
  add(meeting, "h2", "评审会 15 分钟走查路线（点击直达）", "scope-card-head");
  const list = add(meeting, "div", undefined, "walkthrough-list");
  walkthrough.forEach(([duration, title, role, view, summary], index) => {
    const switchable = role !== ctx.role.id && ctx.canSwitchRole?.(role);
    const visible = sectionsFor(ctx.role).some(({ id }) => id === view);
    const node = button(list, "", "walkthrough-item", () => {
      if (switchable) ctx.switchRole(role, view);
      else if (visible) ctx.navigate(view);
    });
    node.disabled = !switchable && !visible;
    const top = add(node, "div", undefined, "walkthrough-top");
    add(top, "strong", `${index + 1}. ${title}`);
    badge(top, duration, "primary");
    add(node, "p", summary);
    const jump = add(
      node,
      "span",
      switchable
        ? "切换视角并跳转"
        : visible
          ? "以当前职责打开"
          : "当前职责无权查看",
      "walkthrough-go",
    );
    if (!node.disabled) jump.append(icon("ArrowRight", 12, jump.ownerDocument));
  });
  const basis = add(scroll, "section", undefined, "scope-card");
  add(basis, "h2", "数据与统计口径", "scope-card-head");
  const bullets = add(basis, "ul", undefined, "help-bullets");
  add(bullets, "li", "业务数据来自当前账号可以查询的禅道记录。");
  add(bullets, "li", "任务计数与负荷仅统计叶子任务，需求按编号去重。");
  add(bullets, "li", "今日到期任务单列，工作量统计用于排期参考。");
  const boundaries = add(scroll, "div", undefined, "bzt-alert tone-info");
  boundaries.append(icon("Info", 15, boundaries.ownerDocument));
  const summary = add(boundaries, "div");
  add(summary, "strong", "产品形态边界：");
  add(
    summary,
    "span",
    "方案梳理了 43 条用户故事（一期 20 / 二期 19 / 三期 4）。本地协作助手、CLI、企微每日摘要与 Web 门户共用禅道业务规则与写入预览。",
  );
}

const shortcuts = {
  FB: [
    [
      "get_my_work",
      "看我反馈的需求进度",
      "我提的需求到哪了？",
      "打开工作台可查看本人反馈的事项和当前跟进人。",
      "workbench",
    ],
    [
      "create_story",
      "一句话提诉求",
      "我要反馈一个新的诉求",
      "在提需表单记录诉求，提交前可核对预览。",
      "intake",
    ],
  ],
  DM: [
    [
      "create_story",
      "同时建设计态与运行态需求",
      "把设计态和运行态需求配对双建",
      "在配对提需表单填写两侧范围，提交前可核对预览。",
      "intake",
      { mode: "pair" },
    ],
    [
      "query_stories",
      "生成业务语言进度卡",
      "把需求进度做成一张业务进度卡",
      "打开需求台账后选择需求，即可查看和复制业务进度卡。",
      "stories",
      { tab: "all-stories" },
    ],
  ],
  DS: [
    [
      "handoff_story",
      "评审通过后移交研发",
      "这条设计需求已通过评审，准备移交研发",
      "在需求流转中选择已完成评审和传递的需求，核对移交预览。",
      "stories",
    ],
    [
      "create_story",
      "跨模块向后端提依赖需求",
      "我要向后端提一个跨模块的依赖",
      "在跨模块表单填写需要协调的范围和目标模块。",
      "intake",
      { mode: "crossModule" },
    ],
  ],
  RM: [
    [
      "get_monthly_dev_queue",
      "把待接收需求按标准拆任务",
      "按标准给本月待接收需求拆任务",
      "在本月队列勾选需求，配置负责人和计划日期后预览。",
      "schedule",
      { tab: "queue" },
    ],
    [
      "get_member_schedule",
      "临时任务给谁做最合适？",
      "看 4 周排期，试算临时任务安排给谁",
      "在 4 周排期中输入预估工时与日期试算人选。",
      "schedule",
      { tab: "matrix" },
    ],
  ],
  RD: [
    [
      "get_story_progress",
      "本次具体要做什么？",
      "查看研发范围与验收标准",
      "可以输入需求编号，或从需求流转台账选择需求查看研发范围。",
      "stories",
      { tab: "all-stories" },
    ],
    [
      "create_story",
      "急事已开工，补录草稿",
      "先做的急事需要补录草稿",
      "打开补录表单，填写实际开工日期和需要补全的工作。",
      "intake",
      { mode: "backfilled" },
    ],
  ],
  QA: [
    [
      "get_my_work",
      "有哪些可以开始测了？",
      "有哪些测试现在可以开始？",
      "从工作台查看可开测和即将转测的任务。",
      "workbench",
    ],
    [
      "get_plan_progress",
      "发布前测试和 Bug 怎样？",
      "看一下版本发布门禁和阻断的 Bug",
      "打开版本门禁查询所选版本的测试完成情况和阻断 Bug。",
      "release-risks",
      { tab: "release" },
    ],
  ],
  PM: [
    [
      "get_plan_progress",
      "L3 计划完成得怎样？",
      "查一下 L3 月度计划交付率",
      "打开 L3 计划与承诺，核对月度交付与承诺兑现情况。",
      "release-risks",
      { tab: "plans" },
    ],
    [
      "get_plan_progress",
      "这个版本能发吗？",
      "查一下这个版本的发布门禁",
      "在版本门禁中查询测试完成情况与 1–2 级未关闭 Bug。",
      "release-risks",
      { tab: "release" },
    ],
  ],
  PJ: [
    [
      "scan_workflow_risks",
      "扫一遍当前最关键的风险",
      "扫一下当前逾期、测试断档和未关联 Bug 等高危卡点",
      "打开风险巡检可逐项核对风险证据与处理建议。",
      "release-risks",
      { tab: "risks" },
    ],
    [
      "get_plan_progress",
      "看承诺兑现与挪月情况",
      "把月初承诺快照和当前状态对比，列出顺延原因",
      "在 L3 计划与承诺核对月初基线与已登记的挪月原因。",
      "release-risks",
      { tab: "plans" },
    ],
  ],
};

const may = (ctx, tool) => ctx.role.actions.includes(tool);
const incomplete = (result) =>
  result?.completeness === "partial" || result?.truncated;
const route = (reply, label, view, initial) => ({
  reply,
  label,
  view,
  initial,
});

async function respondTo(text, ctx, read) {
  const business = ctx.role.id === "FB";
  const storyId = Number(
    /(?:#|需求\s*)\s*(\d+)/u.exec(text)?.[1] ?? /^\d+$/u.exec(text)?.[0],
  );
  if (
    Number.isSafeInteger(storyId) &&
    storyId > 0 &&
    may(ctx, "get_story_progress")
  ) {
    const result = await read("get_story_progress", { storyId });
    const { story, progress, people } = result?.data ?? {};
    if (!result?.ok || !story || !progress)
      return { reply: "当前职责的读取范围内未找到这条需求。" };
    const tab =
      business || /转发|进度卡/u.test(text)
        ? "card"
        : text.includes("范围")
          ? "dev"
          : "full";
    return {
      reply: `#${story.id} ${story.title} · ${progress.value}${progress.level === "inferred" ? "（推测）" : ""}${people?.currentOwner ? " · 当前跟进人 " + people.currentOwner : ""}${incomplete(result) ? "。部分数据未读取。" : ""}`,
      label:
        tab === "card"
          ? "打开业务进度卡"
          : tab === "dev"
            ? "打开研发范围"
            : "查看需求详情",
      storyId: story.id,
      tab,
    };
  }
  if (business) {
    if (
      /提需|反馈|诉求|建议/u.test(text) &&
      !/进展|进度|到哪/u.test(text) &&
      may(ctx, "create_story")
    )
      return route(
        "已记录输入内容，可带入提需表单核对。",
        "前往极简提诉求",
        "intake",
        { title: text },
      );
    return route(
      "输入需求编号可查询进度，或在工作台查看本人反馈的事项。",
      "查看我的需求",
      "workbench",
    );
  }
  if (/风险|卡点|逾期/u.test(text) && may(ctx, "scan_workflow_risks")) {
    const mine = ["DM", "DS", "RD", "QA"].includes(ctx.role.id);
    const result = await read("scan_workflow_risks", {
      scope: mine ? { mine: true } : {},
    });
    const hits = result?.data?.hits?.filter(({ waived }) => !waived);
    const reply =
      result?.ok && hits
        ? `已读取 ${hits.length} 项卡点，其中高危 ${hits.filter(({ severity }) => severity === "high").length} 项。${incomplete(result) ? "部分数据未读取。" : ""}`
        : "尚未读取到可用的风险巡检结果。";
    return route(reply, "打开风险与卡点", "release-risks", { tab: "risks" });
  }
  const version = /\bV\d+(?:\.\d+)+\b/iu.exec(text)?.[0];
  if ((version || /发布|门禁/u.test(text)) && may(ctx, "get_plan_progress"))
    return route(
      "在版本发布门禁核对测试完成情况与阻断 Bug。",
      "查看版本发布门禁",
      "release-risks",
      { tab: "release", ...(version && { version }) },
    );
  if (
    /L3|月度|完成率|承诺|挪月/iu.test(text) &&
    ["PM", "PJ"].includes(ctx.role.id) &&
    may(ctx, "get_plan_progress")
  )
    return route(
      "在 L3 计划与承诺核对交付率与月初承诺。",
      "查看 L3 计划与承诺",
      "release-risks",
      { tab: "plans" },
    );
  if (may(ctx, "create_story")) {
    const mode =
      /双建|配对/u.test(text) && ["DM", "DS"].includes(ctx.role.id)
        ? "pair"
        : /补录|先做|急事/u.test(text)
          ? "backfilled"
          : /跨模块|依赖/u.test(text)
            ? "crossModule"
            : undefined;
    if (mode || /提需|提个需求|新需求/u.test(text))
      return route(
        "可将输入带入提需表单，补充信息后生成操作预览。",
        "打开提需表单",
        "intake",
        { mode, rawText: text },
      );
  }
  if (/排期|谁合适|负荷/u.test(text) && may(ctx, "get_member_schedule"))
    return route(
      "在排期页查看已知工时与未来 4 周负荷。",
      "打开 4 周排期",
      "schedule",
      { tab: "matrix" },
    );
  if (/拆解|任务队列/u.test(text) && may(ctx, "get_monthly_dev_queue"))
    return route(
      "在月度队列查看待接收与在研需求。",
      "查看本月研发队列",
      "schedule",
      { tab: "queue" },
    );
  return {
    reply:
      "可点击上方角色例句，或输入需求编号。工作台按当前职责开放查询与操作。",
  };
}

export function renderShortcuts(container, ctx) {
  const scroll = add(container, "div", undefined, "drawer-scroll");
  add(
    scroll,
    "p",
    ctx.role.id === "FB"
      ? "点击下方角色例句，或输入需求编号，查看本人反馈的诉求。"
      : "点击下方角色例句，或输入需求编号、排期、风险、发布门禁等关键词前往办理。",
    "agent-intro",
  );
  const examples = add(scroll, "div", undefined, "agent-demos-list");
  const stream = add(scroll, "div", undefined, "agent-chat-stream");
  stream.setAttribute("aria-live", "polite");
  stream.hidden = true;
  const composer = add(container, "form", undefined, "agent-composer");
  const input = add(composer, "input", undefined, "bzt-input");
  input.type = "text";
  input.placeholder =
    ctx.role.id === "FB"
      ? "输入需求编号或反馈内容…"
      : "输入需求编号或一句话描述…";
  input.setAttribute("aria-label", "一句话操作内容");
  const send = add(composer, "button", undefined, "btn-primary btn-sm");
  send.append(icon("Send", 13, send.ownerDocument), "发送");
  send.disabled = true;
  send.type = "submit";
  input.addEventListener("input", () => {
    send.disabled = !input.value.trim();
  });
  composer.addEventListener("submit", (event) => {
    event.preventDefault();
    const text = input.value.trim();
    if (!text) return;
    input.value = "";
    send.disabled = true;
    void showReply(text);
  });

  function scrollToLatest() {
    scroll.scrollTop = scroll.scrollHeight;
  }
  async function showReply(text, example) {
    if (!ctx.current()) return;
    stream.hidden = false;
    const turn = add(stream, "div", undefined, "agent-turn");
    add(turn, "div", text, "chat-bubble is-user");
    const bot = add(turn, "div", undefined, "chat-bubble is-bot");
    const read = async (tool, args) => {
      const finish = beginSkeleton(bot, assistantReply, {
        signal: ctx.signal,
        current: ctx.current,
      });
      scrollToLatest();
      try {
        return await ctx.call(tool, args);
      } finally {
        finish();
      }
    };
    scrollToLatest();
    try {
      const reply = example ?? (await respondTo(text, ctx, read));
      if (!ctx.current()) return;
      add(bot, "p", reply.reply);
      if (reply.label)
        button(
          bot,
          reply.label,
          "btn-secondary btn-xs",
          () => {
            if (reply.storyId) ctx.openStory(reply.storyId, reply.tab);
            else ctx.navigate(reply.view, reply.initial);
          },
          "ArrowRight",
          true,
        );
      scrollToLatest();
    } catch (error) {
      if (!ctx.current()) return;
      add(bot, "p", error?.message || "禅道查询未成功，请重试。");
      scrollToLatest();
    }
  }

  for (const [tool, title, phrase, reply, view, initial] of shortcuts[
    ctx.role.id
  ] ?? []) {
    if (!may(ctx, tool)) continue;
    const card = add(examples, "div", undefined, "agent-demo-card");
    add(card, "div", title, "agent-demo-label");
    add(card, "p", `“${phrase}”`, "agent-demo-utt");
    button(
      card,
      "发送这句话",
      "btn-primary btn-xs",
      () => void showReply(phrase, route(reply, "前往办理", view, initial)),
      "ArrowRight",
      true,
    );
  }
}
