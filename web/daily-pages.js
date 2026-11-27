import { icon } from "./meridian-icons.js";
import {
  boardStackSkeleton,
  drawerSkeleton,
  fillLedgerSkeleton,
  intakeListSkeleton,
} from "./daily-skeleton.js";
import { beginSkeleton, skeletonBlock } from "./skeleton.js";

const designColumns = [
  ["设计中", ["未就绪", "设计中"]],
  ["评审与传递中", ["待评审", "待传递"]],
  ["已完待移交 / 已移交", ["待移交", "已移交"]],
];
const progressOptions = [
  "未就绪",
  "设计中",
  "待评审",
  "待传递",
  "待移交",
  "已移交",
  "待接收",
  "研发中",
  "待测试",
  "测试中",
  "待验收",
  "待交付",
  "可关闭",
  "已完成",
  "已取消",
  "已关闭·证据缺失",
  "无法判断",
];
const stageNames = {
  design: "设计",
  review: "评审",
  handoff: "传递",
  dev: "研发",
  interface: "接口",
  test: "测试",
  acceptance: "验收",
  delivery: "交付",
};
const stageStates = {
  missing: ["缺失", "danger"],
  not_started: ["未开始"],
  doing: ["进行中", "primary"],
  done: ["已完成", "success"],
  waived: ["已豁免"],
  cancelled: ["已取消"],
};
const taskStates = {
  wait: "未开始",
  doing: "进行中",
  done: "已完成",
  closed: "已关闭",
  cancel: "已取消",
  pause: "已暂停",
};
const recordStates = {
  draft: "草稿",
  active: "激活",
  reviewing: "评审中",
  closed: "已关闭",
  changed: "已变更",
};
const bizLabels = ["已受理", "设计方案", "研发测试", "验收上线"];
const bizStage = {
  用户诉求: 0,
  未就绪: 0,
  设计中: 1,
  待评审: 1,
  待传递: 1,
  待移交: 1,
  已移交: 2,
  待接收: 2,
  研发中: 2,
  待测试: 2,
  测试中: 2,
  待验收: 3,
  待交付: 3,
  可关闭: 3,
  已完成: 3,
};
const activeStage = {
  设计中: "design",
  待评审: "review",
  待传递: "handoff",
  研发中: "dev",
  待测试: "test",
  测试中: "test",
  待验收: "acceptance",
  待交付: "delivery",
};
const filterNames = {
  type: "类型",
  status: "记录状态",
  limit: "返回条数上限",
  role: "关联维度",
  who: "账号",
  category: "需求类别",
  storyId: "需求编号",
  progress: "业务进展",
  view: "详情视图",
  format: "结果形式",
  unlinked: "仅待关联",
};
const can = (ctx, tool) => ctx.role.actions.includes(tool);
const person = (value) => value?.realname || value?.account;
const total = (result) =>
  Object.values(result.data.countsByProgress).reduce(
    (sum, count) => sum + count,
    0,
  );

function put(parent, tag, text, classes) {
  const node = parent.ownerDocument.createElement(tag);
  if (text != null) node.textContent = String(text);
  if (classes) node.className = classes;
  parent.append(node);
  return node;
}

function svg(parent, name, size = 14) {
  const doc = parent.ownerDocument;
  if (!doc.createElementNS) return;
  const element = icon(name, size, doc);
  parent.append(element);
  return element;
}

function button(
  parent,
  label,
  click,
  classes = "btn-secondary btn-sm",
  graphic,
) {
  const node = put(parent, "button", label, classes);
  node.type = "button";
  node.addEventListener("click", click);
  if (graphic) svg(node, graphic, 13);
  return node;
}

function pill(parent, label, state) {
  return put(
    parent,
    "span",
    label,
    state ? `bzt-badge tone-${state}` : "bzt-badge",
  );
}

function progress(parent, value) {
  const stage = value?.value || "待核对";
  const complete = ["已移交", "已完成", "可关闭"].includes(stage);
  const type = complete
    ? "success"
    : stage === "已取消"
      ? "danger"
      : value?.level === "inferred" || stage === "待移交"
        ? "warn"
        : ["未就绪", "无法判断", "待核对"].includes(stage)
          ? "muted"
          : "primary";
  return pill(
    parent,
    `${stage}${value?.level === "inferred" ? " · 推测" : ""}`,
    type,
  );
}

function notice(parent, text, type = "info") {
  const node = put(parent, "p", text, `bzt-alert tone-${type}`);
  node.setAttribute("role", type === "danger" ? "alert" : "status");
  return node;
}

function pageHeading(parent, title, line, permission, editable) {
  const head = put(parent, "header", undefined, "page-head");
  const intro = put(head, "div");
  const titleRow = put(intro, "div", undefined, "page-title-row");
  put(titleRow, "h1", title, "page-title").tabIndex = -1;
  put(
    titleRow,
    "span",
    permission,
    editable ? "perm-badge-edit" : "perm-badge-ro",
  );
  if (line) put(intro, "p", line, "page-sub");
  return head;
}

function tabs(parent, name, entries, selected, choose, drawer = false) {
  const bar = put(
    parent,
    "div",
    undefined,
    drawer ? "drawer-tabs" : "segmented-tabs",
  );
  bar.setAttribute("role", drawer ? "tablist" : "group");
  bar.setAttribute("aria-label", name);
  const classes = drawer ? "drawer-tab" : "seg-tab";
  const controls = entries.map(([value, text, graphic]) => {
    const node = button(bar, text, () => choose(value), classes, graphic);
    if (drawer) node.setAttribute("role", "tab");
    return [value, node];
  });
  function select(active) {
    for (const [value, control] of controls) {
      const activeTab = active === value;
      control.className = activeTab ? `${classes} is-active` : classes;
      control.setAttribute(
        drawer ? "aria-selected" : "aria-pressed",
        String(activeTab),
      );
    }
  }
  select(selected);
  select.controls = new Map(controls);
  return select;
}

function safeLink(parent, label, href) {
  try {
    const url = new URL(href);
    if (
      ["https:", "http:"].includes(url.protocol) &&
      !url.username &&
      !url.password
    ) {
      const link = put(parent, "a", label);
      link.setAttribute("href", url.href);
      link.setAttribute("target", "_blank");
      link.setAttribute("rel", "noopener noreferrer");
      return link;
    }
  } catch {
    // References without a safe URL still identify the object.
  }
  return put(parent, "span", label);
}

function statusOf(parent, result) {
  if (result.completeness === "partial") {
    const box = put(parent, "div", undefined, "bzt-alert tone-warn daily-gap");
    box.setAttribute("role", "status");
    put(box, "strong", "部分数据未读取");
    const list = put(box, "ul");
    for (const { source, reason } of result.gaps ?? [])
      put(list, "li", `${source} · ${reason}`);
  }
  if (result.truncated)
    notice(parent, "查询结果超过显示上限，当前显示前 100 条。", "warn");
}

function panelHeading(panel, title, subtitle) {
  const head = put(panel, "div", undefined, "panel-head");
  const intro = put(head, "div");
  put(intro, "h2", title, "panel-title");
  if (subtitle) put(intro, "p", subtitle, "panel-sub");
  return head;
}

function ownerChip(parent, name, tone = "accent", role = "") {
  const chip = put(parent, "span", undefined, "owner-chip is-compact");
  const label = name || "待核对";
  put(chip, "span", [...label][0], `owner-avatar is-${tone}`).setAttribute(
    "aria-hidden",
    "true",
  );
  put(chip, "span", label, "owner-name");
  if (role) put(chip, "span", role, "owner-role");
  return chip;
}

function bizProgress(item) {
  const key = item.progress?.value;
  const step = bizStage[key] ?? -1;
  const done = key === "已完成";
  const cancelled = key === "已取消";
  const inferred = item.progress?.level === "inferred";
  const title = done
    ? "已完成"
    : cancelled
      ? "已取消"
      : key === "已关闭·证据缺失"
        ? "已结束，完成情况待核实"
        : key === "用户诉求"
          ? "已登记"
          : key === "未就绪"
            ? "评估准备中"
            : (bizLabels[step] ?? "进展待确认");
  return {
    title: inferred ? `${title} · 推测` : title,
    tone: done
      ? "success"
      : cancelled
        ? "danger"
        : inferred || step < 0
          ? "warn"
          : "primary",
    step,
    done,
    cancelled,
  };
}

function bizStepper(parent, { step, done, cancelled }, compact = false) {
  const cls = (index) =>
    done || index < step ? " is-done" : index === step ? " is-current" : "";
  if (compact) {
    const wrapper = put(parent, "div", undefined, "viz-mini-prog");
    const segments = put(wrapper, "div", undefined, "viz-mini-segs");
    segments.setAttribute("aria-hidden", "true");
    const labels = put(wrapper, "div", undefined, "viz-mini-labels");
    for (const [index, label] of bizLabels.entries()) {
      put(segments, "span", label, `viz-mini-seg${cls(index)}`);
      const node = put(labels, "span", label, cls(index).trim());
      if (!done && index === step) node.setAttribute("aria-current", "step");
    }
    return;
  }
  const wrapper = put(
    parent,
    "div",
    undefined,
    `viz-stepper${done ? " is-done" : cancelled ? " is-cancelled" : ""}`,
  );
  const rail = put(wrapper, "div", undefined, "viz-stepper-rail");
  const fill = put(rail, "div", undefined, "viz-stepper-fill");
  fill.style?.setProperty(
    "width",
    `${done ? 100 : (Math.max(step, 0) * 100) / 3}%`,
  );
  const nodes = put(wrapper, "div", undefined, "viz-stepper-nodes");
  for (const [index, label] of bizLabels.entries()) {
    const node = put(nodes, "div", undefined, `viz-step-node${cls(index)}`);
    if (!done && index === step) node.setAttribute("aria-current", "step");
    put(node, "div", done || index < step ? "✓" : index + 1, "viz-step-dot");
    put(node, "span", label, "viz-step-label");
  }
}

function evidence(parent, result) {
  const { scope, inferences, hints, links } = result;
  if (!scope && !inferences?.length && !hints?.length && !links?.length) return;
  const detail = put(parent, "details", undefined, "daily-evidence");
  put(detail, "summary", "查询范围与数据依据");
  if (scope?.asOf) put(detail, "p", `数据时间 ${scope.asOf}`);
  if (scope?.timeBasis) put(detail, "p", scope.timeBasis);
  const filters = Object.entries(scope?.filters ?? {})
    .filter(([, value]) => value != null)
    .map(
      ([key, value]) =>
        `${filterNames[key] ?? key} ${Array.isArray(value) ? value.join("、") : value}`,
    );
  if (filters.length) put(detail, "p", filters.join(" · "));
  for (const { field, level, basis } of inferences ?? []) {
    const storyId = /^story:(\d+):progress$/u.exec(field)?.[1];
    const subject = storyId ? `需求 #${storyId} 的进展 · ` : "";
    put(
      detail,
      "p",
      `${subject}${level === "inferred" ? "推测" : "记录"} · ${basis}`,
    );
  }
  for (const hint of hints ?? []) put(detail, "p", hint);
  for (const { label, url } of links ?? [])
    safeLink(put(detail, "p"), label, url);
}

function outcome(parent, message, retry) {
  notice(parent, message, "danger");
  button(parent, "重新读取", retry);
}

function accepted(result) {
  if (!result?.ok) throw new Error(result?.message || "查询未返回可用结果。");
  return result;
}

export async function renderIntake(container, ctx, initial = {}) {
  container.replaceChildren();
  const page = put(container, "div", undefined, "bzt-page daily-page");
  const fb = ctx.role.id === "FB";
  const mayCreate = can(ctx, "create_story");
  const design = ["DM", "DS"].includes(ctx.role.id) && mayCreate;
  const head = pageHeading(
    page,
    fb ? "极简提诉求" : "提需求",
    fb
      ? "用自然语言说清业务诉求，提交前核对补充内容。"
      : "系统按规范匹配本月 L3 计划并在预览中列出状态维护人。",
    fb
      ? "业务反馈入口"
      : design
        ? "可提需 + 带入用户需求"
        : mayCreate
          ? "可提需求"
          : "只读查看",
    mayCreate,
  );
  const routeStrip =
    fb || !mayCreate ? undefined : put(page, "div", undefined, "routing-strip");
  const columns = put(page, "div", undefined, "intake-split vp-fill");
  const editor = put(
    columns,
    "section",
    undefined,
    "panel-card vp-card daily-intake-editor",
  );
  if (fb)
    panelHeading(
      editor,
      "填写我的新诉求",
      "预览核对并提交后，可查看系统返回的受理回执。",
    );
  const side = put(columns, "aside", undefined, "panel-card intake-req-panel");
  const sideHeading = panelHeading(
    side,
    fb ? "我反馈的诉求与进展" : "待关联的用户需求",
    fb ? "可打开业务进度卡片并复制转发。" : "带入后根据预览建立追溯关系。",
  );
  const count = put(sideHeading, "span", undefined, "daily-count");
  const list = put(side, "div", undefined, "item-list intake-req-list");
  const { mode, rawText, ...fields } = initial;
  if (rawText && !fields.spec?.background)
    fields.spec = { ...fields.spec, background: rawText };
  const feedback = put(
    side,
    "p",
    "",
    "readonly-muted-note daily-intake-feedback",
  );
  feedback.setAttribute("role", "status");
  let batch;
  const options = {
    modeBar: head,
    routeStrip,
    intakePage: true,
    intakeMode: mode === "backfill" ? "backfilled" : mode,
    intakeCatalog: ctx.intakeCatalog,
    onReceipt(receipt) {
      if (receipt.status === "confirmed") void load();
    },
    ...(can(ctx, "import_stories") && !fb && { showBatch }),
  };
  function showBatch(show) {
    if (show && !batch) {
      batch = put(
        columns,
        "section",
        undefined,
        "panel-card vp-card daily-intake-editor daily-import-editor",
      );
      ctx.renderWrite(
        batch,
        "import_stories",
        {},
        {
          intakePage: true,
          intakeCatalog: ctx.intakeCatalog,
          onReceipt: options.onReceipt,
        },
      );
    }
    editor.hidden = show;
    if (batch) batch.hidden = !show;
    if (routeStrip) routeStrip.hidden = show;
  }
  // The editor itself owns the scroll area. The FB heading stays visible above it.
  const form = fb
    ? put(editor, "div", undefined, "daily-intake-form-host")
    : editor;
  const writer =
    mayCreate && ctx.renderWrite(form, "create_story", fields, options);
  if (!mayCreate) {
    const box = put(editor, "div", undefined, "empty-state-action");
    put(
      box,
      "p",
      "当前职责没有提需求权限，可前往「需求流转」查看需求进度或联系设计侧登记。",
      "empty-inline",
    );
    button(
      box,
      "前往需求流转",
      () => ctx.navigate("stories"),
      "btn-secondary btn-sm",
      "ArrowRight",
    );
  }
  if (mode === "batchImport" && options.showBatch)
    writer?.selectIntakeMode?.(mode);
  let request = 0;
  let currentPage = 1;
  const pageSize = 20;
  const isDs = ctx.role.id === "DS";
  const pendingInput = {
    type: "requirement",
    unlinked: true,
    ...(isDs ? { role: "assigned" } : {}),
    limit: pageSize,
  };
  async function load() {
    if (!ctx.current() || !side.isConnected || !can(ctx, "query_stories"))
      return;
    const pending = ++request;
    const current = () =>
      ctx.current() && side.isConnected && pending === request;
    count.replaceChildren();
    list.replaceChildren();
    feedback.textContent = "";
    const options = { signal: ctx.signal, current };
    const finishCount = beginSkeleton(count, countSkeleton, options);
    const finishList = beginSkeleton(
      list,
      (doc) =>
        intakeListSkeleton(doc, {
          business: fb,
          mayAct: fb ? can(ctx, "get_story_progress") : design,
        }),
      options,
    );
    try {
      const raised = { role: "raised", who: ctx.account };
      const results = fb
        ? await Promise.allSettled([
            ctx
              .call("query_stories", {
                type: "requirement",
                unlinked: true,
                ...raised,
                limit: 100,
              })
              .then(accepted),
            ctx
              .call("query_stories", {
                ...raised,
                type: "story",
                status: ["all"],
                limit: 100,
              })
              .then(accepted),
          ])
        : [
            {
              status: "fulfilled",
              value: accepted(
                await ctx.call("query_stories", {
                  ...pendingInput,
                  page: currentPage,
                }),
              ),
            },
          ];
      if (!current()) return;
      if (!fb && results[0]?.status === "fulfilled") {
        const first = results[0].value;
        const totalItems = first.data.total ?? total(first);
        const totalPages = Math.max(1, Math.ceil(totalItems / pageSize));
        if (currentPage > totalPages && !first.data.items.length) {
          currentPage = totalPages;
          return load();
        }
      }
      list.replaceChildren();
      let resultCount = 0;
      let partial = false;
      let shown = 0;
      for (const [index, answer] of results.entries()) {
        if (answer.status === "rejected") {
          partial = true;
          const topic = index === 0 ? "诉求" : "需求进展";
          outcome(
            list,
            `部分数据未读取 · ${topic}：${answer.reason.message || "查询失败"}`,
            load,
          );
          continue;
        }
        const result = answer.value;
        statusOf(list, result);
        partial ||= result.completeness === "partial";
        resultCount += total(result);
        for (const item of result.data.items) {
          shown++;
          intakeCard(list, ctx, item, {
            fb,
            requirement: index === 0,
            design,
            prefill,
          });
        }
        if (!fb) {
          const totalItems = result.data.total ?? total(result);
          const totalPages = Math.max(1, Math.ceil(totalItems / pageSize));
          if (totalPages > 1 || currentPage > 1) {
            const pager = put(list, "div", undefined, "daily-pager");
            const prev = button(pager, "上一页", () => {
              if (currentPage <= 1) return;
              currentPage -= 1;
              void load();
            });
            prev.disabled = currentPage <= 1;
            put(
              pager,
              "span",
              result.completeness === "partial"
                ? `第 ${currentPage} / ${totalPages} 页（已读取 ${totalItems} 条，数据不完整）`
                : `第 ${currentPage} / ${totalPages} 页（共 ${totalItems} 条）`,
              "daily-pager-info",
            );
            const next = button(pager, "下一页", () => {
              if (currentPage >= totalPages) return;
              currentPage += 1;
              void load();
            });
            next.disabled = currentPage >= totalPages;
          }
          evidence(list, result);
        }
      }
      if (!partial) {
        count.replaceChildren();
        pill(
          count,
          `${resultCount} ${fb ? "项" : "条"}`,
          fb ? "primary" : "warn",
        );
        if (!fb) ctx.setBadge?.("intake", resultCount);
      }
      if (!shown && !partial) {
        const message = fb
          ? "还没有读取到本人反馈或提出的诉求。"
          : "当前范围内没有待关联的用户需求。";
        svg(put(list, "div", message, "empty-inline"), "CircleCheck");
      }

      function prefill(item) {
        if (!current()) return;
        const changed = writer?.prefill({
          requirementId: item.id,
          product: String(item.product.id),
          module: item.module ? String(item.module.id) : "",
          title: item.title,
          feedbackBy: item.feedbackBy ?? "",
        });
        const msg =
          changed === false
            ? "请先核对当前操作回执，再带入新的用户需求。"
            : `已带入用户需求 #${item.id}，创建时按预览关联。`;
        feedback.textContent = msg;
        ctx.toast?.(msg, changed === false ? "warning" : "success");
      }
    } catch (error) {
      if (current()) {
        list.replaceChildren();
        outcome(list, error.message || "无法读取待关联的用户需求。", load);
      }
    } finally {
      finishCount();
      finishList();
    }
  }
  if (can(ctx, "query_stories")) {
    ctx.onSync?.(load);
    return load();
  }
  put(list, "p", "当前职责没有读取此清单的权限。", "empty-inline");
}

function intakeCard(parent, ctx, item, { fb, requirement, design, prefill }) {
  const card = put(parent, "div", undefined, "req-intake-card");
  const top = put(card, "div", undefined, "req-intake-top");
  put(
    top,
    "span",
    `${fb && requirement ? "受理单 " : ""}#${item.id}`,
    "mono req-id",
  );
  const business = fb && bizProgress(item);
  if (business) pill(top, business.title, business.tone);
  else if (item.feedbackBy) pill(top, item.feedbackBy);
  put(card, "div", item.title, "req-intake-title");
  if (business) bizStepper(card, business, true);
  const foot = put(card, "div", undefined, "req-intake-foot");
  if (fb && !requirement) {
    ownerChip(
      foot,
      person(item.currentOwner) || person(item.maintainer),
      "accent",
      "跟进",
    );
    if (can(ctx, "get_story_progress"))
      button(
        foot,
        "查看进度卡片",
        () => ctx.openStory(item.id, "card"),
        "btn-secondary btn-xs",
        "ArrowRight",
      );
  } else {
    put(
      foot,
      "span",
      [item.product.name, item.module?.path].filter(Boolean).join(" · "),
    );
    if (fb) {
      const recipient = person(item.currentOwner) || person(item.maintainer);
      if (recipient)
        put(foot, "span", `受理人：${recipient}`, "readonly-muted-note");
    } else if (design) {
      button(
        foot,
        "一键带入并关联",
        () => prefill(item),
        "btn-primary btn-xs",
        "ArrowRight",
      );
    } else put(foot, "span", "仅设计侧可带入建需求", "readonly-muted-note");
  }
}

function openStoryButton(parent, ctx, id, text, classes = "title-link-btn") {
  if (!can(ctx, "get_story_progress")) return put(parent, "span", text);
  return button(
    parent,
    text,
    (event) => {
      event.stopPropagation();
      ctx.openStory(id);
    },
    classes,
  );
}

function storyActions(
  parent,
  ctx,
  item,
  { board = false, drawer = false, designEmpty = false } = {},
) {
  const { id, category, status, progress: stage } = item;
  const designPermission = ["DM", "DS"].includes(ctx.role.id);
  function action(tool, label, data, preview = true, style = "primary") {
    if (can(ctx, tool))
      button(
        parent,
        label,
        (event) => {
          event.stopPropagation();
          ctx.openTool(tool, data, { preview });
        },
        `btn-${style} ${drawer ? "btn-sm" : "btn-xs"}`,
      );
  }
  if (
    designPermission &&
    category === "design" &&
    (designEmpty || (board && stage?.value === "未就绪"))
  )
    action(
      "decompose_stories",
      drawer ? "生成【设计/评审/传递】三段任务" : "生成三段任务",
      {
        storyIds: [id],
        template: "design",
      },
    );
  if (category === "design" && status === "active" && stage?.value === "待移交")
    action(
      "handoff_story",
      drawer ? "评审通过 · 移交研发" : "移交研发",
      { storyId: id, mode: "from_design" },
      true,
      "success",
    );
  if (category === "feature" && status === "draft")
    action("handoff_story", "激活移交", { storyId: id, mode: "activate" });
  if (stage?.value === "可关闭")
    action(
      "close_stories",
      drawer ? "关闭需求并联动收尾" : "关闭收尾",
      { mode: "story", storyIds: [id] },
      false,
      "success",
    );
}

function countSkeleton(doc) {
  return skeletonBlock(doc, "chip");
}

function designBoardColumns(grid) {
  return designColumns.map(([title, values]) => {
    const column = put(grid, "section", undefined, "board-col-card");
    const head = put(column, "div", undefined, "board-col-head");
    put(head, "h2", title);
    const count = put(head, "span", undefined, "daily-count");
    const stack = put(column, "div", undefined, "board-col-stack");
    return { values, count, stack };
  });
}

function designBoard(other, ctx, columns, items, complete) {
  const unclassified = items.filter(
    ({ progress }) =>
      !designColumns.some(([, values]) => values.includes(progress?.value)),
  );
  for (const { values, count, stack } of columns) {
    const rows = items.filter((item) => values.includes(item.progress?.value));
    count.replaceChildren();
    pill(count, rows.length);
    stack.replaceChildren();
    if (!rows.length)
      put(
        stack,
        "p",
        complete ? "该阶段暂无设计需求" : "当前未读到该阶段需求",
        "empty-inline",
      );
    designRows(stack, ctx, rows);
  }
  if (unclassified.length) {
    const card = put(other, "section", undefined, "panel-card");
    put(card, "h2", "阶段待核对", "panel-title");
    designRows(card, ctx, unclassified);
  }
}

function designRows(column, ctx, rows) {
  for (const item of rows) {
    const row = put(column, "div", undefined, "story-board-card");
    const top = put(row, "div", undefined, "story-card-top");
    put(top, "span", `#${item.id}`, "mono req-id");
    progress(top, item.progress);
    const title = openStoryButton(
      row,
      ctx,
      item.id,
      item.title,
      "story-card-title title-link-btn",
    );
    title.setAttribute("aria-label", `#${item.id} ${item.title}`);
    const foot = put(row, "div", undefined, "story-card-foot");
    put(
      foot,
      "span",
      `维护人：${person(item.maintainer) || "待核对"}`,
      "story-owner",
    );
    storyActions(put(foot, "div", undefined, "row-actions"), ctx, item, {
      board: true,
    });
    if (can(ctx, "get_story_progress"))
      row.addEventListener("click", () => ctx.openStory(item.id));
  }
}

function compactStages(parent, item) {
  const pipeline = put(parent, "div", undefined, "stage-pipeline is-compact");
  const stage = activeStage[item.progress?.value];
  const codes =
    item.category === "design"
      ? ["design", "review", "handoff"]
      : ["dev", "interface", "test", "acceptance", "delivery"];
  for (const code of codes) {
    const current = stage === code;
    const chip = put(
      pipeline,
      "span",
      stageNames[code].slice(0, 1),
      `stage-pill${current ? " is-doing" : ""}`,
    );
    chip.title = current
      ? item.progress.value
      : `${stageNames[code]} · 状态见详情`;
  }
}

function ledgerBody(parent) {
  const table = put(parent, "table", undefined, "bzt-table");
  const head = put(put(table, "thead"), "tr");
  for (const label of [
    "需求标题与归属",
    "阶段管线与业务进展",
    "当前负责 / 状态维护人",
    "操作",
  ])
    put(head, "th", label).setAttribute("scope", "col");
  return put(table, "tbody");
}

function ledger(parent, ctx, items, complete, onClear) {
  const body = ledgerBody(parent);
  if (!items.length) {
    const cell = put(put(body, "tr"), "td", undefined, "empty-inline");
    cell.colSpan = 4;
    const msg = complete
      ? "当前筛选范围内暂无需求。"
      : "当前未读到符合筛选条件的需求。";
    if (onClear) {
      const box = put(cell, "div", undefined, "empty-state-action");
      put(box, "span", msg);
      button(box, "清空筛选", onClear, "btn-secondary btn-xs");
    } else {
      cell.textContent = msg;
    }
    return;
  }
  for (const item of items) {
    const mayOpen = can(ctx, "get_story_progress");
    const row = put(body, "tr", undefined, mayOpen ? "is-clickable" : "");
    const main = put(row, "td");
    const title = put(main, "div", undefined, "ledger-title-row");
    put(title, "span", `#${item.id}`, "mono req-id");
    const storyLink = openStoryButton(
      title,
      ctx,
      item.id,
      item.title,
      "ledger-title title-link-btn",
    );
    storyLink.setAttribute("aria-label", `#${item.id} ${item.title}`);
    if (item.version) pill(title, item.version);
    put(
      main,
      "div",
      [
        item.product.name,
        item.module?.path,
        item.feedbackBy && `来源：${item.feedbackBy}`,
      ]
        .filter(Boolean)
        .join(" · "),
      "ledger-sub",
    );
    const stage = put(put(row, "td"), "div", undefined, "ledger-stage-cell");
    progress(stage, item.progress);
    if (item.category !== "other") compactStages(stage, item);
    const owners = put(row, "td");
    put(owners, "div", person(item.currentOwner) || "待核对", "ledger-owner");
    put(
      owners,
      "div",
      `维护：${person(item.maintainer) || "待核对"}`,
      "ledger-sub",
    );
    const actions = put(put(row, "td"), "div", undefined, "row-actions is-end");
    storyActions(actions, ctx, item);
    if (mayOpen) {
      row.addEventListener("click", () => ctx.openStory(item.id));
      openStoryButton(actions, ctx, item.id, "详情", "btn-secondary btn-xs");
    }
  }
}

const flow = [
  [
    "登记诉求",
    "设计/业务",
    "—",
    "—",
    "记录反馈者与渠道，关联结果以操作回执为准。",
    "intake",
  ],
  [
    "建草稿需求",
    "设计人员",
    "草稿",
    "状态维护人",
    "判断设计或研发类，写清本次实现范围并挂本月计划。",
    "intake",
  ],
  [
    "设计三段",
    "设计人员",
    "草稿/激活",
    "状态维护人",
    "按规范生成设计、评审和传递任务。",
    "stories",
  ],
  [
    "激活移交",
    "设计人员",
    "激活",
    "研发主管",
    "评审通过后生成或激活研发需求并指派研发主管。",
    "stories",
  ],
  [
    "接收与拆解",
    "研发主管",
    "激活",
    "研发主管",
    "3 个工作日内按阶段生成任务。",
    "schedule",
  ],
  [
    "研发协作",
    "研发人员",
    "激活",
    "研发主管",
    "按研发范围卡片开发，多人拆子任务协作。",
    "workbench",
  ],
  [
    "测试与 Bug",
    "测试人员",
    "激活",
    "研发主管",
    "研发完成后接续测试，Bug 关联需求与迭代。",
    "release-risks",
  ],
  [
    "验收交付",
    "设计人员",
    "激活",
    "状态维护人",
    "测试通过后转由状态维护人验收和交付。",
    "workbench",
  ],
  [
    "关闭收尾",
    "设计/研发主管",
    "已关闭",
    "—",
    "关闭需求时联动已完成任务，月底挪月记录原因。",
    "stories",
  ],
];

function flowChart(parent, ctx) {
  const section = put(
    parent,
    "section",
    undefined,
    "panel-card vp-card daily-flow-panel",
  );
  panelHeading(
    section,
    "better-zentao 九步标准协作流转图",
    "点击节点查看禅道状态和指派人规则。",
  );
  const grid = put(
    put(section, "div", undefined, "vp-scroll"),
    "div",
    undefined,
    "flow-grid",
  );
  const banner = put(section, "div", undefined, "flow-detail-banner");
  const filters = {
    intake: ["create_story"],
    schedule: [
      "get_monthly_dev_queue",
      "get_member_schedule",
      "get_team_work",
      "decompose_stories",
    ],
    stories: ["query_stories"],
    "release-risks": ["get_plan_progress", "scan_workflow_risks"],
    workbench: ["get_my_work"],
  };
  const nodes = flow.map(([title, actor, state], index) => {
    const node = button(grid, undefined, () => show(index), "flow-node-card");
    put(node, "div", `${index + 1}. ${title}`, "flow-node-title");
    put(node, "div", `负责：${actor}`, "flow-node-actor");
    pill(put(node, "div", undefined, "flow-node-meta"), state);
    return node;
  });
  function show(index) {
    for (const [i, node] of nodes.entries()) {
      node.className =
        i === index ? "flow-node-card is-active" : "flow-node-card";
      node.setAttribute("aria-pressed", String(i === index));
    }
    const [title, , state, owner, desc, view] = flow[index];
    banner.replaceChildren();
    const content = put(banner, "div");
    put(
      content,
      "div",
      `${index + 1}. ${title} · 禅道状态「${state}」 · 指派给「${owner}」`,
      "flow-detail-title",
    );
    put(content, "p", desc, "flow-detail-desc");
    if (filters[view].some((tool) => can(ctx, tool)))
      button(
        banner,
        "前往对应视图",
        () => ctx.navigate(view),
        "btn-primary btn-sm",
        "ArrowRight",
      );
    else put(banner, "span", "当前职责没有此入口", "readonly-muted-note");
  }
  show(0);
}

export async function renderStories(container, ctx, initial = {}) {
  container.replaceChildren();
  const page = put(container, "div", undefined, "bzt-page daily-page");
  const designEditable =
    can(ctx, "handoff_story") ||
    (["DM", "DS"].includes(ctx.role.id) && can(ctx, "decompose_stories"));
  const editable = designEditable || can(ctx, "close_stories");
  const head = pageHeading(
    page,
    "需求流转与阶段管线",
    "点击任意需求查看「研发范围卡片」或生成「业务转发进度卡」。",
    editable
      ? designEditable
        ? "可操作（设计流转）"
        : "可操作（关闭收尾）"
      : "只读查看",
    editable,
  );
  const entries = [
    ["design-board", "设计阶段看板"],
    ["all-stories", "全部需求台账"],
    ["flow", "9 步标准流转图", "GitBranch"],
  ];
  const stateKey = `bzt.portal.stories/${ctx.account ?? ""}/${ctx.role.id}`;
  let saved = {};
  try {
    saved = JSON.parse(sessionStorage.getItem(stateKey) || "{}") || {};
  } catch {
    saved = {};
  }
  const saveState = () => {
    try {
      sessionStorage.setItem(
        stateKey,
        JSON.stringify({ tab: active, progress: filter }),
      );
    } catch {
      /* ignore */
    }
  };
  let active = entries.some(([key]) => key === initial.tab)
    ? initial.tab
    : entries.some(([key]) => key === saved.tab)
      ? saved.tab
      : "design-board";
  let filter =
    typeof initial.progress === "string"
      ? initial.progress
      : (initial.progress?.[0] ??
        (typeof saved.progress === "string" ? saved.progress : ""));
  let keyword = typeof initial.keyword === "string" ? initial.keyword : "";
  let request = 0;
  const choose = tabs(head, "需求流转视图", entries, active, (value) => {
    if (value === active) return;
    active = value;
    saveState();
    choose(active);
    return load();
  });
  if (!editable) {
    const banner = put(page, "div", undefined, "perm-mode-banner");
    const message = put(banner, "div", undefined, "perm-mode-banner-left");
    svg(message, "ShieldCheck");
    put(message, "span", "当前职责可以查看需求进度、研发范围及业务进度卡。");
    put(banner, "span", "只读查看", "perm-badge-ro");
  }
  const body = put(page, "div", undefined, "daily-story-results");
  const boardBody = put(
    body,
    "div",
    undefined,
    "daily-stack daily-board-results",
  );
  const boardStatus = put(boardBody, "div", undefined, "daily-board-status");
  const boardGrid = put(
    boardBody,
    "div",
    undefined,
    "vp-grid-3 daily-design-board",
  );
  const columns = designBoardColumns(boardGrid);
  const boardOther = put(boardBody, "div", undefined, "daily-board-other");
  const ledgerPanel = put(
    body,
    "section",
    undefined,
    "panel-card vp-card daily-ledger",
  );
  const toolbar = put(ledgerPanel, "div", undefined, "ledger-toolbar");
  const searchWrap = put(toolbar, "div", undefined, "ledger-search-wrap");
  svg(searchWrap, "Search")?.classList.add("ledger-search-icon");
  const search = put(
    searchWrap,
    "input",
    undefined,
    "bzt-input ledger-search-input",
  );
  search.type = "search";
  search.setAttribute("aria-label", "检索当前台账结果");
  search.placeholder = "检索需求编号、标题、模块或反馈方…";
  search.value = keyword;
  const clear = button(
    searchWrap,
    "",
    () => {
      search.value = "";
      setKeyword();
      search.focus?.();
    },
    "ledger-clear-btn",
    "X",
  );
  clear.setAttribute("aria-label", "清空搜索");
  clear.hidden = !keyword;
  const label = put(toolbar, "label", undefined, "ledger-filter-right");
  put(label, "span", "当前阶段：", "filter-label");
  const select = put(label, "select", undefined, "bzt-select");
  const all = put(select, "option", "全部阶段");
  all.value = "";
  const known = new Set([...progressOptions, ...(filter ? [filter] : [])]);
  for (const name of known) put(select, "option", name).value = name;
  select.value = filter;
  let ledgerPage = 1;
  const ledgerPageSize = 20;
  select.addEventListener("change", () => {
    filter = select.value;
    ledgerPage = 1;
    saveState();
    return load();
  });
  const ledgerStatus = put(
    ledgerPanel,
    "div",
    undefined,
    "daily-ledger-status",
  );
  const tableWrap = put(
    ledgerPanel,
    "div",
    undefined,
    "table-wrap vp-table-scroll",
  );
  const ledgerPager = put(ledgerPanel, "div", undefined, "daily-pager");
  ledgerPager.hidden = true;
  const workflow = put(body, "div", undefined, "daily-flow");
  flowChart(workflow, ctx);
  let ledgerResult;
  let finishPending;

  function setKeyword() {
    const nextKeyword = search.value.trim();
    clear.hidden = !search.value;
    if (nextKeyword === keyword) return;
    keyword = nextKeyword;
    ledgerPage = 1;
    if (active === "all-stories") void load();
  }
  search.addEventListener("input", setKeyword);

  function showLedger() {
    const { items } = ledgerResult.data;
    tableWrap.replaceChildren();
    ledger(
      tableWrap,
      ctx,
      items,
      ledgerResult.completeness !== "partial" && !ledgerResult.truncated,
      keyword || filter
        ? () => {
            search.value = "";
            keyword = "";
            clear.hidden = true;
            filter = "";
            select.value = "";
            ledgerPage = 1;
            saveState();
            void load();
          }
        : undefined,
    );
  }

  async function load() {
    finishPending?.();
    const pending = ++request;
    const current = () =>
      ctx.current() && body.isConnected && request === pending;
    const board = active === "design-board";
    if (!current()) return;
    boardBody.hidden = !board;
    ledgerPanel.hidden = active !== "all-stories";
    workflow.hidden = active !== "flow";
    ctx.onSync?.(
      active === "flow" || !can(ctx, "query_stories") ? undefined : load,
    );
    if (active === "flow") return;
    const status = board ? boardStatus : ledgerStatus;
    status.replaceChildren();
    if (board) {
      boardOther.replaceChildren();
      boardGrid.hidden = !can(ctx, "query_stories");
      for (const { count, stack } of columns) {
        count.replaceChildren();
        stack.replaceChildren();
      }
    } else {
      ledgerResult = undefined;
      tableWrap.replaceChildren();
    }
    if (!can(ctx, "query_stories")) {
      put(status, "p", "当前职责没有查询需求的权限。", "empty-inline");
      return;
    }
    const options = { signal: ctx.signal, current };
    const mayAct = designEditable || can(ctx, "close_stories");
    const finishers = [];
    if (board) {
      for (const { count, stack } of columns) {
        finishers.push(beginSkeleton(count, countSkeleton, options));
        finishers.push(
          beginSkeleton(
            stack,
            (doc) => boardStackSkeleton(doc, mayAct),
            options,
          ),
        );
      }
    } else {
      ledgerBody(tableWrap);
      finishers.push(
        beginSkeleton(
          tableWrap,
          (doc) => {
            const scene = doc.createElement("div");
            fillLedgerSkeleton(ledgerBody(scene));
            return scene;
          },
          options,
        ),
      );
    }
    const finish = () => finishers.forEach((stop) => stop());
    finishPending = finish;
    try {
      const result = accepted(
        await ctx.call("query_stories", {
          status: ["all"],
          ...(board
            ? { category: "design", limit: 100 }
            : {
                ...(filter && { progress: [filter] }),
                ...(keyword && { keyword }),
                page: ledgerPage,
                limit: ledgerPageSize,
              }),
        }),
      );
      if (!current()) return;
      if (!board) {
        const totalItems = result.data.total ?? total(result);
        const totalPages = Math.max(1, Math.ceil(totalItems / ledgerPageSize));
        if (ledgerPage > totalPages && !result.data.items.length) {
          ledgerPage = totalPages;
          return load();
        }
      }
      status.replaceChildren();
      statusOf(status, result);
      const { items, countsByProgress } = result.data;
      if (board) {
        if (result.completeness !== "partial")
          ctx.setBadge?.("stories", countsByProgress.待移交 ?? 0);
        evidence(status, result);
        designBoard(
          boardOther,
          ctx,
          columns,
          items,
          result.completeness !== "partial" && !result.truncated,
        );
      } else {
        if (!filter && !keyword) {
          const allCount =
            result.completeness === "partial" ? undefined : total(result);
          choose.controls.get("all-stories").textContent =
            allCount === undefined
              ? "全部需求台账"
              : `全部需求台账 (${allCount})`;
          all.textContent =
            allCount === undefined ? "全部阶段" : `全部阶段 (${allCount})`;
        }
        for (const name of Object.keys(countsByProgress)) {
          if (known.has(name)) continue;
          known.add(name);
          put(select, "option", name).value = name;
        }
        ledgerResult = result;
        showLedger();
        ledgerPager.replaceChildren();
        const totalItems = result.data.total ?? total(result);
        const totalPages = Math.max(1, Math.ceil(totalItems / ledgerPageSize));
        if (totalPages > 1 || ledgerPage > 1) {
          ledgerPager.hidden = false;
          const prev = button(ledgerPager, "上一页", () => {
            if (ledgerPage <= 1) return;
            ledgerPage -= 1;
            void load();
          });
          prev.disabled = ledgerPage <= 1;
          put(
            ledgerPager,
            "span",
            result.completeness === "partial"
              ? `第 ${ledgerPage} / ${totalPages} 页（已读取 ${totalItems} 条，数据不完整）`
              : `第 ${ledgerPage} / ${totalPages} 页（共 ${totalItems} 条）`,
            "daily-pager-info",
          );
          const next = button(ledgerPager, "下一页", () => {
            if (ledgerPage >= totalPages) return;
            ledgerPage += 1;
            void load();
          });
          next.disabled = ledgerPage >= totalPages;
        } else {
          ledgerPager.hidden = true;
        }
        evidence(status, result);
      }
    } catch (error) {
      if (current()) {
        if (board) boardGrid.hidden = true;
        status.replaceChildren();
        outcome(status, error.message || "无法读取需求。", load);
      }
    } finally {
      finish();
      if (finishPending === finish) finishPending = undefined;
    }
  }
  return load();
}

function tasks(parent, items) {
  const list = put(parent, "ul", undefined, "drawer-task-list");
  for (const task of items) {
    const state = Object.hasOwn(taskStates, task.status) ? task.status : "wait";
    const row = put(list, "li", undefined, `drawer-task-row is-${state}`);
    const name = put(row, "div", undefined, "drawer-task-name");
    safeLink(name, `#${task.id} ${task.name}`, task.url);
    if (task.isParent) pill(name, "父任务不重复统计", "warn");
    const meta = put(row, "div", undefined, "drawer-task-right");
    pill(
      meta,
      taskStates[task.status] ?? task.status,
      state === "done" || state === "closed"
        ? "success"
        : state === "doing"
          ? "primary"
          : "muted",
    );
    if (task.deadline)
      pill(
        meta,
        task.deadline,
        task.timeState === "overdue"
          ? "danger"
          : task.timeState === "due_today"
            ? "warn"
            : "muted",
      );
    if (person(task.assignedTo)) put(meta, "span", person(task.assignedTo));
  }
}

function scopeCard(parent, title, value) {
  const card = put(parent, "section", undefined, "scope-card daily-spec-card");
  put(card, "h4", title, "scope-card-head");
  if (value) put(card, "p", value);
  return card;
}

function devView(parent, data) {
  put(
    parent,
    "p",
    "研发按以下范围、排除项与设计章节开展实现。",
    "card-tab-hint",
  );
  const [scope, exclusions] = (data.scope ?? "").split(
    /\s*不做\s*\/\s*已实现\s*[:：]\s*/u,
    2,
  );
  const work = scopeCard(parent, "本次做什么（N03 必填范围）", scope);
  if (!scope)
    notice(work, "尚未填写本次实现范围，请与状态维护人确认。", "warn");
  scopeCard(
    parent,
    "本次不做什么（排除边界）",
    exclusions || "暂无排除项记录。",
  );
  const design = scopeCard(parent, "设计文档章节 & 验收标准");
  for (const [label, value] of [
    ["设计参考", data.designRef],
    ["验收标准", data.verify],
  ]) {
    const line = put(design, "div", undefined, "scope-ref-line");
    put(line, "strong", `${label}：`);
    put(line, "span", value || "暂无记录");
  }
  if (data.tasks.length) tasks(scopeCard(parent, "关联任务"), data.tasks);
}

function ring(parent, percentage) {
  const wrapper = put(parent, "div", undefined, "viz-ring daily-progress-ring");
  const doc = wrapper.ownerDocument;
  if (doc.createElementNS) {
    const ns = "http://www.w3.org/2000/svg";
    const svg = doc.createElementNS(ns, "svg");
    for (const [key, value] of Object.entries({
      viewBox: "0 0 52 52",
      width: 52,
      height: 52,
      "aria-hidden": "true",
    }))
      svg.setAttribute(key, value);
    for (const foreground of [false, true]) {
      if (foreground && !(percentage > 0)) continue;
      const track = doc.createElementNS(ns, "circle");
      for (const [key, value] of Object.entries({
        cx: 26,
        cy: 26,
        r: 23,
        fill: "none",
        "stroke-width": 5,
        stroke: foreground ? "var(--accent)" : "var(--border-hairline)",
      }))
        track.setAttribute(key, value);
      if (foreground) {
        track.setAttribute("pathLength", "100");
        track.setAttribute("stroke-dasharray", `${percentage} 100`);
        track.setAttribute("stroke-linecap", "round");
        track.setAttribute("transform", "rotate(-90 26 26)");
      }
      svg.append(track);
    }
    wrapper.append(svg);
  }
  put(
    wrapper,
    "span",
    percentage == null ? "—" : `${percentage}%`,
    "viz-ring-label",
  );
}

function stagePipeline(parent, stages) {
  const flow = put(parent, "div", undefined, "viz-stage-flow");
  const glyphs = { done: "✓", doing: "●", missing: "!", waived: "–" };
  for (const [index, entry] of stages.entries()) {
    const { stage, state, tasks, required } = entry;
    const step = put(flow, "div", undefined, "viz-stage-step");
    if (index > 0)
      put(
        step,
        "span",
        undefined,
        `viz-stage-line${stages[index - 1].state === "done" ? " is-done" : ""}`,
      );
    const name = stageNames[stage] ?? stage;
    const [label] = stageStates[state] ?? [state];
    const node = put(step, "div", undefined, `viz-stage-node is-${state}`);
    node.title = `${name} · ${label}${required ? "（必需）" : "（可选）"}`;
    const count = new Set(
      tasks.filter(({ isParent }) => !isParent).map(({ id }) => id),
    ).size;
    put(node, "span", glyphs[state] ?? "○", "viz-stage-dot").setAttribute(
      "aria-hidden",
      "true",
    );
    put(node, "span", name, "viz-stage-name");
    put(node, "span", count ? `${label} (${count})` : label, "viz-stage-state");
  }
}

function overview(parent, ctx, data, result) {
  const { story, progress: stage, people, stages, related, risks } = data;
  const items = [
    ...new Map(
      stages.flatMap(({ tasks }) => tasks.map((task) => [task.id, task])),
    ).values(),
  ];
  const leaves = items.filter(
    ({ isParent, status }) => !isParent && status !== "cancel",
  );
  const done = leaves.filter(
    ({ status }) => status === "done" || status === "closed",
  ).length;
  const complete = result.completeness !== "partial" && !result.truncated;
  const hero = put(parent, "div", undefined, "drawer-progress-hero");
  const main = put(hero, "div", undefined, "drawer-progress-hero-main");
  ring(
    main,
    complete && leaves.length
      ? Math.round((100 * done) / leaves.length)
      : undefined,
  );
  const text = put(main, "div", undefined, "drawer-progress-text");
  const title = put(text, "div", undefined, "drawer-progress-title");
  progress(title, stage);
  put(
    title,
    "span",
    complete
      ? leaves.length
        ? `已完成 ${done} / ${leaves.length} 项叶子任务`
        : "尚未读到叶子任务"
      : `当前已读取 ${leaves.length} 项叶子任务`,
  );
  if (stage?.basis) put(text, "div", stage.basis, "drawer-progress-sub");
  if (story.version) pill(hero, story.version);
  const peopleRows = [
    [
      "当前处理人（指派给）",
      person(story.currentOwner) || people.currentOwner,
      "accent",
    ],
    ["状态维护人", person(story.maintainer) || people.maintainer, "purple"],
    ["接收研发主管", person(story.receiver) || people.receiver, "success"],
    ["提出人", people.raisedBy, "warn"],
  ];
  const grid = put(parent, "div", undefined, "drawer-meta-card");
  for (const [label, value, tone] of peopleRows) {
    const cell = put(grid, "div", undefined, "drawer-meta-cell");
    put(cell, "span", label);
    ownerChip(put(cell, "div"), value, tone);
  }
  const phase = put(parent, "section", undefined, "drawer-section");
  put(
    phase,
    "h4",
    `阶段进度管线（${items.filter(({ isParent }) => !isParent).length} 条叶子任务）`,
  );
  if (stages.length) stagePipeline(phase, stages);
  if (items.length) tasks(phase, items);
  else put(phase, "p", "当前可读阶段内暂无关联任务。", "empty-inline");
  const reference = (name, ids) => [
    name,
    [...new Set(ids.filter(Boolean))].map((id) => `#${id}`).join("、"),
  ];
  const links = [
    reference("关联用户需求", related.requirements ?? [related.requirement]),
    reference("配对需求", related.pairs ?? [related.pair]),
    reference("派生来源", [related.derivesFrom]),
  ];
  if (links.some(([, ids]) => ids) || related.bugs.length || risks.length) {
    const more = scopeCard(parent, "关联与风险");
    for (const [label, ids] of links)
      if (ids) put(more, "p", `${label} ${ids}`);
    for (const bug of related.bugs)
      safeLink(put(more, "p"), `缺陷 #${bug.id} ${bug.title}`, bug.url);
    for (const { rule, reason, suggestion, level, waived } of risks) {
      put(
        more,
        "p",
        [
          rule,
          reason,
          suggestion,
          level === "inferred" && "推测",
          waived && `已豁免 ${waived.reason}`,
        ]
          .filter(Boolean)
          .join(" · "),
        "page-sub",
      );
    }
  }
  const actions = put(parent, "div", undefined, "drawer-cta-bar");
  storyActions(
    actions,
    ctx,
    { ...story, progress: stage },
    {
      drawer: true,
      designEmpty: complete && !items.length,
    },
  );
  if (
    ctx.role.id === "RM" &&
    story.category === "feature" &&
    story.status === "active" &&
    can(ctx, "decompose_stories")
  ) {
    const next = stages.find(
      ({ stage, required, state }) =>
        ["test", "acceptance", "delivery"].includes(stage) &&
        required &&
        state === "missing",
    );
    if (next && next.stage === story.nextStage)
      button(
        actions,
        `补建【${stageNames[next.stage]}】任务`,
        () =>
          ctx.openTool(
            "decompose_stories",
            { storyIds: [story.id], template: "next_stage" },
            { preview: true },
          ),
        "btn-primary btn-sm",
      );
  }
  const link = safeLink(actions, "在禅道查看原需求", story.url);
  link.className = "link-inline";
}

function businessCard(parent, result, current, ctx) {
  const { story, card, people, progress: stage } = result.data;
  if (!card) {
    notice(parent, "当前未读到可转发的进度卡片。", "warn");
    return;
  }
  const business = bizProgress({ ...story, progress: stage });
  const visual = put(
    parent,
    "div",
    undefined,
    `biz-card-visual tone-${business.tone}`,
  );
  const hero = put(visual, "div", undefined, "biz-card-hero");
  const title = put(hero, "div", undefined, "biz-card-hero-left");
  const badges = put(title, "div", undefined, "biz-card-badges");
  pill(badges, business.title, business.tone);
  put(badges, "span", `#${story.id}`, "mono req-id");
  if (story.version) pill(badges, story.version);
  put(title, "div", story.title, "biz-card-title");
  put(
    title,
    "div",
    [story.product?.name, story.module?.path].filter(Boolean).join(" · "),
    "biz-card-meta",
  );
  const steps = put(visual, "div", undefined, "biz-card-stepband");
  bizStepper(steps, business);
  const tiles = put(visual, "div", undefined, "biz-card-tiles");
  const next =
    story.nextStage === "handoff"
      ? "交接设计方案"
      : stageNames[story.nextStage];
  for (const [label, value] of [
    ["当前负责人", person(story.currentOwner) || people.currentOwner],
    ["进度联系人", person(story.maintainer) || people.maintainer],
    ["下一步里程碑", next],
  ]) {
    const tile = put(tiles, "div", undefined, "biz-card-tile");
    put(tile, "span", label, "biz-card-tile-label");
    put(tile, "div", value || "待确认", "biz-card-tile-value");
  }
  if (result.scope?.asOf)
    put(visual, "div", `数据时间 ${result.scope.asOf}`, "biz-card-foot mono");
  const actions = put(parent, "div", undefined, "row-actions");
  const feedback = put(parent, "p", "", "page-sub daily-card-feedback");
  feedback.setAttribute("role", "status");
  const rawCard = put(parent, "pre", card, "card-preview-box");
  rawCard.hidden = true;
  button(
    actions,
    "一键复制企微进度卡",
    async () => {
      if (!current()) return;
      try {
        await navigator.clipboard.writeText(card);
        if (current()) {
          feedback.textContent = "进度卡片已复制。";
          ctx?.toast?.("进度卡片已复制", "success");
        }
      } catch {
        if (!current()) return;
        if (rawCard.hidden) toggle.click?.();
        feedback.textContent = "浏览器未能复制，请选中卡片内容手动复制。";
      }
    },
    "btn-primary",
    "Copy",
  );
  const toggle = button(
    actions,
    "查看企微纯文本",
    () => {
      rawCard.hidden = !rawCard.hidden;
      toggle.textContent = rawCard.hidden ? "查看企微纯文本" : "收起企微纯文本";
      toggle.setAttribute("aria-expanded", String(!rawCard.hidden));
    },
    "btn-secondary btn-sm",
  );
  toggle.setAttribute("aria-expanded", "false");
}

export async function renderStoryDrawer(container, ctx, id, tab = "full") {
  container.replaceChildren();
  const fb = ctx.role.id === "FB";
  const head = put(container, "header", undefined, "drawer-head");
  const chip = put(head, "div", undefined, "drawer-head-left");
  put(chip, "span", `#${id}`, "mono drawer-code");
  const marks = put(chip, "div", undefined, "daily-story-meta");
  const actions = put(head, "div", undefined, "row-actions");
  const sync = button(actions, "同步详情", async () => {
    sync.disabled = true;
    try {
      await show(true);
    } finally {
      sync.disabled = false;
    }
  });
  const close = button(actions, "", () => ctx.close(), "icon-btn-subtle", "X");
  close.setAttribute("aria-label", "关闭详情抽屉");
  const title = put(container, "div", undefined, "drawer-title-block");
  const label = put(title, "h3", `需求 #${id}`);
  const meta = put(title, "p", "", "drawer-sub-meta");
  const entries = fb
    ? [["card", "业务进度卡片"]]
    : [
        ["full", "进度概览"],
        ["dev", "研发看范围"],
        ["card", "转发给业务"],
      ];
  let active = fb
    ? "card"
    : entries.some(([key]) => key === tab)
      ? tab
      : "full";
  const choices = tabs(
    container,
    "需求详情视图",
    entries,
    active,
    (key) => {
      if (active === key) return;
      active = key;
      choices(active);
      return show();
    },
    true,
  );
  const content = put(
    container,
    "div",
    undefined,
    "drawer-scroll daily-drawer-content",
  );
  const requests = new Map();
  let request = 0;

  function get(view, fresh) {
    if (fresh || !requests.has(view)) {
      const input =
        view === "dev"
          ? { storyId: id, view: "dev" }
          : { storyId: id, format: "card" };
      const job = (
        fresh
          ? ctx.call("get_story_progress", input, "sync")
          : ctx.call("get_story_progress", input)
      )
        .then(accepted)
        .catch((error) => {
          requests.delete(view);
          throw error;
        });
      requests.set(view, job);
    }
    return requests.get(view);
  }

  async function show(fresh = false) {
    const panel = active;
    const pending = ++request;
    const current = () =>
      ctx.current() && content.isConnected && pending === request;
    if (!current()) return;
    const finish = fresh
      ? () => {}
      : beginSkeleton(content, (doc) => drawerSkeleton(doc, panel), {
          signal: ctx.signal,
          current,
        });
    try {
      const result = await get(panel === "dev" ? "dev" : "full", fresh);
      if (!current()) return;
      content.replaceChildren();
      if (result.snapshot?.retained)
        notice(content, "同步失败，仍显示上次保存的详情。", "warn");
      statusOf(content, result);
      const { data } = result;
      if (data.story) {
        const { story } = data;
        label.textContent = story.title;
        meta.textContent = [
          story.product?.name,
          story.module?.path,
          story.feedbackBy && `来源：${story.feedbackBy}`,
          !fb && recordStates[story.status],
        ]
          .filter(Boolean)
          .join(" · ");
        marks.replaceChildren();
        if (!fb) progress(marks, data.progress);
        if (story.version) pill(marks, story.version);
      }
      if (data.candidates) {
        if (!data.candidates.length)
          put(content, "p", "当前范围内未读到需求。", "page-sub");
        for (const item of data.candidates)
          openStoryButton(
            content,
            ctx,
            item.id,
            `#${item.id} ${item.title || "需求"}`,
          );
      } else if (panel === "dev") devView(content, data);
      else if (panel === "card") businessCard(content, result, current, ctx);
      else overview(content, ctx, data, result);
      if (!fb) evidence(content, result);
    } catch (error) {
      if (current()) {
        content.replaceChildren();
        outcome(content, error.message || "无法读取需求详情。", () =>
          show(true),
        );
      }
    } finally {
      finish();
    }
  }
  return show();
}
