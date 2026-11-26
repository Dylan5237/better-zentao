import {
  bucketValue,
  commitmentList,
  gateCopy,
  gateList,
  iterationMetrics,
  l3Groups,
  metricRing,
  pairedProgress,
  progressTrack,
  queueTable,
  recommendations,
  riskList,
  scheduleMatrix,
} from "./management-skeleton.js";
import { icon } from "./meridian-icons.js";
import { permissionBanner } from "./review-page.js";
import { beginSkeleton, skeletonBlock } from "./skeleton.js";

const queueBuckets = [
  ["toReceive", "① 待接收拆解", "勾选一键建齐五阶段"],
  ["inDev", "② 在研推进中", "研发至测试阶段"],
  ["carriedOver", "③ 上月遗留", "打标不重复计数"],
  ["planNoIteration", "④ 有计划未排迭代", "需拆解挂入迭代"],
  ["iterationNoPlan", "⑤ 有迭代缺 L3 计划", "需补挂月度计划"],
];

const gateStates = {
  ready: ["pass", "绿灯通过，可以发布"],
  blocked: ["block", "红灯阻断，暂不可发布"],
  waiver: ["waived", "黄灯例外放行（已由产品管理登记）"],
  unknown: ["pending", "门禁待核实"],
};

const severityNames = { high: "高危", medium: "中", low: "低", info: "提示" };
const objectNames = {
  story: "需求",
  task: "任务",
  bug: "Bug",
  requirement: "来源需求",
};
const allowed = (ctx, tool) => ctx.role.actions.includes(tool);
const personalScope = (ctx) => ["RD", "QA"].includes(ctx.role.id);
const mineRisks = (ctx) => ["DM", "DS", "RD", "QA"].includes(ctx.role.id);
const canPlan = (ctx) => ["PM", "PJ"].includes(ctx.role.id);
const canDecompose = (ctx) =>
  ctx.role.id === "RM" && allowed(ctx, "decompose_stories");
const person = (entry) => entry?.realname || entry?.account || "暂无记录";
const reference = (ids = []) => ids.map((id) => `#${id}`).join("、");
const partial = (result) =>
  result.completeness === "partial" || Boolean(result.truncated);
const pick = (controls) =>
  Object.fromEntries(
    Object.entries(controls)
      .map(([key, node]) => [key, node.value.trim()])
      .filter(([, value]) => value !== ""),
  );

function add(parent, tag, text, classes) {
  const node = parent.ownerDocument.createElement(tag);
  if (text !== undefined) node.textContent = String(text);
  if (classes) node.className = classes;
  parent.append(node);
  return node;
}

function button(
  parent,
  label,
  action,
  classes = "btn-secondary btn-sm",
  glyph,
) {
  const node = add(parent, "button", glyph ? undefined : label, classes);
  node.type = "button";
  if (glyph) node.append(icon(glyph, 13, node.ownerDocument), label);
  if (action) node.addEventListener("click", action);
  return node;
}

function badge(parent, text, type) {
  return add(
    parent,
    "span",
    text,
    type ? `bzt-badge tone-${type}` : "bzt-badge",
  );
}

function notice(parent, text, state = "info") {
  const node = add(parent, "div", undefined, `bzt-alert tone-${state}`);
  node.append(
    icon(state === "info" ? "Info" : "TriangleAlert", 15, node.ownerDocument),
  );
  const content = add(node, "div", text);
  node.setAttribute("role", state === "danger" ? "alert" : "status");
  return content;
}

function card(parent, title, extra = "") {
  const body = add(parent, "section", undefined, `panel-card ${extra}`.trim());
  const head = add(body, "div", undefined, "panel-head");
  add(head, "h2", title, "panel-title");
  return { body, head };
}

function field(parent, name, label, options = {}) {
  const wrapper = add(parent, "label", undefined, "bzt-field management-field");
  add(wrapper, "span", label);
  const control = add(wrapper, "input", undefined, "bzt-input");
  control.name = name;
  control.type = options.type ?? "text";
  control.value = options.value ?? "";
  if (options.placeholder) control.placeholder = options.placeholder;
  if (options.required) control.required = true;
  return control;
}

function selectField(parent, label, entries) {
  const wrapper = add(parent, "label", undefined, "bzt-field management-field");
  add(wrapper, "span", label);
  const control = add(wrapper, "select", undefined, "bzt-select");
  for (const [value, title] of entries)
    add(control, "option", title).value = value;
  control.value = entries[0]?.[0] ?? "";
  return control;
}

function check(parent, label, checked = false) {
  const wrapper = add(parent, "label", undefined, "check-label");
  const control = add(wrapper, "input", undefined, "bzt-checkbox");
  control.type = "checkbox";
  control.checked = checked;
  wrapper.append(label);
  return control;
}

function submit(form, label, action) {
  const node = add(form, "button", label, "btn-primary btn-sm");
  node.type = "submit";
  form.addEventListener("submit", (event) => {
    event.preventDefault();
    void action();
  });
}

function toggleForm(parent, form, label, focus) {
  form.hidden = true;
  const toggle = button(parent, label, () => {
    form.hidden = !form.hidden;
    toggle.setAttribute("aria-expanded", String(!form.hidden));
    if (!form.hidden) focus?.focus?.();
  });
  toggle.setAttribute("aria-expanded", "false");
}

function storyButton(parent, ctx, id, label = `#${id}`, tab) {
  return allowed(ctx, "get_story_progress")
    ? button(parent, label, () => ctx.openStory(id, tab))
    : add(parent, "span", label);
}

function link(parent, label, href) {
  try {
    const url = new URL(href);
    if (
      ["http:", "https:"].includes(url.protocol) &&
      !url.username &&
      !url.password
    ) {
      const anchor = add(parent, "a", label);
      anchor.setAttribute("href", url.href);
      anchor.setAttribute("target", "_blank");
      anchor.setAttribute("rel", "noopener noreferrer");
      return anchor;
    }
  } catch {
    // A missing or invalid URL still leaves a readable reference.
  }
  return add(parent, "span", label);
}

function table(
  parent,
  columns,
  rows,
  draw,
  { wrapClass = "", tableClass = "" } = {},
) {
  const wrap = add(parent, "div", undefined, `table-wrap ${wrapClass}`.trim());
  const tableElement = add(
    wrap,
    "table",
    undefined,
    `bzt-table ${tableClass}`.trim(),
  );
  const headings = add(add(tableElement, "thead"), "tr");
  for (const label of columns) {
    const heading = add(
      headings,
      "th",
      Array.isArray(label) ? label[0] : label,
    );
    heading.setAttribute("scope", "col");
    if (Array.isArray(label)) {
      const [, short, full] = label;
      add(heading, "div", short, "th-sub mono");
      heading.setAttribute("aria-label", label[0] + " · " + full);
    }
  }
  const body = add(tableElement, "tbody");
  for (const row of rows) draw(add(body, "tr"), row);
  return body;
}

function item(list, title, description) {
  const row = add(list, "div", undefined, "item-row");
  const main = add(row, "div", undefined, "item-row-main");
  const heading = add(main, "div", title, "item-row-title");
  if (description) add(main, "div", description, "item-row-sub");
  return { row, main, heading };
}

function showGaps(parent, report) {
  if (!partial(report)) return;
  const banner = notice(parent, undefined, "warn");
  const message =
    report.completeness === "partial"
      ? "部分数据未读取，当前结果仅涵盖已获取的记录。"
      : "查询结果已截断，可缩小范围后重试。";
  add(banner, "strong", message);
  if (report.gaps?.length) {
    const list = add(banner, "ul");
    for (const { source, reason } of report.gaps)
      add(list, "li", `${source} · ${reason}`);
  }
  if (report.completeness === "partial" && report.truncated)
    add(banner, "span", "查询结果也有截断。");
}

const scopeNames = {
  month: "月份",
  product: "产品",
  team: "团队",
  teamIds: "团队",
  members: "成员",
  module: "模块",
  version: "版本",
  plan: "计划",
  start: "开始",
  end: "截止",
};

function showEvidence(parent, report, title = "统计口径与数据依据") {
  const { scope, inferences, hints, links } = report;
  const details = add(parent, "details", undefined, "management-evidence");
  add(details, "summary", title);
  if (scope?.asOf) add(details, "p", `数据时间 ${scope.asOf}`);
  if (scope?.timeBasis) add(details, "p", scope.timeBasis);
  const filters = Object.entries(scope?.filters ?? {})
    .filter(([key, value]) => Object.hasOwn(scopeNames, key) && value != null)
    .map(([key, value]) => `${scopeNames[key]} ${value}`);
  if (filters.length) add(details, "p", filters.join(" · "));
  for (const evidence of inferences ?? [])
    add(
      details,
      "p",
      `${evidence.level === "inferred" ? "推测" : "记录"} · ${evidence.basis}`,
    );
  for (const hint of hints ?? []) add(details, "p", hint);
  for (const entry of links ?? [])
    link(add(details, "p"), entry.label, entry.url);
}

function loading(output, ctx, load, draw, pending) {
  let serial = 0;
  let finishPrevious;
  return async (input) => {
    if (!ctx.current()) return;
    const attempt = ++serial;
    const current = () => ctx.current() && serial === attempt;
    finishPrevious?.();
    output.replaceChildren();
    const placeholders = [];
    const finish = () => {
      for (const stop of placeholders) stop();
      if (finishPrevious === finish) finishPrevious = undefined;
    };
    finishPrevious = finish;
    const mount = (target, scene) => {
      const stop = beginSkeleton(target, scene, { signal: ctx.signal, current });
      placeholders.push(stop);
      return stop;
    };
    try {
      let result;
      try {
        pending(mount, input);
        result = await load(input);
      } finally {
        finish();
      }
      if (!current()) return;
      output.replaceChildren();
      draw(result, input);
    } catch (error) {
      if (!current()) return;
      output.replaceChildren();
      notice(output, error?.message || "查询失败，请重新查询。", "danger");
      if (error?.details?.candidates?.length) {
        const list = add(output, "ul", undefined, "page-sub");
        for (const candidate of error.details.candidates) {
          const label =
            typeof candidate === "string"
              ? candidate
              : [
                  candidate?.name ?? candidate?.realname,
                  candidate?.id ?? candidate?.account,
                ]
                  .filter(Boolean)
                  .join(" · ");
          if (label) add(list, "li", label);
        }
      }
    }
  };
}

function reportTool(ctx, tool) {
  return async (input) => {
    const result = await ctx.call(tool, input);
    if (!result?.ok) throw new Error(result?.message ?? "查询未返回结果。");
    return result;
  };
}

function mountTabs(
  container,
  ctx,
  { title, subtitle, access, readOnly, banner },
  tabs,
  initial,
) {
  container.replaceChildren();
  const page = add(container, "div", undefined, "bzt-page management-page");
  const head = add(page, "header", undefined, "page-head");
  const intro = add(head, "div");
  const titleRow = add(intro, "div", undefined, "page-title-row");
  add(titleRow, "h1", title, "page-title");
  add(titleRow, "span", access, readOnly ? "perm-badge-ro" : "perm-badge-edit");
  add(intro, "p", subtitle, "page-sub");
  const tabsBar = add(head, "div", undefined, "segmented-tabs");
  tabsBar.setAttribute("aria-label", title);
  tabsBar.setAttribute("role", "group");
  if (banner) permissionBanner(page, banner, access);
  const body = add(page, "div", undefined, "management-tab-body");
  const buttons = new Map();
  const panels = new Map();
  function activate(id, options = {}) {
    if (!ctx.current()) return;
    const [, , draw] = tabs.find(([key]) => key === id);
    for (const [key, control] of buttons) {
      control.className = `seg-tab${key === id ? " is-active" : ""}`;
      control.setAttribute("aria-pressed", String(key === id));
    }
    const panel = panels.get(id);
    if (panel) {
      body.replaceChildren(panel);
      return;
    }
    body.replaceChildren();
    const fresh = add(body, "div", undefined, "management-section");
    panels.set(id, fresh);
    draw(fresh, ctx, options, {
      activate,
      label: (text) => {
        buttons.get(id).textContent = text;
      },
    });
  }
  for (const [id, label, , glyph] of tabs)
    buttons.set(
      id,
      button(tabsBar, label, () => activate(id), "seg-tab", glyph),
    );
  const first = tabs.find(([id]) => id === initial.tab) ?? tabs[0];
  activate(first[0], initial);
}

function showDecompose(parent, ctx, selection, close) {
  const form = add(
    parent,
    "form",
    undefined,
    "panel-card is-highlight-card decompose-drawer-card management-decompose",
  );
  const head = add(form, "div", undefined, "panel-head");
  const heading = add(head, "div");
  add(heading, "h2", "批量拆解配置", "panel-title");
  add(heading, "p", "一次建齐阶段任务，计划日期按规范默认。", "panel-sub");
  button(head, "收起", close, "btn-ghost btn-sm");
  const toggles = add(form, "div", undefined, "decompose-opts-bar");
  const interfaceStage = check(toggles, "含【接口】阶段");
  const delivery = check(toggles, "含【交付】阶段");
  const notify = check(toggles, "拆完通过企微通知负责人", true);
  const selected = add(form, "div", undefined, "management-selection");
  const rows = table(
    form,
    ["配置范围", "研发负责人", "研发截止日（系统默认）", "测试负责人"],
    [],
    undefined,
    { wrapClass: "vp-table-scroll" },
  );
  const shared = add(rows, "tr");
  add(shared, "td", "所选需求共用");
  const dev = field(add(shared, "td"), "devAssignee", "研发负责人", {
    placeholder: "姓名或账号",
  });
  const deadline = field(add(shared, "td"), "devDeadline", "研发截止日", {
    type: "date",
  });
  const test = field(add(shared, "td"), "testAssignee", "测试负责人", {
    placeholder: "留空按规则匹配",
  });
  function input() {
    const assignees = pick({ dev, test });
    const include = {};
    if (interfaceStage.checked) include.interface = true;
    if (delivery.checked) include.delivery = true;
    return {
      storyIds: selection().map(({ id }) => id),
      template: "feature",
      ...(Object.keys(assignees).length && { assignees }),
      ...(deadline.value && { dates: { dev: { deadline: deadline.value } } }),
      ...(Object.keys(include).length && { include }),
      notify: notify.checked,
    };
  }
  const footer = add(form, "div", undefined, "form-footer-bar");
  add(footer, "span", "有不同安排的需求可逐条配置。", "form-footer-note");
  const actions = add(footer, "div", undefined, "row-actions");
  button(actions, "更多配置", () => ctx.openTool("decompose_stories", input()));
  const preview = add(actions, "button", "生成执行预览", "btn-primary");
  preview.type = "submit";
  form.addEventListener("submit", (event) => {
    event.preventDefault();
    if (selection().length && ctx.current())
      ctx.openTool("decompose_stories", input(), { preview: true });
  });
  return () => {
    selected.replaceChildren();
    for (const s of selection())
      badge(selected, `#${s.id} ${s.title}`, "primary");
  };
}

function storyTable(parent, rows, ctx, selected, changed, chooseOne) {
  table(
    parent,
    ["需求标题", "接收研发主管", "当前进展", "操作"],
    rows,
    (tr, story) => {
      const name = add(add(tr, "td"), "div", undefined, "ledger-title-row");
      if (selected) {
        const checkbox = add(name, "input", undefined, "bzt-checkbox");
        checkbox.type = "checkbox";
        checkbox.checked = selected.has(story.id);
        checkbox.setAttribute("aria-label", `选择需求 #${story.id}`);
        checkbox.addEventListener("change", () => {
          if (checkbox.checked) selected.add(story.id);
          else selected.delete(story.id);
          changed();
        });
      }
      add(name, "span", `#${story.id}`, "mono req-id");
      if (allowed(ctx, "get_story_progress"))
        button(
          name,
          story.title,
          () => ctx.openStory(story.id),
          "title-link-btn",
        );
      else add(name, "span", story.title, "ledger-title");
      if (story.carriedOver) badge(name, "上月遗留", "purple");
      add(tr, "td", person(story.receiver));
      badge(
        add(tr, "td"),
        `${story.progress.value}${story.progress.level === "inferred" ? " · 推测" : ""}`,
        "primary",
      );
      const actions = add(
        add(tr, "td"),
        "div",
        undefined,
        "row-actions is-end",
      );
      storyButton(actions, ctx, story.id, "详情");
      if (chooseOne)
        button(
          actions,
          "拆解",
          () => chooseOne(story.id),
          "btn-primary btn-xs",
        );
    },
    { wrapClass: "vp-table-scroll" },
  );
}

function drawQueue(toolbar, output, ctx, report, query, mount) {
  const { buckets, counts, notReady = [], monthEndWarnings = [] } =
    report?.data ?? {};
  if (report) {
    showGaps(output, report);
    ctx.setBadge?.("schedule", partial(report) ? 0 : buckets.toReceive.length);
  }
  const deck = add(output, "div", undefined, "bucket-strip");
  const area = add(
    output,
    "div",
    undefined,
    "management-section management-queue-card",
  );
  const config = add(output, "div", undefined, "management-config");
  const selection = new Set();
  const stories = () => buckets.toReceive.filter(({ id }) => selection.has(id));
  const mayDecompose = canDecompose(ctx);
  const allBucketRows = Math.max(
    1,
    buckets ? queueBuckets.reduce((sum, [id]) => sum + buckets[id].length, 0) : 0,
  );
  let updateSelection;
  let batch;
  let active = "toReceive";
  function closeConfig() {
    config.replaceChildren();
    updateSelection = undefined;
  }
  function openConfig() {
    if (!selection.size) return;
    config.replaceChildren();
    updateSelection = showDecompose(config, ctx, stories, closeConfig);
    updateSelection();
  }
  function changed() {
    batch.textContent = `一键建齐阶段任务 (${selection.size})`;
    batch.disabled = !selection.size;
    if (selection.size) updateSelection?.();
    else closeConfig();
  }
  function chooseOne(id) {
    selection.clear();
    selection.add(id);
    paint();
    openConfig();
  }
  function paint() {
    deck.replaceChildren();
    area.replaceChildren();
    for (const [id, label, hint] of queueBuckets) {
      const selected = active === id;
      const control = button(
        deck,
        undefined,
        () => {
          active = id;
          closeConfig();
          paint();
        },
        `bucket-card${selected ? " is-active" : ""}`,
      );
      control.setAttribute("aria-pressed", String(selected));
      control.disabled = Boolean(mount);
      const count = buckets?.[id].length;
      add(control, "div", label, "bucket-label");
      const value = add(control, "div", count, "bucket-num tabular");
      add(control, "div", hint, "bucket-hint");
      const meter = add(control, "div", undefined, "bucket-meter");
      meter.setAttribute("aria-hidden", "true");
      if (mount) {
        mount(value, bucketValue);
        mount(meter, progressTrack);
      } else {
        const fill = add(meter, "div", undefined, "bucket-meter-fill");
        fill.style.width = `${count ? Math.max(5, Math.round((count / allBucketRows) * 100)) : 0}%`;
      }
    }
    const [id, label] = queueBuckets.find(([key]) => key === active);
    const { body, head } = card(area, label, "vp-card");
    const actions = add(head, "div", undefined, "row-actions");
    if (!mayDecompose)
      add(
        actions,
        "span",
        "仅研发主管可执行拆解 / 挪月 / 清理",
        "readonly-muted-note",
      );
    if (mayDecompose && allowed(ctx, "reschedule_story"))
      button(actions, "月底挪月留痕", () =>
        ctx.openTool("reschedule_story", {
          ...(id === "toReceive" &&
            selection.size && {
              storyIds: stories().map((s) => s.id),
            }),
        }),
      ).disabled = Boolean(mount);
    if (mayDecompose && allowed(ctx, "close_stories"))
      button(actions, "清理历史任务", () =>
        ctx.openTool("close_stories", {
          mode: "cleanup",
          cleanup: {
            classes: ["A"],
            ...(query.team && { scope: { team: query.team } }),
          },
        }),
      ).disabled = Boolean(mount);
    const selectable = id === "toReceive" && mayDecompose;
    if (selectable) {
      batch = button(actions, "", openConfig, "btn-primary btn-sm");
      changed();
    }
    const rows = buckets?.[id];
    if (mount)
      mount(add(body, "div", undefined, "management-pending-table"), queueTable);
    else if (rows.length)
      storyTable(
        body,
        rows,
        ctx,
        selectable ? selection : undefined,
        changed,
        selectable ? chooseOne : undefined,
      );
    else
      add(
        body,
        "p",
        partial(report) ? "已读取记录中，该分组暂无条目。" : "该分组当前为空。",
        "empty-inline",
      );
  }
  paint();
  if (!report) return;
  if (notReady.length) {
    const extra = add(output, "section", undefined, "panel-card");
    extra.hidden = true;
    add(
      add(extra, "div", undefined, "panel-head"),
      "h2",
      `未就绪需求（${notReady.length} 条）`,
      "panel-title",
    );
    storyTable(extra, notReady, ctx);
    const pill = add(toolbar, "div", undefined, "isolated-pill");
    const toggle = button(
      pill,
      `已自动隔离 ${notReady.length} 条未就绪草稿（不混入研发待办）`,
      () => {
        extra.hidden = !extra.hidden;
        toggle.setAttribute("aria-expanded", String(!extra.hidden));
        if (!extra.hidden) extra.scrollIntoView?.({ block: "nearest" });
      },
      "link-inline",
      "TriangleAlert",
    );
    toggle.setAttribute("aria-expanded", "false");
    const misplaced = notReady.find(
      ({ maintainer, assignedTo }) =>
        maintainer?.account &&
        assignedTo?.account &&
        maintainer.account !== assignedTo.account,
    );
    if (mayDecompose && misplaced && allowed(ctx, "assign_story"))
      button(
        pill,
        `退回 #${misplaced.id}`,
        () =>
          ctx.openTool("assign_story", {
            storyIds: [misplaced.id],
            to: misplaced.maintainer.account,
          }),
        "link-inline",
      );
  }
  if (monthEndWarnings.length) {
    const { body } = card(output, "月底提醒 · 阶段任务未开始");
    storyTable(body, monthEndWarnings, ctx);
  }
  const source = {
    snapshot: "承诺快照",
    history: "历史记录推测",
    mixed: "承诺快照与历史记录",
  };
  add(
    output,
    "p",
    [
      `研发主池 ${counts.mainPool} 条`,
      counts.unbucketed
        ? `未归类 ${counts.unbucketed} 条 ${reference(report.data.unbucketedStoryIds)}`
        : "",
      counts.missing
        ? `缺少记录 ${counts.missing} 条 ${reference(report.data.missingStoryIds)}`
        : "",
      report.data.carryOverSource
        ? `上月遗留依据 ${source[report.data.carryOverSource]}`
        : "",
    ]
      .filter(Boolean)
      .join(" · "),
    "page-sub",
  );
  showEvidence(output, report);
}

function queue(parent, ctx, initial) {
  if (
    ["DM", "DS"].includes(ctx.role.id) &&
    allowed(ctx, "decompose_stories") &&
    (initial.storyId || initial.tab === "design")
  ) {
    designTasks(parent, ctx, initial);
    return;
  }
  if (!canDecompose(ctx))
    permissionBanner(
      parent,
      "当前角色为只读查看：批量拆解阶段任务、退回误指派草稿、月底挪月及历史任务清理仅研发主管（RM）可执行。",
    );
  if (!allowed(ctx, "get_monthly_dev_queue")) {
    notice(parent, "当前职责没有读取本月研发队列的权限。");
    return;
  }
  const toolbar = add(parent, "div", undefined, "toolbar-row");
  const teamTabs = add(toolbar, "div", undefined, "segmented-tabs");
  const end = add(toolbar, "div", undefined, "row-actions");
  const isolation = add(end, "div", undefined, "management-isolation");
  const form = add(parent, "form", undefined, "management-toolbar");
  const month = field(form, "month", "月份", {
    type: "month",
    value: initial.month,
  });
  const team = field(form, "team", "团队", {
    value: initial.team,
    placeholder: "名称或代号",
  });
  const output = add(parent, "div", undefined, "management-section");
  const run = loading(
    output,
    ctx,
    reportTool(ctx, "get_monthly_dev_queue"),
    (result, input) => drawQueue(isolation, output, ctx, result, input),
    (mount, input) => {
      isolation.replaceChildren();
      drawQueue(isolation, output, ctx, undefined, input, mount);
    },
  );
  const teams = ctx.developmentTeams ?? [];
  const tabs = [["", "默认研发组"], ...teams.map(({ id, name }) => [id, name])];
  const controls = new Map();
  const refresh = () => {
    for (const [id, control] of controls) {
      const active = id === team.value.trim();
      control.className = `seg-tab${active ? " is-active" : ""}`;
      control.setAttribute("aria-pressed", String(active));
    }
    return run({ ...pick({ month, team }), includeNotReady: true });
  };
  for (const [id, name] of tabs)
    controls.set(
      id,
      button(
        teamTabs,
        name,
        () => {
          team.value = id;
          void refresh();
        },
        "seg-tab",
      ),
    );
  submit(form, "查询月度队列", refresh);
  if (teams.length) toggleForm(end, form, "筛选月份与团队", month);
  void refresh();
}

function hoursText(value) {
  return String(Math.round(value * 100) / 100);
}

function drawMatrix(output, report, self) {
  const members = report.data.members;
  if (!members.length) {
    add(output, "p", "暂无可展示的成员排期。", "empty-inline");
    return;
  }
  const periods = [
    ...new Map(
      members.flatMap((member) =>
        member.buckets.map(({ start, end }) => [start, end]),
      ),
    ),
  ].sort(([a], [b]) => a.localeCompare(b));
  const headings = [
    self ? "本人" : "成员",
    ...periods.map(([start, end], index) => [
      `第 ${index + 1} 周`,
      `${start.slice(5)} ~ ${end.slice(5)}`,
      `${start} 至 ${end}`,
    ]),
    "逾期",
    "未排期",
  ];
  const grid = table(output, headings, [], undefined, {
    wrapClass: "vp-table-scroll",
    tableClass: "heatmap-table",
  });
  for (const member of members) {
    const row = add(grid, "tr", undefined, "is-clickable");
    const memberHeader = add(row, "th");
    memberHeader.setAttribute("scope", "row");
    const identity = add(memberHeader, "div", undefined, "member-cell");
    const load = member.buckets.reduce(
      (total, { leftHours }) => total + leftHours,
      0,
    );
    const capacity = Math.max(0, load + member.capacityHours);
    const missing = member.buckets.reduce(
      (total, { missingEstimate }) => total + missingEstimate,
      0,
    );
    const toggle = button(
      identity,
      person(member),
      () => {
        details.hidden = !details.hidden;
        toggle.setAttribute("aria-expanded", String(!details.hidden));
      },
      "link-inline",
      "ChevronDown",
    );
    toggle.setAttribute("aria-expanded", String(self));
    add(
      identity,
      "span",
      `4 周已排 ${hoursText(load)}h / 总容量 ${hoursText(capacity)}h`,
      "ledger-sub",
    );
    if (missing) badge(identity, `缺工时 ${missing}`, "warn");
    const weeklyCapacityReference = periods.length
      ? capacity / periods.length
      : 0;
    const byStart = new Map(
      member.buckets.map((period) => [period.start, period]),
    );
    for (const [start] of periods) {
      const cell = add(row, "td", undefined, "heat-td");
      const slot = byStart.get(start);
      if (!slot) {
        cell.textContent = "—";
        continue;
      }
      // 排期契约只返回成员的四周总容量，颜色按周均参考，不推定每周实际可用工时。
      const ratio =
        weeklyCapacityReference > 0
          ? slot.leftHours / weeklyCapacityReference
          : 0;
      const tone =
        ratio > 1
          ? "over"
          : ratio >= 0.75
            ? "warn"
            : ratio > 0
              ? "balanced"
              : "cool";
      const heat = add(cell, "div", undefined, "heat-cell is-" + tone);
      add(heat, "div", `${hoursText(slot.leftHours)}h`, "heat-hrs tabular");
      add(
        heat,
        "div",
        `${slot.taskCount} 项${slot.missingEstimate ? ` · 缺工时 ${slot.missingEstimate}` : ""}`,
        "heat-rem",
      );
    }
    badge(
      add(row, "td"),
      member.overdue.length,
      member.overdue.length ? "danger" : "muted",
    );
    badge(
      add(row, "td"),
      member.unscheduled.length,
      member.unscheduled.length ? "warn" : "muted",
    );
    const details = add(grid, "tr", undefined, "heat-expand-row");
    details.hidden = !self;
    const detailCell = add(details, "td");
    detailCell.colSpan = headings.length;
    const tasks = add(detailCell, "div", undefined, "member-tasks-box");
    for (const [key, label] of [
      ["overdue", "逾期任务"],
      ["unscheduled", "未排期任务"],
    ]) {
      add(tasks, "strong", `${label}（${member[key].length} 项）`);
      for (const task of member[key]) {
        const taskRow = add(tasks, "div", undefined, "member-task-item");
        link(taskRow, `#${task.id} ${task.name}`, task.url);
        add(
          taskRow,
          "span",
          [
            task.deadline,
            task.left === undefined ? "缺工时" : `${hoursText(task.left)}h`,
          ]
            .filter(Boolean)
            .join(" · "),
          "member-task-meta",
        );
      }
    }
  }
}

function locked(parent, title, body) {
  const panel = add(parent, "section", undefined, "perm-locked-panel");
  const badge = add(panel, "div", undefined, "perm-locked-icon");
  badge.append(icon("ShieldCheck", 20, badge.ownerDocument));
  add(panel, "h3", title);
  add(panel, "p", body);
  return panel;
}

function matrix(parent, ctx, initial, tabs) {
  const self = personalScope(ctx);
  if (!allowed(ctx, "get_member_schedule")) {
    const panel = locked(
      parent,
      "研发工时热力矩阵仅向主管与管理层开放",
      "工作量用于安排排期。当前职责可在月度队列查看需求的排期归属。",
    );
    button(panel, "返回本月待研发队列", () => tabs.activate("queue"));
    return;
  }

  const scope = add(
    parent,
    "div",
    undefined,
    "bzt-alert tone-info management-schedule-scope",
  );
  scope.append(icon("Info", 15, scope.ownerDocument));
  add(
    scope,
    "span",
    self
      ? `个人排期视角（N16 隐私保护）：仅展示本人（${ctx.displayName ?? ctx.account}）未来 4 周排期与叶子任务。`
      : "口径说明（N16）：统计禅道可见的叶子任务。颜色按 4 周容量的周均值参考，最终指派由研发主管决定。",
  );
  const teams =
    ctx.developmentTeams?.filter(({ members }) => members.length) ?? [];
  const query = add(
    parent,
    "form",
    undefined,
    "management-toolbar management-matrix-query",
  );
  const team =
    !self && teams.length
      ? selectField(scope, "团队", [
          ["", "默认团队"],
          ...teams.map(({ id, name }) => [id, name]),
        ])
      : undefined;
  if (team && initial.team) team.value = initial.team;
  const members = self
    ? undefined
    : field(query, "members", "成员账号", {
        value: Array.isArray(initial.members)
          ? initial.members.join("、")
          : initial.members,
        placeholder: "可输入多个账号",
      });
  const alerts = add(parent, "div", undefined, "management-config");
  const split = add(
    parent,
    "div",
    undefined,
    `matrix-split vp-fill${self ? " is-single" : ""}`,
  );
  const left = card(
    split,
    self ? "我的未来 4 周个人排期负荷" : "未来 4 周成员工时热力矩阵",
    "vp-card",
  );
  const output = add(left.body, "div", undefined, "management-matrix-output");
  const refresh = (newTask) => {
    const teamMembers =
      teams.find(({ id }) => id === team?.value)?.members ?? [];
    const fromField =
      members?.value
        .trim()
        .split(/[\s,，、]+/u)
        .filter(Boolean) ?? [];
    const accounts = self
      ? [ctx.account]
      : [...new Set(fromField.length ? fromField : teamMembers)];
    return run({
      weeks: 4,
      bucket: "week",
      ...(accounts.length && { members: accounts }),
      ...(!self && newTask && { newTask }),
    });
  };
  submit(query, "查询排期", () => refresh());
  if (team) toggleForm(scope, query, "筛选成员", members);
  if (self) query.hidden = true;
  team?.addEventListener("change", () => {
    members.value = "";
    void refresh();
  });
  let acceptSuggestions = true;
  let finishSuggestions;
  const suggestions = self
    ? undefined
    : suggestionPanel(split, initial, refresh, () => {
        acceptSuggestions = false;
        finishSuggestions?.();
      });
  const run = loading(
    output,
    ctx,
    reportTool(ctx, "get_member_schedule"),
    (report, input) => {
      showGaps(alerts, report);
      const visible = self
        ? {
            ...report,
            data: {
              ...report.data,
              members: report.data.members.filter(
                ({ account }) => account === ctx.account,
              ),
            },
          }
        : report;
      drawMatrix(output, visible, self);
      showEvidence(output, report);
      if (!suggestions || !acceptSuggestions) return;
      suggestions.replaceChildren();
      const candidates = report.data.suggestions ?? [];
      if (candidates.length) {
        candidates.forEach((entry, index) => {
          const { heading } = item(
            suggestions,
            `${index + 1}. ${person(entry)}`,
            entry.reason,
          );
          badge(heading, `建议截止日 ${entry.suggestedDeadline}`, "primary");
        });
      } else {
        const empty = !input.newTask
          ? "填写预估工时后试算。"
          : partial(report)
            ? "排期数据不完整，暂时无法生成可靠推荐。"
            : "当前暂无人选建议。";
        add(suggestions, "p", empty, "empty-inline");
      }
    },
    (mount, input) => {
      alerts.replaceChildren();
      mount(output, (doc) => scheduleMatrix(doc, self));
      if (!suggestions) return;
      acceptSuggestions = true;
      suggestions.replaceChildren();
      if (input.newTask) finishSuggestions = mount(suggestions, recommendations);
      else add(suggestions, "p", "填写预估工时后试算。", "empty-inline");
    },
  );
  void refresh(initial.newTask);
}

function suggestionPanel(parent, initial, refresh, invalidate) {
  const right = card(parent, "临时任务推荐谁？", "vp-card");
  badge(right.head, "前 3 推荐", "primary");
  const trial = add(
    right.body,
    "form",
    undefined,
    "form-grid management-suggest",
  );
  const estimate = field(trial, "estimateHours", "预估工时 (h)", {
    type: "number",
    value: initial.newTask?.estimateHours,
    required: true,
  });
  estimate.min = "0";
  estimate.step = "any";
  const deadline = field(trial, "deadline", "期望截止日", {
    type: "date",
    value: initial.newTask?.deadline,
  });
  const suggestions = add(right.body, "div", undefined, "item-list vp-scroll");
  add(
    right.body,
    "p",
    "系统提供推荐和理由，由主管决定是否指派。",
    "panel-footnote",
  );
  submit(trial, "试算人选", () => {
    const estimateHours = Number(estimate.value);
    if (!Number.isFinite(estimateHours) || estimateHours <= 0) {
      invalidate();
      suggestions.replaceChildren();
      notice(suggestions, "请填写大于 0 的预估工时。", "warn");
      return;
    }
    return refresh({
      estimateHours,
      ...(deadline.value && { deadline: deadline.value }),
    });
  });
  return suggestions;
}

function designTasks(parent, ctx, initial) {
  const { body, head } = card(parent, "建齐设计阶段任务");
  add(
    body,
    "p",
    "为设计类需求一次配置【设计】【评审】【传递】。计划起止按规范默认，可在操作预览前调整。",
    "page-sub",
  );
  button(
    head,
    "配置设计阶段任务",
    () =>
      ctx.openTool("decompose_stories", {
        template: "design",
        ...(initial.storyId && { storyIds: [initial.storyId] }),
      }),
    "btn btn-primary btn-sm",
  );
}

export function renderSchedule(container, ctx, initial = {}) {
  const self = personalScope(ctx);
  const canWrite = canDecompose(ctx);
  const tabs = [
    ["queue", "本月待研发与批量拆解", queue, "Layers"],
    [
      "matrix",
      self ? "我的 4 周个人排期" : "4 周排期热力矩阵与临时指派",
      matrix,
      "Users",
    ],
  ];
  mountTabs(
    container,
    ctx,
    {
      title: "拆解与排期",
      subtitle: self
        ? "查看本月待研发队列，并在「我的 4 周个人排期」查看本人负荷与叶子任务（N16 隐私保护）"
        : "一站式建齐【研发】【接口】【测试】【验收】【交付】任务，看清未来 4 周成员可用容量",
      access: canWrite ? "可操作（研发主管）" : "只读查看",
      readOnly: !canWrite,
    },
    tabs,
    initial,
  );
}

function rateText(metric) {
  if (!metric || metric.rate === null) return "暂无可算比例";
  return `${hoursText(metric.rate * 100)}%（${metric.numerator} / ${metric.denominator}）`;
}

function bugRows(parent, bugs, ctx) {
  const rows = add(parent, "div", undefined, "item-list vp-scroll");
  for (const bug of bugs) {
    const { row, heading } = item(rows);
    badge(heading, `${bug.severity} 级`, "danger");
    link(heading, `#${bug.id} ${bug.title}`, bug.url);
    if (bug.story) storyButton(row, ctx, bug.story, `关联需求 #${bug.story}`);
  }
}

function reviewReleaseException(parent, ctx, ids, close) {
  const { body, head } = card(parent, "登记发布门禁例外");
  button(head, "收起", close);
  add(
    body,
    "p",
    "选择本版本的阻断需求，逐条登记原因。确认回执后，可重新查询门禁。",
    "page-sub",
  );
  const actions = add(body, "div", undefined, "management-toolbar");
  const choices = selectField(
    actions,
    "关联需求",
    ids.map((id) => [String(id), `需求 #${id}`]),
  );
  button(
    actions,
    "填写例外原因",
    () => {
      if (ctx.current())
        ctx.openTool("set_story_meta", {
          storyId: Number(choices.value),
          waiver: { rule: "R13" },
        });
    },
    "btn btn-warn btn-sm",
  );
}

function showGate(output, ctx, report, mount) {
  if (report) showGaps(output, report);
  const data = report?.data;
  const actual = !data
    ? "unknown"
    : partial(report) && ["ready", "waiver"].includes(data.gate)
      ? "unknown"
      : data.gate;
  const [type, status] = gateStates[actual];
  const hero = add(output, "div", undefined, `gate-hero is-${type}`);
  const left = add(hero, "div", undefined, "gate-hero-left");
  add(left, "span", undefined, `traffic-lamp is-${type}`).setAttribute(
    "aria-hidden",
    "true",
  );
  const intro = add(left, "div", undefined, "management-gate-intro");
  const heading = mount
    ? undefined
    : add(
        intro,
        "h2",
        data ? `${data.version} 发布门禁：${status}` : "选择产品与发布版本",
        "gate-title",
      );
  const incomplete = data?.testIncompleteStoryIds ?? [];
  const missing = new Set(data?.testEvidenceMissingStoryIds ?? []);
  const bugs = data?.openSeriousBugs ?? [];
  if (data) {
    const dates = {
      calendar: "配置发布日历",
      release: "禅道发布记录",
      legacyPlan: "历史版本计划",
    };
    const days = data.workdaysUntilRelease;
    const date = data.releaseDate
      ? `${data.releaseDate}${data.dateSource ? `（${dates[data.dateSource]}）` : ""}`
      : "待确定";
    const rate = data.testCompletionRate;
    add(
      intro,
      "p",
      [
        `发布日 ${date}`,
        days != null
          ? days < 0
            ? `已过 ${-days} 个工作日`
            : `距发布日 ${days} 个工作日`
          : "",
        `测试完成 ${rate.numerator} / ${rate.denominator}`,
        `未关 1–2 级 Bug ${bugs.length} 条`,
        `超发布日任务 ${data.lateLeafTasks?.length ?? 0} 条`,
      ]
        .filter(Boolean)
        .join(" · "),
      "gate-sub",
    );
    for (const flag of data.flags ?? []) badge(heading, flag, "danger");
    for (const entry of data.waivers)
      add(
        intro,
        "p",
        `#${entry.storyId} 例外原因 ${entry.reason} · 登记人 ${entry.approvedBy}`,
        "gate-waiver-note",
      );
  } else if (mount) {
    mount(intro, gateCopy);
  } else {
    add(intro, "p", "填写禅道使用的版本标识，查询测试和严重 Bug。", "gate-sub");
  }
  const canWaive = ctx.role.id === "PM" && allowed(ctx, "set_story_meta");
  const cancelled = new Set(
    data?.progressGroups?.find(({ progress }) => progress === "已取消")
      ?.storyIds ?? [],
  );
  const waived = new Set(data?.waivers?.map(({ storyId }) => storyId) ?? []);
  const releaseStories = new Set(data?.storyIds ?? []);
  const knownBlockers = new Set([
    ...incomplete.filter((id) => !missing.has(id)),
    ...bugs.map(({ story }) => story),
  ]);
  const candidates = [...knownBlockers].filter(
    (id) => releaseStories.has(id) && !waived.has(id) && !cancelled.has(id),
  );
  const exceptions = add(output, "div", undefined, "management-config");
  const waiver = button(
    hero,
    "批准例外放行",
    () => {
      exceptions.replaceChildren();
      reviewReleaseException(exceptions, ctx, candidates, () =>
        exceptions.replaceChildren(),
      );
    },
    canWaive ? "btn-warn" : "btn-secondary",
  );
  if (!canWaive) {
    waiver.textContent = "仅产品管理可批准例外";
    waiver.setAttribute("aria-label", "批准例外放行（仅产品管理可操作）");
  }
  waiver.disabled =
    !canWaive || actual !== "blocked" || candidates.length === 0;
  if (canWaive && actual === "blocked" && !candidates.length)
    add(intro, "p", "当前证据未定位到可登记例外的需求。", "page-sub");

  const grid = add(output, "div", undefined, "gate-cards-grid");
  const tests = card(grid, "未完成测试的需求", "vp-card");
  const defects = card(grid, "阻断发布的 1–2 级未关闭 Bug", "vp-card");
  if (mount) {
    for (const panel of [tests, defects]) {
      mount(add(panel.head, "span"), (doc) => skeletonBlock(doc, "chip"));
      mount(add(panel.body, "div"), gateList);
    }
    return;
  }
  if (!data) {
    add(tests.body, "p", "查询版本后查看需求。", "page-sub");
    add(defects.body, "p", "查询版本后查看 Bug。", "page-sub");
    return;
  }
  badge(
    tests.head,
    `${incomplete.length} 条`,
    incomplete.length ? "danger" : actual === "unknown" ? "warn" : "success",
  );
  badge(
    defects.head,
    `${bugs.length} 条`,
    bugs.length ? "danger" : actual === "unknown" ? "warn" : "success",
  );
  if (incomplete.length) {
    const progressById = new Map(
      (data.progressGroups ?? []).flatMap(({ progress, storyIds }) =>
        storyIds.map((id) => [id, progress]),
      ),
    );
    const list = add(tests.body, "div", undefined, "item-list vp-scroll");
    for (const id of incomplete) {
      const { row, heading } = item(
        list,
        `需求 #${id}`,
        `当前进展 ${progressById.get(id) ?? "暂无记录"}`,
      );
      if (missing.has(id)) badge(heading, "测试证据缺失", "warn");
      storyButton(row, ctx, id, "查看进展");
    }
  } else {
    add(
      tests.body,
      "p",
      actual === "unknown"
        ? "已读取记录中暂无待处理项，需核对测试证据。"
        : "已读取记录未发现未完成测试的需求。",
      "page-sub",
    );
  }
  if (bugs.length) bugRows(defects.body, bugs, ctx);
  else
    add(
      defects.body,
      "p",
      actual === "unknown"
        ? "已读取记录中暂无严重 Bug，需核对数据范围。"
        : "已读取记录未发现未关闭的高严重级别 Bug。",
      "page-sub",
    );

  const lateTasks = data.lateLeafTasks ?? [];
  const unlinked = data.unlinkedSeriousBugs ?? [];
  const warnings = data.releaseWarningStoryIds ?? [];
  if (lateTasks.length) {
    const { body, head } = card(grid, "任务截止晚于计划发布日", "vp-card");
    badge(head, `${lateTasks.length} 条`, "warn");
    const list = add(body, "div", undefined, "item-list vp-scroll");
    for (const task of lateTasks) {
      const { row } = item(
        list,
        `任务 #${task.taskId}`,
        `计划截止 ${task.deadline}`,
      );
      storyButton(row, ctx, task.storyId, `关联需求 #${task.storyId}`);
    }
  }
  if (unlinked.length) {
    const { body, head } = card(grid, "产品内未关联需求的活跃 Bug", "vp-card");
    badge(head, `${unlinked.length} 条`, "warn");
    add(body, "p", "这些 1–2 级 Bug 需要人工核对版本归属。", "panel-sub");
    bugRows(body, unlinked, ctx);
  }
  if (warnings.length)
    add(output, "p", `R13 发布前门禁预警 ${reference(warnings)}`, "page-sub");
  showEvidence(output, report);
}

function release(parent, ctx, initial) {
  if (!allowed(ctx, "get_plan_progress")) {
    locked(
      parent,
      "当前职责没有发布门禁读取权限",
      "可由产品管理核对测试完成情况与严重 Bug。",
    );
    return;
  }
  const configured = ctx.releaseCalendar ?? [];
  const preferred = initial.version
    ? undefined
    : configured.find(
        ({ product }) =>
          !initial.product || String(product) === String(initial.product),
      );
  const line = add(parent, "div", undefined, "toolbar-row");
  const versions = add(
    line,
    "div",
    undefined,
    "segmented-tabs management-versions",
  );
  const settings = add(line, "div", undefined, "row-actions");
  add(
    settings,
    "span",
    "门禁标准：版本内全部需求（含存量版本计划）测试完成，且版本内 1–2 级严重 Bug 清零",
    "toolbar-note",
  );
  const form = add(parent, "form", undefined, "management-toolbar");
  const product = field(form, "product", "产品", {
    value: String(initial.product ?? preferred?.product ?? ""),
    placeholder: "名称或编号",
  });
  const version = field(form, "version", "发布版本", {
    required: true,
    value: initial.version ?? preferred?.version,
    placeholder: "禅道版本标识",
  });
  if (configured.length) toggleForm(settings, form, "查询其他版本", version);
  const output = add(parent, "div", undefined, "management-section");
  const versionKey = (product, version) =>
    JSON.stringify([String(product ?? ""), version]);
  const history = new Map(
    configured.map(({ product, version, date }) => [
      versionKey(product, version),
      { product: String(product), version, releaseDate: date },
    ]),
  );
  const paint = (key) => {
    versions.replaceChildren();
    for (const [id, entry] of history) {
      const control = button(
        versions,
        `${entry.version}${entry.releaseDate ? `（${entry.releaseDate}）` : ""}`,
        () => {
          product.value = entry.product ?? "";
          version.value = entry.version;
          void refresh();
        },
        `seg-tab${id === key ? " is-active" : ""}`,
      );
      control.setAttribute("aria-pressed", String(id === key));
    }
  };
  const run = loading(
    output,
    ctx,
    reportTool(ctx, "get_plan_progress"),
    (report, input) => {
      const { version: returnedVersion, productId, releaseDate } = report.data;
      const actualProduct =
        productId == null ? input.product : String(productId);
      const requestedKey = versionKey(input.product, returnedVersion);
      const existing = history.get(requestedKey);
      const key = existing
        ? requestedKey
        : versionKey(actualProduct, returnedVersion);
      history.set(key, {
        product: existing?.product ?? actualProduct,
        version: returnedVersion,
        releaseDate: releaseDate ?? existing?.releaseDate,
      });
      paint(key);
      showGate(output, ctx, report);
    },
    (mount) => showGate(output, ctx, undefined, mount),
  );
  const refresh = () => {
    const input = pick({ product, version });
    paint(versionKey(input.product, input.version));
    return run({ view: "release", ...input });
  };
  submit(form, "查询发布门禁", () => {
    if (version.value.trim()) return refresh();
    version.value = "";
    version.reportValidity();
  });
  if (version.value.trim()) void refresh();
  else {
    paint();
    showGate(output, ctx);
  }
}

// 巡检规则和阈值来自 docs/04 §5，实际命中依据取自服务。
const riskRules = [
  [
    "R01",
    "任务逾期",
    "P1",
    "叶子任务截止日早于今天",
    "联系负责人更新排期或协调支持",
  ],
  [
    "R02",
    "研发完成测试未接续",
    "P1",
    "测试缺失 1 个工作日，等待超过 2 个工作日",
    "补建测试任务或协调启动测试",
  ],
  ["R03", "接收超时", "P1", "移交后超过 3 个工作日", "提醒研发主管拆解"],
  ["R04", "未就绪先指派", "P1", "草稿或评审中指派给研发侧", "转回状态维护人"],
  [
    "R05",
    "需求缺范围",
    "P1",
    "缺实现范围，或引用缺章节、版本",
    "补写范围、章节与版本",
  ],
  [
    "R06",
    "结构违规",
    "P2",
    "未挂 L3、孤儿任务、新建多人任务或缺必需阶段",
    "补挂计划、拆子任务或补建阶段",
  ],
  [
    "R07",
    "设计完成未移交",
    "P2",
    "评审及传递完成超过 2 个工作日",
    "核对研发需求并完成移交",
  ],
  [
    "R08",
    "用户需求未关联",
    "P2",
    "超过 5 个工作日未关联研发需求",
    "关联来源与研发需求",
  ],
  ["R09", "应关未关", "P2", "可关闭超过 5 个工作日", "关闭需求及已完成任务"],
  [
    "R10",
    "计划与迭代脱节",
    "P2",
    "本月第 5 个工作日起",
    "核对 L3 和本月研发迭代",
  ],
  [
    "R11",
    "测试后缺验收或交付",
    "P2",
    "测试完成超过 1 个工作日",
    "补建验收或必需交付任务",
  ],
  ["R12", "Bug 未关联", "P2", "Bug 缺关联需求或测试执行", "补充关联需求与执行"],
  [
    "R13",
    "发布门禁未满足",
    "P2",
    "发布前 3 个工作日",
    "完成测试、关闭严重 Bug 或登记例外",
  ],
  [
    "R14",
    "历史任务待清理",
    "P2",
    "结转或停留超过 30 自然日",
    "按分类核对并关闭",
  ],
  [
    "R15",
    "跨产品不对称",
    "P3",
    "同一诉求一端完成超过 10 个工作日",
    "核对滞后一侧排期",
  ],
  [
    "R16",
    "疑似先做后录",
    "P3",
    "创建晚于实际开始或首个相关提交",
    "核对记录并补全来源",
  ],
];

function ruleDirectory(parent) {
  const card = add(parent, "details", undefined, "accordion-card");
  const summary = add(card, "summary", undefined, "accordion-head");
  add(summary, "span", "展开 R01–R16 完整风险巡检规则目录（16 条）");
  summary.append(icon("ChevronDown", 15, summary.ownerDocument));
  const body = add(
    card,
    "div",
    undefined,
    "accordion-body risks-accordion-body",
  );
  table(
    body,
    ["规则", "阶段", "触发阈值", "建议动作"],
    riskRules,
    (tr, [id, name, stage, threshold, action]) => {
      const title = add(tr, "td");
      add(title, "span", id, "mono req-id");
      title.append(" " + name);
      badge(add(tr, "td"), stage);
      add(tr, "td", threshold);
      add(tr, "td", action);
    },
  );
}

function riskFilters(filters, count, paint) {
  filters.replaceChildren();
  filters.setAttribute("aria-label", "按风险严重程度筛选");
  const choices = [
    ["all", count === undefined ? "全部卡点" : `全部卡点 (${count})`],
    ["high", "高危阻断"],
    ["norm", "规范提醒"],
  ];
  const buttons = new Map();
  for (const [id, title] of choices) {
    const active = id === "all";
    const control = button(
      filters,
      title,
      paint && (() => paint(id)),
      `seg-tab${active ? " is-active" : ""}`,
    );
    control.setAttribute("aria-pressed", String(active));
    control.disabled = !paint;
    buttons.set(id, control);
  }
  return buttons;
}

function drawRiskRows(place, filters, ctx, report, tabs) {
  showGaps(place, report);
  const { hits, summary } = report.data;
  const active = hits.filter(({ waived }) => !waived);
  ctx.setBadge?.("release-risks", partial(report) ? 0 : active.length);
  tabs.label(
    partial(report)
      ? `风险与卡点（已读取 ${active.length}）`
      : `风险与卡点 (${active.length})`,
  );
  const names = new Map(summary.map(({ rule, name }) => [rule, name]));
  const list = add(
    add(place, "section", undefined, "panel-card vp-card"),
    "div",
    undefined,
    "item-list vp-scroll",
  );
  const buttons = riskFilters(filters, active.length, paint);
  function paint(filter) {
    for (const [key, node] of buttons) {
      node.className = `seg-tab${key === filter ? " is-active" : ""}`;
      node.setAttribute("aria-pressed", String(key === filter));
    }
    list.replaceChildren();
    const visible = active.filter(
      ({ severity }) =>
        filter === "all" ||
        (filter === "high" ? severity === "high" : severity !== "high"),
    );
    if (!visible.length)
      add(
        list,
        "p",
        partial(report)
          ? "已读取记录中暂未发现此类卡点，无法确认全量风险。"
          : "当前筛选范围暂未发现卡点。",
        "empty-inline",
      );
    for (const hit of visible) {
      const { object, rule, severity, level, owner } = hit;
      const description = [
        hit.reason,
        `对接人 ${person(owner)}`,
        hit.since ? `自 ${hit.since}` : "",
      ]
        .filter(Boolean)
        .join(" · ");
      const { row, main, heading } = item(list, undefined, description);
      badge(heading, rule);
      badge(
        heading,
        severityNames[severity],
        severity === "high"
          ? "danger"
          : severity === "medium"
            ? "warn"
            : undefined,
      );
      add(
        heading,
        "span",
        [
          names.get(rule),
          `${objectNames[object.type]} #${object.id} ${object.title}`,
        ]
          .filter(Boolean)
          .join(" · "),
      );
      if (level === "inferred") badge(heading, "推测", "warn");
      if (hit.suggestion) add(main, "div", hit.suggestion, "item-row-sub");
      const actions = add(row, "div", undefined, "row-actions");
      if (object.type === "story" && allowed(ctx, "get_story_progress"))
        storyButton(actions, ctx, object.id, "查看需求");
      else link(actions, `查看${objectNames[object.type]}`, object.url);
      if (
        object.type === "story" &&
        canDecompose(ctx) &&
        ["R02", "R11"].includes(rule)
      )
        button(
          actions,
          "补齐阶段任务",
          () =>
            ctx.openTool("decompose_stories", {
              storyIds: [object.id],
              template: "next_stage",
            }),
          "btn-primary btn-xs",
        );
      if (
        object.type === "story" &&
        rule === "R13" &&
        ctx.role.id === "PM" &&
        allowed(ctx, "set_story_meta") &&
        allowed(ctx, "get_plan_progress")
      )
        button(actions, "核对发布例外", () => tabs.activate("release"));
    }
  }
  paint("all");
  const waived = hits.filter((entry) => entry.waived);
  if (waived.length) {
    const { body, head } = card(
      place,
      "已登记规则豁免记录",
      "risks-waivers-card",
    );
    badge(head, `${waived.length} 条`);
    const list = add(body, "div", undefined, "item-list vp-scroll");
    for (const { object, rule, waived: entry } of waived)
      item(
        list,
        `${rule} · ${objectNames[object.type]} #${object.id} ${object.title}`,
        `${entry.by} · ${entry.reason}`,
      );
  }
  showEvidence(place, report);
}

function risks(parent, ctx, initial, tabs) {
  if (!allowed(ctx, "scan_workflow_risks")) {
    locked(parent, "当前职责没有风险巡检权限", "可在下方核对巡检规则。");
    ruleDirectory(parent);
    return;
  }
  const toolbar = add(parent, "div", undefined, "toolbar-row");
  const filters = add(toolbar, "div", undefined, "segmented-tabs");
  const settings = add(toolbar, "div", undefined, "row-actions");
  const form = add(parent, "form", undefined, "management-toolbar");
  const product = field(form, "product", "产品", {
    value: initial.product,
    placeholder: "名称或编号",
  });
  const team = field(form, "team", "团队", {
    value: initial.team,
    placeholder: "名称或代号",
  });
  const month = field(form, "month", "月份", {
    type: "month",
    value: initial.month,
  });
  const mine = mineRisks(ctx);
  if (mine) add(settings, "span", "巡检范围为本人相关记录", "toolbar-note");
  let rules = Array.isArray(initial.rules)
    ? [
        ...new Set(
          initial.rules.filter((rule) => riskRules.some(([id]) => rule === id)),
        ),
      ]
    : [];
  const output = add(parent, "div", undefined, "management-section");
  const run = loading(
    output,
    ctx,
    reportTool(ctx, "scan_workflow_risks"),
    (result) => drawRiskRows(output, filters, ctx, result, tabs),
    (mount) => {
      tabs.label("风险与卡点");
      riskFilters(filters);
      mount(add(output, "section", undefined, "panel-card vp-card"), riskList);
    },
  );
  const refresh = () =>
    run({
      scope: { ...pick({ product, team, month }), ...(mine && { mine: true }) },
      ...(rules.length && { rules }),
    });
  submit(form, "重新巡检", refresh);
  toggleForm(settings, form, "筛选巡检范围", product);
  if (rules.length) {
    const filter = add(settings, "div", undefined, "row-actions");
    badge(filter, rules.join("、"), "primary");
    button(filter, "清除规则筛选", () => {
      rules = [];
      filter.hidden = true;
      void refresh();
    });
  }
  ruleDirectory(parent);
  void refresh();
}

function resultGap(parent, settled, label) {
  if (settled.status === "fulfilled") showGaps(parent, settled.value);
  else
    notice(
      parent,
      `${label}查询失败${settled.reason?.message ? ` · ${settled.reason.message}` : ""}`,
      "warn",
    );
}

function commitmentCard(parent, ctx, data, mount) {
  const { body, head } = card(parent, "月度承诺", "vp-card");
  const tabs = add(head, "div", undefined, "segmented-tabs");
  const content = add(body, "div", undefined, "item-list vp-scroll");
  const comparison = data
    ? [
        ["已兑现", data.fulfilled ?? []],
        ["新增插入", data.inserted ?? []],
        ["待完成", data.pendingStoryIds ?? []],
        ["已取消", data.cancelledStoryIds ?? []],
        ["无法判断", data.unknownStoryIds ?? []],
      ]
    : [];
  const shifted = data?.carriedOver ?? [];
  const baseline = data?.snapshotAvailable
    ? new Set([
        ...comparison
          .filter(([label]) => label !== "新增插入")
          .flatMap(([, ids]) => ids),
        ...shifted.map(({ id }) => id),
      ]).size
    : null;
  const controls = new Map();
  const render = (tab) => {
    for (const [id, control] of controls) {
      const active = id === tab;
      control.className = "seg-tab" + (active ? " is-active" : "");
      control.setAttribute("aria-pressed", String(active));
    }
    content.replaceChildren();
    if (mount) {
      mount(content, commitmentList);
      return;
    }
    if (tab === "reschedule") {
      if (!shifted.length) {
        add(
          content,
          "p",
          data ? "本月已读取记录中暂无挪月顺延留痕。" : "挪月记录暂未读取。",
          "empty-inline",
        );
        return;
      }
      for (const { id, reason } of shifted) {
        const { row } = item(
          content,
          `需求 #${id}`,
          reason ? `原因 ${reason}` : "未查到顺延原因",
        );
        const actions = add(row, "div", undefined, "row-actions");
        if (reason) badge(actions, "已留痕", "purple");
        storyButton(actions, ctx, id, "详情");
      }
      return;
    }
    if (baseline === null) {
      add(
        content,
        "p",
        data
          ? "缺少月初承诺快照，待补齐基线后核对兑现、顺延和插入。"
          : "月度承诺暂未读取。",
        "empty-inline",
      );
      return;
    }
    for (const [name, ids] of comparison) {
      const { row } = item(content, `${name} ${ids.length} 条`);
      if (!ids.length) continue;
      const actions = add(row, "div", undefined, "row-actions");
      for (const id of ids) storyButton(actions, ctx, id);
    }
    const sources = add(content, "details", undefined, "management-evidence");
    add(sources, "summary", "月初快照来源");
    table(
      sources,
      ["产品", "采集时间", "来源"],
      data.snapshots,
      (tr, { productId, takenAt, source }) => {
        add(tr, "td", `#${productId}`);
        add(tr, "td", new Date(takenAt).toISOString());
        add(tr, "td", source === "imported" ? "共享导入" : "本地采集");
      },
    );
  };
  controls.set(
    "baseline",
    button(
      tabs,
      `月初承诺基线${baseline === null ? "" : " (" + baseline + ")"}`,
      () => render("baseline"),
      "seg-tab",
    ),
  );
  controls.set(
    "reschedule",
    button(
      tabs,
      `挪月顺延留痕${data ? " (" + shifted.length + ")" : ""}`,
      () => render("reschedule"),
      "seg-tab",
    ),
  );
  add(head, "span", "仅研发主管可登记挪月", "readonly-muted-note");
  if (mount) for (const control of controls.values()) control.disabled = true;
  render("baseline");
  return baseline;
}

function progressRing(parent, rate, tone) {
  const ring = add(parent, "div", undefined, "viz-ring management-ring");
  ring.setAttribute("aria-hidden", "true");
  const svgNs = "http://www.w3.org/2000/svg";
  const svg = ring.ownerDocument.createElementNS(svgNs, "svg");
  svg.setAttribute("viewBox", "0 0 60 60");
  svg.setAttribute("width", "58");
  svg.setAttribute("height", "58");
  ring.append(svg);
  const radii = [
    ["var(--bg-subtle)", 1],
    ["var(--" + tone + ")", rate],
  ];
  for (const [stroke, fraction] of radii) {
    const circle = ring.ownerDocument.createElementNS(svgNs, "circle");
    for (const [name, value] of Object.entries({
      cx: 30,
      cy: 30,
      r: 25,
      fill: "none",
      stroke,
      "stroke-width": 5,
      "stroke-linecap": "round",
      pathLength: 100,
      "stroke-dasharray": `${(fraction ?? 0) * 100} 100`,
    }))
      circle.setAttribute(name, String(value));
    if (fraction > 0) svg.append(circle);
  }
  add(
    ring,
    "span",
    rate == null ? "—" : `${Math.round(rate * 100)}%`,
    "viz-ring-label",
  );
}

function planMetric(parent, label, metric, hint, tone, mount) {
  const tile = add(parent, "div", undefined, "kpi-card is-ring-kpi");
  const body = add(tile, "div", undefined, "kpi-ring-body");
  if (mount) mount(add(body, "div", undefined, "viz-ring management-ring"), metricRing);
  else progressRing(body, metric?.rate, tone);
  const copy = add(body, "div", undefined, "kpi-ring-text");
  add(copy, "div", label, "kpi-label");
  const value = add(copy, "div", undefined, "kpi-num tabular");
  if (mount) mount(value, (doc) => skeletonBlock(doc, "value"));
  else value.textContent = metric ? rateText(metric) : "待查询";
  add(copy, "div", hint, "kpi-foot");
}

function l3Panel(parent, plan, month, mount) {
  const { body, head } = card(
    parent,
    `${month ? `${month} ` : ""}月度模块计划（L3）进度`,
    "vp-card",
  );
  if (mount) {
    mount(add(head, "span"), (doc) => skeletonBlock(doc, "chip"));
    mount(add(body, "div"), l3Groups);
    return;
  }
  if (plan) badge(head, `${plan.planIds.length} 个计划`);
  const entries = plan?.groups?.length
    ? add(body, "div", undefined, "l3-bars is-two-col vp-scroll")
    : undefined;
  for (const group of plan?.groups ?? []) {
    const tile = add(entries, "div", undefined, "l3-tile");
    const top = add(tile, "div", undefined, "l3-tile-head");
    add(top, "strong", group.key ?? "未归类模块", "l3-tile-title");
    add(top, "span", rateText(group.storyDeliveryRate), "l3-tile-ratio");
    if (group.total && group.counts) {
      const status = [
        ["completed", "done", "已完成"],
        ["inProgress", "doing", "进行中"],
        ["toReceive", "toReceive", "待接收"],
        ["notReady", "notReady", "未就绪"],
        ["cancelled", "cancelled", "已取消"],
        ["unknown", "unknown", "未知"],
      ];
      const track = add(tile, "div", undefined, "viz-stacked-bar");
      track.setAttribute("aria-hidden", "true");
      const meta = add(tile, "div", undefined, "l3-tile-meta");
      for (const [key, tone, name] of status) {
        const count = group.counts[key];
        if (!count) continue;
        const fill = add(track, "div", undefined, "viz-seg is-" + tone);
        fill.style.width = `${(count / group.total) * 100}%`;
        add(meta, "span", `${name} ${count}`);
      }
    }
  }
  if (!plan?.groups?.length)
    add(
      body,
      "p",
      plan?.planIds?.length
        ? `L3 计划 ${reference(plan.planIds)} · 暂无可计算的模块分组。`
        : plan
          ? "查询范围暂无可展示的 L3 计划。"
          : "待重新查询 L3 计划。",
      "empty-inline",
    );
}

function iterationPanels(left, right, ctx, iteration, mount) {
  const pairs = card(left, "跨产品配对进度对比（US-PM-04）", "plans-col-fixed");
  const groups = iteration?.crossProduct ?? [];
  if (mount) {
    mount(add(pairs.head, "span"), (doc) => skeletonBlock(doc, "chip"));
    mount(add(pairs.body, "div"), pairedProgress);
  } else if (!groups.length) {
    add(
      pairs.body,
      "p",
      iteration ? "当前已读取范围暂无配对需求。" : "暂未读取跨产品配对记录。",
      "empty-inline",
    );
  } else {
    badge(pairs.head, `${groups.length} 组`);
    const list = add(pairs.body, "div", undefined, "item-list vp-scroll");
    for (const { stories } of groups) {
      const row = add(list, "div", undefined, "pair-compare-row");
      for (const story of stories) {
        const side = add(row, "div", undefined, "pair-side");
        add(side, "div", story.product.name, "pair-side-label");
        const title = add(side, "div", undefined, "pair-side-title");
        storyButton(title, ctx, story.id, `#${story.id} ${story.title}`);
        add(side, "div", story.progress.value, "pair-side-prog");
      }
    }
  }
  const { body, head } = card(
    right,
    "迭代过程指标（US-PJ-03）",
    "plans-col-fixed",
  );
  badge(head, "叶子任务口径");
  if (mount) {
    mount(add(body, "div"), iterationMetrics);
    return;
  }
  if (!iteration?.executionIds?.length) {
    add(
      body,
      "p",
      iteration
        ? "查询范围暂无可展示的研发迭代指标。"
        : "暂未读取迭代过程指标。",
      "empty-inline",
    );
    return;
  }
  table(
    body,
    ["研发迭代", "需求数", "拆解及时率", "进行中逾期占比", "测试流转中位耗时"],
    [iteration],
    (tr, row) => {
      add(tr, "td", reference(row.executionIds));
      add(tr, "td", `${row.storyIds.length} 条`, "tabular");
      add(tr, "td", rateText(row.decompositionTimeliness), "tabular");
      add(tr, "td", rateText(row.overdueRate), "tabular");
      add(
        tr,
        "td",
        row.testCycleMedianWorkdays == null
          ? "暂无样本"
          : `${row.testCycleMedianWorkdays} 工作日 · ${row.testCycleSampleSize} 个样本`,
        "tabular",
      );
    },
  );
}

function drawPlans(output, ctx, reports, mount) {
  const [planReport, commitmentReport, iterationReport] = reports ?? [];
  if (reports) {
    resultGap(output, planReport, "L3 计划");
    resultGap(output, commitmentReport, "月度承诺");
    resultGap(output, iterationReport, "迭代过程指标");
  }
  const plan = planReport?.value?.data;
  const commitments = commitmentReport?.value?.data;
  const iteration =
    iterationReport?.value?.data?.view === "iteration"
      ? iterationReport.value.data
      : undefined;
  const month =
    planReport?.value?.scope.filters.month ??
    commitmentReport?.value?.scope.filters.month;

  const grid = add(output, "div", undefined, "kpi-grid-3");
  planMetric(
    grid,
    "需求交付率（按需求编号去重）",
    plan?.storyDeliveryRate,
    "已完成 ÷（月度计划内需求 − 已取消）",
    "success",
    mount,
  );
  planMetric(
    grid,
    "叶子任务完成率",
    plan?.taskCompletionRate,
    "独立统计叶子任务，不替代需求交付率",
    "accent",
    mount,
  );
  const commitment = add(grid, "div", undefined, "kpi-card");
  add(commitment, "div", `${month ?? "月度"} 承诺基线与挪月`, "kpi-label");
  const total = add(commitment, "div", undefined, "kpi-num tabular");
  const ratioBar = add(commitment, "div", undefined, "kpi-ratio-bar");
  ratioBar.setAttribute("aria-hidden", "true");
  if (mount) {
    mount(total, (doc) => skeletonBlock(doc, "value"));
    mount(ratioBar, progressTrack);
  } else total.textContent = "基线待补齐";
  add(
    commitment,
    "p",
    commitments?.missingSnapshotProductIds?.length
      ? `缺少月初承诺快照的产品 ${reference(commitments.missingSnapshotProductIds)}`
      : "按月初快照核对当前进展",
    "kpi-foot",
  );
  const panels = add(output, "div", undefined, "plans-bento");
  const left = add(panels, "div", undefined, "plans-col");
  const right = add(panels, "div", undefined, "plans-col");
  l3Panel(left, plan, month, mount);
  iterationPanels(left, right, ctx, iteration, mount);
  const baseline = commitmentCard(right, ctx, commitments, mount);
  if (mount) return;
  if (baseline !== null) {
    const moved = commitments.carriedOver.length;
    total.textContent = `${baseline} 条 / 挪月 ${moved}`;
    if (baseline) {
      const kept = add(ratioBar, "div", undefined, "kpi-ratio-fill is-kept");
      const shifted = add(
        ratioBar,
        "div",
        undefined,
        "kpi-ratio-fill is-resched",
      );
      kept.style.width = `${(Math.max(0, baseline - moved) / baseline) * 100}%`;
      shifted.style.width = `${Math.min(1, moved / baseline) * 100}%`;
    }
  }
  for (const [entry, label] of [
    [planReport, "L3 计划"],
    [commitmentReport, "月度承诺"],
    [iterationReport, "迭代过程指标"],
  ])
    if (entry.value)
      showEvidence(output, entry.value, `${label}统计口径与数据依据`);
}

function plans(parent, ctx, initial) {
  if (!canPlan(ctx) || !allowed(ctx, "get_plan_progress")) {
    locked(
      parent,
      "当前职责可核对版本发布门禁",
      "L3 月度计划与承诺由产品管理和项目管理查询。",
    );
    return;
  }
  const toolbar = add(parent, "div", undefined, "toolbar-row management-end");
  const form = add(parent, "form", undefined, "management-toolbar");
  const product = field(form, "product", "产品", {
    value: initial.product,
    placeholder: "名称或编号",
  });
  const month = field(form, "month", "月份", {
    type: "month",
    value: initial.month,
  });
  const plan = field(form, "plan", "L3 计划", {
    value: initial.plan,
    placeholder: "名称或编号",
  });
  const output = add(parent, "div", undefined, "management-section");
  const read = reportTool(ctx, "get_plan_progress");
  const run = loading(
    output,
    ctx,
    ({ plan, ...filters }) =>
      Promise.allSettled([
        read({
          view: "plan",
          groupBy: "module",
          ...filters,
          ...(plan && { plan }),
        }),
        read({ view: "commitment", ...filters }),
        read({ view: "iteration", ...filters }),
      ]),
    (result) => drawPlans(output, ctx, result),
    (mount) => drawPlans(output, ctx, undefined, mount),
  );
  const refresh = () => run(pick({ product, month, plan }));
  submit(form, "查询计划与承诺", refresh);
  toggleForm(toolbar, form, "筛选计划与承诺", product);
  button(form, "迭代指标", () =>
    ctx.openTool("get_plan_progress", {
      view: "iteration",
      ...pick({ product, month }),
    }),
  );
  void refresh();
}

export function renderReleaseRisks(container, ctx, initial = {}) {
  const attributes = {
    PM: ["可审批发布例外", false],
    PJ: ["可巡检与核对", false],
    DM: ["只读 / 可处理设计收尾卡点", true],
    RM: ["只读 / 可处理研发拆解与挪月", true],
  };
  const [access, readOnly] = attributes[ctx.role.id] ?? ["只读查看", true];
  const tabs = [
    ["release", "版本发布门禁", release],
    ["risks", "风险与卡点", risks],
    ["plans", "L3 计划与承诺", plans],
  ];
  mountTabs(
    container,
    ctx,
    {
      title: "发布门禁与风险巡检",
      subtitle:
        "版本发布红绿灯把关（N12）、16 条规范卡点巡检（R01–R16）与 L3 月度承诺兑现",
      access,
      readOnly,
      banner:
        readOnly &&
        "当前角色以只读核验为主，版本发布例外由产品管理审批并留痕。",
    },
    tabs,
    initial.tab === "gate" ? { ...initial, tab: "release" } : initial,
  );
}
