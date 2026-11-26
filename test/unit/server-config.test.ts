import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import type { ServerConfig } from "../../src/core/server-config.ts";

const blockedFetch = vi.fn<typeof fetch>(async () => {
  throw new Error("离线测试禁止出站。");
});
let root: string;

beforeEach(async () => {
  blockedFetch.mockClear();
  vi.stubGlobal("fetch", blockedFetch);
  root = await mkdtemp(join(tmpdir(), "bzt-server-config-"));
});

afterEach(async () => {
  vi.unstubAllGlobals();
  await rm(root, { recursive: true, force: true });
  expect(blockedFetch).not.toHaveBeenCalled();
});

function source() {
  return {
    version: 1,
    externalOrigin: "https://workbench.invalid:8443",
    dataDir: join(root, "data"),
    session: {
      idleTimeoutMinutes: 480,
      absoluteTimeoutMinutes: 1440,
      maxSessions: 20,
      maxSessionsPerUser: 5,
    },
    http: { perInstanceConcurrency: 8, perUserConcurrency: 4, authReserve: 2 },
    instances: {
      instanceA: {
        name: "Fixture A",
        baseUrl: "https://zentao-a.invalid",
        teamConfigPath: join(root, "team.json"),
      },
    },
  };
}

async function writeConfig(json: string) {
  const path = join(root, "server.json");
  await writeFile(path, json, "utf8");
  return path;
}

it("配置 schema 和文件加载器都应用安全默认值", async () => {
  const { serverConfigSchema, loadServerConfig } =
    await import("../../src/core/server-config.ts");
  const input = source();
  const parsed: ServerConfig = serverConfigSchema.parse(input);
  expect(parsed).toMatchObject({
    version: 1,
    host: "127.0.0.1",
    port: 17330,
    externalOrigin: input.externalOrigin,
    readOnly: true,
    allowInsecureHttp: false,
    trustedProxies: [],
    notify: { enabled: false },
    cache: { reportTtlSeconds: 60 },
  });
  const file = await writeConfig(JSON.stringify(input));
  expect(await loadServerConfig(file, {})).toEqual(parsed);
});

it("显式 HTTP 调试配置接受动态端口", async () => {
  const { serverConfigSchema } =
    await import("../../src/core/server-config.ts");
  expect(
    serverConfigSchema.parse({
      ...source(),
      externalOrigin: "http://127.0.0.1:8443",
      allowInsecureHttp: true,
      port: 0,
    }),
  ).toMatchObject({ port: 0, allowInsecureHttp: true });
});

it.each([
  "http://workbench.invalid",
  "https://workbench.invalid/portal",
  "https://user:secret@workbench.invalid",
  "https://workbench.invalid?test=1",
  "https://workbench.invalid#fragment",
])("拒绝非法外部源 %s", async (externalOrigin) => {
  const { serverConfigSchema, loadServerConfig } =
    await import("../../src/core/server-config.ts");
  const input = { ...source(), externalOrigin };
  expect(serverConfigSchema.safeParse(input).success).toBe(false);
  const file = await writeConfig(JSON.stringify(input));
  await expect(async () => loadServerConfig(file, {})).rejects.toThrow();
});

it("拒绝空实例登记表", async () => {
  const { serverConfigSchema, loadServerConfig } =
    await import("../../src/core/server-config.ts");
  const input = { ...source(), instances: {} };
  expect(serverConfigSchema.safeParse(input).success).toBe(false);
  const file = await writeConfig(JSON.stringify(input));
  await expect(async () => loadServerConfig(file, {})).rejects.toThrow();
});

it.each(["password", "accessToken", "clientSecret"])(
  "CFG-10 拒绝嵌套凭据字段 %s 且不回显其值",
  async (key) => {
    const { serverConfigSchema, loadServerConfig } =
      await import("../../src/core/server-config.ts");
    const original = source();
    const secret = "synthetic-server-config-credential";
    const input = {
      ...original,
      instances: {
        instanceA: { ...original.instances.instanceA, [key]: secret },
      },
    };
    expect(serverConfigSchema.safeParse(input).success).toBe(false);
    const file = await writeConfig(JSON.stringify(input));
    const failure = await Promise.resolve()
      .then(() => loadServerConfig(file, {}))
      .then(
        () => undefined,
        (error: unknown) => error,
      );
    expect(failure).toBeInstanceOf(Error);
    expect(String(failure)).not.toContain(secret);
  },
);

it.each([
  [
    "顶层",
    (json: string) => '{"readOnly":false,"readOnly":true,' + json.slice(1),
  ],
  [
    "嵌套转义等价键",
    (json: string) =>
      json.replace('"name":', '"\\u006eame":"alternate","name":'),
  ],
])("文件加载器拒绝%s的重复 JSON 键", async (_kind, duplicate) => {
  const { serverConfigSchema, loadServerConfig } =
    await import("../../src/core/server-config.ts");
  const raw = duplicate(JSON.stringify(source()));
  // 普通 JSON.parse 会保留后一个值，因此 schema 单独无法察觉重复。
  expect(serverConfigSchema.safeParse(JSON.parse(raw)).success).toBe(true);
  const file = await writeConfig(raw);
  await expect(async () => loadServerConfig(file, {})).rejects.toThrow();
});
