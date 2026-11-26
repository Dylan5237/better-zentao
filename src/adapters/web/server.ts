import { randomBytes } from "node:crypto";
import { readFile } from "node:fs/promises";
import {
  createServer,
  type IncomingMessage,
  type ServerResponse,
} from "node:http";
import { z } from "zod";
import { portalMonthSchema } from "../../services/portal.ts";
import { projectToolError } from "../../services/workbench.ts";
import type { PortalReadMode } from "../../services/portal-snapshots.ts";

interface Connection {
  identity: {
    account: string;
    roles: readonly { id: string; label: string; actions: readonly string[] }[];
    roleSetup?: RoleSetup;
  };
  call(
    role: string,
    tool: string,
    input: unknown,
    mode?: PortalReadMode,
    month?: string,
  ): Promise<unknown>;
  checkUpdates?(
    role: string,
    acknowledge?: string,
    section?: string,
  ): Promise<unknown>;
  readRoles(): Promise<Connection["identity"]["roles"]>;
  readIdentity?(): Promise<Connection["identity"]>;
  readRoleSetup?(): Promise<RoleSetup | undefined>;
  saveRoles?(
    roles: string[],
    revision: string,
  ): Promise<Connection["identity"]>;
  projectError(error: unknown): ReturnType<typeof projectToolError>;
  close(): void;
}
interface RoleSetup {
  choices: readonly { id: string; label: string }[];
  selected: readonly string[];
  locked?: readonly string[];
  revision: string;
}
interface StartupState {
  needsBaseUrl: boolean;
  account?: string;
  hasSavedLogin: boolean;
}
interface PortalOptions {
  port: number;
  clock: () => number;
  startup?: () => StartupState | Promise<StartupState>;
  onLaunchUrlChanged?: (url: string) => void | Promise<void>;
  login(
    account: string,
    password: string,
    options?: { baseUrl?: string; localOwner?: boolean; saved?: boolean },
  ): Promise<Connection>;
}
const launchField = z.string().min(1).max(128);
const loginForm = z.union([
  z.strictObject({
    account: z.string().trim().min(1).max(256),
    password: z.string().min(1).max(4096),
    baseUrl: z.string().trim().min(1).max(2048).optional(),
    launch: launchField.optional(),
  }),
  z.strictObject({ saved: z.literal(true), launch: launchField }),
]);
const roleForm = z.strictObject({
  roles: z.array(z.string().min(1).max(16)).max(8),
  revision: z.string().min(1).max(128),
});
const action = z.strictObject({
  role: z.string().min(1),
  tool: z.string().min(1),
  input: z.record(z.string(), z.unknown()),
  readMode: z.enum(["default", "cached", "sync"]).optional(),
  month: portalMonthSchema.optional(),
});
const updateRequest = z.strictObject({
  role: z.string().min(1).max(16),
  section: z
    .enum(["workbench", "intake", "stories", "schedule", "release-risks"])
    .optional(),
  acknowledge: z
    .string()
    .regex(/^[0-9a-f]{64}$/u)
    .optional(),
});
const empty = z.strictObject({});
const assets = new Map<string, readonly [string, string]>([
  ["/", ["index.html", "text/html"]],
  ["/app.js", ["app.js", "text/javascript"]],
  ["/read-views.js", ["read-views.js", "text/javascript"]],
  ["/write-views.js", ["write-views.js", "text/javascript"]],
  ["/portal.css", ["portal.css", "text/css"]],
  ...[
    "meridian-shell",
    "meridian-icons",
    "skeleton",
    "portal-skeleton",
    "workbench-skeleton",
    "daily-skeleton",
    "management-skeleton",
    "meridian-home-native",
    "meridian-home-controls",
    "daily-pages",
    "management-pages",
    "workbench-page",
    "review-page",
    "review-content",
  ].map((name): [string, readonly [string, string]] => [
    "/" + name + ".js",
    [name + ".js", "text/javascript"],
  ]),
  ...[
    "meridian",
    "skeleton",
    "meridian-shell",
    "daily-pages",
    "management-pages",
    "workbench-page",
  ].map((name): [string, readonly [string, string]] => [
    "/" + name + ".css",
    [name + ".css", "text/css"],
  ]),
]);

function reply(res: ServerResponse, status: number, value: unknown) {
  res
    .writeHead(status, { "Content-Type": "application/json; charset=utf-8" })
    .end(JSON.stringify(value));
}
function failure(
  res: ServerResponse,
  status: number,
  code: string,
  message: string,
) {
  reply(res, status, { ok: false, code, message });
}
function businessError(
  res: ServerResponse,
  error: ReturnType<typeof projectToolError>,
) {
  const status =
    error.code === "AUTH_FAILED"
      ? 401
      : error.code === "PERMISSION_DENIED"
        ? 403
        : error.retryable
          ? 503
          : 400;
  if (!res.headersSent) reply(res, status, error);
  else res.end();
}
async function json(req: IncomingMessage) {
  const chunks: Buffer[] = [];
  let size = 0;
  for await (const chunk of req) {
    if (!Buffer.isBuffer(chunk) || (size += chunk.length) > 128 * 1024)
      return undefined;
    chunks.push(chunk);
  }
  try {
    const value: unknown = JSON.parse(Buffer.concat(chunks).toString("utf8"));
    return value;
  } catch {
    return undefined;
  }
}

export async function startPortal({
  port,
  clock,
  login,
  startup,
  onLaunchUrlChanged,
}: PortalOptions) {
  let origin = "";
  let cookieName = "";
  const instanceId = randomBytes(16).toString("hex");
  let launchToken = randomBytes(32).toString("hex");
  const launchUrl = () => origin + "/#launch=" + launchToken;
  let session:
    | { connection: Connection; token: string; lastUsed: number; busy: number }
    | undefined;
  let loggingIn = false;
  let savingRoles = false;
  let stopping = false;
  const idleMs = 8 * 60 * 60 * 1000;
  function forget() {
    if (session?.busy === 0) session.connection.close();
    session = undefined;
  }
  async function handle(req: IncomingMessage, res: ServerResponse) {
    res.setHeader("Cache-Control", "no-store");
    res.setHeader(
      "Content-Security-Policy",
      "default-src 'none'; script-src 'self'; style-src 'self'; connect-src 'self'; img-src 'self'; form-action 'self'; base-uri 'none'; frame-ancestors 'none'",
    );
    res.setHeader("Referrer-Policy", "no-referrer");
    res.setHeader("X-Content-Type-Options", "nosniff");
    const requestHost = "http://" + req.headers.host;
    if (
      requestHost !== origin &&
      !(origin === "http://127.0.0.1" && requestHost === origin + ":80")
    )
      return failure(
        res,
        403,
        "PERMISSION_DENIED",
        "请使用启动时显示的本机地址。",
      );
    const path = req.url ?? "";
    if (req.method === "GET") {
      const asset = assets.get(path);
      if (asset) {
        const content = await readFile(
          new URL("../../../web/" + asset[0], import.meta.url),
        );
        res
          .writeHead(200, { "Content-Type": asset[1] + "; charset=utf-8" })
          .end(content);
        return;
      }
    }
    if (
      ![
        "/api/startup",
        "/api/login",
        "/api/logout",
        "/api/session",
        "/api/call",
        "/api/updates",
        "/api/roles",
      ].includes(path)
    )
      return failure(res, 404, "NOT_FOUND", "页面不存在。");
    if (
      req.method !==
      (path === "/api/session" || path === "/api/startup" ? "GET" : "POST")
    )
      return failure(res, 405, "INVALID_INPUT", "请求方法不正确。");
    if (
      req.method === "POST" &&
      (req.headers.origin !== origin ||
        req.headers["content-type"]?.split(";")[0]?.trim() !==
          "application/json")
    )
      return failure(res, 403, "PERMISSION_DENIED", "请从本机门户页面提交。");
    if (path === "/api/startup") {
      res.setHeader("X-Bzt-Portal-Instance", instanceId);
      if (
        req.headers["x-bzt-launch"] !== undefined &&
        req.headers["x-bzt-launch"] !== launchToken
      )
        return failure(
          res,
          403,
          "PERMISSION_DENIED",
          "启动链接已失效，请重新打开本机工作台。",
        );
      const state = startup
        ? await startup()
        : { needsBaseUrl: false, hasSavedLogin: false };
      return reply(
        res,
        200,
        req.headers["x-bzt-launch"] === launchToken
          ? state
          : { needsBaseUrl: state.needsBaseUrl, hasSavedLogin: false },
      );
    }
    if (session && !session.busy && clock() - session.lastUsed >= idleMs)
      forget();
    const busy = () =>
      failure(res, 409, "INVALID_INPUT", "当前操作正在进行，请稍后重试。");
    if (path === "/api/login") {
      const fields = loginForm.safeParse(await json(req));
      if (!fields.success)
        return failure(res, 400, "INVALID_INPUT", "请输入禅道账号和密码。");
      if (loggingIn || session?.busy) return busy();
      loggingIn = true;
      try {
        const form = fields.data;
        const localOwner = form.launch === launchToken;
        if (form.launch && !localOwner)
          return failure(
            res,
            403,
            "PERMISSION_DENIED",
            "启动链接已失效。请重新打开本机工作台，或使用禅道账号登录。",
          );
        if ("baseUrl" in form && form.baseUrl && !localOwner)
          return failure(
            res,
            403,
            "PERMISSION_DENIED",
            "首次设置禅道地址，请从本机启动入口打开。",
          );
        const saved = "saved" in form;
        const connection = await login(
          saved ? "" : form.account,
          saved ? "" : form.password,
          {
            localOwner,
            ...(saved
              ? { saved: true }
              : form.baseUrl
                ? { baseUrl: form.baseUrl }
                : {}),
          },
        );
        if (stopping || res.destroyed) {
          connection.close();
          return;
        }
        forget();
        const token = randomBytes(32).toString("hex");
        session = { connection, token, lastUsed: clock(), busy: 0 };
        if (localOwner) {
          launchToken = randomBytes(32).toString("hex");
          // 已建立的会话不依赖启动器交接文件。交接失败时仍可手工登录。
          try {
            await onLaunchUrlChanged?.(launchUrl());
          } catch {
            /* 手工登录仍可用 */
          }
        }
        res.setHeader(
          "Set-Cookie",
          cookieName + "=" + token + "; Path=/api/; HttpOnly; SameSite=Strict",
        );
        return reply(res, 200, connection.identity);
      } finally {
        loggingIn = false;
      }
    }
    const active = session;
    if (
      !active ||
      !req.headers.cookie
        ?.split(";")
        .some((s) => s.trim() === cookieName + "=" + active.token)
    )
      return failure(res, 401, "AUTH_FAILED", "请先登录。");
    if (loggingIn) return busy();
    if (savingRoles || (path === "/api/roles" && active.busy)) return busy();
    if (path !== "/api/updates") active.lastUsed = clock();
    if (
      path !== "/api/session" &&
      req.headers["x-bzt-account"] !==
        encodeURIComponent(active.connection.identity.account)
    )
      return failure(res, 409, "AUTH_FAILED", "登录账号已切换，请刷新页面。");
    // 退出即时撤销身份。已开始的操作完成回读后，最后一个请求负责关闭旧账号库。
    ++active.busy;
    if (path === "/api/roles") savingRoles = true;
    const ended = () => failure(res, 401, "AUTH_FAILED", "本次会话已结束。");
    const respond = (value: unknown) =>
      session === active ? reply(res, 200, value) : ended();
    try {
      if (path === "/api/session") {
        if (active.connection.readIdentity)
          return respond(await active.connection.readIdentity());
        return respond({
          account: active.connection.identity.account,
          roles: await active.connection.readRoles(),
          roleSetup: await active.connection.readRoleSetup?.(),
        });
      }
      const body = await json(req);
      if (session !== active) return ended();
      if (path === "/api/updates") {
        const fields = updateRequest.safeParse(body);
        if (!fields.success || !active.connection.checkUpdates)
          return failure(res, 400, "INVALID_INPUT", "同步检查参数不合法。");
        return respond(
          await active.connection.checkUpdates(
            fields.data.role,
            fields.data.acknowledge,
            fields.data.section,
          ),
        );
      }
      if (path === "/api/roles") {
        if (!active.connection.saveRoles)
          return failure(
            res,
            403,
            "PERMISSION_DENIED",
            "仅本机使用者可维护本人的职责。",
          );
        const fields = roleForm.safeParse(body);
        if (!fields.success)
          return failure(res, 400, "INVALID_INPUT", "请重新核对所选职责。");
        return respond(
          await active.connection.saveRoles(
            fields.data.roles,
            fields.data.revision,
          ),
        );
      }
      if (path === "/api/logout") {
        if (!empty.safeParse(body).success)
          return failure(res, 400, "INVALID_INPUT", "退出参数不合法。");
        forget();
        res.setHeader(
          "Set-Cookie",
          cookieName + "=; Path=/api/; HttpOnly; SameSite=Strict; Max-Age=0",
        );
        return reply(res, 200, { ok: true });
      }
      const fields = action.safeParse(body);
      if (!fields.success)
        return failure(res, 400, "INVALID_INPUT", "表单参数不合法。");
      const { role, tool, input, readMode, month } = fields.data;
      return respond(
        await active.connection.call(role, tool, input, readMode, month),
      );
    } catch (error) {
      if (session !== active) return ended();
      const projected = active.connection.projectError(error);
      if (path === "/api/roles" && projected.code === "PLAN_STALE")
        return failure(
          res,
          409,
          projected.code,
          "职责配置已变更，请刷新后重新选择。",
        );
      return businessError(res, projected);
    } finally {
      if (path === "/api/roles") savingRoles = false;
      --active.busy;
      if (!active.busy && session !== active) active.connection.close();
    }
  }
  const server = createServer(
    { maxHeaderSize: 8192, requestTimeout: 30000 },
    (req, res) => {
      void handle(req, res).catch((err: unknown) =>
        businessError(res, projectToolError(err)),
      );
    },
  );
  await new Promise<void>((resolve, reject) => {
    server.once("error", reject);
    server.listen(port, "127.0.0.1", () => {
      server.off("error", reject);
      resolve();
    });
  });
  const address = server.address();
  if (!address || typeof address === "string")
    throw new Error("本机监听地址无效。");
  origin = new URL("http://127.0.0.1:" + address.port).origin;
  cookieName = "bzt_portal_" + address.port;
  const timer = setInterval(() => {
    if (session && !session.busy && clock() - session.lastUsed >= idleMs)
      forget();
  }, 60_000);
  timer.unref();
  return {
    url: origin,
    instanceId,
    get launchUrl() {
      return launchUrl();
    },
    async close() {
      stopping = true;
      clearInterval(timer);
      await new Promise<void>((resolve, reject) =>
        server.close((error) => (error ? reject(error) : resolve())),
      );
      forget();
    },
  };
}
