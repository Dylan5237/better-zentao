import {
  skeletonBlock,
  skeletonCard,
  skeletonTable,
  skeletonText,
} from "./skeleton.js";

const queryShapes = {
  get_my_work: [0, 6],
  get_team_work: [3, 9],
  get_member_schedule: [0, 6],
  query_stories: [4, 7],
  get_story_progress: [6, 4],
  scan_workflow_risks: [4, 8],
  get_monthly_dev_queue: [7, 9],
};
const planShapes = {
  plan: [4, 10],
  release: [7, 3],
  iteration: [6, 8],
  commitment: [3, 2],
};

export function querySkeleton(doc, tool, input) {
  const [metrics, columns] =
    tool === "get_plan_progress"
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
      grid.append(skeletonCard(doc, skeletonBlock(doc, "short"), "metric"));
    }
    root.append(grid);
  }
  const weeklyColumns =
    tool === "get_member_schedule" && input.bucket !== "day" && input.weeks;
  const taskList = tool === "get_story_progress" && input.view === "dev";
  const count = weeklyColumns ? Math.min(input.weeks, 12) + 2 : columns;
  root.append(skeletonTable(doc, taskList ? 8 : count));
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
