import { resolve } from "node:path";
import { z } from "zod";
export { calendarMonth as portalMonthSchema } from "../core/calendar.ts";
import { allTools } from "../contracts/tools/index.ts";
import {
  loadFileConfig,
  readConfigEnvironment,
  type TeamConfig,
} from "../core/config.ts";
import { BztError } from "../core/errors.ts";
import { instanceWebRouteDto } from "../core/dto/org.ts";
import { portalLinkProjector } from "./portal-links.ts";
import {
  createPortalSnapshots,
  type PortalReadMode,
} from "./portal-snapshots.ts";
import { createPortalRoleSettings } from "./portal-role-settings.ts";
import {
  openAuthenticatedWorkbench,
  projectToolError,
  type Workbench,
  type WorkbenchRuntime,
} from "./workbench.ts";

import {
  authorizePortalToolInput,
  portalDenied as denied,
  portalRolePage,
  portalRoles,
  roleChoices,
  snapshotTools,
  type PageTool,
  type PortalRole,
  type PortalTool,
  type RolePage,
} from "./portal-policy.ts";

export {
  authorizePortalToolInput,
  portalRolePage,
  portalRoles,
  type PageTool,
  type PortalRole,
  type PortalTool,
  type RolePage,
};

export async function dispatchPortalTool(
  w: Workbench,
  tool: PortalTool,
  raw: unknown,
  role: PortalRole,
  fresh = false,
  month?: string,
) {
  const tracking = fresh ? w.portalReadSources.freshTracking : w.tracking;
  switch (tool) {
    case "get_my_work":
      return tracking.getMyWork(raw, month);
    case "get_team_work":
      return tracking.getTeamWork(raw, month);
    case "get_story_progress":
      return tracking.getStoryProgress(raw, { raisedByMe: role === "FB" });
    case "query_stories":
      return tracking.queryStories(raw, month);
    case "get_plan_progress":
      return w.management.getPlanProgress(raw);
    case "get_monthly_dev_queue":
      return w.management.getMonthlyDevQueue(raw);
    case "get_member_schedule":
      return w.schedule.getMemberSchedule(raw, month);
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
export function runPortalAction(
  execute: (
    tool: PortalTool,
    raw: unknown,
    role: PortalRole,
    fresh?: boolean,
    month?: string,
  ) => Promise<unknown>,
  account: string,
  readRoles: () => Promise<RolePage[]>,
  previews = new Map<string, PortalRole>(),
  snapshots?: {
    read(
      role: string,
      tool: string,
      input: unknown,
      mode: PortalReadMode,
      fetchReport: () => Promise<unknown>,
    ): Promise<unknown>;
    invalidate(): void;
  },
) {
  // 跨入口共用操作库，Web 确认须绑定用户在此会话及职责下看到的预览。
  return async (
    role: string,
    name: string,
    input: unknown,
    mode: PortalReadMode = "default",
    month?: string,
  ) => {
    const page = (await readRoles()).find((r) => r.id === role);
    if (!page || (mode !== "default" && !snapshotTools.has(name)))
      return denied();
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
      const result = allTools[name].output.parse(
        await execute(name, query.data, page.id),
      );
      if (
        name === "confirm_operation" &&
        ["confirmed", "partial", "unknown"].includes(
          z.object({ status: z.string() }).parse(result).status,
        )
      )
        snapshots?.invalidate();
      return result;
    }
    const { tool, data, reportMonth } = authorizePortalToolInput(
      page,
      name,
      input,
      account,
      month,
    );
    const read = async () =>
      allTools[tool].output.parse(
        await (reportMonth
          ? execute(tool, data, page.id, mode === "sync", reportMonth)
          : mode === "sync"
            ? execute(tool, data, page.id, true)
            : execute(tool, data, page.id)),
      );
    if (snapshots && snapshotTools.has(tool))
      return snapshots.read(
        role,
        tool,
        reportMonth ? { ...data, reportMonth } : data,
        mode,
        read,
      );
    const result = await read();
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
    const { cache, sampleActivity, instance, baseUrl, currentMonth } =
      w.portalReadSources;
    const snapshots = createPortalSnapshots(
      cache,
      runtime.clock,
      sampleActivity,
    );
    let linkProjector:
      Promise<ReturnType<typeof portalLinkProjector>> | undefined;
    async function linkSettings() {
      const key = "portal-link-route-v1";
      try {
        const saved = cache.get(key);
        if (saved) return instanceWebRouteDto.parse(JSON.parse(saved));
      } catch {
        // 路由缓存损坏时重新读取实例配置。
      }
      const info = await instance();
      try {
        cache.set(key, JSON.stringify(info), 7 * 24 * 60 * 60_000);
      } catch {
        // 数据读取不依赖路由缓存。
      }
      return info;
    }
    async function projectLinks(value: unknown) {
      linkProjector ??= linkSettings().then(
        (info) =>
          portalLinkProjector(
            baseUrl,
            info.requestType,
            info.moduleVar,
            info.methodVar,
          ),
        () => {
          linkProjector = undefined;
          return portalLinkProjector(baseUrl);
        },
      );
      return (await linkProjector)(value);
    }
    let configRevision = "";
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
      get dataMonth() {
        return currentMonth();
      },
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
          this.roles.some((page) => page.actions.includes("create_story"))
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
      configRevision = JSON.stringify(config);
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

    const call = runPortalAction(
      (tool, input, role, fresh, month) =>
        dispatchPortalTool(w, tool, input, role, fresh, month),
      loginAccount,
      readRoles,
      previews,
      {
        read: (role, tool, input, mode, fetchReport) =>
          snapshots.read(role, tool, input, mode, fetchReport, configRevision),
        invalidate: () => snapshots.invalidate(),
      },
    );
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
      async call(
        role: string,
        tool: string,
        input: unknown,
        mode?: PortalReadMode,
        month?: string,
      ) {
        const value = await call(
          role,
          tool,
          input,
          mode,
          month ?? currentMonth(),
        );
        return mode === "cached" && !reportExists(value)
          ? value
          : projectLinks(value);
      },
      async checkUpdates(role: string, acknowledge?: string, section?: string) {
        if (!(await readRoles()).some(({ id }) => id === role)) return denied();
        return snapshots.check(role, acknowledge, section);
      },
    };
  } catch (error) {
    w.close();
    throw error;
  }
}

function reportExists(value: unknown) {
  return z.object({ ok: z.literal(true) }).safeParse(value).success;
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
