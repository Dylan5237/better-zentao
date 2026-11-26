const storyStatus = {
  draft: "草稿",
  reviewing: "评审中",
  active: "已激活",
  changing: "变更中",
  closed: "已关闭",
};
const stages = {
  design: "设计",
  review: "评审",
  handoff: "传递",
  dev: "研发",
  interface: "接口",
  test: "测试",
  acceptance: "验收",
  delivery: "交付",
};
const timeStates = {
  overdue: "逾期",
  due_today: "今天到期",
  due_soon: "临期",
  on_track: "正常",
  unscheduled: "未排期",
  done: "已完成",
};
const taskStatus = {
  wait: "未开始",
  doing: "进行中",
  pause: "已暂停",
  changed: "待确认变更",
  done: "已完成",
  closed: "已关闭",
  cancel: "已取消",
};
const bugStatus = { active: "待处理", resolved: "已解决", closed: "已关闭" };
const scopeLabels = {
  product: "产品",
  module: "模块",
  plan: "计划",
  month: "月份",
  version: "版本",
  execution: "迭代",
  team: "团队",
  members: "成员",
  people: "待查人员",
  who: "人员",
  keyword: "关键词",
  openedFrom: "登记起日",
  openedTo: "登记止日",
  storyId: "需求号",
  requirementId: "用户需求号",
  intakeId: "受理编号",
  status: "状态",
  progress: "进展",
  feedbackBy: "反馈者",
  groupBy: "分组方式",
  scope: "范围",
  view: "视图",
  groups: "工作分组",
  horizonDays: "临期工作日",
  since: "自",
  start: "查询起日",
  end: "查询止日",
  weeks: "周数",
  bucket: "排期粒度",
  newTask: "候选任务",
  estimateHours: "预估工时",
  earliestStart: "最早开始日",
  deadline: "截止日",
  skills: "技能",
  mine: "仅本人",
  rules: "规则",
  minSeverity: "最低等级",
  opId: "操作编号",
  recent: "最近操作数",
  productIds: "产品编号",
  teamIds: "团队编号",
  includeNotReady: "含未就绪明细",
  releaseDate: "发布日",
  dateSource: "发布日来源",
  storyDeliveryRate: "需求交付率",
  carryOverSource: "遗留依据",
  visibleHours: "禅道可见投入",
  decompositionTimeliness: "拆解及时性",
  overdueRate: "逾期率",
  testCycleMedianWorkdays: "测试周期中位数",
  suggestions: "候选建议",
};
const number = new Intl.NumberFormat("zh-CN", { maximumFractionDigits: 2 });
const percent = new Intl.NumberFormat("zh-CN", {
  style: "percent",
  maximumFractionDigits: 1,
});

function add(parent, tag, text, className) {
  const node = parent.ownerDocument.createElement(tag);
  if (text !== undefined) node.textContent = String(text);
  if (className) node.className = className;
  parent.append(node);
  return node;
}

function label(names, key) {
  return Object.hasOwn(names, key) ? names[key] : key;
}

function link(document, text, value) {
  if (typeof value !== "string") return null;
  let url;
  try {
    url = new URL(value);
  } catch {
    return null;
  }
  if (
    !["http:", "https:"].includes(url.protocol) ||
    url.username ||
    url.password
  )
    return null;

  const anchor = document.createElement("a");
  anchor.textContent = text;
  anchor.setAttribute("href", url.href);
  anchor.setAttribute("target", "_blank");
  anchor.setAttribute("rel", "noopener noreferrer");
  return anchor;
}

function itemLink(out, item) {
  const text = `#${item.id} ${item.title ?? item.name ?? ""}`.trim();
  return link(out.ownerDocument, text, item.url) ?? text;
}

function table(out, title, headings, rows, empty) {
  if (!rows.length && !empty) return;
  if (title) add(out, "h3", title);
  if (!rows.length) {
    add(out, "p", empty, "muted");
    return;
  }
  const wrap = add(out, "div", undefined, "table-wrap");
  const grid = add(wrap, "table", undefined, "data-table");
  const header = add(add(grid, "thead"), "tr");
  for (const heading of headings)
    add(header, "th", heading).setAttribute("scope", "col");
  const body = add(grid, "tbody");
  for (const values of rows) {
    const row = add(body, "tr");
    for (const value of values) {
      const cell = add(row, "td");
      if (value && typeof value === "object") cell.append(value);
      else
        cell.textContent =
          value === undefined || value === null || value === ""
            ? "—"
            : String(value);
    }
  }
}

function metrics(out, pairs) {
  const entries = pairs.filter(
    ([, value]) => value !== undefined && value !== null && value !== "",
  );
  if (!entries.length) return;
  const list = add(out, "dl", undefined, "metrics");
  for (const [name, value] of entries) {
    const pair = add(list, "div", undefined, "metric");
    add(pair, "dt", name);
    add(pair, "dd", value);
  }
}

function list(out, title, rows) {
  if (!rows?.length) return;
  if (title) add(out, "h3", title);
  const items = add(out, "ul");
  for (const text of rows) add(items, "li", text);
}

function prose(out, title, text) {
  if (!text) return;
  add(out, "h3", title);
  add(out, "pre", text, "read-prose");
}

function person(value) {
  if (typeof value === "string") return value;
  return value?.realname || value?.account;
}

function refs(ids) {
  return ids?.map((id) => `#${id}`).join("、");
}

function hours(value) {
  return Number.isFinite(value) ? `${number.format(value)} 小时` : undefined;
}

function rate(value) {
  if (!value || value.rate === null) return "无可用分母";
  return `${percent.format(value.rate)}（${value.numerator}/${value.denominator}）`;
}

function inferred(text, level) {
  return text && level === "inferred" ? `${text}（推测）` : text;
}

function taskRow(out, task) {
  const timing = label(timeStates, task.timeState);
  return [
    itemLink(out, task),
    inferred(label(stages, task.stage), task.stageLevel),
    person(task.assignedTo),
    label(taskStatus, task.status),
    timing && task.overdueDays
      ? `${timing} ${task.overdueDays} 工作日`
      : timing,
    task.deadline,
    hours(task.left) ?? "缺工时",
    task.execution?.name,
  ];
}

const taskColumns = [
  "任务",
  "阶段",
  "处理人",
  "禅道状态",
  "时间状态",
  "截止日",
  "剩余工时",
  "迭代",
];

function storyRow(out, story) {
  const next = [label(stages, story.nextStage), story.nextDeadline]
    .filter(Boolean)
    .join(" · ");
  return [
    itemLink(out, story),
    [story.product?.name, story.module?.path].filter(Boolean).join(" / "),
    inferred(story.progress?.value, story.progress?.level) ??
      label(storyStatus, story.status),
    person(story.maintainer),
    person(story.currentOwner),
    story.plan?.title,
    next,
  ];
}

const storyColumns = [
  "需求",
  "产品 / 模块",
  "进展",
  "状态维护人",
  "处理人",
  "计划",
  "下一步",
];

function parentRisks(out, rows = []) {
  table(
    out,
    "父级风险",
    ["父任务", "截止日", "说明"],
    rows.map(({ task, reason }) => [
      itemLink(out, task),
      task.deadline,
      reason,
    ]),
  );
}

function risks(out, rows = [], empty) {
  const severity = { high: "高", medium: "中", low: "低", info: "提示" };
  table(
    out,
    "风险明细",
    ["规则", "等级", "事项", "负责人", "命中时间", "原因", "处理建议", "豁免"],
    rows.map((risk) => [
      risk.rule,
      inferred(label(severity, risk.severity), risk.level),
      itemLink(out, risk.object),
      person(risk.owner),
      risk.since,
      risk.reason,
      risk.suggestion,
      risk.waived ? `${risk.waived.by} · ${risk.waived.reason}` : undefined,
    ]),
    empty,
  );
}

function bugs(out, title, rows = []) {
  table(
    out,
    title,
    ["缺陷", "严重程度", "状态", "关联需求"],
    rows.map((bug) => [
      itemLink(out, bug),
      bug.severity,
      label(bugStatus, bug.status),
      bug.story && `#${bug.story}`,
    ]),
  );
}

function showMyWork(out, data) {
  const rows = [
    ["新增", data.new],
    ["逾期", data.action?.overdue],
    ["今天到期", data.action?.dueToday],
    ["临期", data.action?.dueSoon],
    ["未排期", data.action?.unscheduled],
    ["待接收", data.action?.toReceive],
    ["待评审", data.action?.toReview],
    ["已指派但未就绪", data.waiting_ready],
    ["我维护的", data.maintained],
    ["我提出的", data.raised],
    ["可开测", data.can_start?.tests],
    ["即将开测", data.can_start?.upcomingTests],
    ["可验收交付", data.can_start?.acceptDeliver],
  ].flatMap(([group, items]) =>
    (items ?? []).map((item) => [
      group,
      itemLink(out, item),
      inferred(item.progress?.value, item.progress?.level) ??
        label(timeStates, item.timeState),
      person(item.assignedTo ?? item.currentOwner),
      item.deadline ?? item.nextDeadline,
      person(item.waitingFor),
    ]),
  );
  table(
    out,
    null,
    ["工作分组", "事项", "进展", "处理人", "截止日", "等候"],
    rows,
    "暂无符合条件的工作事项。",
  );
  parentRisks(out, data.parentRisks);
}

function showTeamWork(out, data) {
  metrics(out, [
    ["未完成", data.totals?.open],
    ["逾期", data.totals?.overdue],
    ["临期", data.totals?.dueSoon],
  ]);
  table(
    out,
    null,
    ["分组", ...taskColumns],
    (data.groups ?? []).flatMap(({ label, items }) =>
      items.map((task) => [label, ...taskRow(out, task)]),
    ),
    "暂无符合条件的团队任务。",
  );
  parentRisks(out, data.parentRisks);
}

function showSchedule(out, data) {
  const members = data.members ?? [];
  const periods = new Map();
  for (const member of members) {
    for (const bucket of member.buckets) periods.set(bucket.start, bucket.end);
  }
  const starts = [...periods.keys()].sort();
  const rows = members.map((member) => {
    const buckets = new Map(
      member.buckets.map((bucket) => [bucket.start, bucket]),
    );
    return [
      person(member),
      hours(member.capacityHours),
      ...starts.map((day) => {
        const bucket = buckets.get(day);
        if (!bucket) return undefined;
        const missing = bucket.missingEstimate;
        return `${hours(bucket.leftHours)} · ${bucket.taskCount} 项${missing ? ` · 缺工时 ${missing} 项` : ""}`;
      }),
    ];
  });
  table(
    out,
    "成员排期",
    [
      "成员",
      "剩余容量",
      ...starts.map((day) =>
        day === periods.get(day) ? day : `${day} 至 ${periods.get(day)}`,
      ),
    ],
    rows,
    "暂无可排期的成员。",
  );
  for (const [title, key] of [
    ["逾期任务", "overdue"],
    ["未排期任务", "unscheduled"],
  ]) {
    table(
      out,
      title,
      ["成员", ...taskColumns],
      members.flatMap((member) =>
        (member[key] ?? []).map((task) => [
          person(member),
          ...taskRow(out, task),
        ]),
      ),
    );
  }
  table(
    out,
    "候选建议",
    ["成员", "建议截止日", "理由"],
    (data.suggestions ?? []).map((row) => [
      person(row),
      row.suggestedDeadline,
      row.reason,
    ]),
  );
}

function showStories(out, data) {
  metrics(out, Object.entries(data.countsByProgress ?? {}));
  table(
    out,
    null,
    storyColumns,
    (data.items ?? []).map((row) => storyRow(out, row)),
    "暂无需求记录。",
  );
}

function showStory(out, data) {
  if (data.candidates) {
    table(
      out,
      "候选需求",
      ["需求"],
      data.candidates.map((row) => [itemLink(out, row)]),
      "暂无候选需求。",
    );
    return;
  }
  if (!data.story) {
    const sections = [
      ["实现范围", data.scope],
      ["设计引用", data.designRef],
      ["验收条件", data.verify],
    ];
    for (const [title, text] of sections) prose(out, title, text);
    table(
      out,
      "任务",
      taskColumns,
      (data.tasks ?? []).map((task) => taskRow(out, task)),
      "暂无关联任务。",
    );
    return;
  }

  const story = data.story;
  const heading = add(out, "h3");
  const title = itemLink(out, story);
  if (typeof title === "string") heading.textContent = title;
  else heading.append(title);
  metrics(out, [
    ["当前进展", inferred(data.progress?.value, data.progress?.level)],
    ["记录状态", label(storyStatus, story.status)],
    [
      "产品 / 模块",
      [story.product?.name, story.module?.path].filter(Boolean).join(" / "),
    ],
    ["计划", story.plan?.title],
    ["版本", story.version],
    [
      "下一步",
      [label(stages, story.nextStage), story.nextDeadline]
        .filter(Boolean)
        .join(" · "),
    ],
  ]);
  if (data.progress?.basis) add(out, "p", data.progress.basis, "muted");
  const people = data.people ?? {};
  metrics(out, [
    ["提出人", people.raisedBy],
    ["反馈者", people.feedbackBy],
    ["进度联系人", people.maintainer],
    ["处理人", people.currentOwner],
    ["接收人", people.receiver],
  ]);
  const steps = data.stages ?? [];
  const stageStates = {
    missing: "缺失",
    not_started: "未开始",
    doing: "进行中",
    done: "已完成",
    waived: "已豁免",
    cancelled: "已取消",
  };
  table(
    out,
    "阶段进展",
    ["阶段", "要求", "状态", "依据"],
    steps.map((step) => [
      label(stages, step.stage),
      step.required ? "必需" : "按需",
      label(stageStates, step.state),
      step.evidence?.join(" · "),
    ]),
    "暂无阶段记录。",
  );
  table(
    out,
    "任务",
    taskColumns,
    steps.flatMap(({ tasks }) => tasks.map((task) => taskRow(out, task))),
  );
  const related = data.related ?? {};
  metrics(out, [
    [
      "关联用户需求",
      refs(
        related.requirements ??
          (related.requirement ? [related.requirement] : []),
      ),
    ],
    ["配对需求", refs(related.pairs ?? (related.pair ? [related.pair] : []))],
    ["派生来源", related.derivesFrom && `#${related.derivesFrom}`],
  ]);
  bugs(out, "关联缺陷", related.bugs);
  risks(out, data.risks);
  prose(out, "进度卡片", data.card);
}

function showRisks(out, data) {
  metrics(
    out,
    (data.summary ?? []).map((row) => [`${row.rule} ${row.name}`, row.count]),
  );
  risks(out, data.hits, "当前查询未返回风险条目。");
}

function showQueue(out, data) {
  const counts = data.counts ?? {};
  const buckets = data.buckets ?? {};
  const groups = [
    ["待接收", "toReceive"],
    ["在研", "inDev"],
    ["上月遗留", "carriedOver"],
    ["有计划，未排迭代", "planNoIteration"],
    ["有迭代，缺计划", "iterationNoPlan"],
  ];
  metrics(out, [
    ["研发主池", counts.mainPool],
    ...groups.map(([name, key]) => [name, counts[key]]),
    ["未就绪", counts.notReady],
  ]);
  table(
    out,
    "本月队列",
    ["归类", ...storyColumns, "排期备注"],
    groups.flatMap(([name, key]) =>
      (buckets[key] ?? []).map((story) => [
        name,
        ...storyRow(out, story),
        groups
          .filter(([, flag]) => flag !== key && story[flag] === true)
          .map(([note]) => note)
          .join(" · "),
      ]),
    ),
    "暂无归类的研发需求。",
  );
  table(
    out,
    "未就绪",
    storyColumns,
    (data.notReady ?? []).map((story) => storyRow(out, story)),
  );
  table(
    out,
    "月底提醒",
    storyColumns,
    (data.monthEndWarnings ?? []).map((story) => storyRow(out, story)),
  );
  const source = {
    snapshot: "承诺快照",
    history: "历史记录",
    mixed: "承诺快照与历史记录",
  };
  metrics(out, [
    ["未归类需求", refs(data.unbucketedStoryIds)],
    ["缺少记录的需求", refs(data.missingStoryIds)],
    ["遗留依据", label(source, data.carryOverSource)],
  ]);
}

function showPlan(out, data) {
  metrics(out, [
    ["叶子需求", data.total],
    ["需求交付率", rate(data.storyDeliveryRate)],
    ["任务完成率", rate(data.taskCompletionRate)],
    ["计划范围", refs(data.planIds)],
  ]);
  const groups = data.groups ?? [];
  table(
    out,
    "分组进展",
    [
      "分组",
      "需求数",
      "已完成",
      "执行中",
      "待接收",
      "未就绪",
      "已取消",
      "无法判断",
      "交付率",
      "任务完成率",
    ],
    groups.map((group) => [
      group.key ?? "未归类",
      group.total,
      group.counts?.completed,
      group.counts?.inProgress,
      group.counts?.toReceive,
      group.counts?.notReady,
      group.counts?.cancelled,
      group.counts?.unknown,
      rate(group.storyDeliveryRate),
      rate(group.taskCompletionRate),
    ]),
    "暂无分组进展记录。",
  );
}

function references(out, title, groups) {
  table(
    out,
    title,
    ["类别", "编号"],
    groups
      .filter(([, ids]) => ids?.length)
      .map(([name, ids]) => [name, refs(ids)]),
  );
}

function showRelease(out, data) {
  const gate = {
    ready: "可发布",
    waiver: "例外放行",
    blocked: "发布受阻",
    unknown: "无法判断",
  };
  const dates = {
    calendar: "配置发布日历",
    release: "禅道发布记录",
    legacyPlan: "历史版本计划",
  };
  metrics(out, [
    ["版本", data.version],
    ["发布门禁", label(gate, data.gate)],
    ["测试完成率", rate(data.testCompletionRate)],
    ["未关闭的严重缺陷", data.openSeriousBugs?.length],
    ["发布日", data.releaseDate ?? "待确定"],
    ["发布日来源", label(dates, data.dateSource)],
    ["距发布工作日", data.workdaysUntilRelease],
  ]);
  list(out, null, data.flags);
  references(
    out,
    "版本需求进展",
    (data.progressGroups ?? []).map(({ progress, storyIds }) => [
      progress,
      storyIds,
    ]),
  );
  references(out, "门禁证据", [
    ["测试未完成", data.testIncompleteStoryIds],
    ["测试证据缺失", data.testEvidenceMissingStoryIds],
    ["缺少需求关联的缺陷", data.unlinkedBugIds],
    ["发布前门禁预警", data.releaseWarningStoryIds],
  ]);
  bugs(out, "未关闭缺陷", data.openBugs ?? data.openSeriousBugs);
  bugs(out, "未关联需求的严重缺陷", data.unlinkedSeriousBugs);
  table(
    out,
    "晚于发布日的任务",
    ["需求", "任务", "截止日"],
    (data.lateLeafTasks ?? []).map((row) => [
      `#${row.storyId}`,
      `#${row.taskId}`,
      row.deadline,
    ]),
  );
  table(
    out,
    "门禁例外",
    ["需求", "版本", "登记人", "原因"],
    (data.waivers ?? []).map((row) => [
      `#${row.storyId}`,
      row.version,
      row.approvedBy,
      row.reason,
    ]),
  );
}

function snapshots(out, data) {
  const missing = refs(data.missingSnapshotProductIds);
  if (data.snapshotAvailable === false || missing) {
    add(
      out,
      "p",
      missing ? `缺少承诺快照的产品 ${missing}` : "缺少承诺快照。",
      "notice",
    );
  }
  table(
    out,
    "承诺快照",
    ["产品", "采集时间", "来源"],
    (data.snapshots ?? []).map((row) => {
      const date = new Date(row.takenAt);
      return [
        `#${row.productId}`,
        Number.isNaN(date.valueOf()) ? undefined : date.toISOString(),
        row.source === "imported" ? "共享导入" : "本地采集",
      ];
    }),
  );
}

function showCommitment(out, data) {
  snapshots(out, data);
  metrics(out, [
    ["兑现", data.fulfilled?.length],
    ["顺延", data.carriedOver?.length],
    ["插入", data.inserted?.length],
  ]);
  references(out, "承诺对比", [
    ["已兑现", data.fulfilled],
    ["新增插入", data.inserted],
    ["待完成", data.pendingStoryIds],
    ["已取消", data.cancelledStoryIds],
    ["无法判断", data.unknownStoryIds],
  ]);
  table(
    out,
    "顺延原因",
    ["需求", "原因"],
    (data.carriedOver ?? []).map((row) => [
      `#${row.id}`,
      row.reason ?? "暂无记录",
    ]),
  );
}

function showIteration(out, data) {
  metrics(out, [
    ["迭代范围", refs(data.executionIds)],
    ["需求数", data.storyIds?.length],
    ["拆解及时性", rate(data.decompositionTimeliness)],
    ["逾期率", rate(data.overdueRate)],
    [
      "测试周期中位数",
      data.testCycleMedianWorkdays == null
        ? "暂无有效样本"
        : `${data.testCycleMedianWorkdays} 工作日`,
    ],
    ["测试周期样本", `${data.testCycleSampleSize ?? 0} 个样本`],
  ]);
  const visible = data.visibleHours;
  if (visible) {
    add(out, "h3", "禅道可见投入");
    metrics(out, [
      ["预估", hours(visible.estimate)],
      ["已消耗", hours(visible.consumed)],
      ["剩余", hours(visible.left)],
      ["叶子任务", visible.leafTaskCount],
      ["缺工时", visible.missingHoursTaskCount],
    ]);
  }
  table(
    out,
    "规范执行情况",
    ["负责人", "R05", "R06"],
    (data.complianceByOwner ?? []).map((row) => [
      row.owner ?? "未指派",
      row.counts.R05 ?? 0,
      row.counts.R06 ?? 0,
    ]),
  );
  const stageStatus = {
    completed: "已完成",
    in_progress: "进行中",
    cancelled: "已取消",
    missing: "缺失",
  };
  table(
    out,
    "跨产品需求对比",
    ["关联批次", ...storyColumns, "阶段"],
    (data.crossProduct ?? []).flatMap(({ stories }, index) =>
      stories.map((story) => [
        index + 1,
        ...storyRow(out, story),
        story.stages
          .map(
            ({ stage, status }) =>
              `${label(stages, stage)} ${label(stageStatus, status)}`,
          )
          .join(" · "),
      ]),
    ),
  );
  snapshots(out, data);
}

const planViews = new Map([
  ["plan", showPlan],
  ["release", showRelease],
  ["commitment", showCommitment],
  ["iteration", showIteration],
]);

function showManagement(out, data) {
  const view = planViews.get(data.view);
  if (view) view(out, data);
  else add(out, "p", "暂无计划或迭代数据。", "muted");
}

function showContext(out, data) {
  metrics(out, [
    ["当前用户", person(data.me)],
    ["产品", data.product?.name],
    ["模块", data.module?.path],
    ["设计主管", data.module?.designLead],
    ["研发主管", data.module?.devLead],
    ["测试负责人", data.module?.testLead],
    ["计划", data.plan?.title],
    ["迭代", data.execution?.name],
  ]);
  table(
    out,
    "人员",
    ["查找项", "姓名", "账号", "团队", "职责"],
    (data.people ?? []).map((row) => [
      row.input,
      row.realname,
      row.account,
      row.team,
      row.roles.join("、"),
    ]),
  );
}

function showOperations(out, data) {
  const status = {
    confirmed: "已确认",
    partial: "部分成功",
    unknown: "待核实",
    not_executed: "未执行",
    failed: "失败",
  };
  const steps = {
    done: "完成",
    skipped: "已跳过",
    failed: "失败",
    unknown: "待核实",
    pending: "待执行",
  };
  const delivery = { sent: "已发送", queued: "已排队", failed: "发送失败" };
  const rows = Array.isArray(data) ? data : [data];
  if (!rows.length) add(out, "p", "暂无操作回执。", "muted");
  for (const row of rows) {
    add(out, "h3", row.opId);
    metrics(out, [["操作状态", label(status, row.status)]]);
    table(
      out,
      "执行步骤",
      ["步骤", "操作", "状态", "禅道记录", "错误"],
      (row.steps ?? []).map((step) => [
        step.seq,
        step.action,
        label(steps, step.state),
        step.zentaoId && itemLink(out, { id: step.zentaoId, url: step.url }),
        step.error,
      ]),
    );
    table(
      out,
      "新建记录",
      ["类型", "对象"],
      (row.created ?? []).map((item) => [item.type, itemLink(out, item)]),
    );
    table(
      out,
      "企微通知",
      ["接收人", "状态"],
      (row.notified ?? []).map((receipt) => [
        receipt.target,
        label(delivery, receipt.state),
      ]),
    );
    list(out, "后续处理", row.nextActions);
  }
}

function filterText(value) {
  if (typeof value === "boolean") return value ? "是" : "否";
  if (typeof value === "number" || typeof value === "string")
    return String(value);
  if (Array.isArray(value))
    return value.map(filterText).filter(Boolean).join("、");
  if (!value || typeof value !== "object") return "";
  return Object.entries(value)
    .map(([key, field]) => {
      const rendered = filterText(field);
      return rendered ? `${label(scopeLabels, key)} ${rendered}` : "";
    })
    .filter(Boolean)
    .join(" · ");
}

const readers = new Map([
  ["resolve_context", showContext],
  ["get_my_work", showMyWork],
  ["get_team_work", showTeamWork],
  ["get_member_schedule", showSchedule],
  ["query_stories", showStories],
  ["get_story_progress", showStory],
  ["scan_workflow_risks", showRisks],
  ["get_operation", showOperations],
  ["get_plan_progress", showManagement],
  ["get_monthly_dev_queue", showQueue],
]);

export function renderRead(container, tool, result) {
  container.replaceChildren();
  if (!result?.ok) {
    add(container, "p", result?.message ?? "查询失败。", "notice");
    return;
  }

  const scope = result.scope;
  if (scope?.asOf) {
    add(
      container,
      "p",
      [`数据时间 ${scope.asOf}`, scope.timeBasis].filter(Boolean).join(" · "),
      "muted",
    );
  }
  const filters = filterText(scope?.filters);
  if (filters) add(container, "p", `查询范围 ${filters}`, "muted");
  if (result.completeness === "partial" || result.gaps?.length) {
    const notice = add(container, "div", undefined, "notice");
    add(notice, "strong", "数据不完整");
    list(
      notice,
      null,
      result.gaps?.map(({ source, reason }) => `${source} · ${reason}`),
    );
  }
  if (result.truncated)
    add(container, "p", "查询结果已截断，可缩小范围后重试。", "notice");

  const render = readers.get(tool);
  if (render && result.data != null) render(container, result.data);
  else add(container, "p", "暂无可显示的查询结果。", "muted");

  list(
    container,
    "数据依据",
    result.inferences?.map(
      ({ field, level, basis }) =>
        `${level === "inferred" ? "推测" : "记录"} · ${label(scopeLabels, field)} · ${basis}`,
    ),
  );
  list(container, "提示", result.hints);
  const links = (result.links ?? [])
    .map(({ label, url }) => link(container.ownerDocument, label, url))
    .filter(Boolean);
  if (links.length) {
    add(container, "h3", "相关链接");
    const items = add(container, "ul");
    for (const anchor of links) add(items, "li").append(anchor);
  }
}
