import { request } from "node:http";
import { mkdtemp, readdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, expect, vi } from "vitest";
import type { startServer } from "../../src/adapters/server/http.ts";
import type { ServerConfig } from "../../src/core/server-config.ts";
import type { ModelTransport } from "../../src/services/ai/model-gateway.ts";

export const externalOrigin = "https://workbench.invalid";
export const password = "synthetic-srv-password-85";
export const viewerPath = "/api.php/v1/user";
export const tokenPath = "/api.php/v1/tokens";
export const storyPath = "/api.php/v1/stories/101";
export const reportPath = "/api.php/v1/products/29/stories";
export const assignmentPath = storyPath + "/assign";
export const report = { role: "RM", tool: "query_stories", input: {} };
export const detail = {
  role: "RM",
  tool: "get_story_progress",
  input: { storyId: 101, view: "dev" },
};
export const assignment = {
  role: "RM",
  tool: "assign_story",
  input: { storyIds: [101], to: "bob", notify: false },
};

type InstanceId = "instanceA" | "instanceB";
type Account = "alice" | "bob";
type RunningServer = Awaited<ReturnType<typeof startServer>>;
type HeaderOverrides = Record<string, string | undefined>;

export function confirmation(opId: string) {
  return {
    role: "RM",
    tool: "confirm_operation",
    input: { opId, previewAck: true },
  };
}

export function operation(opId: string) {
  return { role: "RM", tool: "get_operation", input: { opId } };
}

export async function filesBelow(root: string): Promise<string[]> {
  const entries = await readdir(root, { recursive: true, withFileTypes: true });
  return entries
    .filter((entry) => entry.isFile())
    .map((entry) => join(entry.parentPath, entry.name));
}

function fakeInstance(id: InstanceId) {
  const baseUrl = `https://${id.toLowerCase()}.invalid`;
  const initialTitle = `fixture-${id}-story-101`;
  const people = (["alice", "bob"] as const).map((account, index) => ({
    id: index + 1,
    account,
    realname: `${id}-${account}`,
    role: "dev",
    dept: 0,
    deleted: false,
  }));
  const story = {
    id: 101,
    type: "story",
    product: 29,
    module: 3,
    title: initialTitle,
    status: "draft",
    category: "feature",
    assignedTo: "alice",
    openedBy: "alice",
    openedDate: "2026-11-25 09:00:00",
    spec: `<h3>本次实现范围</h3><p>${initialTitle}</p>`,
  };
  return { baseUrl, initialTitle, people, story };
}

function fakeZentao() {
  const instances = {
    instanceA: fakeInstance("instanceA"),
    instanceB: fakeInstance("instanceB"),
  };
  const sessions = new Map<
    string,
    { instanceId: InstanceId; account: Account }
  >();
  const requests: {
    instanceId: InstanceId;
    path: string;
    method: string;
    token: string | null;
    account: Account;
  }[] = [];
  const faults = new Map<string, number>();
  const unexpected: string[] = [];
  let wrongViewer = false;
  let redirectViewer = false;
  let serial = 0;
  let nextPause:
    | {
        path: string;
        started: () => void;
        release: Promise<void>;
      }
    | undefined;

  function rejectRequest(path: string): never {
    unexpected.push(path);
    throw new Error("离线夹具收到未登记请求。");
  }

  const fetcher = vi.fn<typeof fetch>(async (input, init) => {
    const url = new URL(input instanceof Request ? input.url : String(input));
    const { pathname: path } = url;
    const instanceId = (["instanceA", "instanceB"] as const).find(
      (id) => instances[id].baseUrl === url.origin,
    );
    if (!instanceId) return rejectRequest("unregistered origin");
    const instance = instances[instanceId];
    const method = init?.method ?? "GET";
    const token = new Headers(init?.headers).get("Token");

    if (path === tokenPath && method === "POST") {
      const credentials: unknown = JSON.parse(String(init?.body));
      if (typeof credentials !== "object" || credentials === null)
        return rejectRequest(path);
      const person = instance.people.find(
        ({ account }) =>
          "account" in credentials && credentials.account === account,
      );
      if (!person) return rejectRequest(path);
      requests.push({
        instanceId,
        path,
        method,
        token,
        account: person.account,
      });
      if (!("password" in credentials && credentials.password === password))
        return Response.json({ message: password }, { status: 401 });
      const issued = `synthetic-srv-token-${instanceId}-${person.account}-${++serial}`;
      sessions.set(issued, { instanceId, account: person.account });
      return Response.json({ token: issued }, { status: 201 });
    }

    // 探测版本的入口在现有适配层中允许不带禅道令牌。
    if (path === "/index.php" && method === "GET")
      return Response.json({ version: "22.6", URAndSR: true });

    const identity = token === null ? undefined : sessions.get(token);
    if (!identity || identity.instanceId !== instanceId)
      return rejectRequest(path + " without its instance token");
    const { account } = identity;
    requests.push({ instanceId, path, method, token, account });
    if (path === viewerPath && redirectViewer) {
      // 模拟 fetch 的重定向策略，阻断会跟随跳转的调用。
      if (init?.redirect === "error") throw new TypeError("Fixture redirect");
      if (init?.redirect !== "manual")
        return rejectRequest("redirect to unregistered origin");
      return new Response(null, {
        status: 302,
        headers: { Location: "https://unregistered.invalid/redirect" },
      });
    }
    const fault = faults.get(`${instanceId}:${account}:${path}`);
    if (fault !== undefined)
      return Response.json(
        { message: `${password} ${token}` },
        { status: fault },
      );

    if (method === "POST" && path === assignmentPath) {
      const body: unknown = JSON.parse(String(init?.body));
      if (
        typeof body !== "object" ||
        body === null ||
        !("assignedTo" in body) ||
        (body.assignedTo !== "alice" && body.assignedTo !== "bob")
      )
        return rejectRequest(path);
      instance.story.assignedTo = body.assignedTo;
      return Response.json({ id: 101 }, { status: 200 });
    }
    if (method !== "GET") return rejectRequest(method + " " + path);

    switch (path) {
      case viewerPath:
        return Response.json({
          profile: {
            ...instance.people.find((person) =>
              wrongViewer
                ? person.account !== account
                : person.account === account,
            ),
            password: "synthetic-upstream-password-hash",
            users: { privateAccount: "synthetic-upstream-directory-value" },
          },
        });
      case "/api.php/v2/users":
        return Response.json({ users: instance.people, total: 2 });
      case "/api.php/v1/products":
        return Response.json({
          products: [
            {
              id: 29,
              name: `fixture-product-${instanceId}`,
              status: "normal",
              deleted: false,
            },
          ],
          total: 1,
        });
      case reportPath:
        return Response.json(
          { stories: [instance.story], total: 1 },
          { status: 201 },
        );
      case storyPath: {
        const result = Response.json(instance.story);
        const pause = nextPause;
        if (pause?.path === path) {
          nextPause = undefined;
          pause.started();
          await pause.release;
        }
        return result;
      }
      case "/api.php/v1/products/29/bugs":
        return Response.json({ bugs: [], total: 0 });
      case "/api.php/v1/products/29/plans":
        return Response.json({ plans: [], total: 0 });
      case "/api.php/v1/executions":
        return Response.json({ executions: [], total: 0 });
      case "/api.php/v2/my/contribute":
      case "/api.php/v2/my/work":
        return Response.json({
          stories: [],
          tasks: [],
          pager: { recTotal: 0 },
          todoCount: {},
        });
      default:
        return rejectRequest(path);
    }
  });

  return {
    instances,
    fetcher,
    requests,
    unexpected,
    tokens: () => [...sessions.keys()],
    writes: () => requests.filter(({ path }) => path === assignmentPath),
    mismatchViewer: () => {
      wrongViewer = true;
    },
    redirectViewer: () => {
      redirectViewer = true;
    },
    fail(
      instanceId: InstanceId,
      account: Account,
      path: string,
      status?: number,
    ) {
      const key = `${instanceId}:${account}:${path}`;
      if (status === undefined) faults.delete(key);
      else faults.set(key, status);
    },
    pauseNextDetail() {
      const started = Promise.withResolvers<void>();
      const release = Promise.withResolvers<void>();
      nextPause = {
        path: storyPath,
        started: started.resolve,
        release: release.promise,
      };
      return { started: started.promise, release: release.resolve };
    },
  };
}

export function useServerFixture() {
  let root: string;
  let now: number;
  let upstream: ReturnType<typeof fakeZentao>;
  const logs: string[] = [];
  const servers = new Set<RunningServer>();

  beforeEach(async () => {
    root = await mkdtemp(join(tmpdir(), "bzt-test-server-"));
    now = Date.UTC(2026, 10, 26, 1);
    logs.length = 0;
    upstream = fakeZentao();
    vi.stubGlobal("fetch", upstream.fetcher);
    await Promise.all([
      writeFile(
        join(root, "instanceA.json"),
        JSON.stringify({
          roles: { RM: ["alice", "bob"], RD: ["alice", "bob"] },
        }),
      ),
      writeFile(
        join(root, "instanceB.json"),
        JSON.stringify({
          roles: { RM: ["alice", "bob"], RD: ["alice", "bob"] },
        }),
      ),
    ]);
  });

  afterEach(async () => {
    try {
      await Promise.all([...servers].map((server) => server.close()));
      expect(upstream.unexpected).toEqual([]);
    } finally {
      servers.clear();
      vi.unstubAllGlobals();
      await rm(root, { recursive: true, force: true });
    }
  });

  return {
    root: () => root,
    upstream: () => upstream,
    teamPath: (id: InstanceId) => join(root, id + ".json"),
    advance: (ms: number) => {
      now += ms;
    },
    logs,
    async start(
      overrides: Partial<ServerConfig> = {},
      runtimeOverrides: {
        readonly env?: Record<string, string | undefined>;
        readonly aiTransport?: ModelTransport;
      } = {},
    ) {
      const { startServer } = await import("../../src/adapters/server/http.ts");
      const { serverConfigSchema } =
        await import("../../src/core/server-config.ts");
      const config: ServerConfig = serverConfigSchema.parse({
        version: 1,
        host: "127.0.0.1",
        port: 0,
        externalOrigin,
        trustedProxies: ["127.0.0.1", "::1", "::ffff:127.0.0.1"],
        dataDir: join(root, "data"),
        session: {
          idleTimeoutMinutes: 480,
          absoluteTimeoutMinutes: 1440,
          maxSessions: 20,
          maxSessionsPerUser: 5,
        },
        http: {
          perInstanceConcurrency: 8,
          perUserConcurrency: 4,
          authReserve: 2,
        },
        instances: {
          instanceA: {
            name: "Fixture A",
            baseUrl: upstream.instances.instanceA.baseUrl,
            teamConfigPath: join(root, "instanceA.json"),
          },
          instanceB: {
            name: "Fixture B",
            baseUrl: upstream.instances.instanceB.baseUrl,
            teamConfigPath: join(root, "instanceB.json"),
          },
        },
        ...overrides,
      });
      const server = await startServer({
        config,
        clock: () => now,
        env: {
          BZT_HOME: root,
          BZT_LOG_LEVEL: "debug",
          ...(runtimeOverrides.env ?? {}),
        },
        fetch: upstream.fetcher,
        aiTransport: runtimeOverrides.aiTransport,
        logSink: (line: string) => {
          logs.push(line);
        },
      });
      servers.add(server);
      return server;
    },
    async close(server: RunningServer) {
      await server.close();
      servers.delete(server);
    },
  };
}

export function browser(server: RunningServer) {
  let cookie: string | undefined;
  let csrf: string | undefined;

  async function send(
    path: string,
    body?: unknown,
    overrides: HeaderOverrides = {},
  ) {
    const serialized = body === undefined ? undefined : JSON.stringify(body);
    const headers = {
      Host: new URL(server.externalOrigin).host,
      "X-Forwarded-Proto": "https",
      Cookie: cookie,
      ...(serialized === undefined
        ? {}
        : {
            Origin: server.externalOrigin,
            "Content-Type": "application/json",
            "Content-Length": String(Buffer.byteLength(serialized)),
            "X-Bzt-Csrf": csrf,
          }),
      ...overrides,
    };
    // 使用实际回环连接模拟反代转发；Host 与 Origin 来自外部配置。
    return new Promise<{
      status: number | undefined;
      headers: Headers;
      body: unknown;
    }>((resolve, reject) => {
      const req = request(
        {
          host: "127.0.0.1",
          port: server.port,
          path,
          method: serialized === undefined ? "GET" : "POST",
          headers: Object.fromEntries(
            Object.entries(headers).filter(([, value]) => value !== undefined),
          ),
        },
        (res) => {
          const chunks: string[] = [];
          res.setEncoding("utf8");
          res.on("data", (chunk: string) => {
            chunks.push(chunk);
          });
          res.on("error", reject);
          res.on("end", () => {
            try {
              const responseHeaders = new Headers();
              for (const [name, value] of Object.entries(res.headersDistinct))
                for (const item of value ?? [])
                  responseHeaders.append(name, item);
              const text = chunks.join("");
              const body: unknown =
                text &&
                responseHeaders
                  .get("content-type")
                  ?.includes("application/json")
                  ? JSON.parse(text)
                  : text;
              const issued = responseHeaders.getSetCookie()[0];
              if (issued !== undefined && res.statusCode === 200) {
                const pair = issued.split(";")[0];
                cookie = pair?.endsWith("=") ? undefined : pair;
                if (cookie === undefined) csrf = undefined;
              }
              if (
                typeof body === "object" &&
                body !== null &&
                "csrfToken" in body &&
                typeof body.csrfToken === "string"
              )
                csrf = body.csrfToken;
              resolve({
                status: res.statusCode,
                headers: responseHeaders,
                body,
              });
            } catch (error) {
              reject(error);
            }
          });
        },
      );
      req.on("error", reject);
      req.setTimeout(3500, () => req.destroy(new Error("回环测试请求超时。")));
      req.end(serialized);
    });
  }

  return {
    send,
    cookie: () => cookie,
    csrf: () => csrf,
    login(instanceId: InstanceId = "instanceA", account: Account = "alice") {
      return send("/api/login", { instanceId, account, password });
    },
    call(action: unknown, overrides?: HeaderOverrides) {
      return send("/api/call", action, overrides);
    },
  };
}

export async function login(
  client: ReturnType<typeof browser>,
  instanceId?: InstanceId,
  account?: Account,
) {
  const response = await client.login(instanceId, account);
  expect(response.status).toBe(200);
  expect(client.cookie()).toBeTruthy();
  const session = await client.send("/api/session");
  expect(session.status).toBe(200);
  expect(client.csrf()).toEqual(expect.any(String));
  return session;
}
