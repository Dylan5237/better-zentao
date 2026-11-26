import { skeletonBlock, skeletonText } from "./skeleton.js";

function place(doc, tag, className, ...children) {
  const node = doc.createElement(tag);
  if (className) node.className = className;
  node.append(...children);
  return node;
}

function bars(doc, className, ...kinds) {
  return place(
    doc,
    "div",
    className,
    ...kinds.map((kind) => skeletonBlock(doc, kind)),
  );
}

export function intakeListSkeleton(doc, { business, mayAct }) {
  const list = place(doc, "div", "item-list");
  for (let i = 0; i < 3; i++) {
    const card = place(
      doc,
      "div",
      "req-intake-card",
      bars(doc, "req-intake-top", "chip", "chip"),
      bars(doc, "req-intake-title", "title"),
    );
    if (business) {
      const step = place(doc, "div", "viz-mini-prog");
      step.append(
        bars(doc, "viz-mini-segs", "text", "text", "text", "text"),
        bars(doc, "viz-mini-labels", "short", "short", "short", "short"),
      );
      card.append(step);
    }
    const foot = place(doc, "div", "req-intake-foot");
    if (business)
      foot.append(bars(doc, "daily-skeleton-owner", "avatar", "chip"));
    else foot.append(skeletonBlock(doc, "short"));
    if (mayAct) foot.append(skeletonBlock(doc, "button"));
    card.append(foot);
    list.append(card);
  }
  return list;
}

export function boardStackSkeleton(doc, mayAct) {
  const stack = place(doc, "div", "board-col-stack");
  for (let i = 0; i < 2; i++) {
    const row = place(
      doc,
      "div",
      "story-board-card",
      bars(doc, "story-card-top", "chip", "chip"),
      bars(doc, "story-card-title", "title"),
      bars(doc, "story-card-foot", "short", ...(mayAct ? ["button"] : [])),
    );
    stack.append(row);
  }
  return stack;
}

export function fillLedgerSkeleton(body) {
  const doc = body.ownerDocument;
  for (let i = 0; i < 4; i++) {
    const row = place(
      doc,
      "tr",
      "",
      place(
        doc,
        "td",
        "",
        bars(doc, "ledger-title-row", "chip", "title"),
        skeletonBlock(doc, "short"),
      ),
      place(
        doc,
        "td",
        "",
        place(
          doc,
          "div",
          "ledger-stage-cell",
          skeletonBlock(doc, "chip"),
          bars(
            doc,
            "stage-pipeline is-compact daily-skeleton-stages",
            "chip",
            "chip",
            "chip",
            "chip",
            "chip",
          ),
        ),
      ),
      place(doc, "td", "", skeletonText(doc)),
      place(doc, "td", "", skeletonBlock(doc, "button")),
    );
    body.append(row);
  }
}

function scopeSkeleton(doc) {
  const content = place(doc, "div", "daily-skeleton-drawer");
  content.append(skeletonBlock(doc));
  for (const lines of [3, 2, 2])
    content.append(
      place(
        doc,
        "section",
        "scope-card daily-spec-card",
        bars(doc, "scope-card-head", "title"),
        skeletonText(doc, lines),
      ),
    );
  return content;
}

function overviewSkeleton(doc) {
  const content = place(doc, "div", "daily-skeleton-drawer");
  const hero = place(
    doc,
    "div",
    "drawer-progress-hero",
    place(
      doc,
      "div",
      "drawer-progress-hero-main",
      bars(doc, "daily-progress-ring", "avatar"),
      place(
        doc,
        "div",
        "drawer-progress-text",
        bars(doc, "drawer-progress-title", "chip", "text"),
        skeletonBlock(doc),
      ),
    ),
  );
  const owners = place(doc, "div", "drawer-meta-card");
  for (const label of [
    "当前处理人（指派给）",
    "状态维护人",
    "接收研发主管",
    "提出人",
  ]) {
    const heading = place(doc, "span", "");
    heading.textContent = label;
    owners.append(
      place(
        doc,
        "div",
        "drawer-meta-cell",
        heading,
        bars(doc, "daily-skeleton-owner", "avatar", "chip"),
      ),
    );
  }
  const phase = place(doc, "section", "drawer-section");
  const heading = place(doc, "h4", "");
  heading.textContent = "阶段进度管线";
  const flow = place(doc, "div", "viz-stage-flow");
  for (let i = 0; i < 5; i++)
    flow.append(
      place(
        doc,
        "div",
        "viz-stage-step",
        place(
          doc,
          "div",
          "viz-stage-node",
          skeletonBlock(doc, "avatar"),
          skeletonBlock(doc, "chip"),
        ),
      ),
    );
  const tasks = place(doc, "ul", "drawer-task-list");
  for (let i = 0; i < 3; i++)
    tasks.append(
      place(
        doc,
        "li",
        "drawer-task-row",
        skeletonBlock(doc, "title"),
        bars(doc, "drawer-task-right", "chip", "chip"),
      ),
    );
  phase.append(heading, flow, tasks);
  content.append(hero, owners, phase);
  return content;
}

function businessSkeleton(doc) {
  const content = place(doc, "div", "daily-skeleton-drawer");
  const hero = place(
    doc,
    "div",
    "biz-card-hero",
    place(
      doc,
      "div",
      "biz-card-hero-left",
      bars(doc, "biz-card-badges", "chip", "chip"),
      bars(doc, "biz-card-title", "title"),
      bars(doc, "biz-card-meta", "short"),
    ),
  );
  const steps = place(doc, "div", "viz-stepper-nodes");
  for (let i = 0; i < 4; i++)
    steps.append(bars(doc, "viz-step-node", "avatar", "chip"));
  const tiles = place(doc, "div", "biz-card-tiles");
  for (const label of ["当前负责人", "进度联系人", "下一步里程碑"]) {
    const heading = place(doc, "span", "biz-card-tile-label");
    heading.textContent = label;
    tiles.append(
      place(doc, "div", "biz-card-tile", heading, skeletonBlock(doc, "text")),
    );
  }
  content.append(
    place(
      doc,
      "div",
      "biz-card-visual",
      hero,
      place(
        doc,
        "div",
        "biz-card-stepband",
        place(doc, "div", "viz-stepper", steps),
      ),
      tiles,
    ),
    bars(doc, "row-actions", "button", "button"),
  );
  return content;
}

export function drawerSkeleton(doc, panel) {
  if (panel === "dev") return scopeSkeleton(doc);
  if (panel === "card") return businessSkeleton(doc);
  return overviewSkeleton(doc);
}

export function previewSkeleton(doc) {
  const steps = place(doc, "ol", "preview-steps-list");
  for (let i = 0; i < 2; i++) {
    const fields = place(doc, "div", "preview-fields-wrap");
    for (let j = 0; j < 3; j++)
      fields.append(bars(doc, "preview-field-pill", "chip", "chip"));
    steps.append(
      place(
        doc,
        "li",
        "preview-step-card",
        bars(doc, "preview-step-target", "chip", "title"),
        fields,
      ),
    );
  }
  return place(
    doc,
    "div",
    "daily-preview-skeleton",
    place(doc, "div", "bzt-alert tone-info", skeletonText(doc)),
    steps,
  );
}

export function receiptSkeleton(doc) {
  const steps = place(doc, "ol", "preview-steps-list");
  for (let i = 0; i < 2; i++)
    steps.append(
      place(
        doc,
        "li",
        "preview-step-card",
        bars(doc, "preview-step-target", "title", "chip"),
      ),
    );
  return place(
    doc,
    "div",
    "daily-receipt-skeleton",
    bars(doc, "bzt-alert", "title"),
    steps,
    bars(doc, "row-actions is-end", "button"),
  );
}
