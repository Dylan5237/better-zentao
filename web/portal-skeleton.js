import { skeletonBlock, skeletonTable, skeletonText } from "./skeleton.js";

const queryShapes = {
  resolve_context: [8, 5],
  get_my_work: [0, 6],
  get_team_work: [3, 9],
  get_member_schedule: [0, 7],
  query_stories: [4, 8],
  get_story_progress: [4, 8],
  scan_workflow_risks: [4, 6],
  get_operation: [1, 5],
  get_monthly_dev_queue: [7, 10],
};
const planShapes = { plan: [4, 8], release: [7, 3], iteration: [6, 8], commitment: [4, 2] };

export function querySkeleton(doc, tool, input) {
  const [metrics, columns] = tool === "get_plan_progress"
    ? (planShapes[input.view] ?? planShapes.plan)
    : queryShapes[tool];
  const root = doc.createElement("div");
  root.className = "sk-query";
  root.append(skeletonText(doc, 1));
  if (tool === "get_story_progress" && input.view === "dev") {
    root.append(skeletonText(doc, 3));
  } else if (metrics) {
    const grid = doc.createElement("div");
    grid.className = "metrics";
    for (let i = 0; i < metrics; i++) {
      const item = doc.createElement("div");
      item.className = "metric";
      item.append(skeletonText(doc, 2));
      grid.append(item);
    }
    root.append(grid);
  }
  root.append(skeletonTable(doc, columns));
  return root;
}

export function commandSkeleton(doc) {
  const list = doc.createElement("div");
  const group = doc.createElement("div");
  group.className = "cmd-group-label";
  group.append(skeletonBlock(doc, "chip"));
  list.append(group);
  for (let i = 0; i < 3; i++) {
    const row = doc.createElement("div");
    row.className = "cmd-item sk-command";
    row.append(skeletonBlock(doc, "avatar"), skeletonBlock(doc, "text"));
    list.append(row);
  }
  return list;
}

export function roleOptionsSkeleton(doc, count) {
  const grid = doc.createElement("div");
  grid.className = "role-options sk-role-options";
  for (let i = 0; i < count; i++) {
    const row = doc.createElement("div");
    row.className = "role-option";
    row.append(skeletonBlock(doc, "avatar"), skeletonText(doc, 2));
    grid.append(row);
  }
  return grid;
}
