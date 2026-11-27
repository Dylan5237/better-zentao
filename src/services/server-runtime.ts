import { createHash, randomBytes, timingSafeEqual } from "node:crypto";
import { mkdirSync } from "node:fs";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { z } from "zod";
import {
  createZentaoReadClient,
  exchangeZentaoSessionToken,
  revokeZentaoReadClient,
  type ZentaoReadClient,
} from "../api/client.ts";
import { sampleMyActivity } from "../api/my.ts";
import { getCurrentUser, getInstanceWebRoute } from "../api/org.ts";
import { allTools } from "../contracts/tools/index.ts";
import { formatLocalDate } from "../core/calendar.ts";
import type { Clock } from "../core/clock.ts";
import {
  loadFileConfig,
  type ConfigEnv,
  type TeamConfig,
} from "../core/config.ts";
import { instanceWebRouteDto } from "../core/dto/org.ts";
import { BztError } from "../core/errors.ts";
import { createPartitionedReadPool } from "../core/http-policy.ts";
import { loadServerConfig, type ServerConfig } from "../core/server-config.ts";

export { loadServerConfig, type Clock, type ConfigEnv, type ServerConfig };

export function isServerConflictError(error: unknown): boolean {
  return (
    error instanceof BztError &&
    (error.code === "PLAN_STALE" || error.details?.conflict === true)
  );
}
import {
  canonicalAccountDir,
  instanceHashOf,
  openLocalStore,
  type LocalStore,
} from "../core/store/index.ts";
import { portalLinkProjector } from "./portal-links.ts";
import {
  createPortalSnapshots,
  type PortalReadMode,
} from "./portal-snapshots.ts";
import {
  dispatchPortalTool,
  portalRoles,
  runPortalAction,
  type PortalRole,
} from "./portal.ts";
import { createServerWorkbench, projectToolError } from "./workbench.ts";
import { createTargetWriteCoordinator } from "./write-coordinator.ts";

/** CR-008 §4.1：面向 Web 与未来内置 AI 助手复用的不可伪造主体边界。 */
export interface Principal {
  readonly instanceId: string;
  readonly instanceHash: string;
  readonly account: string;
  readonly sessionId: string;
  readonly roles: readonly PortalRole[];
  readonly configVersion: string;
}

export interface ServerRuntimeOptions {
  readonly config: ServerConfig;
  readonly clock: Clock;
  readonly env?: ConfigEnv;
  readonly logSink?: (line: string) => void;
}

interface UserContext {
  readonly key: string;
  readonly store: LocalStore;
  readonly snapshots: ReturnType<typeof createPortalSnapshots>;
  refs: number;
}

interface PreviewGrant {
  readonly role: PortalRole;
  readonly configVersion: string;
}

interface ServerSession {
  readonly sessionId: string;
  readonly csrfToken: string;
  readonly instanceId: string;
  readonly instanceHash: string;
  readonly baseUrl: string;
  readonly account: string;
  readonly displayName: string;
  readonly viewer: Awaited<ReturnType<typeof getCurrentUser>>;
  readonly client: ZentaoReadClient;
  readonly userContext: UserContext;
  readonly createdAt: number;
  lastUsedAt: number;
  revoked: boolean;
  busy: number;
  readonly previews: Map<string, PreviewGrant>;
  linkProjector?: Promise<ReturnType<typeof portalLinkProjector>>;
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

const bypassCacheTools = new Set<string>(["get_story_progress"]);
const storedInstanceSchema = z.object({ instanceHash: z.string() });
const storedOpGrantSchema = z.strictObject({
  instanceId: z.string(),
  role: z.string(),
});
const opGrantPrefix = "portal-op-grant-v1:";
const previewIdSchema = z.object({
  opId: z.string().min(1),
  preview: z.object({}),
});

function hashText(text: string): string {
  return createHash("sha256").update(text, "utf8").digest("hex");
}

function safeEqual(a: string, b: string): boolean {
  const left = Buffer.from(a, "utf8");
  const right = Buffer.from(b, "utf8");
  return left.length === right.length && timingSafeEqual(left, right);
}

function reportExists(value: unknown): boolean {
  return z.object({ ok: z.literal(true) }).safeParse(value).success;
}

function acquireDataDirLock(dataDir: string): DatabaseSync {
  mkdirSync(dataDir, { recursive: true, mode: 0o700 });
  const lockDb = new DatabaseSync(join(dataDir, ".server.lock"), {
    timeout: 0,
  });
  try {
    lockDb.exec("BEGIN IMMEDIATE");
    return lockDb;
  } catch {
    try {
      lockDb.close();
    } catch {
      // 锁释放异常不覆盖主错误。
    }
    throw new BztError("INVALID_INPUT", "数据目录已被另一个集中服务进程占用。");
  }
}

export function createServerRuntime(options: ServerRuntimeOptions) {
  const { config, clock, logSink } = options;
  const baseEnv: ConfigEnv = {
    ...(options.env ?? {}),
    // ADR-23 / S-D05：Server 1.0 默认关闭企微群推。
    ...(config.notify.enabled ? {} : { BZT_WECOM_WEBHOOK: undefined }),
    ZENTAO_PASSWORD: undefined,
  };
  const lockDb = acquireDataDirLock(config.dataDir);
  const readPool = createPartitionedReadPool({
    perInstanceLimit: config.http.perInstanceConcurrency,
    perUserLimit: config.http.perUserConcurrency,
    authReserve: config.http.authReserve,
  });
  const writeCoordinator = createTargetWriteCoordinator();
  const idleTimeoutMs = config.session.idleTimeoutMinutes * 60_000;
  const absoluteTimeoutMs = config.session.absoluteTimeoutMinutes * 60_000;
  const reportTtlMs = config.cache.reportTtlSeconds * 1000;

  const sessions = new Map<string, ServerSession>();
  const userContexts = new Map<string, UserContext>();
  let closed = false;

  function userKeyOf(instanceHash: string, account: string): string {
    return `${instanceHash}\n${account}`;
  }

  function acquireUserContext(
    baseUrl: string,
    instanceHash: string,
    account: string,
  ): UserContext {
    const key = userKeyOf(instanceHash, account);
    const existing = userContexts.get(key);
    if (existing) {
      existing.refs += 1;
      return existing;
    }
    const store = openLocalStore({
      baseUrl,
      account,
      clock,
      wal: true,
      busyTimeoutMs: 1000,
      dbPath: join(
        config.dataDir,
        "users",
        instanceHash,
        canonicalAccountDir(account),
        "state.db",
      ),
    });
    const snapshots = createPortalSnapshots(
      store.cache,
      clock,
      () => Promise.resolve(undefined),
      {
        ttlMs: reportTtlMs,
        bypassTools: bypassCacheTools,
        disableReportCache: true,
        failClosedOnPartial: true,
      },
    );
    const context: UserContext = { key, store, snapshots, refs: 1 };
    userContexts.set(key, context);
    return context;
  }

  function releaseUserContext(context: UserContext): void {
    context.refs = Math.max(0, context.refs - 1);
    if (context.refs === 0 && userContexts.get(context.key) === context) {
      userContexts.delete(context.key);
      context.store.close();
    }
  }

  function revokeSession(session: ServerSession): void {
    if (session.revoked) return;
    session.revoked = true;
    revokeZentaoReadClient(session.client);
    session.previews.clear();
    if (sessions.get(session.sessionId) === session) {
      sessions.delete(session.sessionId);
    }
    if (session.busy === 0) {
      releaseUserContext(session.userContext);
    }
  }

  function pruneExpiredSessions(): void {
    const now = clock();
    for (const session of [...sessions.values()]) {
      if (
        now - session.createdAt >= absoluteTimeoutMs ||
        now - session.lastUsedAt >= idleTimeoutMs
      ) {
        revokeSession(session);
      }
    }
  }

  function getActiveSession(
    sessionId: string | undefined,
    touchLastUsed: boolean,
  ): ServerSession {
    if (!sessionId) throw new BztError("AUTH_FAILED", "请先登录。");
    const session = sessions.get(sessionId);
    if (!session || session.revoked)
      throw new BztError("AUTH_FAILED", "请先登录。");
    const now = clock();
    if (
      now - session.createdAt >= absoluteTimeoutMs ||
      now - session.lastUsedAt >= idleTimeoutMs
    ) {
      revokeSession(session);
      throw new BztError("AUTH_FAILED", "本次会话已过期，请重新登录。");
    }
    if (touchLastUsed) session.lastUsedAt = now;
    return session;
  }

  async function loadInstanceTeamConfig(
    instanceId: string,
  ): Promise<{ config: TeamConfig; version: string }> {
    const instance = config.instances[instanceId];
    if (!instance || instance.enabled === false)
      throw new BztError("PERMISSION_DENIED", "所选禅道实例不可用。");
    // 集中模式不读取宿主机个人 config.json，仅按实例不可变快照加载。
    const loaded = await loadFileConfig({
      env: { BZT_CONFIG: instance.teamConfigPath },
      optionalTeamConfig: false,
      includeTeamDocument: true,
    });
    const version = hashText(loaded.teamDocument?.contents ?? "");
    return { config: loaded.config, version };
  }

  function buildIdentity(session: ServerSession, teamConfig: TeamConfig) {
    const roles = portalRoles(teamConfig.roles, session.account);
    const granted = new Set<string>(roles.map(({ id }) => id));
    for (const [opId, grant] of session.previews) {
      if (!granted.has(grant.role)) session.previews.delete(opId);
    }
    const wb = createServerWorkbench({
      client: session.client,
      viewer: session.viewer,
      config: teamConfig,
      stateDir: config.dataDir,
      clock,
      baseUrl: session.baseUrl,
      store: session.userContext.store,
      env: { ...baseEnv, ZENTAO_BASE_URL: session.baseUrl },
      logSink,
      writeCoordinator,
    });
    const teams = wb.portalTeams();
    return {
      instanceId: session.instanceId,
      account: session.account,
      displayName: session.displayName,
      csrfToken: session.csrfToken,
      readOnly: config.readOnly,
      dataMonth: formatLocalDate(clock(), teamConfig.timezone).slice(0, 7),
      roles,
      ...(roles.some((role) => role.id !== "FB")
        ? { releaseCalendar: wb.releaseCalendar }
        : {}),
      ...(roles.some((role) => role.id === "DM") && teams.designMaintainers
        ? { designMaintainers: teams.designMaintainers }
        : {}),
      ...(roles.some((role) => ["DM", "PM", "PJ", "RM"].includes(role.id))
        ? { developmentTeams: teams.developmentTeams }
        : {}),
      ...(roles.some((role) => role.actions.includes("create_story"))
        ? { intakeCatalog: wb.intakeCatalog() }
        : {}),
    };
  }

  async function projectLinks(session: ServerSession, value: unknown) {
    session.linkProjector ??= (async () => {
      const key = "portal-link-route-v1";
      try {
        const saved = session.userContext.store.cache.get(key);
        if (saved) {
          const info = instanceWebRouteDto.parse(JSON.parse(saved));
          return portalLinkProjector(
            session.baseUrl,
            info.requestType,
            info.moduleVar,
            info.methodVar,
          );
        }
      } catch {
        // 路由缓存损坏时回退。
      }
      try {
        const info = await getInstanceWebRoute(session.client);
        try {
          session.userContext.store.cache.set(
            key,
            JSON.stringify(info),
            7 * 24 * 60 * 60_000,
          );
        } catch {
          // 缓存失败不影响业务响应。
        }
        return portalLinkProjector(
          session.baseUrl,
          info.requestType,
          info.moduleVar,
          info.methodVar,
        );
      } catch {
        session.linkProjector = undefined;
        return portalLinkProjector(session.baseUrl);
      }
    })();
    return (await session.linkProjector)(value);
  }

  return {
    startup() {
      return {
        mode: "server" as const,
        readOnly: config.readOnly,
        instances: Object.entries(config.instances)
          .filter(([, instance]) => instance.enabled !== false)
          .map(([id, instance]) => ({ id, name: instance.name })),
      };
    },

    async login(input: {
      readonly instanceId: string;
      readonly account: string;
      readonly password: string;
      readonly previousSessionId?: string;
    }) {
      if (closed) throw new BztError("ZENTAO_UNAVAILABLE", "服务正在关闭。");
      pruneExpiredSessions();
      if (input.previousSessionId) {
        const previous = sessions.get(input.previousSessionId);
        if (previous) revokeSession(previous);
      }
      const instance = config.instances[input.instanceId];
      if (!instance || instance.enabled === false)
        throw new BztError("PERMISSION_DENIED", "所选禅道实例未登记或已停用。");

      const account = input.account.trim();
      const instanceHash = instanceHashOf(instance.baseUrl);
      const { token } = await exchangeZentaoSessionToken({
        baseUrl: instance.baseUrl,
        account,
        password: input.password,
        clock,
        env: baseEnv,
        logSink,
        readPool,
        instanceHash,
      });

      const team = await loadInstanceTeamConfig(input.instanceId);
      const bound: { session?: ServerSession } = {};
      const client = createZentaoReadClient({
        baseUrl: instance.baseUrl,
        account,
        token,
        clock,
        timezone: team.config.timezone,
        env: baseEnv,
        logSink,
        readPool,
        instanceHash,
        onAuthFailed: () => {
          if (bound.session) {
            bound.session.userContext.snapshots.invalidate();
            revokeSession(bound.session);
          }
        },
        isRevoked: () => bound.session?.revoked === true,
      });
      // 登录必须先回读并核对禅道身份，核对通过前不创建会话也不打开 state.db。
      const viewer = await getCurrentUser(client);
      if (viewer.account !== account)
        throw new BztError("AUTH_FAILED", "登录账号与禅道返回的身份不一致。");

      const userKey = userKeyOf(instanceHash, account);
      const userSessions = [...sessions.values()]
        .filter(
          (entry) =>
            !entry.revoked &&
            userKeyOf(entry.instanceHash, entry.account) === userKey,
        )
        .sort((left, right) => left.lastUsedAt - right.lastUsedAt);
      while (userSessions.length >= config.session.maxSessionsPerUser) {
        const oldest = userSessions.shift();
        if (oldest) revokeSession(oldest);
      }
      if (sessions.size >= config.session.maxSessions)
        throw new BztError("ZENTAO_UNAVAILABLE", "当前在线会话数已达上限。");

      const userContext = acquireUserContext(
        instance.baseUrl,
        instanceHash,
        account,
      );
      const sessionId = randomBytes(32).toString("hex");
      const csrfToken = randomBytes(32).toString("hex");
      const now = clock();
      const session: ServerSession = {
        sessionId,
        csrfToken,
        instanceId: input.instanceId,
        instanceHash,
        baseUrl: instance.baseUrl,
        account,
        displayName: viewer.realname || account,
        viewer,
        client,
        userContext,
        createdAt: now,
        lastUsedAt: now,
        revoked: false,
        busy: 0,
        previews: new Map(),
      };
      bound.session = session;
      sessions.set(sessionId, session);
      return {
        sessionId,
        identity: buildIdentity(session, team.config),
      };
    },

    verifyCsrf(sessionId: string, provided: string | undefined): void {
      const session = getActiveSession(sessionId, false);
      if (!provided || !safeEqual(session.csrfToken, provided))
        throw new BztError("PERMISSION_DENIED", "CSRF 校验失败。");
    },

    async readIdentity(sessionId: string) {
      const session = getActiveSession(sessionId, true);
      session.busy += 1;
      try {
        const team = await loadInstanceTeamConfig(session.instanceId);
        if (session.revoked)
          throw new BztError("AUTH_FAILED", "本次会话已结束。");
        return buildIdentity(session, team.config);
      } finally {
        session.busy -= 1;
        if (session.busy === 0 && session.revoked) {
          releaseUserContext(session.userContext);
        }
      }
    },

    async invokeTool(
      sessionId: string,
      request: {
        readonly role: string;
        readonly tool: string;
        readonly input: unknown;
        readonly readMode?: PortalReadMode;
        readonly month?: string;
      },
    ) {
      const session = getActiveSession(sessionId, true);
      session.busy += 1;
      try {
        const team = await loadInstanceTeamConfig(session.instanceId);
        const roles = portalRoles(team.config.roles, session.account);
        const granted = new Set<string>(roles.map(({ id }) => id));
        for (const [opId, grant] of session.previews) {
          if (!granted.has(grant.role)) session.previews.delete(opId);
        }
        const page = roles.find((entry) => entry.id === request.role);
        if (!page)
          throw new BztError("PERMISSION_DENIED", "当前职责无权执行该操作。");
        if (config.readOnly && writeTools.has(request.tool))
          throw new BztError("PERMISSION_DENIED", "当前服务处于只读模式。");

        const wb = createServerWorkbench({
          client: session.client,
          viewer: session.viewer,
          config: team.config,
          stateDir: config.dataDir,
          clock,
          baseUrl: session.baseUrl,
          store: session.userContext.store,
          env: { ...baseEnv, ZENTAO_BASE_URL: session.baseUrl },
          logSink,
          writeCoordinator,
          assertBeforeDispatch: () => {
            if (session.revoked)
              throw new BztError("AUTH_FAILED", "本次会话已结束。");
          },
        });

        // 集中端独立处理 get_operation 与 confirm_operation（F-07 / SRV-OP-01）：
        // 未执行预览绑定发起会话、角色与配置版本；已派发回执对原主体且具备对应工具权限的角色跨重启可读。
        if (request.tool === "get_operation") {
          const parsed = allTools.get_operation.input.safeParse(request.input);
          if (!parsed.success || !parsed.data.opId)
            throw new BztError("PERMISSION_DENIED", "当前职责无权执行该操作。");
          const opId = parsed.data.opId;
          let grantMatches = false;
          try {
            const rawGrant = session.userContext.store.cache.get(
              opGrantPrefix + opId,
              0,
            );
            const parsedGrant = rawGrant
              ? storedOpGrantSchema.safeParse(JSON.parse(rawGrant))
              : undefined;
            grantMatches =
              parsedGrant !== undefined &&
              parsedGrant.success &&
              parsedGrant.data.instanceId === session.instanceId &&
              parsedGrant.data.role === page.id;
          } catch {
            grantMatches = false;
          }
          if (!grantMatches)
            throw new BztError("PERMISSION_DENIED", "无权查看该操作回执。");
          const hasPreview = session.previews.get(opId)?.role === page.id;
          if (!hasPreview) {
            let ownedDispatched = false;
            try {
              const record = session.userContext.store.operations.get(opId);
              const meta = storedInstanceSchema.safeParse(
                JSON.parse(record.planJson),
              );
              const roleAllowsKind = page.actions.some(
                (action) => action === record.kind,
              );
              ownedDispatched =
                record.actor === session.account &&
                meta.success &&
                meta.data.instanceHash === session.instanceHash &&
                record.executedAt !== null &&
                roleAllowsKind;
            } catch {
              ownedDispatched = false;
            }
            if (!ownedDispatched)
              throw new BztError("PERMISSION_DENIED", "无权查看该操作回执。");
          }
          const receipt = allTools.get_operation.output.parse(
            wb.getOperation(parsed.data),
          );
          const projected = await projectLinks(session, receipt);
          if (session.revoked)
            throw new BztError("AUTH_FAILED", "本次会话已结束。");
          return projected;
        }

        if (request.tool === "confirm_operation") {
          const parsed = allTools.confirm_operation.input.safeParse(
            request.input,
          );
          if (!parsed.success)
            throw new BztError("PERMISSION_DENIED", "当前职责无权执行该操作。");
          const grant = session.previews.get(parsed.data.opId);
          if (
            !grant ||
            grant.role !== page.id ||
            grant.configVersion !== team.version
          ) {
            if (grant) session.previews.delete(parsed.data.opId);
            throw new BztError("PERMISSION_DENIED", "无权确认该操作计划。");
          }
          if (parsed.data.previewAck !== true)
            throw new BztError("PREVIEW_REQUIRED", "请先确认已阅读预览。");
          const result = allTools.confirm_operation.output.parse(
            await wb.confirmOperation(parsed.data),
          );
          session.previews.delete(parsed.data.opId);
          if (
            ["confirmed", "partial", "unknown"].includes(
              z.object({ status: z.string() }).parse(result).status,
            )
          )
            session.userContext.snapshots.invalidate();
          const projected = await projectLinks(session, result);
          if (session.revoked)
            throw new BztError("AUTH_FAILED", "本次会话已结束。");
          return projected;
        }

        const sessionPreviews = new Map<string, PortalRole>();
        for (const [opId, grant] of session.previews) {
          sessionPreviews.set(opId, grant.role);
        }
        const action = runPortalAction(
          (tool, raw, role, _fresh, month) =>
            // Gate A 边界 1（授权优先于缓存）：Server 模式在快照未命中或直读详情时
            // 始终经 freshTracking 向上游实时验证，避免读回 store.cache 中陈旧对象。
            dispatchPortalTool(wb, tool, raw, role, true, month),
          session.account,
          () => Promise.resolve(roles),
          sessionPreviews,
          {
            read: (role, tool, input, mode, fetchReport) =>
              session.userContext.snapshots.read(
                role,
                tool,
                input,
                mode,
                fetchReport,
                team.version,
              ),
            invalidate: () => session.userContext.snapshots.invalidate(),
          },
        );
        const currentMonth = formatLocalDate(
          clock(),
          team.config.timezone,
        ).slice(0, 7);
        const value = await action(
          request.role,
          request.tool,
          request.input,
          request.readMode ?? "default",
          request.month ?? currentMonth,
        );
        if (session.revoked) {
          session.userContext.snapshots.invalidate();
          throw new BztError("AUTH_FAILED", "本次会话已结束。");
        }
        const prepared = previewIdSchema.safeParse(value);
        if (prepared.success) {
          session.userContext.store.cache.setPermanent(
            opGrantPrefix + prepared.data.opId,
            JSON.stringify({
              instanceId: session.instanceId,
              role: page.id,
            }),
          );
          session.previews.set(prepared.data.opId, {
            role: page.id,
            configVersion: team.version,
          });
        }
        const projected =
          request.readMode === "cached" && !reportExists(value)
            ? value
            : await projectLinks(session, value);
        if (session.revoked) {
          session.userContext.snapshots.invalidate();
          throw new BztError("AUTH_FAILED", "本次会话已结束。");
        }
        return projected;
      } catch (error) {
        if (session.revoked) {
          throw new BztError("AUTH_FAILED", "本次会话已结束。");
        }
        throw error;
      } finally {
        session.busy -= 1;
        if (session.busy === 0 && session.revoked) {
          releaseUserContext(session.userContext);
        }
      }
    },

    async checkUpdates(
      sessionId: string,
      request: {
        readonly role: string;
        readonly acknowledge?: string;
        readonly section?: string;
      },
    ) {
      // 后台更新探测不续期空闲超时（SRV-LIFE-01）。
      const session = getActiveSession(sessionId, false);
      session.busy += 1;
      try {
        const team = await loadInstanceTeamConfig(session.instanceId);
        const roles = portalRoles(team.config.roles, session.account);
        if (!roles.some(({ id }) => id === request.role))
          throw new BztError("PERMISSION_DENIED", "当前职责无权执行该操作。");
        const result = await session.userContext.snapshots.check(
          request.role,
          request.acknowledge,
          request.section,
          () => sampleMyActivity(session.client),
        );
        if (session.revoked)
          throw new BztError("AUTH_FAILED", "本次会话已结束。");
        return result;
      } finally {
        session.busy -= 1;
        if (session.busy === 0 && session.revoked) {
          releaseUserContext(session.userContext);
        }
      }
    },

    logout(sessionId: string): void {
      const session = getActiveSession(sessionId, false);
      revokeSession(session);
    },

    projectError(error: unknown) {
      return projectToolError(error, baseEnv);
    },

    pruneExpiredSessions,

    close(): void {
      if (closed) return;
      closed = true;
      for (const session of [...sessions.values()]) {
        revokeSession(session);
      }
      for (const context of [...userContexts.values()]) {
        userContexts.delete(context.key);
        context.store.close();
      }
      try {
        lockDb.close();
      } catch {
        // 关闭锁句柄失败不中断退出。
      }
    },
  };
}
