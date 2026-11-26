import {
  add,
  addIcon,
  allowed,
  badge,
  button,
  choice,
  count,
  createFromRequirement,
  emptyText,
  externalLink,
  filterControls,
  go,
  limited,
  pendingBlock,
  person,
  progressTitle,
  storyAction,
  storyChoices,
  storySearch,
  taskSearch,
  toolAction,
  unique,
} from "./meridian-home-controls.js";
import { renderNativeWorkbench } from "./meridian-home-native.js";
import { beginSkeleton } from "./skeleton.js";
import {
  pendingDistribution,
  pendingFeedback,
  pendingItems,
  pendingPlanTiles,
} from "./workbench-skeleton.js";

const intake = (ctx, options) => () => ctx.navigate("intake", options);
const work = (...groups) => [
  "work",
  "我的工作",
  "get_my_work",
  { groups, markSeen: false },
];
const unlinked = [
  "unlinked",
  "待关联用户需求",
  "query_stories",
  { type: "requirement", unlinked: true, limit: 100 },
];
const profiles = {
  FB: {
    group: "biz",
    headline: "一句话提诉求，随时看处理进度",
    reads: [work("raised")],
    render: renderFeedback,
  },
  DM: {
    group: "design",
    headline: "接住所有诉求，把关设计与移交",
    reads: [unlinked, work("maintained", "action")],
    render: renderDesign,
  },
  DS: {
    group: "design",
    headline: "范围写清楚，移交验收不遗漏",
    reads: [unlinked, work("maintained")],
    render: renderDesign,
  },
  RM: {
    group: "rd",
    headline: "待办清爽不杂乱，一站拆任务看排期",
    reads: [
      work("action", "waiting_ready", "new"),
      ["team", "团队逾期任务", "get_team_work", { view: "overdue" }],
      ["queue", "本月研发队列", "get_monthly_dev_queue", {}],
    ],
    render: renderDevelopmentLead,
  },
  RD: {
    group: "rd",
    headline: "看清今日聚焦、实现范围与子任务",
    reads: [work("action", "new")],
    render: renderDeveloper,
  },
  QA: {
    group: "rd",
    headline: "提前排好测试档期，看清版本卡点",
    reads: [work("can_start")],
    render: renderTesting,
  },
  PM: {
    group: "mgmt",
    headline: "掌握 L3 月度完成率与发布门禁",
    reads: [
      [
        "plan",
        "L3 月度计划",
        "get_plan_progress",
        { view: "plan", month: "本月", groupBy: "module" },
      ],
    ],
    render: renderProduct,
  },
  PJ: {
    group: "mgmt",
    headline: "巡检关键风险，跟踪承诺与顺延",
    reads: [
      ["risks", "风险巡检", "scan_workflow_risks", { scope: {} }],
      [
        "commitment",
        "月度承诺",
        "get_plan_progress",
        { view: "commitment", month: "本月" },
      ],
    ],
    render: renderProject,
  },
};

const modes = [
  [
    "zentao",
    "一档·禅道原生",
    "一档 · 禅道原生风格",
    "高密度表格台账与多维条件检索",
  ],
  [
    "hybrid",
    "二档·融合增强",
    "二档 · 工作台+禅道融合",
    "工作台卡片、可视化进度与多维筛选",
  ],
  [
    "meridian",
    "三档·全封装",
    "三档 · 完全封装工作台",
    "业务分组与可视化进度卡片",
  ],
];

const percent = new Intl.NumberFormat("zh-CN", {
  style: "percent",
  maximumFractionDigits: 1,
});

function card(parent, title, { subtitle, grouped = false } = {}) {
  const panel = add(parent, "section", undefined, "panel-card vp-card");
  const header = add(panel, "div", undefined, "panel-head");
  const copy =
    grouped || subtitle
      ? add(header, "div", undefined, "workbench-panel-heading")
      : header;
  add(copy, "h2", title, "panel-title");
  if (subtitle) add(copy, "p", subtitle, "panel-sub");
  return { panel, header, copy };
}

function metric(
  parent,
  pending,
  label,
  value,
  hint,
  { click, tone, pendingHint = false } = {},
) {
  const node = add(
    parent,
    click ? "button" : "div",
    undefined,
    click ? "kpi-card is-clickable" : "kpi-card",
  );
  if (click) {
    node.type = "button";
    node.addEventListener("click", click);
  }
  add(node, "div", label, "kpi-label");
  const measure = add(
    node,
    "div",
    pending ? undefined : value,
    tone ? `kpi-num tabular workbench-${tone}` : "kpi-num tabular",
  );
  if (pending) pendingBlock(measure, "value");
  const foot = add(node, "div", undefined, "kpi-foot");
  if (pending && pendingHint) pendingBlock(foot, "text");
  else {
    add(foot, "span", hint);
    if (click) addIcon(foot, "ArrowRight", 13);
  }
}

function metricGrid(parent, columns, pending) {
  const grid = add(parent, "div", undefined, "kpi-grid-" + columns);
  return (label, value, hint, options) =>
    metric(grid, pending, label, value, hint, options);
}

function resultBadge(parent, ctx, tone) {
  const tally = badge(parent, "", tone);
  if (ctx.pending) pendingBlock(tally, "short");
  return tally;
}

function item(list, title, subtitle, { click, tag, tone } = {}) {
  const row = add(
    list,
    click ? "button" : "div",
    undefined,
    click ? "item-row is-clickable" : "item-row",
  );
  if (click) {
    row.type = "button";
    row.addEventListener("click", click);
  }
  const main = add(row, "span", undefined, "item-row-main");
  const name = add(main, "span", undefined, "item-row-title");
  if (tag) badge(name, tag, tone);
  add(name, "span", title);
  add(main, "span", subtitle, "item-row-sub");
  return row;
}

function filteredList(
  panel,
  ctx,
  {
    rows,
    source,
    fields = [],
    search,
    placeholder,
    empty,
    display,
    onCount,
    include = () => true,
    contentClass = "item-list vp-scroll",
    pendingRows = pendingItems,
  },
) {
  function refresh() {
    const visible = rows.filter(
      (row) => include(row) && (!controls || controls.matches(row)),
    );
    onCount?.(visible.length);
    controls?.tally(source, visible.length);
    content.replaceChildren();
    if (!visible.length)
      add(content, "p", emptyText(source, empty), "empty-inline");
    for (const row of visible) display(content, row);
  }
  const controls =
    ctx.mode === "hybrid"
      ? filterControls(panel, {
          fields,
          search,
          placeholder,
          onChange: refresh,
          pending: ctx.pending,
        })
      : undefined;
  const content = add(panel, "div", undefined, contentClass);
  if (ctx.pending) pendingRows(content);
  else refresh();
  return refresh;
}

function pills(
  parent,
  options,
  active,
  onSelect,
  className = "filter-pills-row",
  pending = false,
) {
  const group = add(parent, "div", undefined, className);
  const style = className === "segmented-tabs" ? "seg-tab" : "filter-pill-btn";
  const controls = options.map(([id, label]) => {
    const control = button(
      group,
      label,
      () => {
        update(id);
        onSelect(id);
      },
      style,
    );
    if (pending) pendingBlock(control, "short");
    return [id, control];
  });
  function update(id) {
    for (const [key, control] of controls) {
      control.className = key === id ? style + " is-active" : style;
      control.setAttribute("aria-pressed", String(key === id));
    }
  }
  update(active);
  return update;
}

function monthName(result) {
  const month = result?.scope?.filters?.month;
  return /^\d{4}-\d{2}$/u.test(month) ? `${Number(month.slice(5))} 月` : "本月";
}

function attentionTone(total) {
  return total === undefined ? undefined : total ? "danger" : "success";
}

const feedbackSteps = ["已受理", "设计方案", "研发测试中", "验收上线"];
const stepIndexes = new Map([
  ["未就绪", 0],
  ["待接收", 0],
  ["设计中", 1],
  ["待评审", 1],
  ["待传递", 1],
  ["待移交", 1],
  ["已移交", 2],
  ["研发中", 2],
  ["待测试", 2],
  ["测试中", 2],
  ["待验收", 3],
  ["待交付", 3],
  ["可关闭", 3],
  ["已完成", 4],
]);

function feedbackForm(parent, ctx) {
  if (!allowed(ctx, "create_story")) return;
  const { panel } = card(parent, "一句话提出新诉求");
  panel.className = "panel-card";
  const form = add(panel, "form", undefined, "fb-quick-bar");
  const field = add(form, "input", undefined, "bzt-input");
  field.setAttribute("aria-label", "新诉求");
  field.placeholder = "说说您遇到的问题或想加的功能…";
  field.required = true;
  const submit = add(form, "button", undefined, "btn-primary");
  addIcon(submit, "Send", 14);
  add(submit, "span", "发送诉求");
  submit.type = "submit";
  form.addEventListener("submit", (event) => {
    event.preventDefault();
    const text = field.value.trim();
    if (text)
      ctx.navigate("intake", { title: text, spec: { background: text } });
  });
}

function feedbackStepper(parent, active) {
  const steps = add(
    parent,
    "div",
    undefined,
    "viz-stepper" + (active === 4 ? " is-done" : ""),
  );
  const rail = add(steps, "div", undefined, "viz-stepper-rail");
  const fill = add(rail, "div", undefined, "viz-stepper-fill");
  fill.style.setProperty("width", `${Math.min(3, active) * (100 / 3)}%`);
  const nodes = add(steps, "div", undefined, "viz-stepper-nodes");
  feedbackSteps.forEach((label, index) => {
    const state =
      index < active ? " is-done" : index === active ? " is-current" : "";
    const step = add(nodes, "div", undefined, "viz-step-node" + state);
    if (index === active) step.setAttribute("aria-current", "step");
    add(step, "div", index < active ? "✓" : index + 1, "viz-step-dot");
    add(step, "span", label, "viz-step-label");
  });
}

function renderFeedback(parent, ctx, { work, feedback }) {
  const { panel, header } = card(parent, "我反馈的需求进展", {
    subtitle: "跟进已登记的诉求和需求，查看当前处理人及下一步。",
  });
  if (allowed(ctx, "query_stories"))
    button(header, "查看全部", go(ctx, "stories"), "btn-sm");
  const stories = unique(work.data?.raised);
  const requirements = unique(feedback?.data?.items).map((story) => ({
    ...story,
    requirement: true,
  }));
  const rows = [
    ...requirements,
    ...(ctx.mode === "hybrid" ? stories : stories.slice(0, 3)),
  ];
  const source =
    feedback?.error || limited(feedback) || (!work.data && feedback?.data)
      ? { ...work, data: work.data ?? feedback?.data, completeness: "partial" }
      : work;
  const activeStep = (story) =>
    story.requirement ? 0 : stepIndexes.get(story.progress?.value);
  filteredList(panel, ctx, {
    rows,
    source,
    fields: [
      choice(
        "全部阶段",
        rows,
        activeStep,
        (story) => feedbackSteps[Math.min(3, activeStep(story))],
      ),
      choice(
        "全部模块",
        rows,
        (story) => story.module?.id,
        (story) => story.module?.path,
      ),
      choice(
        "全部对接人",
        rows,
        (story) => story.currentOwner?.account,
        (story) => person(story.currentOwner),
      ),
    ],
    search: storySearch,
    placeholder: "检索诉求 / 负责人…",
    empty: "当前筛选条件下暂无需求记录。",
    contentClass: "fb-stories-stack vp-scroll",
    pendingRows: pendingFeedback,
    display: (items, story) => {
      const surface = add(items, "div", undefined, "fb-story-card");
      const head = add(surface, "div", undefined, "fb-story-top");
      const prefix = story.requirement ? "受理单 #" : "#";
      add(head, "strong", `${prefix}${story.id} ${story.title}`);
      const actions = add(head, "div", undefined, "row-actions");
      if (story.requirement) {
        badge(actions, "已受理 · 待评估", "warn");
        externalLink(actions, "在禅道查看", story.url);
      } else {
        badge(
          actions,
          progressTitle(story.progress),
          progressTones.get(story.progress?.value),
        );
        button(
          actions,
          "查看进度卡片",
          storyAction(ctx, story.id, "card"),
          "btn-secondary btn-sm",
        );
      }
      const stage = activeStep(story);
      if (stage !== undefined) feedbackStepper(surface, stage);
      const meta = add(
        surface,
        "div",
        undefined,
        "fb-story-meta workbench-feedback-meta",
      );
      add(
        meta,
        "span",
        `当前跟进：${person(story.currentOwner)} · 需求对接：${person(story.maintainer)}`,
      );
      if (story.nextStage)
        add(
          meta,
          "span",
          `下一步：${story.nextStage}${story.nextDeadline ? `（预计 ${story.nextDeadline}）` : ""}`,
        );
    },
  });
}

const progressTones = new Map([
  ["未就绪", "warn"],
  ["待接收", "warn"],
  ["设计中", "purple"],
  ["待评审", "purple"],
  ["待传递", "purple"],
  ["待移交", "purple"],
  ["已移交", "success"],
  ["研发中", "primary"],
  ["待测试", "danger"],
  ["测试中", "primary"],
  ["待验收", "success"],
  ["待交付", "success"],
  ["可关闭", "success"],
  ["已完成", "success"],
]);

function designRows(ctx, { work, design }) {
  const members = ctx.role.id === "DM" ? (ctx.designMaintainers ?? []) : [];
  const memberIds = new Set([
    ctx.account,
    ...members.map(({ account }) => account),
  ]);
  const extraRows = (design?.data?.items ?? []).filter(({ maintainer }) =>
    memberIds.has(maintainer?.account),
  );
  const rows = unique([...(work.data?.maintained ?? []), ...extraRows]);
  const source = design?.data
    ? design
    : design?.error && work.data
      ? { ...work, completeness: "partial" }
      : work;
  return { rows, source, members };
}

function renderDesign(parent, ctx, { work, unlinked, design }) {
  const requirements = unique(unlinked.data?.items);
  const {
    rows: maintained,
    source,
    members,
  } = designRows(ctx, { work, design });
  const supervisor = ctx.role.id === "DM";
  const leads = new Set([
    ctx.account,
    ...members.filter(({ lead }) => lead).map(({ account }) => account),
  ]);
  const canAccept = (story) =>
    !supervisor || !members.length || leads.has(story.maintainer?.account);
  const open = maintained.filter(({ status }) => status !== "closed");
  const handoffs = open.filter(
    ({ category, progress }) =>
      category === "design" && progress?.value === "待移交",
  );
  const acceptance = open.filter(
    (story) =>
      canAccept(story) && ["待验收", "可关闭"].includes(story.progress?.value),
  );
  const deliveries = open.filter(
    (story) => canAccept(story) && story.progress?.value === "待交付",
  );
  const dealtWith = new Set(
    [...handoffs, ...acceptance, ...deliveries].map(({ id }) => id),
  );
  const reviews = unique(work.data?.action?.toReview).filter(
    ({ id }) => !dealtWith.has(id),
  );
  const unlinkedTotal = unlinked.data?.countsByProgress
    ? Object.values(unlinked.data.countsByProgress).reduce(
        (sum, total) => sum + total,
        0,
      )
    : requirements.length;
  const unlinkedScope = { ...unlinked, truncated: false };
  ctx.setBadge?.(
    "intake",
    unlinked.data && !limited(unlinkedScope) ? unlinkedTotal : undefined,
  );
  ctx.setBadge?.(
    "stories",
    source.data && !limited(source) ? handoffs.length : undefined,
  );

  const addMetric = metricGrid(parent, 3, ctx.pending);
  addMetric(
    "待关联用户需求",
    count(unlinkedScope, unlinkedTotal),
    "点击一键带入建研发需求",
    {
      click: allowed(ctx, "create_story") ? intake(ctx) : undefined,
    },
  );
  addMetric(
    "设计完成待移交",
    count(source, handoffs.length),
    "评审过一键生成研发需求",
    {
      click: go(ctx, "stories"),
    },
  );
  addMetric(
    "待验收与可关闭",
    count(source, acceptance.length),
    "测试已完成，等您确认收尾",
  );

  const actions = [
    ...requirements.map((story) => ({ story, kind: "req" })),
    ...handoffs.map((story) => ({ story, kind: "ho" })),
    ...[...acceptance, ...deliveries].map((story) => ({ story, kind: "ac" })),
    ...reviews.map((story) => ({ story, kind: "review" })),
  ];
  const grid = add(parent, "div", undefined, "vp-grid-2 workbench-design-grid");
  const { panel, header } = card(grid, "现在需要您处理的事项");
  const actionScope = {
    data: source.data || unlinked.data,
    completeness:
      !source.data || !unlinked.data || limited(source) || limited(unlinked)
        ? "partial"
        : "complete",
  };
  const actionCount = resultBadge(header, ctx, "primary");
  const actionNames = new Map([
    ["req", "待回关联用户需求"],
    ["ho", "设计待移交研发"],
    ["ac", "待验收 / 可关闭"],
    ["review", "待评审"],
  ]);
  filteredList(panel, ctx, {
    rows: actions,
    source: actionScope,
    fields: [
      {
        label: "全部事项类型",
        value: ({ kind }) => kind,
        options: actionNames,
      },
    ],
    search: ({ story, kind }) =>
      [actionNames.get(kind), storySearch(story)].join(" "),
    placeholder: "检索待办事项…",
    empty: "当前筛选条件下暂无待处理事项。",
    onCount: (total) => {
      actionCount.textContent = count(actionScope, total, " 项");
    },
    display: (items, { story, kind }) => {
      const ref = `#${story.id} ${story.title}`;
      if (kind === "req") {
        const row = item(
          items,
          `用户需求待回关联：${story.title}`,
          `由 ${story.feedbackBy || "待确认的反馈方"} 提出，关联后提出人可跟进后续进展`,
        );
        button(
          row,
          "一键生成研发需求",
          createFromRequirement(ctx, story),
          "btn-primary btn-sm",
        );
      } else if (kind === "ho") {
        const basis = story.progress?.level === "inferred";
        const row = item(
          items,
          `设计已评审通过，待移交研发：${ref}`,
          `研发接收人 ${person(story.receiver)}${basis ? " · 阶段为推测" : ""}`,
        );
        button(
          row,
          "一键移交研发",
          toolAction(ctx, "handoff_story", {
            storyId: story.id,
            mode: "from_design",
          }),
          "btn-success btn-sm",
        );
      } else {
        const progress = story.progress?.value;
        const label =
          kind === "review"
            ? "待您评审"
            : {
                可关闭: "可关闭收尾",
                待验收: "测试已通过，待您验收",
                待交付: "待交付",
              }[progress];
        const row = item(
          items,
          `${label}：${ref}`,
          `当前处理人 ${person(story.currentOwner)}`,
          {
            tag: story.progress?.level === "inferred" ? "推测" : undefined,
          },
        );
        const close =
          progress === "可关闭"
            ? toolAction(ctx, "close_stories", {
                mode: "story",
                storyIds: [story.id],
                closedReason: "done",
              })
            : undefined;
        const buttons = add(row, "div", undefined, "row-actions");
        button(
          buttons,
          close ? "关闭并收尾" : "查看详情",
          close || storyAction(ctx, story.id),
          close ? "btn-success btn-sm" : "btn-primary btn-sm",
        );
        if (progress === "可关闭" && !close)
          externalLink(buttons, "在禅道关闭收尾", story.url);
      }
    },
  });

  const maintainedCard = card(
    grid,
    supervisor
      ? "团队与我维护的需求（US-DM-03 · 按维护人筛选）"
      : "我维护的需求（移交研发后仍可持续跟进）",
    { grouped: true },
  );
  maintainedCard.panel.className += " workbench-maintained-panel";
  let maintainer = null;
  const maintainedCount = resultBadge(maintainedCard.header, ctx);
  if (supervisor) {
    const names = new Map(
      maintained.flatMap(({ maintainer }) =>
        maintainer?.realname ? [[maintainer.account, maintainer.realname]] : [],
      ),
    );
    const options = members.length
      ? [
          [null, "全部设计团队"],
          ...members.map(({ account, realname, lead }) => [
            account,
            (realname ||
              names.get(account) ||
              (account === ctx.account && ctx.displayName) ||
              account) + (lead ? "（设计主管）" : ""),
          ]),
        ]
      : [[null, "本人维护"]];
    pills(maintainedCard.copy, options, maintainer, (next) => {
      maintainer = next;
      refreshMaintained();
    });
    if (!members.length)
      add(
        maintainedCard.panel,
        "p",
        "暂未配置设计团队范围，当前仅显示本人维护的需求。",
        "panel-sub",
      );
  }
  const refreshMaintained = filteredList(maintainedCard.panel, ctx, {
    rows: maintained,
    source,
    fields: storyChoices(maintained),
    search: storySearch,
    placeholder: "检索需求标题 / #ID…",
    empty: "该筛选条件下暂无需求。",
    pendingRows: (items) => pendingItems(items, { tag: true }),
    include: (story) => !maintainer || story.maintainer?.account === maintainer,
    onCount: (total) => {
      maintainedCount.textContent = count(source, total, " 条");
    },
    display: (items, story) => {
      const detail = storyAction(ctx, story.id);
      const row = add(
        items,
        "div",
        undefined,
        detail ? "item-row is-clickable" : "item-row",
      );
      const main = add(
        row,
        detail ? "button" : "div",
        undefined,
        "item-row-main workbench-story-open",
      );
      if (detail) {
        main.type = "button";
        main.addEventListener("click", detail);
      }
      const title = add(main, "span", undefined, "item-row-title");
      add(title, "span", "#" + story.id, "mono req-id");
      add(title, "span", story.title);
      badge(
        title,
        progressTitle(story.progress),
        progressTones.get(story.progress?.value),
      );
      add(
        main,
        "span",
        `维护人：${person(story.maintainer)} · 当前处理：${person(story.currentOwner)} · 反馈方：${story.feedbackBy || "待确认"}`,
        "item-row-sub",
      );
      button(
        row,
        "转发进度卡",
        storyAction(ctx, story.id, "card"),
        "btn-secondary btn-sm",
      );
    },
  });
}

function showDesignReminder(parent, ctx, reads) {
  const story = designRows(ctx, reads).rows.find(({ riskCodes }) =>
    riskCodes?.includes("R04"),
  );
  const hit = reads.risks?.data?.hits?.find(
    ({ rule, waived }) => rule === "R04" && !waived,
  );
  const id = story?.id ?? hit?.object.id;
  if (!id) return;
  const reason = story
    ? "需求尚未就绪，当前处理人属于研发侧且不是状态维护人"
    : hit.reason;
  const note = add(parent, "div", undefined, "bzt-hint-strip");
  addIcon(note, "TriangleAlert", 14);
  add(note, "span", `规范提示：#${id} ${reason}（R04）。`);
  const open =
    storyAction(ctx, id) ??
    (allowed(ctx, "scan_workflow_risks")
      ? () => ctx.navigate("release-risks", { tab: "risks", rules: ["R04"] })
      : undefined);
  button(note, "查看 R04", open, "link-inline");
}

function renderDevelopmentLead(
  parent,
  ctx,
  { work, team, queue },
  selectedTeam,
) {
  const source = selectedTeam ? queue : work;
  const toReceive = unique(
    selectedTeam
      ? queue.data?.buckets?.toReceive
      : work.data?.action?.toReceive,
  );
  const newIds = new Set(
    (work.data?.new ?? [])
      .filter(({ title }) => title !== undefined)
      .map(({ id }) => id),
  );
  const waiting = unique(
    selectedTeam ? queue.data?.notReady : work.data?.waiting_ready,
  );
  const led = team.scope?.filters?.teams;
  const queued = queue.scope?.filters?.teamIds;
  const sameScope =
    led?.length &&
    queued?.length === led.length &&
    led.every((id) => queued.includes(id));
  ctx.setBadge?.(
    "schedule",
    sameScope && !limited(queue) ? queue.data?.counts?.toReceive : undefined,
  );
  const overdue = team.data?.totals?.overdue;
  const addMetric = metricGrid(parent, 3, ctx.pending);
  addMetric(
    "待接收并拆解",
    count(source, toReceive.length),
    "点击进入一站式建齐阶段任务",
    {
      click: go(ctx, "schedule", "queue"),
    },
  );
  addMetric(
    "组内在研需求",
    count(queue, sameScope ? queue.data?.counts?.inDev : undefined),
    sameScope ? "已排期进入研发或测试阶段" : "需确认主管团队范围",
    { pendingHint: true },
  );
  addMetric(
    "团队逾期任务（仅叶子）",
    count(team, overdue),
    "已自动剔除父任务防重复计数",
    {
      click: go(ctx, "schedule", "matrix"),
      tone: limited(team) && !overdue ? undefined : attentionTone(overdue),
    },
  );

  const waitingList =
    waiting.length && add(parent, "div", undefined, "workbench-rm-alerts");
  for (const story of waiting) {
    const notice = add(
      waitingList,
      "div",
      undefined,
      "bzt-alert tone-warn workbench-rm-alert",
    );
    addIcon(notice, "TriangleAlert", 15);
    const copy = add(notice, "div", undefined, "bzt-alert-body");
    add(
      copy,
      "strong",
      story.status === "draft"
        ? "未就绪草稿已自动隔离："
        : "未就绪需求已自动隔离：",
    );
    const maintainer = story.waitingFor ?? story.maintainer;
    add(
      copy,
      "span",
      ` #${story.id} ${story.title} · 等待 ${person(maintainer)} 完善`,
    );
    const assign =
      maintainer?.account &&
      toolAction(ctx, "assign_story", {
        storyIds: [story.id],
        to: maintainer.account,
      });
    button(
      notice,
      assign ? "退回状态维护人" : "查看详情",
      assign || storyAction(ctx, story.id),
      "btn-warn btn-sm",
    );
  }

  const columns = add(parent, "div", undefined, "vp-grid-2");
  const { panel, header } = card(columns, "新到的待接收需求（拆解即接收）");
  button(
    header,
    "去批量拆解 →",
    go(ctx, "schedule", "queue"),
    "btn-primary btn-sm",
  );
  filteredList(panel, ctx, {
    rows: toReceive,
    source,
    fields: [
      choice(
        "全部模块",
        toReceive,
        (row) => row.module?.id,
        (row) => row.module?.path,
      ),
      choice("全部版本", toReceive, (row) => row.version),
    ],
    search: storySearch,
    empty: "暂无待接收需求。",
    pendingRows: (items) => pendingItems(items, { tag: true }),
    display: (items, story) => {
      const row = item(
        items,
        `#${story.id} ${story.title}`,
        `状态维护人：${person(story.maintainer)}`,
        {
          tag: newIds.has(story.id) ? "新到" : undefined,
          tone: "primary",
        },
      );
      const decompose = toolAction(ctx, "decompose_stories", {
        storyIds: [story.id],
        template: "feature",
      });
      button(
        row,
        decompose ? "一键建齐阶段任务" : "查看详情",
        decompose || storyAction(ctx, story.id),
        "btn-primary btn-sm",
      );
    },
  });

  const selectedName = ctx.developmentTeams?.find(
    ({ id }) => id === selectedTeam,
  )?.name;
  const overdueCard = card(
    columns,
    `${selectedName ? selectedName + " · " : ""}团队逾期任务（按成员分组 · get_team_work · US-RM-06）`,
  );
  const teamRows = unique(
    team.data?.groups?.flatMap(({ items }) => items),
  ).filter(({ isParent, timeState }) => !isParent && timeState === "overdue");
  const byMember = teamRows.sort(
    (a, b) =>
      person(a.assignedTo).localeCompare(person(b.assignedTo), "zh-CN") ||
      (a.deadline ?? "").localeCompare(b.deadline ?? ""),
  );
  const badgeCount = resultBadge(
    overdueCard.header,
    ctx,
    ctx.pending ? undefined : overdue ? "danger" : "success",
  );
  let displayedMember;
  filteredList(overdueCard.panel, ctx, {
    rows: byMember,
    source: team,
    fields: [
      choice(
        "全部组内成员",
        teamRows,
        (task) => task.assignedTo?.account,
        (task) => person(task.assignedTo),
      ),
      choice("全部阶段", teamRows, (task) => task.stage),
    ],
    search: taskSearch,
    empty:
      overdue && !teamRows.length
        ? "当前读取范围未返回逾期明细。"
        : "暂无匹配的逾期任务。",
    pendingRows: (items) => pendingItems(items, { group: true, tag: true }),
    onCount: (total) => {
      displayedMember = undefined;
      badgeCount.textContent = count(
        team,
        teamRows.length ? total : overdue,
        " 条",
      );
    },
    display: (parent, task) => {
      const name = person(task.assignedTo);
      if (name !== displayedMember) {
        displayedMember = name;
        add(parent, "h3", name, "rd-group-header");
      }
      const row = item(
        parent,
        task.name,
        `#${task.id} · 截止 ${task.deadline || "待定"}`,
        { tag: "已逾期", tone: "danger" },
      );
      externalLink(row, "在禅道查看", task.url);
    },
  });
}

const taskTime = new Map([
  ["overdue", { label: "已逾期", title: "已逾期", tone: "danger" }],
  [
    "due_today",
    { label: "今日到期", title: "今日截止（不算逾期）", tone: "warn" },
  ],
  ["due_soon", { label: "近期到期", title: "临近截止", tone: "primary" }],
  ["unscheduled", { label: "缺少排期", title: "缺少排期", tone: "muted" }],
  ["on_track", { label: "按期推进", title: "按期推进", tone: "success" }],
]);

function renderDeveloper(parent, ctx, { work, personalTasks }) {
  const action = work.data?.action;
  const newIds = new Set(
    (work.data?.new ?? [])
      .filter(({ name, isParent }) => name && !isParent)
      .map(({ id }) => id),
  );
  const tasks = unique(
    [
      ...(work.data?.new ?? []),
      ...(action?.overdue ?? []),
      ...(action?.dueToday ?? []),
      ...(action?.dueSoon ?? []),
      ...(action?.unscheduled ?? []),
      ...(personalTasks?.data?.groups?.flatMap(({ items }) => items) ?? []),
    ].filter(({ timeState, isParent }) => taskTime.has(timeState) && !isParent),
  );
  const source = personalTasks?.data
    ? personalTasks
    : personalTasks?.error && work.data
      ? { ...work, completeness: "partial" }
      : work;
  // 时间分组与截止口径由服务端按业务日历确定。
  const ordered = [...taskTime.keys()].flatMap((time) =>
    tasks
      .filter(({ timeState }) => timeState === time)
      .sort(
        (a, b) =>
          (a.deadline ?? "").localeCompare(b.deadline ?? "") || a.id - b.id,
      ),
  );
  const total = (key) =>
    ordered.filter(({ timeState }) => timeState === key).length;
  const overdue = total("overdue");
  const soon = total("due_soon") + total("unscheduled");
  const addMetric = metricGrid(parent, 4, ctx.pending);
  addMetric(
    "新到达任务",
    count(work, newIds.size),
    "刚流转到我名下（US-RD-01）",
    { click: () => select("new") },
  );
  addMetric("当前逾期", count(source, overdue), "截止日早于今天", {
    click: () => select("overdue"),
    tone:
      !source.data || (limited(source) && !overdue)
        ? undefined
        : attentionTone(overdue),
  });
  addMetric("今日到期", count(source, total("due_today")), "今日到期不算逾期", {
    click: () => select("due_today"),
    tone: "warn",
  });
  addMetric(
    "临近截止 / 未排期",
    count(source, soon),
    "未来 3 个工作日内 / 待设定日期",
    {
      click: () => select("soon"),
    },
  );

  let active = "all";
  function select(next) {
    active = next;
    updatePills(active);
    refresh();
  }
  const { panel, header, copy } = card(
    parent,
    "今日聚焦任务（点击查看「做什么 / 不做什么 / 设计第几节」）",
    { grouped: true },
  );
  const filterTypes = [
    ["all", "全部", ordered.length],
    ["new", "新到达", newIds.size],
    ["overdue", "已逾期", total("overdue")],
    ["due_today", "今日截止", total("due_today")],
    ["due_soon", "临近截止", total("due_soon")],
    ["unscheduled", "缺少排期", total("unscheduled")],
  ];
  const updatePills = pills(
    copy,
    filterTypes.map(([id, label, total]) => [
      id,
      ctx.pending
        ? label
        : `${label} (${count(id === "new" ? work : source, total)})`,
    ]),
    active,
    select,
    undefined,
    ctx.pending,
  );
  const badgeCount = resultBadge(header, ctx);
  let group;
  const refresh = filteredList(panel, ctx, {
    rows: ordered,
    source,
    fields: [
      choice(
        "全部迭代",
        tasks,
        (task) => task.execution?.id,
        (task) => task.execution?.name,
      ),
      choice("全部阶段", tasks, (task) => task.stage),
      choice(
        "全部状态",
        tasks,
        (task) => task.status,
        (task) =>
          ({ wait: "待开始", doing: "进行中", pause: "已暂停" })[task.status] ??
          task.status,
      ),
    ],
    search: taskSearch,
    empty: "当前筛选条件下暂无待办任务。",
    pendingRows: (items) =>
      pendingItems(items, { group: true, tag: true, actions: 2 }),
    include: (row) =>
      active === "all" ||
      (active === "new"
        ? newIds.has(row.id)
        : active === "soon"
          ? ["due_soon", "unscheduled"].includes(row.timeState)
          : row.timeState === active),
    onCount: (total) => {
      group = undefined;
      badgeCount.textContent = count(source, total, " 项");
    },
    display: (items, task) => {
      const time = taskTime.get(task.timeState);
      if (group !== task.timeState) {
        group = task.timeState;
        add(items, "h3", time.title, "rd-group-header");
      }
      const related = task.story
        ? `#${task.story.id} ${task.story.title || ""}`.trim()
        : "未关联需求";
      const row = item(
        items,
        task.name,
        `所属需求 ${related} · 截止 ${task.deadline || "未设定"}`,
        {
          tag: newIds.has(task.id) ? "新到" : undefined,
          tone: "primary",
        },
      );
      const actions = add(row, "div", undefined, "row-actions");
      button(
        actions,
        "看范围与章节",
        storyAction(ctx, task.story?.id, "dev"),
        "btn-secondary btn-sm",
      );
      externalLink(actions, "在禅道查看或拆子任务", task.url);
    },
  });
}

const gateStatus = {
  ready: ["is-pass", "门禁通过"],
  waiver: ["is-waived", "已登记发布例外"],
  blocked: ["is-block", "发布阻断"],
};

function releaseGate(parent, ctx, product, report) {
  const planner = allowed(ctx, "get_plan_progress");
  const risks = allowed(ctx, "scan_workflow_risks");
  if (!planner && !risks) return;
  const data = report?.data?.view === "release" ? report.data : undefined;
  const status =
    limited(report) && data?.gate !== "blocked"
      ? undefined
      : gateStatus[data?.gate];
  const [state, description] = status ?? ["", "门禁待核对"];
  const hero = add(parent, "section", undefined, "gate-hero " + state);
  const left = add(hero, "div", undefined, "gate-hero-left");
  const title = product ? "发布门禁" : "版本发布体检";
  const remaining = data?.workdaysUntilRelease;
  const date = data?.releaseDate
    ? `（${data.releaseDate}${Number.isFinite(remaining) && remaining >= 0 ? `，剩 ${remaining} 个工作日` : ""}）`
    : "";
  if (ctx.pending && report) {
    pendingBlock(left, "avatar", "traffic-lamp");
    const copy = add(left, "div", undefined, "workbench-pending-gate-copy");
    pendingBlock(copy, "title");
    pendingBlock(add(copy, "p", undefined, "gate-sub"), "text");
  } else {
    add(
      left,
      "span",
      undefined,
      "traffic-lamp " + (state || "workbench-lamp-unknown"),
    ).setAttribute("aria-hidden", "true");
    const copy = add(left, "div");
    add(
      copy,
      "strong",
      data ? `${data.version} ${title}${date}：${description}` : title,
    );
    add(
      copy,
      "p",
      data
        ? `未完测试 ${count(report, data.testIncompleteStoryIds?.length, " 条")} · 高危 Bug ${count(report, data.openSeriousBugs?.length, " 条")}`
        : planner
          ? "选定产品和版本后核对未完成测试、高优 Bug 与例外记录。"
          : "查看与您相关的测试和 Bug 风险。",
      "gate-sub",
    );
  }
  const label = planner
    ? product
      ? "查看发布门禁"
      : "查看完整门禁与 Bug →"
    : "查看发布风险与 Bug →";
  button(
    hero,
    label,
    data
      ? () =>
          ctx.navigate("release-risks", {
            tab: "gate",
            version: data.version,
            ...(data.productId != null && { product: String(data.productId) }),
          })
      : go(ctx, "release-risks", planner ? "gate" : "risks"),
    "btn-primary",
  );
}

function renderTesting(parent, ctx, { work, gate }) {
  const ready = work.data?.can_start;
  const grid = add(parent, "div", undefined, "vp-grid-2");
  for (const [title, tasks, imminent] of [
    ["现在就能测（研发已完成）", ready?.tests, false],
    ["即将转测（可提前排期）", ready?.upcomingTests, true],
  ]) {
    const { panel, header } = card(grid, title);
    const rows = unique(tasks).filter(({ isParent }) => !isParent);
    const tally = resultBadge(header, ctx, imminent ? "primary" : "success");
    filteredList(panel, ctx, {
      rows,
      source: work,
      fields: [
        choice(
          "全部迭代",
          rows,
          (task) => task.execution?.id,
          (task) => task.execution?.name,
        ),
        choice(
          "全部紧急度",
          rows,
          (task) => task.timeState,
          (task) => taskTime.get(task.timeState)?.label,
        ),
        choice(
          "全部测试人员",
          rows,
          (task) => task.assignedTo?.account,
          (task) => person(task.assignedTo),
        ),
      ],
      search: taskSearch,
      placeholder: "检索测试任务 / #ID…",
      empty: imminent ? "暂无即将转测的待排期任务" : "暂无新近转入待测的任务",
      pendingRows: (items) =>
        pendingItems(items, { actions: imminent ? 0 : 1, actionKind: "chip" }),
      onCount: (total) => {
        tally.textContent = count(work, total, " 项");
      },
      display: (items, task) => {
        const detail = storyAction(ctx, task.story?.id);
        const related = task.story
          ? `#${task.story.id} ${task.story.title || ""} · `
          : "";
        const window = imminent
          ? `计划窗口 ${task.estStarted || "待定"} 至 ${task.deadline || "待定"}`
          : `期望截止 ${task.deadline || "待定"}`;
        const row = item(items, task.name, `${related}${window}`, {
          click: detail,
        });
        if (!imminent) badge(row, "可开始", "success");
        if (!detail) externalLink(row, "查看任务", task.url);
      },
    });
  }
  releaseGate(parent, ctx, false, gate);
}

function rate(stat, result) {
  if (!Number.isFinite(stat?.rate)) return "无可用分母";
  return `${limited(result) ? "已读 " : ""}${percent.format(stat.rate)}（${stat.numerator}/${stat.denominator}）`;
}

const planStatuses = [
  ["completed", "done", "已完成"],
  ["inProgress", "doing", "执行中"],
  ["toReceive", "toReceive", "待接收"],
  ["notReady", "notReady", "未就绪"],
  ["cancelled", "cancelled", "已取消"],
  ["unknown", "unknown", "无法判断"],
];

function planDistribution(parent, counts, total, showAll = false) {
  if (!counts || !Number.isFinite(total)) return;
  const bar = add(
    parent,
    "div",
    undefined,
    total > 0 ? "viz-stacked-bar" : "viz-stacked-bar is-empty",
  );
  bar.style.setProperty("height", showAll ? "8px" : "6px");
  const legend = add(
    parent,
    "div",
    undefined,
    showAll ? "l3-dist-legend" : "l3-tile-meta",
  );
  for (const [key, style, label] of planStatuses) {
    const value = counts[key];
    if (!Number.isFinite(value)) continue;
    if (value > 0 && total > 0) {
      const segment = add(bar, "div", undefined, "viz-seg is-" + style);
      segment.style.setProperty(
        "width",
        `${Math.min(100, (value / total) * 100)}%`,
      );
      segment.title = `${label}：${value} 条`;
    }
    if (showAll || value > 0) {
      const code = add(legend, "span", undefined, "l3-legend-item");
      add(code, "i", undefined, "l3-dot is-" + style);
      add(code, "span", `${label} ${value}`);
    }
  }
}

function renderProduct(parent, ctx, { plan, gate }) {
  const { panel, header } = card(
    parent,
    `${monthName(plan)}各模块 L3 计划完成度`,
  );
  const report = plan.data;
  if (ctx.pending) {
    const badges = add(header, "div", undefined, "row-actions");
    pendingBlock(badges, "chip", "workbench-pending-plan-rate");
    pendingBlock(badges, "chip", "workbench-pending-plan-rate");
    pendingDistribution(
      add(panel, "div", undefined, "l3-dist-wrap"),
      planStatuses.length,
      true,
    );
  } else if (report) {
    const badges = add(header, "div", undefined, "row-actions");
    badge(
      badges,
      `需求交付率 ${rate(report.storyDeliveryRate, plan)}`,
      "primary",
    );
    badge(badges, `叶子任务完成率 ${rate(report.taskCompletionRate, plan)}`);
    planDistribution(
      add(panel, "div", undefined, "l3-dist-wrap"),
      report.counts,
      report.total,
      true,
    );
  }
  const label = (group) =>
    group.key == null ? "未归属模块" : `模块 #${group.key}`;
  const groups = report?.groups ?? [];
  filteredList(panel, ctx, {
    rows: groups,
    source: plan,
    fields: [choice("全部 L3 模块", groups, label)],
    search: label,
    placeholder: "检索 L3 模块…",
    empty: "当前筛选条件下暂无匹配的 L3 模块计划。",
    contentClass: "l3-bars is-two-col vp-scroll",
    pendingRows: pendingPlanTiles,
    display: (items, group) => {
      const row = add(
        items,
        "div",
        undefined,
        "l3-tile" + (!group.total ? " is-empty-plan" : ""),
      );
      const head = add(row, "div", undefined, "l3-tile-head");
      add(head, "span", label(group), "l3-tile-title");
      add(head, "span", rate(group.storyDeliveryRate, plan), "l3-tile-ratio");
      planDistribution(row, group.counts, group.total);
    },
  });
  releaseGate(parent, ctx, true, gate);
}

const riskSeverities = new Map([
  ["high", { label: "高危", tone: "danger" }],
  ["medium", { label: "中危", tone: "warn" }],
  ["low", { label: "低危" }],
  ["info", { label: "信息" }],
]);

function renderProject(parent, ctx, { risks, commitment }) {
  const active = (risks.data?.hits ?? []).filter(({ waived }) => !waived);
  const ordered = [...riskSeverities.keys()].flatMap((severity) =>
    active.filter((hit) => hit.severity === severity),
  );
  const high = ordered.filter(({ severity }) => severity === "high").length;
  ctx.setBadge?.(
    "release-risks",
    !risks.data || limited(risks) ? undefined : active.length,
  );
  const summary = new Map(
    (risks.data?.summary ?? []).map(({ rule, name }) => [rule, name]),
  );
  const snapshot = commitment.data;
  const carried = snapshot?.carriedOver ?? [];
  const baseline = snapshot?.snapshotAvailable
    ? new Set([
        ...(snapshot.fulfilled ?? []),
        ...(snapshot.pendingStoryIds ?? []),
        ...(snapshot.cancelledStoryIds ?? []),
        ...(snapshot.unknownStoryIds ?? []),
        ...carried.map(({ id }) => id),
      ]).size
    : undefined;
  const recorded =
    baseline === undefined
      ? undefined
      : new Set(
          carried.filter(({ reason }) => reason?.trim()).map(({ id }) => id),
        ).size;
  const partial = snapshot?.missingSnapshotProductIds?.length > 0;
  const snapshotScope = partial
    ? { ...commitment, completeness: "partial" }
    : commitment;
  const addMetric = metricGrid(parent, 3, ctx.pending);
  addMetric(
    "高危阻断卡点",
    count(risks, high),
    "任务逾期 / 测试断档 / 发布门禁",
    {
      click: go(ctx, "release-risks", "risks"),
      tone:
        !risks.data || (limited(risks) && !high)
          ? undefined
          : attentionTone(high),
    },
  );
  addMetric(
    `${monthName(commitment)}承诺基线`,
    count(snapshotScope, baseline, " 条"),
    baseline === undefined
      ? "暂无可用月初快照"
      : partial
        ? "部分产品缺少月初快照"
        : "依据月初快照",
    {
      click: go(ctx, "release-risks", "plans"),
      pendingHint: true,
    },
  );
  addMetric(
    "已留痕顺延 / 挪月",
    count(snapshotScope, recorded, " 条"),
    "仅统计有原因记录的顺延",
    {
      click: go(ctx, "release-risks", "plans"),
    },
  );

  const { panel, header } = card(
    parent,
    ctx.mode === "hybrid"
      ? "风险卡点多维工作台（融合禅道筛选）"
      : "最值得现在推动的 5 个卡点",
  );
  button(
    header,
    limited(risks) || !risks.data
      ? "查看风险 →"
      : `查看全部 ${risks.data.hits.length} 项 →`,
    go(ctx, "release-risks", "risks"),
    "btn-sm",
  );
  filteredList(panel, ctx, {
    rows: ctx.mode === "hybrid" ? ordered : ordered.slice(0, 5),
    source: risks,
    fields: [
      choice(
        "全部级别",
        ordered,
        (hit) => hit.severity,
        (hit) => riskSeverities.get(hit.severity)?.label,
      ),
      choice(
        "全部规则 R01–R16",
        ordered,
        (hit) => hit.rule,
        (hit) => hit.rule + " " + (summary.get(hit.rule) ?? ""),
      ),
      choice(
        "全部对接人",
        ordered,
        (hit) => hit.owner?.account,
        (hit) => person(hit.owner),
      ),
    ],
    search: (hit) =>
      [
        hit.rule,
        summary.get(hit.rule),
        "#" + hit.object.id,
        hit.object.title,
        hit.reason,
        person(hit.owner),
      ].join(" "),
    placeholder: "检索风险、规则或对接人…",
    empty: "当前没有发现匹配的待处理卡点。",
    pendingRows: (items) => pendingItems(items, { tag: true }),
    display: (items, hit) => {
      const severity = riskSeverities.get(hit.severity);
      const ref = `#${hit.object.id} ${hit.object.title}`;
      const row = item(
        items,
        `${summary.get(hit.rule) || hit.rule} · ${ref}`,
        `${hit.reason} · 建议对接 ${person(hit.owner)}${hit.level === "inferred" ? " · 推测" : ""}`,
        {
          tag: severity?.label,
          tone: severity?.tone,
        },
      );
      const detail =
        hit.object.type === "story" && storyAction(ctx, hit.object.id);
      if (detail) button(row, "查看详情", detail, "btn-primary btn-sm");
      else externalLink(row, "查看详情", hit.object.url);
    },
  });
}

async function read(ctx, [key, source, tool, input]) {
  if (!allowed(ctx, tool)) return [key, { source }];
  try {
    const result = await ctx.call(tool, input);
    if (result?.ok) return [key, { source, ...result }];
  } catch (error) {
    if (error?.status && typeof error.message === "string")
      return [key, { source, error: error.message }];
  }
  return [key, { source, error: "查询暂时失败" }];
}

function homeQueries(ctx, profile, selectedTeam) {
  const native = ctx.mode === "zentao";
  const { id } = ctx.role;
  const reads = [...profile.reads];
  if (id === "DM" || (id === "DS" && native)) {
    if (native || ctx.designMaintainers?.length) {
      reads.push([
        "design",
        "维护需求台账",
        "query_stories",
        {
          type: "story",
          status: ["all"],
          limit: 100,
          ...(id === "DS" && { role: "maintainer" }),
        },
      ]);
    }
    if (native) {
      reads.push([
        "requirements",
        "用户需求池",
        "query_stories",
        {
          type: "requirement",
          status: ["all"],
          limit: 100,
        },
      ]);
      reads[reads.indexOf(unlinked)] = [
        ...unlinked.slice(0, 3),
        { ...unlinked[3], status: ["all"] },
      ];
    } else if (allowed(ctx, "scan_workflow_risks")) {
      reads.push([
        "risks",
        "R04 规范检测",
        "scan_workflow_risks",
        { scope: { mine: true }, rules: ["R04"] },
      ]);
    }
  }
  if (id === "FB" && allowed(ctx, "query_stories")) {
    reads.push([
      "feedback",
      "本人受理的诉求",
      "query_stories",
      {
        type: "requirement",
        unlinked: true,
        role: "raised",
        limit: 100,
      },
    ]);
  }
  if (id === "RD" && ctx.account && allowed(ctx, "get_team_work")) {
    reads.push([
      "personalTasks",
      "本人叶子任务",
      "get_team_work",
      { members: [ctx.account], view: "all_open" },
    ]);
  }
  const release = ctx.releaseCalendar?.[0];
  if (
    (id === "QA" || id === "PM") &&
    release &&
    allowed(ctx, "get_plan_progress")
  ) {
    reads.push([
      "gate",
      "版本发布门禁",
      "get_plan_progress",
      {
        view: "release",
        product: String(release.product),
        version: release.version,
      },
    ]);
  }
  if (id === "PM" && native) {
    reads.push([
      "releaseStories",
      "版本需求",
      "query_stories",
      { type: "story", status: ["all"], limit: 100 },
    ]);
  }
  if (id === "PJ" && native) {
    reads.push([
      "iteration",
      "本月迭代过程指标",
      "get_plan_progress",
      { view: "iteration", month: "本月" },
    ]);
  }
  if (id === "RM" && (selectedTeam || native)) {
    return reads.map(([key, label, tool, input]) => {
      if (key === "team")
        return [
          key,
          label,
          tool,
          {
            ...input,
            ...(selectedTeam && { team: selectedTeam }),
            view: native ? "all_open" : "overdue",
          },
        ];
      if (key === "queue" && selectedTeam)
        return [
          key,
          label,
          tool,
          { ...input, team: selectedTeam, includeNotReady: true },
        ];
      return [key, label, tool, input];
    });
  }
  return reads;
}

function evidenceSkeleton(parent, className, height) {
  const block = add(parent, "div", undefined, className);
  if (height) block.style.setProperty("min-height", `${height}px`);
  pendingBlock(block, "title");
  return block;
}

function showEvidence(parent, reads, pending = false) {
  const notes = [];
  const gaps = [];
  let observed;
  for (const result of Object.values(reads)) {
    if (result.error) gaps.push(`${result.source} · ${result.error}`);
    else if (result.completeness === "partial") {
      for (const gap of result.gaps ?? [])
        gaps.push(`${gap.source} · ${gap.reason}`);
      if (!result.gaps?.length)
        gaps.push(result.source + " · 读到的范围不完整");
    }
    if (result.truncated) gaps.push(`${result.source} · 部分记录已截断`);
    if (result.scope?.asOf && (!observed || result.scope.asOf < observed))
      observed = result.scope.asOf;
    for (const hint of result.hints ?? []) notes.push(hint);
    for (const inference of result.inferences ?? []) {
      if (inference.level === "inferred")
        notes.push(`推测 · ${inference.basis}`);
    }
  }
  if (gaps.length || notes.length) {
    const className = gaps.length
      ? "bzt-alert tone-warn workbench-evidence"
      : "workbench-evidence page-sub";
    if (pending) return evidenceSkeleton(parent, className);
    const evidence = add(parent, "details", undefined, className);
    add(
      evidence,
      "summary",
      gaps.length ? "数据不完整，汇总仅覆盖已读取的范围" : "数据依据与提示",
    );
    if (observed) add(evidence, "p", "数据时间 " + observed);
    const entries = add(evidence, "ul");
    for (const note of new Set([...gaps, ...notes])) add(entries, "li", note);
    return evidence;
  }
}

export async function renderWorkbench(container, ctx) {
  if (!ctx.current()) return;
  if (!Object.hasOwn(profiles, ctx.role.id)) return;
  const profile = profiles[ctx.role.id];
  const [mode, tier, modeLabel, description] =
    modes.find(([key]) => key === ctx.mode) ?? modes[2];
  container.replaceChildren();
  const root = add(container, "div", undefined, "bzt-page workbench-home");
  const head = add(root, "div", undefined, "page-head");
  const title = add(head, "div");
  const titleRow = add(title, "div", undefined, "page-title-row");
  add(titleRow, "h1", `${ctx.role.label}工作台`, "page-title");
  const identity = ctx.displayName || ctx.account;
  add(
    titleRow,
    "span",
    identity ? `${identity}（${ctx.role.label}）` : ctx.role.label,
    "role-chip grp-" + profile.group,
  );
  add(titleRow, "span", tier, "mode-tier-badge is-" + mode).title = description;
  add(
    title,
    "p",
    mode === "meridian"
      ? profile.headline
      : `${profile.headline}（${modeLabel}）`,
    "page-sub",
  );

  const actions = add(head, "div", undefined, "page-head-actions");
  const switcher = add(actions, "div", undefined, "mode-tier-bar");
  switcher.setAttribute("role", "group");
  switcher.setAttribute("aria-label", "三档交互模式切换");
  for (const [key, text, label, hint] of modes) {
    const choice = button(
      switcher,
      text,
      () => ctx.setMode?.(key),
      "mode-tier-btn is-" + key + (mode === key ? " is-active" : ""),
    );
    choice.setAttribute("aria-pressed", String(mode === key));
    choice.title = label + "：" + hint;
  }
  if (allowed(ctx, "create_story")) {
    const developer = ctx.role.id === "RD";
    button(
      actions,
      developer
        ? "急事已开工？先建草稿"
        : ctx.role.id === "FB"
          ? "极简提诉求"
          : "提新需求",
      intake(ctx, developer ? { mode: "backfilled" } : undefined),
      "btn-primary",
      developer ? "GitPullRequestDraft" : "Plus",
    );
  }
  if (ctx.role.id === "FB" && mode !== "zentao") feedbackForm(root, ctx);

  const teams = ctx.role.id === "RM" ? (ctx.developmentTeams ?? []) : [];
  const initialTeam = teams[0]?.id;
  let generation = 0;
  let activeTab = 0;
  let teamNote;
  const evidenceByTeam = new Map();
  function showTeam(team) {
    if (teamNote)
      teamNote.textContent =
        "当前视角：" + teams.find(({ id }) => id === team).name;
  }
  if (initialTeam) {
    const toolbar = add(root, "div", undefined, "toolbar-row");
    teamNote = add(toolbar, "p", "当前视角：" + teams[0].name, "toolbar-note");
    pills(
      toolbar,
      teams.map(({ id, name }) => [id, name]),
      initialTeam,
      (team) => void load(team),
      "segmented-tabs",
    );
  }
  const body = add(root, "div", undefined, "workbench-body");
  function renderContent(parent, context, reads, team) {
    if (mode === "zentao")
      renderNativeWorkbench(parent, context, reads, {
        activeTab,
        selectTab: (next) => {
          activeTab = next;
        },
      });
    else profile.render(parent, context, reads, team);
  }
  async function load(team) {
    if (!ctx.current()) return;
    const version = ++generation;
    const current = () => ctx.current() && version === generation;
    const queries = homeQueries(ctx, profile, team);
    const sources = Object.fromEntries(
      queries.map(([key, source]) => [key, { source }]),
    );
    const reads = { ...sources };
    const finish = beginSkeleton(
      body,
      (doc) => {
        const scene = doc.createElement("div");
        scene.className = "workbench-body workbench-skeleton";
        renderContent(
          scene,
          { ...ctx, pending: true, setBadge: undefined },
          sources,
          team,
        );
        const previous = evidenceByTeam.get(team);
        if (!showEvidence(scene, reads, true)) {
          if (previous)
            evidenceSkeleton(scene, previous.className, previous.height);
          else if (ctx.role.id === "DM" && mode !== "zentao")
            evidenceSkeleton(
              scene,
              "bzt-alert workbench-evidence workbench-pending-note",
            );
        }
        showTeam(team);
        return scene;
      },
      { signal: ctx.signal, current },
    );
    try {
      await Promise.all(
        queries.map(async (input) => {
          const [key, result] = await read(ctx, input);
          reads[key] = result;
        }),
      );
      if (!current()) return;
      showTeam(team);
      body.replaceChildren();
      renderContent(body, ctx, reads, team);
      const evidence = showEvidence(body, reads);
      if (evidence && ctx.role.id === "RM")
        evidenceByTeam.set(team, {
          className: evidence.className,
          height: evidence.getBoundingClientRect?.().height,
        });
      else evidenceByTeam.delete(team);
      if (ctx.role.id === "DM" && mode !== "zentao")
        showDesignReminder(body, ctx, reads);
    } finally {
      finish();
    }
  }
  await load(initialTeam);
}
