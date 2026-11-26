import { readFile } from "node:fs/promises";
import {
  createServer,
  type IncomingMessage,
  type ServerResponse,
} from "node:http";
import { z } from "zod";
import { portalMonthSchema } from "../../services/portal.ts";
import {
  createServerRuntime,
  type Clock,
  type ConfigEnv,
  type ServerConfig,
} from "../../services/server-runtime.ts";
import { projectToolError } from "../../services/workbench.ts";

export interface StartServerOptions {
  readonly config: ServerConfig;
  readonly clock: Clock;
  readonly env?: ConfigEnv;
  readonly fetch?: unknown;
  readonly logSink?: (line: string) => void;
}

const loginForm = z.strictObject({
  instanceId: z.string().trim().min(1).max(64),
  account: z.string().trim().min(1).max(256),
  password: z.string().min(1).max(4096),
});

const actionForm = z.strictObject({
  role: z.string().min(1).max(16),
  tool: z.string().min(1).max(64),
  input: z.record(z.string(), z.unknown()),
  readMode: z.enum(["default", "cached", "sync"]).optional(),
  month: portalMonthSchema.optional(),
});

const updateForm = z.strictObject({
  role: z.string().min(1).max(16),
  section: z
    .enum(["workbench", "intake", "stories", "schedule", "release-risks"])
    .optional(),
  acknowledge: z
    .string()
    .regex(/^[0-9a-f]{64}$/u)
    .optional(),
});

const emptyForm = z.strictObject({});

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

function reply(res: ServerResponse, status: number, value: unknown): void {
  if (res.headersSent) {
    res.end();
    return;
  }
  res
    .writeHead(status, { "Content-Type": "application/json; charset=utf-8" })
    .end(JSON.stringify(value));
}

function failure(
  res: ServerResponse,
  status: number,
  code: string,
  message: string,
): void {
  reply(res, status, { ok: false, code, message });
}

function businessError(
  res: ServerResponse,
  error: ReturnType<typeof projectToolError>,
): void {
  const status =
    error.code === "AUTH_FAILED"
      ? 401
      : error.code === "PERMISSION_DENIED"
        ? 403
        : error.code === "PLAN_STALE"
          ? 409
          : error.retryable
            ? 503
            : 400;
  reply(res, status, error);
}

async function readJsonBody(req: IncomingMessage): Promise<unknown> {
  const chunks: Buffer[] = [];
  let size = 0;
  for await (const chunk of req) {
    if (!Buffer.isBuffer(chunk) || (size += chunk.length) > 128 * 1024)
      return undefined;
    chunks.push(chunk);
  }
  try {
    const parsed: unknown = JSON.parse(Buffer.concat(chunks).toString("utf8"));
    return parsed;
  } catch {
    return undefined;
  }
}

function readCookie(
  header: string | undefined,
  name: string,
): string | undefined {
  if (!header) return undefined;
  const prefix = name + "=";
  for (const part of header.split(";")) {
    const trimmed = part.trim();
    if (trimmed.startsWith(prefix)) {
      const value = trimmed.slice(prefix.length);
      return value || undefined;
    }
  }
  return undefined;
}

function readHeader(value: string | string[] | undefined): string | undefined {
  return Array.isArray(value) ? value[0] : value;
}

export async function startServer(options: StartServerOptions) {
  const { config, clock, env, logSink } = options;
  const external = new URL(config.externalOrigin);
  const isHttps = external.protocol === "https:";
  const expectedHost = external.host.toLowerCase();
  const trustedProxies = new Set(config.trustedProxies);
  const runtime = createServerRuntime({ config, clock, env, logSink });

  let cookieName = isHttps ? "__Host-bzt_session" : "";

  function setSessionCookie(res: ServerResponse, value: string): void {
    const cookie = isHttps
      ? `${cookieName}=${value}; Path=/; HttpOnly; Secure; SameSite=Strict`
      : `${cookieName}=${value}; Path=/api/; HttpOnly; SameSite=Strict`;
    res.setHeader("Set-Cookie", cookie);
  }

  function clearSessionCookie(res: ServerResponse): void {
    const cookie = isHttps
      ? `${cookieName}=; Path=/; HttpOnly; Secure; SameSite=Strict; Max-Age=0`
      : `${cookieName}=; Path=/api/; HttpOnly; SameSite=Strict; Max-Age=0`;
    res.setHeader("Set-Cookie", cookie);
  }

  function setSecurityHeaders(res: ServerResponse): void {
    res.setHeader("Cache-Control", "no-store");
    res.setHeader(
      "Content-Security-Policy",
      "default-src 'none'; script-src 'self'; style-src 'self'; connect-src 'self'; img-src 'self'; form-action 'self'; base-uri 'none'; frame-ancestors 'none'",
    );
    res.setHeader("Referrer-Policy", "no-referrer");
    res.setHeader("X-Content-Type-Options", "nosniff");
    if (isHttps) {
      res.setHeader(
        "Strict-Transport-Security",
        "max-age=31536000; includeSubDomains",
      );
    }
  }

  async function handle(
    req: IncomingMessage,
    res: ServerResponse,
  ): Promise<void> {
    setSecurityHeaders(res);
    const path = req.url ?? "";
    if (req.method === "GET" && path === "/healthz") {
      return reply(res, 200, { ok: true, mode: "server" });
    }

    const requestHost = req.headers.host?.toLowerCase();
    if (!requestHost || requestHost !== expectedHost) {
      return failure(res, 403, "PERMISSION_DENIED", "请使用批准的访问地址。");
    }

    if (isHttps) {
      const peer = req.socket.remoteAddress ?? "";
      const forwardedProto = readHeader(
        req.headers["x-forwarded-proto"],
      )?.toLowerCase();
      if (!trustedProxies.has(peer) || forwardedProto !== "https") {
        return failure(
          res,
          403,
          "PERMISSION_DENIED",
          "请通过受信任的 HTTPS 反向代理访问。",
        );
      }
    }

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
    ) {
      return failure(res, 404, "NOT_FOUND", "页面不存在。");
    }

    const expectedMethod =
      path === "/api/session" || path === "/api/startup" ? "GET" : "POST";
    if (req.method !== expectedMethod) {
      return failure(res, 405, "INVALID_INPUT", "请求方法不正确。");
    }

    if (req.method === "POST") {
      const origin = readHeader(req.headers.origin);
      const contentType = readHeader(req.headers["content-type"])
        ?.split(";")[0]
        ?.trim()
        .toLowerCase();
      if (
        origin !== config.externalOrigin ||
        contentType !== "application/json"
      ) {
        return failure(res, 403, "PERMISSION_DENIED", "请从授权门户页面提交。");
      }
    }

    if (path === "/api/startup") {
      return reply(res, 200, runtime.startup());
    }

    if (path === "/api/login") {
      const body = await readJsonBody(req);
      const fields = loginForm.safeParse(body);
      if (!fields.success) {
        return failure(
          res,
          400,
          "INVALID_INPUT",
          "请选择禅道实例并输入账号和密码。",
        );
      }
      try {
        const previousSessionId = readCookie(req.headers.cookie, cookieName);
        const { sessionId, identity } = await runtime.login({
          ...fields.data,
          previousSessionId,
        });
        setSessionCookie(res, sessionId);
        return reply(res, 200, identity);
      } catch (error) {
        return businessError(res, runtime.projectError(error));
      }
    }

    const sessionId = readCookie(req.headers.cookie, cookieName);
    if (!sessionId) {
      return failure(res, 401, "AUTH_FAILED", "请先登录。");
    }

    if (path === "/api/session") {
      try {
        return reply(res, 200, await runtime.readIdentity(sessionId));
      } catch (error) {
        return businessError(res, runtime.projectError(error));
      }
    }

    // 所有认证后 POST 必须通过会话绑定 CSRF 校验。
    try {
      runtime.verifyCsrf(sessionId, readHeader(req.headers["x-bzt-csrf"]));
    } catch (error) {
      return businessError(res, runtime.projectError(error));
    }

    if (path === "/api/roles") {
      return failure(
        res,
        403,
        "PERMISSION_DENIED",
        "集中部署模式下职责由管理员维护，禁止自助修改。",
      );
    }

    const body = await readJsonBody(req);

    if (path === "/api/logout") {
      if (!emptyForm.safeParse(body).success) {
        return failure(res, 400, "INVALID_INPUT", "退出参数不合法。");
      }
      try {
        runtime.logout(sessionId);
        clearSessionCookie(res);
        return reply(res, 200, { ok: true });
      } catch (error) {
        return businessError(res, runtime.projectError(error));
      }
    }

    if (path === "/api/updates") {
      const fields = updateForm.safeParse(body);
      if (!fields.success) {
        return failure(res, 400, "INVALID_INPUT", "同步检查参数不合法。");
      }
      try {
        return reply(
          res,
          200,
          await runtime.checkUpdates(sessionId, fields.data),
        );
      } catch (error) {
        return businessError(res, runtime.projectError(error));
      }
    }

    const fields = actionForm.safeParse(body);
    if (!fields.success) {
      return failure(res, 400, "INVALID_INPUT", "表单参数不合法。");
    }
    try {
      return reply(res, 200, await runtime.invokeTool(sessionId, fields.data));
    } catch (error) {
      const projected = runtime.projectError(error);
      if (projected.code === "AUTH_FAILED") {
        clearSessionCookie(res);
      }
      return businessError(res, projected);
    }
  }

  const server = createServer(
    { maxHeaderSize: 8192, requestTimeout: 30_000 },
    (req, res) => {
      void handle(req, res).catch((err: unknown) =>
        businessError(res, projectToolError(err)),
      );
    },
  );

  try {
    await new Promise<void>((resolve, reject) => {
      server.once("error", reject);
      server.listen(config.port, config.host, () => {
        server.off("error", reject);
        resolve();
      });
    });
  } catch (error) {
    runtime.close();
    throw error;
  }

  const address = server.address();
  if (!address || typeof address === "string") {
    runtime.close();
    server.close();
    throw new Error("集中服务监听地址无效。");
  }
  if (!isHttps) {
    cookieName = `bzt_session_${address.port}`;
  }

  const timer = setInterval(() => {
    runtime.pruneExpiredSessions();
  }, 60_000);
  timer.unref();

  return {
    url: `http://${config.host}:${address.port}`,
    port: address.port,
    externalOrigin: config.externalOrigin,
    async close() {
      clearInterval(timer);
      await new Promise<void>((resolve, reject) =>
        server.close((error) => (error ? reject(error) : resolve())),
      );
      runtime.close();
    },
  };
}
