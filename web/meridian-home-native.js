import {
  add,
  allowed,
  badge,
  button,
  categoryLabel,
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

const storyStatus = {
  draft: "草稿",
  reviewing: "评审中",
  active: "激活",
  closed: "已关闭",
  changing: "变更中",
};
const taskStatus = {
  wait: "待开始",
  doing: "进行中",
  done: "已完成",
  closed: "已关闭",
  cancel: "已取消",
  pause: "已暂停",
};
const timing = {
  overdue: "已逾期",
  due_today: "今日到期",
  due_soon: "近期到期",
  on_track: "按期推进",
  unscheduled: "缺少排期",
  done: "已完成",
};
const severityLabel = {
  high: "高危",
  medium: "提醒",
  low: "规范",
  info: "信息",
};
const idColumn = (label = "ID") => [label, ({ id }) => "#" + id, "mono req-id"];
const storyTitle =
  (ctx, tab = "full") =>
  (cell, row) => {
    const open = storyAction(ctx, row.id, tab);
    if (open) button(cell, row.title, open, "title-link-btn");
    else cell.textContent = row.title;
  };
const riskDetail = (ctx) => (cell, hit) => {
  const detail = hit.object.type === "story" && storyAction(ctx, hit.object.id);
  if (detail) button(cell, "查看详情", detail, "zt-link-btn");
  else externalLink(cell, "查看详情", hit.object.url, "zt-link-btn");
};
const taskTitle = (cell, task) => {
  externalLink(cell, task.name, task.url, "title-link-btn");
  if (!cell.textContent) cell.textContent = task.name;
};
const valueRate = (rate) =>
  Number.isFinite(rate?.rate)
    ? `${new Intl.NumberFormat("zh-CN", { style: "percent", maximumFractionDigits: 1 }).format(rate.rate)}（${rate.numerator}/${rate.denominator}）`
    : "—";

function taskFields(rows) {
  return [
    choice(
      "全部迭代",
      rows,
      (task) => task.execution?.id,
      (task) => task.execution?.name,
    ),
    choice("全部阶段", rows, (task) => task.stage),
    choice(
      "全部状态",
      rows,
      (task) => task.status,
      (task) => taskStatus[task.status] ?? task.status,
    ),
    choice(
      "全部排期状态",
      rows,
      (task) => task.timeState,
      (task) => timing[task.timeState],
    ),
  ];
}

function storyTable(ctx, source, rows, { title, design = false } = {}) {
  const fields = storyChoices(rows);
  if (design)
    fields.push(
      choice(
        "全部状态",
        rows,
        (row) => row.status,
        (row) => storyStatus[row.status] ?? row.status,
      ),
      choice(
        "全部维护人",
        rows,
        (row) => row.maintainer?.account,
        (row) => person(row.maintainer),
      ),
    );
  return {
    label: title,
    source,
    rows,
    fields,
    search: storySearch,
    columns: [
      idColumn(),
      ["P", (row) => row.priority],
      ["需求标题", storyTitle(ctx), "workbench-native-title", true],
      ["模块", (row) => row.module?.path],
      ["类型", (row) => categoryLabel(row.category)],
      ["状态", (row) => storyStatus[row.status] ?? row.status],
      [
        "阶段进展",
        (cell, row) => badge(cell, progressTitle(row.progress)),
        "",
        true,
      ],
      ["维护人", (row) => person(row.maintainer)],
      ["当前指派", (row) => person(row.currentOwner)],
      ["版本", (row) => row.version],
      [
        "操作",
        (cell, row) => {
          const actions = add(cell, "div", undefined, "zt-action-links");
          if (
            design &&
            row.category === "design" &&
            row.progress?.value === "待移交"
          )
            button(
              actions,
              "移交研发",
              toolAction(ctx, "handoff_story", {
                storyId: row.id,
                mode: "from_design",
              }),
              "zt-link-btn is-success",
            );
          button(
            actions,
            "进度卡",
            storyAction(ctx, row.id, "card"),
            "zt-link-btn",
          );
        },
        "",
        true,
      ],
    ],
  };
}

function feedbackTabs(ctx, { work, feedback }) {
  const requirements = unique(feedback?.data?.items);
  const raised = unique(work.data?.raised);
  const grouped = [
    ...requirements.map((row) => ({ ...row, requirement: true })),
    ...raised,
  ];
  const complete = (row) => row.progress?.value === "已完成";
  return [
    ["我的诉求台账", grouped],
    ["推进中", grouped.filter((row) => !complete(row))],
    ["已验收上线", grouped.filter(complete)],
  ].map(([label, rows]) => ({
    label,
    source:
      feedback && limited(feedback)
        ? { ...work, completeness: "partial" }
        : work,
    rows,
    fields: [
      choice(
        "全部模块",
        rows,
        (row) => row.module?.id,
        (row) => row.module?.path,
      ),
      choice("全部业务进度", rows, (row) => row.progress?.value),
    ],
    search: storySearch,
    columns: [
      idColumn("编号"),
      ["类型", (row) => (row.requirement ? "用户诉求" : "跟进中")],
      [
        "诉求 / 需求标题",
        (cell, row) => {
          if (row.requirement) cell.textContent = row.title;
          else storyTitle(ctx, "card")(cell, row);
        },
        "workbench-native-title",
        true,
      ],
      ["所属模块", (row) => row.module?.path],
      ["业务进度", (row) => progressTitle(row.progress)],
      ["当前对接", (row) => person(row.currentOwner)],
      ["预计时间", (row) => row.nextDeadline, "mono"],
      [
        "操作",
        (cell, row) => {
          if (row.requirement)
            externalLink(cell, "查看诉求", row.url, "zt-link-btn");
          else
            button(
              cell,
              "进度卡",
              storyAction(ctx, row.id, "card"),
              "zt-link-btn",
            );
        },
        "",
        true,
      ],
    ],
    footer: "当前账号登记的诉求与需求进展。",
    action: [
      "+ 极简提新诉求",
      allowed(ctx, "create_story") && go(ctx, "intake"),
    ],
  }));
}

function designTabs(ctx, { work, design, requirements, unlinked }) {
  const source = design?.data ? design : work;
  const storyRows = unique(design?.data?.items ?? work.data?.maintained);
  const requestRows = unique([
    ...(requirements?.data?.items ?? []),
    ...(unlinked.data?.items ?? []),
  ]);
  const unlinkedIds = new Set((unlinked.data?.items ?? []).map(({ id }) => id));
  const linkage = (row) =>
    unlinkedIds.has(row.id)
      ? "待回关联"
      : unlinked.data && !limited(unlinked)
        ? "已关联研发"
        : "待核对";
  return [
    storyTable(ctx, source, storyRows, { title: "研发需求列表", design: true }),
    {
      label: "用户需求池",
      source: requirements?.data ? requirements : unlinked,
      rows: requestRows,
      fields: [
        choice(
          "全部模块",
          requestRows,
          (row) => row.module?.id,
          (row) => row.module?.path,
        ),
        choice("全部关联状态", requestRows, linkage),
      ],
      search: storySearch,
      columns: [
        idColumn(),
        ["用户需求标题", (row) => row.title, "workbench-native-title"],
        [
          "产品 / 模块",
          (row) =>
            [row.product?.name, row.module?.path].filter(Boolean).join(" / "),
        ],
        ["来源反馈", (row) => row.feedbackBy],
        ["登记日期", (row) => row.openedDate, "mono"],
        ["关联研发需求", linkage],
        [
          "操作",
          (cell, row) => {
            if (unlinkedIds.has(row.id))
              button(
                cell,
                "一键生成研发需求",
                createFromRequirement(ctx, row),
                "zt-link-btn",
              );
            else externalLink(cell, "查看用户需求", row.url, "zt-link-btn");
          },
          "",
          true,
        ],
      ],
      action: ["+ 提新需求", allowed(ctx, "create_story") && go(ctx, "intake")],
    },
  ];
}

function taskTable(
  ctx,
  source,
  rows,
  label,
  { qa = false, footer, action } = {},
) {
  return {
    label,
    source,
    rows,
    fields: taskFields(rows),
    search: taskSearch,
    columns: [
      idColumn(qa ? "任务ID" : "ID"),
      [qa ? "测试任务" : "任务名称", taskTitle, "workbench-native-title", true],
      ["所属需求", (row) => row.story && `#${row.story.id} ${row.story.title}`],
      ["迭代", (row) => row.execution?.name],
      ["阶段", (row) => row.stage],
      ["状态", (row) => taskStatus[row.status] ?? row.status],
      ["指派给", (row) => person(row.assignedTo)],
      ["预计开始", (row) => row.estStarted, "mono"],
      ["截止日", (row) => row.deadline, "mono"],
      ["剩余(h)", (row) => row.left, "tabular"],
      ["排期", (row) => timing[row.timeState]],
      [
        "操作",
        (cell, row) => {
          const open = storyAction(
            ctx,
            row.story?.id,
            ctx.role.id === "RD" ? "dev" : "full",
          );
          if (open) button(cell, "查看需求", open, "zt-link-btn");
          else externalLink(cell, "在禅道查看", row.url, "zt-link-btn");
        },
        "",
        true,
      ],
    ],
    footer,
    action,
  };
}

function leadTabs(ctx, { work, team, queue }) {
  const tasks = unique(team.data?.groups?.flatMap(({ items }) => items)).filter(
    ({ isParent }) => !isParent,
  );
  const rows = unique([
    ...(work.data?.action?.toReceive ?? []),
    ...Object.values(queue.data?.buckets ?? {}).flat(),
  ]);
  const stories = storyTable(ctx, queue.data ? queue : work, rows, {
    title: "研发需求队列",
  });
  stories.columns.pop();
  stories.columns.push([
    "操作",
    (cell, row) => {
      if (
        row.progress?.value === "待接收" ||
        work.data?.action?.toReceive?.some(({ id }) => id === row.id)
      )
        button(
          cell,
          "拆解",
          toolAction(ctx, "decompose_stories", {
            storyIds: [row.id],
            template: "feature",
          }),
          "zt-link-btn",
        );
    },
    "",
    true,
  ]);
  stories.action = ["去任务拆解", go(ctx, "schedule", "queue")];
  return [
    stories,
    taskTable(ctx, team, tasks, "团队叶子任务台账", {
      footer: "仅计叶子任务。今日到期单独显示。",
      action: ["查看排期矩阵", go(ctx, "schedule", "matrix")],
    }),
  ];
}

function developerTabs(ctx, { work, personalTasks }) {
  const recorded = unique([
    ...(work.data?.new ?? []).filter(({ name }) => name !== undefined),
    ...["overdue", "dueToday", "dueSoon", "unscheduled"].flatMap(
      (key) => work.data?.action?.[key] ?? [],
    ),
    ...(personalTasks?.data?.groups ?? []).flatMap(({ items }) => items),
  ]).filter(({ isParent }) => !isParent);
  const open = recorded.filter(({ timeState }) => timeState !== "done");
  const urgent = open.filter(({ timeState }) =>
    ["overdue", "due_today"].includes(timeState),
  );
  const footer = "展示本次读到的个人工作记录，已完成历史任务可在禅道查看。";
  const action = allowed(ctx, "get_member_schedule")
    ? ["查看我的 4 周个人排期 →", go(ctx, "schedule", "matrix")]
    : undefined;
  return [
    taskTable(
      ctx,
      personalTasks?.data ? personalTasks : work,
      open,
      "指派给我的待办",
      { footer, action },
    ),
    taskTable(ctx, work, urgent, "逾期 / 今日截止", { footer, action }),
    taskTable(
      ctx,
      personalTasks?.data ? personalTasks : work,
      recorded,
      "全部个人任务",
      { footer, action },
    ),
  ];
}

function testingTabs(ctx, { work, gate }) {
  const ready = work.data?.can_start;
  const tasks = unique([
    ...(ready?.tests ?? []),
    ...(ready?.upcomingTests ?? []),
  ]).filter(({ isParent }) => !isParent);
  const openGate =
    allowed(ctx, "get_plan_progress") && go(ctx, "release-risks", "gate");
  const release = gate?.data?.view === "release" ? gate.data : undefined;
  const serious = new Set((release?.openSeriousBugs ?? []).map(({ id }) => id));
  const bugs = unique([
    ...(release?.unlinkedSeriousBugs ?? []).map((bug) => ({
      ...bug,
      unlinked: true,
    })),
    ...[...(release?.openBugs ?? []), ...(release?.openSeriousBugs ?? [])].map(
      (bug) => ({
        ...bug,
        version: release.version,
      }),
    ),
  ]);
  return [
    taskTable(ctx, work, tasks, "版本测试任务", {
      qa: true,
      action: ["查看发布门禁", openGate],
    }),
    {
      label: "活跃 Bug 列表",
      source: gate,
      rows: bugs,
      fields: [
        choice("全部版本", bugs, (row) => row.version),
        choice(
          "全部严重级",
          bugs,
          (row) => row.severity,
          (row) => row.severity + " 级",
        ),
      ],
      search: (row) =>
        [row.id, row.title, row.version, row.severity]
          .filter(Boolean)
          .join(" "),
      columns: [
        idColumn("Bug ID"),
        ["级别", (row) => row.severity + " 级"],
        [
          "Bug 标题",
          (cell, row) => {
            externalLink(cell, row.title, row.url, "title-link-btn");
            if (!cell.textContent) cell.textContent = row.title;
          },
          "workbench-native-title",
          true,
        ],
        ["版本", (row) => row.version],
        [
          "门禁判定",
          (cell, row) => {
            if (row.unlinked) badge(cell, "版本待核对", "warn");
            else if (serious.has(row.id)) badge(cell, "高危阻断", "danger");
            else badge(cell, "活跃");
          },
          "",
          true,
        ],
      ],
      empty: gate
        ? undefined
        : "选定实际产品与版本后，在发布门禁查看真实 Bug 清单。",
      footer:
        release &&
        `${release.version} 的活跃 Bug · 未关联需求的严重 Bug 单独标明版本待核对。`,
      action: [release ? "查询其他版本" : "选择版本查看 Bug", openGate],
    },
  ];
}

function productTabs(ctx, { plan, releaseStories }) {
  const rows = plan.data?.groups ?? [];
  return [
    {
      label: "月度 L3 计划表",
      source: plan,
      rows,
      search: (row) => `模块 ${row.key ?? "未归属"}`,
      columns: [
        [
          "L3 模块",
          (row) => (row.key == null ? "未归属模块" : "模块 #" + row.key),
        ],
        ["需求数", (row) => row.total],
        ["已完成", (row) => row.counts?.completed],
        ["执行中", (row) => row.counts?.inProgress],
        ["待接收", (row) => row.counts?.toReceive],
        ["未就绪", (row) => row.counts?.notReady],
        ["完成率", (row) => valueRate(row.storyDeliveryRate)],
      ],
      footer:
        plan.data &&
        `需求交付率 ${valueRate(plan.data.storyDeliveryRate)} · 叶子任务完成率 ${valueRate(plan.data.taskCompletionRate)}`,
      action: ["查看门禁明细", go(ctx, "release-risks", "gate")],
    },
    storyTable(ctx, releaseStories, unique(releaseStories?.data?.items), {
      title: "版本需求台账",
    }),
  ];
}

function projectTabs(ctx, { risks, iteration }) {
  const rows = risks.data?.hits ?? [];
  const execution = iteration?.data;
  return [
    {
      label: "风险巡检台账",
      source: risks,
      rows,
      fields: [
        choice(
          "全部级别",
          rows,
          (hit) => hit.severity,
          (hit) => severityLabel[hit.severity],
        ),
        choice("全部规则 R01–R16", rows, (hit) => hit.rule),
        choice(
          "全部对接人",
          rows,
          (hit) => hit.owner?.account,
          (hit) => person(hit.owner),
        ),
      ],
      search: (hit) =>
        [
          hit.rule,
          hit.object.id,
          hit.object.title,
          hit.reason,
          person(hit.owner),
        ].join(" "),
      columns: [
        ["规则", (hit) => hit.rule],
        ["级别", (hit) => severityLabel[hit.severity]],
        [
          "卡点对象",
          (hit) => `#${hit.object.id} ${hit.object.title}`,
          "workbench-native-title",
        ],
        ["触发原因", (hit) => hit.reason],
        ["对接人", (hit) => person(hit.owner)],
        ["依据", (hit) => (hit.level === "inferred" ? "推测" : "记录")],
        ["操作", riskDetail(ctx), "", true],
      ],
      action: ["查看风险与例外", go(ctx, "release-risks", "risks")],
    },
    {
      label: "迭代过程监控",
      source: iteration,
      rows: execution?.executionIds?.length ? [execution] : [],
      search: (row) => row.executionIds.join(" "),
      columns: [
        ["迭代ID", (row) => row.executionIds.join("、")],
        ["需求数", (row) => new Set(row.storyIds).size],
        ["拆解及时率", (row) => valueRate(row.decompositionTimeliness)],
        ["在研逾期占比", (row) => valueRate(row.overdueRate)],
        [
          "测试流转中位耗时",
          (row) =>
            Number.isFinite(row.testCycleMedianWorkdays)
              ? row.testCycleMedianWorkdays + " 工作日"
              : "—",
        ],
      ],
      footer: "所列迭代的汇总口径。",
    },
  ];
}

const createTabs = {
  FB: feedbackTabs,
  DM: designTabs,
  DS: designTabs,
  RM: leadTabs,
  RD: developerTabs,
  QA: testingTabs,
  PM: productTabs,
  PJ: projectTabs,
};

export function renderNativeWorkbench(
  parent,
  ctx,
  reads,
  { activeTab = 0, selectTab } = {},
) {
  const tabs = createTabs[ctx.role.id](ctx, reads);
  const shell = add(
    parent,
    "section",
    undefined,
    "panel-card vp-card zt-shell",
  );
  const header = add(shell, "div", undefined, "zt-tab-bar");
  const navigation = add(header, "div", undefined, "zt-tabs-left");
  navigation.setAttribute("role", "group");
  navigation.setAttribute("aria-label", "禅道台账");
  add(header, "span", "禅道 22.6 原生风格视图", "mode-tier-badge is-zentao");
  const content = add(shell, "div", undefined, "workbench-native-content");
  const controls = tabs.map((tab, i) => {
    const control = button(
      navigation,
      undefined,
      () => {
        if (!ctx.current()) return;
        selectTab?.(i);
        switchTab(i);
      },
      "zt-tab-btn",
    );
    add(control, "span", tab.label);
    const tally = add(
      control,
      "span",
      ctx.pending ? undefined : count(tab.source, tab.rows.length),
      "zt-tab-count",
    );
    if (ctx.pending) pendingBlock(tally, "short");
    return control;
  });
  function switchTab(active) {
    if (!ctx.current()) return;
    for (const [i, control] of controls.entries()) {
      control.className = i === active ? "zt-tab-btn is-active" : "zt-tab-btn";
      control.setAttribute("aria-pressed", String(i === active));
    }
    content.replaceChildren();
    const {
      rows,
      columns,
      fields = [],
      source,
      footer,
      action,
      search = () => "",
      empty,
    } = tabs[active];
    const filters = filterControls(content, {
      fields,
      search,
      onChange: refresh,
      placeholder: "检索编号 / 标题 / 关键词…",
      native: true,
      unit: "条",
      pending: ctx.pending,
    });
    const wrap = add(content, "div", undefined, "table-wrap vp-table-scroll");
    const table = add(wrap, "table", undefined, "bzt-table zt-table");
    const head = add(add(table, "thead"), "tr");
    for (const [label] of columns)
      add(head, "th", label).setAttribute("scope", "col");
    const body = add(table, "tbody");
    if (footer || action?.[1]) {
      const foot = add(content, "div", undefined, "zt-foot-bar");
      const summary = add(foot, "div", footer);
      if (ctx.pending && !footer && ctx.role.id === "PM")
        pendingBlock(summary, "text", "workbench-pending-native-summary");
      if (action)
        button(
          add(foot, "div", undefined, "row-actions"),
          ...action,
          "btn-secondary btn-xs",
        );
    }
    if (ctx.pending) {
      for (let i = 0; i < 5; i++) {
        const row = add(body, "tr");
        for (const [label, , className] of columns) {
          const cell = add(row, "td", undefined, className);
          pendingBlock(cell, label === "操作" ? "chip" : "text");
        }
      }
      return;
    }
    function refresh() {
      const visible = rows.filter((row) => filters.matches(row));
      filters.tally(source, visible.length);
      body.replaceChildren();
      if (!visible.length) {
        const cell = add(
          add(body, "tr"),
          "td",
          empty ?? emptyText(source, "当前筛选条件下暂无记录。"),
          "workbench-native-empty",
        );
        cell.setAttribute("colspan", String(columns.length));
      }
      for (const item of visible) {
        const row = add(body, "tr");
        for (const [, read, className, render] of columns) {
          const cell = add(row, "td", undefined, className);
          if (render) read(cell, item);
          else cell.textContent = String(read?.(item) ?? "—");
        }
      }
    }
    refresh();
  }
  switchTab(activeTab);
}
