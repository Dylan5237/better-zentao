import { add, pendingBlock } from "./meridian-home-controls.js";

export function pendingItems(
  list,
  { group = false, tag = false, actions = 1, actionKind = "button" } = {},
) {
  for (let i = 0; i < 4; i++) {
    if (group && i % 2 === 0)
      pendingBlock(add(list, "h3", undefined, "rd-group-header"), "short");
    const row = add(list, "div", undefined, "item-row");
    const main = add(row, "span", undefined, "item-row-main");
    const title = add(main, "span", undefined, "item-row-title");
    if (tag && i % 2 === 0) pendingBlock(title, "chip");
    pendingBlock(title, "title");
    pendingBlock(add(main, "span", undefined, "item-row-sub"), "text");
    if (actions) {
      const controls = add(row, "div", undefined, "row-actions");
      for (let j = 0; j < actions; j++) pendingBlock(controls, actionKind);
    }
  }
}

export function pendingFeedback(list) {
  for (let i = 0; i < 3; i++) {
    const card = add(list, "div", undefined, "fb-story-card");
    const head = add(card, "div", undefined, "fb-story-top");
    pendingBlock(head, "title");
    const controls = add(head, "div", undefined, "row-actions");
    pendingBlock(controls, "chip");
    pendingBlock(controls, "button");
    const steps = add(card, "div", undefined, "viz-stepper");
    add(steps, "div", undefined, "viz-stepper-rail");
    const nodes = add(steps, "div", undefined, "viz-stepper-nodes");
    for (let j = 0; j < 4; j++) {
      const step = add(nodes, "div", undefined, "viz-step-node");
      pendingBlock(step, "avatar", "viz-step-dot");
      pendingBlock(step, "short", "viz-step-label");
    }
    const meta = add(
      card,
      "div",
      undefined,
      "fb-story-meta workbench-feedback-meta",
    );
    pendingBlock(meta, "text");
  }
}

export function pendingDistribution(parent, legendItems, summary = false) {
  pendingBlock(parent, "text", "viz-stacked-bar workbench-pending-bar");
  const legend = add(
    parent,
    "div",
    undefined,
    summary ? "l3-dist-legend" : "l3-tile-meta",
  );
  for (let i = 0; i < legendItems; i++) pendingBlock(legend, "chip");
}

export function pendingPlanTiles(list) {
  for (let i = 0; i < 4; i++) {
    const tile = add(list, "div", undefined, "l3-tile");
    const head = add(tile, "div", undefined, "l3-tile-head");
    pendingBlock(head, "title", "l3-tile-title");
    pendingBlock(head, "short", "l3-tile-ratio");
    pendingDistribution(tile, 3);
  }
}
