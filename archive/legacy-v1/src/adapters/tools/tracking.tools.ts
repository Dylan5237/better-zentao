import { dashboardInput, overdueInput, progressInput, queryInput } from "../../services/inputs.js";
import { defineTool } from "./definition.js";

export const trackingTools = [
  defineTool({
    name: "get_my_dashboard", command: "me", schema: dashboardInput, readOnly: true,
    description: "查看当前用户的逾期及临期任务、待办数量、指派给我的需求与我提出的需求。",
    cli: { upcomingDays: "number" },
    invoke: (client, input) => client.tracking.getMyDashboard(input),
  }),
  defineTool({
    name: "get_team_overdue", command: "overdue", schema: overdueInput, readOnly: true,
    description: "按部门、团队别名或成员统计逾期任务。默认本部门，排除父任务并拆分多人协作任务。",
    cli: { team: "text", department: "reference", members: "list", includeParentTasks: "boolean", includeMultiUserDetail: "boolean" },
    invoke: (client, input) => client.tracking.getTeamOverdue(input),
  }),
  defineTool({
    name: "query_stories", command: "stories", schema: queryInput, readOnly: true,
    description: "跨页查询单产品的研发需求或用户需求，按状态、阶段、类别、计划、人员或反馈者过滤。",
    cli: {
      product: "reference", state: "text", keyword: "text", category: "text", status: "text", stage: "text",
      plan: "reference", assignedTo: "text", openedBy: "text", feedbackBy: "text", storyType: "text",
      limit: "id", maxScanPages: "id",
    },
    invoke: (client, input) => client.tracking.queryStories(input),
  }),
  defineTool({
    name: "get_story_progress", command: "progress", schema: progressInput, readOnly: true, positional: ["storyId"],
    description: "按研发需求 ID、用户需求 ID 或反馈者查询需求、关联任务及逾期情况，生成中文进度摘要。",
    cli: { storyId: "id", requirementId: "id", feedbackBy: "text", product: "reference", includeActions: "boolean" },
    invoke: (client, input) => client.tracking.getStoryProgress(input),
  }),
];
