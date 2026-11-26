import { icon } from "./meridian-icons.js";
import { skeletonBlock } from "./skeleton.js";

export const go = (ctx, view, tab) => () =>
  tab ? ctx.navigate(view, { tab }) : ctx.navigate(view);
export const allowed = (ctx, tool) => ctx.role.actions.includes(tool);
export const toolAction = (ctx, tool, input) =>
  allowed(ctx, tool) ? () => ctx.openTool(tool, input) : undefined;
export const storyAction = (ctx, id, tab = "full") =>
  id && allowed(ctx, "get_story_progress")
    ? () => ctx.openStory(id, tab)
    : undefined;

export function createFromRequirement(ctx, story) {
  if (!allowed(ctx, "create_story")) return;
  return () =>
    ctx.navigate("intake", {
      requirementId: story.id,
      title: story.title,
      category: "feature",
      ...(story.product?.id && { product: String(story.product.id) }),
      ...(story.module?.id && { module: String(story.module.id) }),
      ...(story.feedbackBy && { feedbackBy: story.feedbackBy }),
    });
}

export function add(parent, tag, text, className) {
  const node = parent.ownerDocument.createElement(tag);
  if (text !== undefined) node.textContent = String(text);
  if (className) node.className = className;
  parent.append(node);
  return node;
}

export function pendingBlock(parent, kind, className) {
  const block = skeletonBlock(parent.ownerDocument, kind);
  if (className) block.className += " " + className;
  parent.append(block);
  return block;
}

export function addIcon(parent, name, size) {
  parent.append(icon(name, size, parent.ownerDocument));
}

export function button(parent, text, click, variant = "btn-secondary", symbol) {
  if (!click) return;
  const control = add(
    parent,
    "button",
    symbol ? undefined : text,
    variant === "btn-sm" || variant === "btn-xs"
      ? "btn-secondary " + variant
      : variant,
  );
  if (symbol) {
    addIcon(control, symbol, 15);
    add(control, "span", text);
  }
  control.type = "button";
  control.addEventListener("click", click);
  return control;
}

export function badge(parent, text, tone) {
  return add(
    parent,
    "span",
    text,
    tone ? "bzt-badge tone-" + tone + " tabular" : "bzt-badge tabular",
  );
}

export function person(value) {
  return value?.realname || value?.account || "待确认";
}

export function unique(items = []) {
  return [...new Map(items.map((item) => [item.id, item])).values()];
}

export function limited(result) {
  return result?.completeness === "partial" || result?.truncated;
}

export function count(result, total, suffix = "") {
  if (!result?.data || !Number.isFinite(total)) return "—";
  if (!limited(result)) return `${total}${suffix}`;
  return total > 0 ? `≥${total}${suffix}` : "—";
}

export function emptyText(result, text) {
  if (!result?.data) return "暂未取得数据";
  return limited(result) ? "已读取范围内暂无可展示记录" : text;
}

export function progressTitle(progress) {
  if (!progress) return "进展待确认";
  return progress.level === "inferred"
    ? `${progress.value}（推测）`
    : progress.value;
}

export function externalLink(
  parent,
  label,
  href,
  className = "btn-secondary btn-sm",
) {
  if (!href) return;
  let url;
  try {
    url = new URL(href);
  } catch {
    return;
  }
  if (
    !["http:", "https:"].includes(url.protocol) ||
    url.username ||
    url.password
  )
    return;
  const link = add(parent, "a", label, className);
  link.setAttribute("href", url.href);
  link.setAttribute("target", "_blank");
  link.setAttribute("rel", "noopener noreferrer");
}

export function choice(label, rows, value, name = value) {
  const options = new Map();
  for (const row of rows) {
    const key = value(row);
    if (key !== undefined && key !== null && key !== "")
      options.set(String(key), name(row) ?? String(key));
  }
  return { label, value, options };
}

export function storySearch(story) {
  return [
    "#" + story.id,
    story.title,
    story.product?.name,
    story.module?.path,
    story.feedbackBy,
    person(story.maintainer),
    person(story.currentOwner),
  ]
    .filter(Boolean)
    .join(" ");
}

export function taskSearch(task) {
  return [
    "#" + task.id,
    task.name,
    task.story?.title,
    task.execution?.name,
    person(task.assignedTo),
  ]
    .filter(Boolean)
    .join(" ");
}

export function storyChoices(rows) {
  return [
    choice(
      "全部产品",
      rows,
      (row) => row.product?.id,
      (row) => row.product?.name,
    ),
    choice(
      "全部模块",
      rows,
      (row) => row.module?.id,
      (row) => row.module?.path,
    ),
    choice(
      "全部类型",
      rows,
      (row) => row.category,
      (row) => categoryLabel(row.category),
    ),
    choice("全部阶段", rows, (row) => row.progress?.value),
    choice("全部版本", rows, (row) => row.version),
  ];
}

export function categoryLabel(category) {
  return { design: "设计态", feature: "研发需求", other: "其他" }[category];
}

export function filterControls(
  parent,
  {
    fields,
    search,
    onChange,
    placeholder = "关键词 / #ID…",
    native = false,
    unit = "项",
    pending = false,
  },
) {
  const prefix = native ? "zt" : "hybrid";
  const bar = add(parent, "div", undefined, prefix + "-filter-bar");
  const tallyClass = native ? "zt-count-pill" : "hybrid-hit-badge";
  if (pending) {
    const search = add(
      bar,
      "span",
      undefined,
      prefix + "-input workbench-pending-control",
    );
    pendingBlock(search, "text");
    for (const { label } of fields) {
      const select = add(
        bar,
        "span",
        undefined,
        prefix + "-select workbench-pending-control",
      );
      select.style.setProperty("width", `calc(${label.length}ic + 24px)`);
      pendingBlock(select, "text");
    }
    pendingBlock(add(bar, "span", undefined, tallyClass), "chip");
    const reset = add(
      bar,
      "span",
      undefined,
      prefix + "-reset-btn workbench-pending-control",
    );
    pendingBlock(reset, "text");
    return;
  }
  const input = add(bar, "input", undefined, prefix + "-input");
  input.type = "search";
  input.placeholder = placeholder;
  input.setAttribute("aria-label", placeholder);
  input.addEventListener("input", onChange);
  const controls = fields.map(({ label, value, options }) => {
    const select = add(bar, "select", undefined, prefix + "-select");
    select.setAttribute("aria-label", label);
    add(select, "option", label).value = "";
    for (const [key, text] of options) add(select, "option", text).value = key;
    select.value = "";
    select.addEventListener("change", onChange);
    return { select, value };
  });
  const tally = add(bar, "span", undefined, tallyClass);
  tally.setAttribute("aria-live", "polite");
  button(
    bar,
    native ? "重置" : "清空",
    () => {
      input.value = "";
      for (const { select } of controls) select.value = "";
      onChange();
    },
    native ? "zt-reset-btn" : "hybrid-reset-btn",
  );
  function reset() {
    input.value = "";
    for (const { select } of controls) select.value = "";
    onChange();
  }
  return {
    reset,
    hasActive() {
      return Boolean(
        input.value.trim() ||
        controls.some(({ select }) => Boolean(select.value)),
      );
    },
    matches(row) {
      const keyword = input.value.trim().toLowerCase();
      return (
        (!keyword || search(row).toLowerCase().includes(keyword)) &&
        controls.every(
          ({ select, value }) =>
            !select.value || String(value(row)) === select.value,
        )
      );
    },
    tally(result, total) {
      const summary = count(result, total, " " + unit);
      tally.textContent =
        native && summary !== "—" ? "命中 " + summary : summary;
    },
  };
}
