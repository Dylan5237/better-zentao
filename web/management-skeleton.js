import { skeletonBlock, skeletonRows, skeletonText } from "./skeleton.js";

function add(parent, tag, className) {
  const node = parent.ownerDocument.createElement(tag);
  node.className = className;
  parent.append(node);
  return node;
}

function element(doc, className) {
  const node = doc.createElement("div");
  node.className = className;
  return node;
}

function withClass(node, className) {
  node.className += ` ${className}`;
  return node;
}

export function bucketValue(doc) {
  return withClass(skeletonBlock(doc, "value"), "management-skel-bucket-value");
}

export function progressTrack(doc) {
  return withClass(skeletonBlock(doc), "management-skel-track");
}

function tableFrame(doc, columns, className) {
  const wrap = element(doc, `table-wrap ${className}`);
  const table = add(wrap, "table", "bzt-table");
  const headings = add(add(table, "thead", ""), "tr", "");
  for (const label of columns) add(headings, "th", "").textContent = label;
  const body = add(table, "tbody", "");
  return { wrap, body };
}

export function queueTable(doc, columns, selectable) {
  const { wrap, body } = tableFrame(
    doc,
    columns,
    "vp-table-scroll management-skel-queue-table",
  );
  for (let i = 0; i < 4; i++) {
    const row = add(body, "tr", "");
    const identity = add(
      add(row, "td", ""),
      "div",
      "ledger-title-row management-skel-ledger-title",
    );
    if (selectable)
      identity.append(withClass(skeletonBlock(doc), "management-skel-check"));
    identity.append(skeletonBlock(doc, "short"), skeletonBlock(doc));
    add(row, "td", "").append(skeletonBlock(doc, "short"));
    add(row, "td", "").append(skeletonBlock(doc, "chip"));
    const actions = add(add(row, "td", ""), "div", "row-actions is-end");
    actions.append(skeletonBlock(doc, "button"));
    if (selectable) actions.append(skeletonBlock(doc, "button"));
  }
  return wrap;
}

export function scheduleMatrix(doc, self) {
  const wrap = element(
    doc,
    "table-wrap vp-table-scroll management-skel-matrix",
  );
  const table = add(wrap, "table", "bzt-table heatmap-table");
  const head = add(add(table, "thead", ""), "tr", "");
  const columns = [
    self ? "本人" : "成员",
    "第 1 周",
    "第 2 周",
    "第 3 周",
    "第 4 周",
    "逾期",
    "未排期",
  ];
  for (const [index, label] of columns.entries()) {
    const header = add(head, "th", "");
    header.textContent = label;
    if (index >= 1 && index <= 4)
      add(header, "div", "th-sub").append(skeletonBlock(doc, "short"));
  }
  const body = add(table, "tbody", "");
  for (let i = 0; i < (self ? 1 : 4); i++) {
    const row = add(body, "tr", "");
    add(add(row, "td", ""), "div", "member-cell").append(skeletonText(doc));
    for (let week = 0; week < 4; week++) {
      const cell = add(row, "td", "heat-td");
      add(cell, "div", "heat-cell management-skel-heat").append(
        skeletonText(doc),
      );
    }
    for (let i = 0; i < 2; i++)
      add(row, "td", "").append(skeletonBlock(doc, "chip"));
  }
  if (self) {
    const tasks = add(add(body, "tr", "heat-expand-row"), "td", "");
    tasks.colSpan = columns.length;
    add(tasks, "div", "member-tasks-box").append(skeletonText(doc));
  }
  return wrap;
}

function itemList(
  doc,
  className,
  count,
  { chips = 0, action = "button", lines = 1 } = {},
) {
  const list = skeletonRows(doc, count, (row) => {
    const main = add(row, "div", "item-row-main");
    const title = add(main, "div", "item-row-title");
    for (let chip = 0; chip < chips; chip++)
      title.append(skeletonBlock(doc, "chip"));
    title.append(skeletonBlock(doc, "title"));
    if (lines)
      add(main, "div", "item-row-sub").append(skeletonText(doc, lines));
    if (action) row.append(skeletonBlock(doc, action));
  });
  list.className = `item-list vp-scroll ${className}`;
  return list;
}

export function recommendations(doc) {
  return itemList(doc, "management-skel-recommendations", 3, {
    chips: 1,
    action: null,
  });
}

export function riskList(doc) {
  return itemList(doc, "management-skel-risk-list", 4, { chips: 2, lines: 2 });
}

export function gateCopy(doc) {
  const copy = element(doc, "sk-lines management-skel-gate-copy");
  copy.append(skeletonBlock(doc, "title"), skeletonBlock(doc));
  return copy;
}

export function gateList(doc) {
  return itemList(doc, "management-skel-gate-list", 3);
}

export function metricRing(doc) {
  return withClass(skeletonBlock(doc, "avatar"), "management-skel-ring");
}

export function l3Groups(doc) {
  const groups = element(
    doc,
    "l3-bars is-two-col vp-scroll management-skel-l3",
  );
  for (let i = 0; i < 4; i++) {
    const tile = add(groups, "div", "l3-tile");
    add(tile, "div", "l3-tile-head").append(
      skeletonBlock(doc, "title"),
      skeletonBlock(doc, "short"),
    );
    tile.append(progressTrack(doc), skeletonText(doc, 1));
  }
  return groups;
}

export function pairedProgress(doc) {
  const list = element(doc, "item-list vp-scroll management-skel-pairs");
  for (let i = 0; i < 2; i++) {
    const row = add(list, "div", "pair-compare-row");
    for (let side = 0; side < 2; side++)
      add(row, "div", "pair-side").append(skeletonText(doc, 3));
  }
  return list;
}

export function iterationMetrics(doc, columns) {
  const { wrap, body } = tableFrame(doc, columns, "management-skel-iteration");
  const row = add(body, "tr", "");
  for (const [i] of columns.entries())
    add(row, "td", "").append(skeletonBlock(doc, i < 2 ? "short" : "text"));
  return wrap;
}

export function commitmentList(doc) {
  return itemList(doc, "management-skel-commitment", 5, {
    action: "chip",
    lines: 0,
  });
}

export function assistantReply(doc) {
  const reply = element(doc, "management-skel-reply");
  reply.append(skeletonText(doc), skeletonBlock(doc, "button"));
  return reply;
}
