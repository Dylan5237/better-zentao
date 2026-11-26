import { resolve } from "node:path";
import { z } from "zod";
import { allTools } from "../contracts/tools/index.ts";
import {
  loadFileConfig,
  readConfigEnvironment,
  type TeamConfig,
} from "../core/config.ts";
import { BztError } from "../core/errors.ts";
import { createPortalRoleSettings } from "./portal-role-settings.ts";
import {
  openAuthenticatedWorkbench,
  projectToolError,
  type Workbench,
  type WorkbenchRuntime,
} from "./workbench.ts";

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
const rolePages = {
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

type PortalRole = keyof typeof rolePages;
type PageTool = (typeof rolePages)[PortalRole]["actions"][number];
type PortalTool = PageTool | "confirm_operation" | "get_operation";
interface RolePage {
  id: PortalRole;
  label: string;
  actions: readonly PageTool[];
}

const roleIds = Object.keys(rolePages).filter(isRole);
const roleChoices = roleIds.map((id) => ({ id, label: rolePages[id].label }));

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

function isRole(id: string): id is PortalRole {
  return Object.hasOwn(rolePages, id);
}

function allowed(tool: string, page: RolePage): tool is PageTool {
  return page.actions.some((action) => action === tool);
}

function denied(): never {
  throw new BztError("PERMISSION_DENIED", "当前职责无权执行该操作。");
}

async function dispatch(
  w: Workbench,
  tool: PortalTool,
  raw: unknown,
  role: PortalRole,
) {
  switch (tool) {
    case "get_my_work":
      return w.tracking.getMyWork(raw);
    case "get_team_work":
      return w.tracking.getTeamWork(raw);
    case "get_story_progress":
      return w.tracking.getStoryProgress(raw, { raisedByMe: role === "FB" });
    case "query_stories":
      return w.tracking.queryStories(raw);
    case "get_plan_progress":
      return w.management.getPlanProgress(raw);
    case "get_monthly_dev_queue":
      return w.management.getMonthlyDevQueue(raw);
    case "get_member_schedule":
      return w.schedule.getMemberSchedule(raw);
    case "scan_workflow_risks":
      return w.risk.scanWorkflowRisks(raw);
    case "create_story":
      return w.createStory(raw);
    case "import_stories":
      return w.importStories(raw);
    case "handoff_story":
      return w.handoffStory(raw);
    case "decompose_stories":
      return w.decomposeStories(raw);
    case "assign_story":
      return w.assignStory(raw);
    case "reschedule_story":
      return w.rescheduleStory(raw);
    case "close_stories":
      return w.closeStories(raw);
    case "set_story_meta":
      return w.setStoryMeta(raw);
    case "confirm_operation":
      return w.confirmOperation(allTools.confirm_operation.input.parse(raw));
    case "get_operation":
      return w.getOperation(allTools.get_operation.input.parse(raw));
  }
}

const previewId = z.object({ opId: z.string().min(1), preview: z.object({}) });
const formFields = z.record(z.string(), z.unknown());
export function runPortalAction(
  execute: (
    tool: PortalTool,
    raw: unknown,
    role: PortalRole,
  ) => Promise<unknown>,
  account: string,
  readRoles: () => Promise<RolePage[]>,
  previews = new Map<string, PortalRole>(),
) {
  // 跨入口共用操作库，Web 确认须绑定用户在此会话及职责下看到的预览。
  return async (role: string, name: string, input: unknown) => {
    const page = (await readRoles()).find((r) => r.id === role);
    if (!page) return denied();
    if (name === "confirm_operation" || name === "get_operation") {
      const query = allTools[name].input.safeParse(input);
      if (
        !query.success ||
        !query.data.opId ||
        previews.get(query.data.opId) !== role
      )
        return denied();
      if (
        name === "confirm_operation" &&
        !("previewAck" in query.data && query.data.previewAck === true)
      )
        throw new BztError("PREVIEW_REQUIRED", "请先确认已阅读预览。");
      return allTools[name].output.parse(
        await execute(name, query.data, page.id),
      );
    }
    if (!allowed(name, page)) return denied();
    const fields = formFields.safeParse(input);
    if (
      role !== "PM" &&
      role !== "PJ" &&
      name === "get_plan_progress" &&
      fields.data?.view !== "release"
    )
      return denied();
    if (!fields.success || !allTools[name].input.safeParse(fields.data).success)
      throw new BztError("INVALID_INPUT", "请核对表单字段。");
    const data = fields.data;
    if (name === "get_my_work") {
      data.markSeen = false;
      if (role === "FB") data.groups = ["raised"];
    }
    if (name === "get_team_work" && role === "RD") {
      if (data.view !== "all_open") return denied();
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
      return denied();
    if (name === "get_member_schedule" && (role === "RD" || role === "QA")) {
      if (data.newTask) return denied();
      data.members = [account];
    }
    if (
      name === "scan_workflow_risks" &&
      ["DM", "DS", "RD", "QA"].includes(role)
    )
      data.scope = { ...formFields.parse(data.scope ?? {}), mine: true };
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
      return denied();
    const result = allTools[name].output.parse(
      await execute(name, data, page.id),
    );
    const prepared = previewId.safeParse(result);
    if (prepared.success) previews.set(prepared.data.opId, page.id);
    return result;
  };
}

export async function loginPortal(
  runtime: WorkbenchRuntime,
  account: string,
  password: string,
  localOwner = false,
) {
  const loginAccount = account.trim();
  const configuredOwner = runtime.env.ZENTAO_ACCOUNT?.trim();
  const options = portalConfig({
    ...runtime,
    env: {
      ...runtime.env,
      ZENTAO_ACCOUNT: loginAccount,
      ZENTAO_PASSWORD: password,
    },
  });
  const w = await openAuthenticatedWorkbench(options, true);
  try {
    // 工作台已经将表单账号与禅道回读的登录身份核对一致。
    const mayEdit = configuredOwner
      ? configuredOwner === loginAccount
      : localOwner === true;
    const roleSettings = mayEdit
      ? createPortalRoleSettings(options, loginAccount, roleChoices)
      : undefined;
    const initial = await roleSettings?.read();
    const identity = {
      account: loginAccount,
      displayName: w.viewer?.realname || loginAccount,
      roles: portalRoles(initial?.table ?? w.roles, loginAccount),
      get releaseCalendar(): Workbench["releaseCalendar"] | undefined {
        return this.roles.some((role) => role.id !== "FB")
          ? w.releaseCalendar
          : undefined;
      },
      get designMaintainers(): ReturnType<
        Workbench["portalTeams"]
      >["designMaintainers"] {
        return this.roles.some((role) => role.id === "DM")
          ? w.portalTeams().designMaintainers
          : undefined;
      },
      get developmentTeams():
        ReturnType<Workbench["portalTeams"]>["developmentTeams"] | undefined {
        return this.roles.some((role) =>
          ["DM", "PM", "PJ", "RM"].includes(role.id),
        )
          ? w.portalTeams().developmentTeams
          : undefined;
      },
      get intakeCatalog(): ReturnType<typeof w.intakeCatalog> | undefined {
        return mayEdit &&
          this.roles.some((page) => allowed("create_story", page))
          ? w.intakeCatalog()
          : undefined;
      },
      ...(initial && { roleSetup: initial.roleSetup }),
    };
    let granted = new Set(identity.roles.map(({ id }) => id));
    const previews = new Map<string, PortalRole>();

    function updateRoles(table: TeamConfig["roles"], fromSave = false) {
      const current = portalRoles(table, loginAccount);
      // 外部撤销立即生效，外部新增待重登。本人在门户保存后即时应用。
      const allowed = fromSave
        ? current
        : current.filter(({ id }) => granted.has(id));
      granted = new Set(allowed.map(({ id }) => id));
      for (const [opId, role] of previews) {
        if (!granted.has(role)) previews.delete(opId);
      }
      w.updateRoles(table);
      identity.roles = allowed;
      return allowed;
    }

    async function readRoles() {
      const { config } = await loadFileConfig(options);
      return updateRoles(config.roles);
    }

    async function readIdentity() {
      if (roleSettings) {
        const { table, roleSetup } = await roleSettings.read();
        updateRoles(table);
        identity.roleSetup = roleSetup;
      } else await readRoles();
      return { ...identity };
    }

    return {
      identity,
      close: w.close,
      readRoles,
      readIdentity,
      ...(roleSettings && {
        async readRoleSetup() {
          return (await readIdentity()).roleSetup;
        },
        async saveRoles(roles: string[], revision: string) {
          const saved = await roleSettings.save(roles, revision);
          updateRoles(saved.table, true);
          identity.roleSetup = saved.roleSetup;
          return { ...identity, roleSetup: saved.roleSetup };
        },
      }),
      projectError: (error: unknown) => projectToolError(error, options.env),
      call: runPortalAction(
        (tool, input, role) => dispatch(w, tool, input, role),
        loginAccount,
        readRoles,
        previews,
      ),
    };
  } catch (error) {
    w.close();
    throw error;
  }
}

function portalConfig(runtime: WorkbenchRuntime) {
  return {
    ...runtime,
    env: {
      ...runtime.env,
      BZT_CONFIG: resolve(
        runtime.env.BZT_CONFIG?.trim() || "config/team.local.json",
      ),
    },
    optionalTeamConfig: true,
  };
}

export async function checkPortalSettings(runtime: WorkbenchRuntime) {
  readConfigEnvironment(runtime.env);
  await loadFileConfig(portalConfig(runtime));
}
