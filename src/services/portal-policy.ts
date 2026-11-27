import { z } from "zod";
import { allTools } from "../contracts/tools/index.ts";
import type { TeamConfig } from "../core/config.ts";
import { BztError } from "../core/errors.ts";

/**
 * CR-009 CAP-01：单一来源的角色工具白名单与参数收窄策略（纯策略模块，零 src/api 依赖）。
 * 供 Portal（src/services/portal.ts）与统一能力调度（src/services/capability-runtime.ts）共同复用。
 */

const personal = [
  "get_my_work",
  "get_story_progress",
  "query_stories",
] as const;
const design = [
  ...personal,
  "get_monthly_dev_queue",
  "get_plan_progress",
  "scan_workflow_risks",
  "create_story",
  "handoff_story",
  "decompose_stories",
] as const;
const management = [
  ...personal,
  "get_member_schedule",
  "get_monthly_dev_queue",
  "get_plan_progress",
  "scan_workflow_risks",
] as const;

export const rolePages = {
  FB: { label: "业务反馈者", actions: [...personal, "create_story"] },
  PM: { label: "产品管理", actions: [...management, "set_story_meta"] },
  PJ: {
    label: "项目管理",
    actions: [...management, "get_team_work"],
  },
  DM: {
    label: "设计主管",
    actions: [
      ...design,
      "assign_story",
      "import_stories",
      "get_member_schedule",
    ],
  },
  DS: { label: "设计人员", actions: design },
  RM: {
    label: "研发主管",
    actions: [
      ...personal,
      "get_monthly_dev_queue",
      "get_team_work",
      "get_member_schedule",
      "get_plan_progress",
      "scan_workflow_risks",
      "decompose_stories",
      "assign_story",
      "reschedule_story",
      "close_stories",
    ],
  },
  RD: {
    label: "研发人员",
    actions: [
      ...personal,
      "get_team_work",
      "create_story",
      "get_monthly_dev_queue",
      "get_member_schedule",
      "get_plan_progress",
      "scan_workflow_risks",
    ],
  },
  QA: {
    label: "测试人员",
    actions: [
      ...personal,
      "scan_workflow_risks",
      "get_plan_progress",
      "get_monthly_dev_queue",
      "get_member_schedule",
    ],
  },
} as const;

export type PortalRole = keyof typeof rolePages;
export type PageTool = (typeof rolePages)[PortalRole]["actions"][number];
export type PortalTool = PageTool | "confirm_operation" | "get_operation";

export const snapshotTools = new Set<string>([
  ...personal,
  "get_team_work",
  "get_member_schedule",
  "get_plan_progress",
  "get_monthly_dev_queue",
  "scan_workflow_risks",
]);

export interface RolePage {
  id: PortalRole;
  label: string;
  actions: readonly PageTool[];
}

const formFields = z.record(z.string(), z.unknown());

function isRole(id: string): id is PortalRole {
  return Object.hasOwn(rolePages, id);
}

const roleIds = Object.keys(rolePages).filter(isRole);
export const roleChoices = roleIds.map((id) => ({
  id,
  label: rolePages[id].label,
}));

export function portalRolePage(role: PortalRole): RolePage {
  return { id: role, ...rolePages[role] };
}

export function portalRoles(
  table: TeamConfig["roles"],
  account: string,
): RolePage[] {
  const result: RolePage[] = [];
  for (const id of roleIds) {
    if (
      table[id]?.includes(account) ||
      (id === "QA" && table.QA_LEAD?.includes(account))
    )
      result.push({ id, ...rolePages[id] });
  }
  return result;
}

function allowed(tool: string, page: RolePage): tool is PageTool {
  return page.actions.some((action) => action === tool);
}

export function portalDenied(): never {
  throw new BztError("PERMISSION_DENIED", "当前职责无权执行该操作。");
}

/**
 * 校验职责工具白名单并对表单参数执行角色收窄。
 */
export function authorizePortalToolInput(
  page: RolePage,
  name: string,
  input: unknown,
  account: string,
  month?: string,
): {
  readonly tool: PageTool;
  readonly data: Record<string, unknown>;
  readonly reportMonth: string | undefined;
} {
  if (!allowed(name, page)) portalDenied();
  const role = page.id;
  const fields = formFields.safeParse(input);
  if (
    role !== "PM" &&
    role !== "PJ" &&
    name === "get_plan_progress" &&
    fields.data?.view !== "release"
  )
    portalDenied();
  if (!fields.success || !allTools[name].input.safeParse(fields.data).success)
    throw new BztError("INVALID_INPUT", "请核对表单字段。");
  const data = { ...fields.data };
  if (name === "get_my_work") {
    data.markSeen = false;
    if (role === "FB") data.groups = ["raised"];
  }
  if (name === "get_team_work" && role === "RD") {
    if (data.view !== "all_open") portalDenied();
    delete data.team;
    data.members = [account];
  }
  if (name === "query_stories" && role === "FB") {
    data.role = "raised";
    data.who = account;
  }
  if (
    name === "decompose_stories" &&
    role !== "RM" &&
    data.template !== "design"
  )
    portalDenied();
  if (name === "get_member_schedule" && (role === "RD" || role === "QA")) {
    if (data.newTask) portalDenied();
    data.members = [account];
  }
  const reportMonth =
    name !== "get_story_progress" && snapshotTools.has(name)
      ? month
      : undefined;
  if (
    reportMonth &&
    (name === "get_plan_progress" || name === "get_monthly_dev_queue")
  )
    data.month = reportMonth;
  if (name === "scan_workflow_risks" && ["DM", "DS", "RD", "QA"].includes(role))
    data.scope = { ...formFields.parse(data.scope ?? {}), mine: true };
  if (reportMonth && name === "scan_workflow_risks")
    data.scope = {
      ...formFields.parse(data.scope ?? {}),
      month: reportMonth,
    };
  if (
    name === "set_story_meta" &&
    !z
      .strictObject({
        storyId: z.number(),
        waiver: z.strictObject({
          rule: z.literal("R13"),
          reason: z.string(),
        }),
      })
      .safeParse(data).success
  )
    portalDenied();
  return { tool: name, data, reportMonth };
}
