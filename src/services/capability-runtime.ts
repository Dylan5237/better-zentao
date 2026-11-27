import { allTools } from "../contracts/tools/index.ts";
import { BztError } from "../core/errors.ts";
import {
  authorizePortalToolInput,
  portalRolePage,
  type PortalRole,
} from "./portal-policy.ts";

/** CR-009 §4.3：统一能力调用渠道。 */
export type InvocationChannel = "gui" | "ai" | "mcp" | "cli";

/** CR-009 §4.3：服务端不可伪造主体（G-06 集中调度边界）。 */
export type TrustedPrincipal = Readonly<{
  instanceId: string;
  instanceHash: string;
  account: string;
  sessionId: string;
  roles: readonly PortalRole[];
  configVersion: string;
  readOnly: boolean;
}>;

/**
 * CR-009 §4.3 / §8 A-03（P0）：统一能力调度与策略边界。
 * 收敛参数校验、角色/范围收窄、readOnly 拦截与 AI 确认禁令。
 */
export interface CapabilityRuntimeOptions {
  /** 校验主体角色与工具权限，并按渠道做参数收窄。 */
  readonly principal: TrustedPrincipal;
  readonly channel: InvocationChannel;
  /**
   * 工具执行器：给定 (tool, input, role) 执行上层业务服务。
   * 与 runPortalAction 的 execute 回调同构，可接 Workbench 或 ProviderWorkbench。
   */
  readonly execute: (
    tool: string,
    input: unknown,
    role: PortalRole,
    month?: string,
  ) => Promise<unknown>;
  /** 读取当前有效角色（默认直接使用 principal.roles 快照）。 */
  readonly readRoles?: () => Promise<readonly { id: PortalRole }[]>;
  /** 会话是否已被撤销（默认 false）。 */
  readonly isRevoked?: () => boolean;
}

const writeTools = new Set<string>([
  "create_story",
  "import_stories",
  "handoff_story",
  "decompose_stories",
  "assign_story",
  "reschedule_story",
  "close_stories",
  "set_story_meta",
  "confirm_operation",
]);

/** AI 渠道无条件禁止确认/执行写入（CR-009 §4.3 不变量 2）。 */
const aiForbiddenTool = "confirm_operation";
const aiForbiddenMessage =
  "AI 助手不能代为确认或执行写入，请交由用户人工确认预览。";

type ToolName = keyof typeof allTools & string;

function isToolName(tool: string): tool is ToolName {
  return Object.hasOwn(allTools, tool);
}

export function createCapabilityRuntime(options: CapabilityRuntimeOptions) {
  const { principal, channel, execute } = options;

  async function currentRoles(): Promise<readonly PortalRole[]> {
    if (!options.readRoles) return principal.roles;
    const rows = await options.readRoles();
    return rows.map(({ id }) => id);
  }

  return {
    /** 固定调用渠道，供 AgentRuntime 校验必须绑定 "ai"。 */
    readonly: principal.readOnly,
    channel,
    /** 校验并执行一次工具调用；复用单一角色工具白名单与参数收窄策略，输出经契约投影。 */
    async invoke(
      role: string,
      tool: string,
      rawInput: unknown,
      month?: string,
    ): Promise<unknown> {
      if (options.isRevoked?.())
        throw new BztError("AUTH_FAILED", "本次会话已结束。");
      if (!isToolName(tool)) throw new BztError("INVALID_INPUT", "未知工具。");
      // P0：AI 渠道严禁 confirm_operation（即便 previewAck=true 或 W1）。
      if (channel === "ai" && tool === aiForbiddenTool)
        throw new BztError("PERMISSION_DENIED", aiForbiddenMessage);
      if (principal.readOnly && writeTools.has(tool))
        throw new BztError("PERMISSION_DENIED", "当前服务处于只读模式。");
      const roles = await currentRoles();
      const granted = roles.find((entry) => entry === role);
      if (granted === undefined)
        throw new BztError("PERMISSION_DENIED", "当前职责无权执行该操作。");
      const contract = allTools[tool];
      let effectiveInput: unknown;
      if (
        (channel === "gui" || channel === "ai") &&
        tool !== "confirm_operation" &&
        tool !== "get_operation" &&
        tool !== "resolve_context"
      ) {
        const page = portalRolePage(granted);
        effectiveInput = authorizePortalToolInput(
          page,
          tool,
          rawInput,
          principal.account,
          month,
        ).data;
      } else {
        const parsed = contract.input.safeParse(rawInput);
        if (!parsed.success)
          throw new BztError("INVALID_INPUT", "工具参数不合法。");
        effectiveInput = parsed.data;
      }
      const value = await execute(tool, effectiveInput, granted, month);
      return contract.output.parse(value);
    },
  };
}

export type CapabilityRuntime = ReturnType<typeof createCapabilityRuntime>;
