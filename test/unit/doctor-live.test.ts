import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { runCli } from "../../src/adapters/cli/run-cli.ts";
import { getDoctorStatus } from "../../src/services/doctor.ts";
import { assertNoSensitiveData } from "../helpers/assert-no-sensitive-data.ts";

const account = "fixture-doctor-account";
const password = "fixture-doctor-secret";
const hostname = "doctor.internal.test";
const token = "fixture-doctor-token";
const realname = "测试账号姓名";
const env = {
  ZENTAO_BASE_URL: `https://${hostname}/zentao`,
  ZENTAO_ACCOUNT: account,
  ZENTAO_PASSWORD: password,
};
const profile = {
  id: 10,
  account,
  realname,
  dept: 2,
  role: "po",
  password,
  token,
  users: { [account]: realname },
};
const secrets = [account, password, hostname, token, realname];
const clock = () => 0;

function fakeZentao({
  version = "22.6",
  URAndSR = true,
  failLogin = false,
  malformedUser = false,
  overrides = {},
}: {
  version?: string;
  URAndSR?: boolean;
  failLogin?: boolean;
  malformedUser?: boolean;
  overrides?: Readonly<Record<string, () => Response>>;
} = {}) {
  const fetcher = vi.fn<typeof fetch>(async (input) => {
    const route = new URL(String(input)).pathname.slice("/zentao".length);
    const override = overrides[route];
    if (override) return override();
    switch (route) {
      case "/api.php/v1/tokens":
        return failLogin
          ? Response.json({ message: password }, { status: 401 })
          : Response.json({ token }, { status: 201 });
      case "/index.php":
        return Response.json({ version, URAndSR, token });
      case "/api.php/v1/user":
        return Response.json({
          profile: malformedUser ? { ...profile, id: token } : profile,
        });
      default:
        return Response.json({ message: token }, { status: 404 });
    }
  });
  vi.stubGlobal("fetch", fetcher);
  return fetcher;
}

afterEach(() => vi.unstubAllGlobals());

describe("WP-05 doctor --live（CFG-01–CFG-05 / S01）", () => {
  it("实连只读取版本与当前账号，输出、错误日志及退出码走 CLI 入口", async () => {
    const fetcher = fakeZentao();
    const stdout = vi.fn<(text: string) => void>();
    const stderr = vi.fn<(text: string) => void>();
    await expect(
      runCli(["doctor", "--live"], {
        env,
        clock,
        nodeVersion: "24.11.0",
        stdout,
        stderr,
      }),
    ).resolves.toBe(0);
    const line = stdout.mock.lastCall?.[0] ?? "";
    expect(JSON.parse(line)).toMatchObject({
      ok: true,
      live: { version: "22.6", URAndSR: true, account: "[已脱敏]" },
    });
    expect(fetcher.mock.calls.map(([, request]) => request?.method)).toEqual([
      "POST",
      "GET",
      "GET",
    ]);
    expect(
      fetcher.mock.calls.map(([url]) => new URL(String(url)).pathname),
    ).toEqual([
      "/zentao/api.php/v1/tokens",
      "/zentao/index.php",
      "/zentao/api.php/v1/user",
    ]);
    assertNoSensitiveData([stdout.mock.calls, stderr.mock.calls], secrets);
  });

  it.each([
    ["版本漂移", { version: "22.7", URAndSR: true, visibleVersion: "22.7" }],
    [
      "三级需求关闭",
      { version: "22.6", URAndSR: false, visibleVersion: "22.6" },
    ],
    [
      "版本字段污染",
      { version: "Bearer " + token, URAndSR: true, visibleVersion: "[已脱敏]" },
    ],
  ])("%s时保留连通结果并提示能力需要重新验证", async (_name, instance) => {
    fakeZentao(instance);
    const logSink = vi.fn<(text: string) => void>();
    const result = await getDoctorStatus(env, "24.11.0", {
      live: true,
      clock,
      logSink,
    });
    expect(result).toMatchObject({
      ok: true,
      live: {
        version: instance.visibleVersion,
        URAndSR: instance.URAndSR,
        writeCapabilities: "unverified",
      },
      warnings: [
        {
          check: "CFG-02",
          message: expect.stringContaining("能力需要重新验证"),
        },
      ],
    });
    if (instance.version !== "22.6") {
      expect(result).toHaveProperty(
        "live.capabilitiesNeedingReverification",
        expect.arrayContaining(["story.create", "story.assign"]),
      );
    }
    assertNoSensitiveData([result, logSink.mock.calls], secrets);
  });

  it.each([
    { failLogin: true, code: "AUTH_FAILED" },
    { malformedUser: true, code: "ZENTAO_SCHEMA_MISMATCH" },
  ])("实连失败只报告脱敏缺口 %j", async ({ code, ...options }) => {
    fakeZentao(options);
    const logSink = vi.fn<(text: string) => void>();
    const result = await getDoctorStatus(env, "24.11.0", {
      live: true,
      clock,
      logSink,
    });
    expect(result).toMatchObject({
      ok: false,
      completeness: "partial",
      liveError: { code },
    });
    assertNoSensitiveData([result, logSink.mock.calls], secrets);
  });

  it("缺少凭据、运行时版本不符、配置无效或未授权实连时均保持离线", async () => {
    const fetcher = fakeZentao();
    await getDoctorStatus(env, "24.11.0", { clock });
    await getDoctorStatus({}, "24.11.0", { live: true, clock });
    await getDoctorStatus(env, "22.1.0", { live: true, clock });
    await getDoctorStatus(env, "24.11.0", {
      live: true,
      clock,
      cli: { product: "1.5" },
    });
    expect(fetcher).not.toHaveBeenCalled();
  });

  it("使用投影核对配置的产品、模块和活动账号", async () => {
    const directory = await mkdtemp(join(tmpdir(), "bzt-doctor-live-"));
    const config = join(directory, "team.json");
    const missingAccount = "fixture-missing-account";
    const deletedAccount = "fixture-deleted-account";
    try {
      await writeFile(
        config,
        JSON.stringify({
          products: {
            "29": { name: "示例产品", state: "other", probeOnly: true },
            "30": { name: "缺失产品", state: "other" },
          },
          modules: {
            "29:101": { name: "有效模块", designLead: account },
            "29:102": { name: "缺失模块", devLead: deletedAccount },
          },
          roles: { PM: [missingAccount] },
        }),
      );
      const fetcher = fakeZentao({
        overrides: {
          "/api.php/v1/products": () =>
            Response.json({
              products: [
                { id: 29, name: "示例产品", status: "normal", deleted: false },
              ],
            }),
          "/api.php/v1/products/29": () =>
            Response.json({
              id: 29,
              moduleOptionMenu: [{ id: 101, name: "有效模块" }],
            }),
          "/api.php/v2/users": () =>
            Response.json({
              users: [
                { ...profile, deleted: false },
                { ...profile, id: 11, account: deletedAccount, deleted: true },
              ],
            }),
        },
      });
      const logSink = vi.fn<(text: string) => void>();
      const result = await getDoctorStatus(env, "24.11.0", {
        live: true,
        clock,
        cli: { config },
        logSink,
      });
      expect(result).toMatchObject({
        ok: false,
        live: {
          configFindings: {
            missingProducts: [30],
            invalidModules: ["29:102"],
            invalidAccountCount: 2,
          },
        },
      });
      expect(fetcher.mock.calls).toHaveLength(6);
      assertNoSensitiveData(
        [result, logSink.mock.calls],
        [...secrets, missingAccount, deletedAccount],
      );
    } finally {
      await rm(directory, { recursive: true, force: true });
    }
  });

  it("远端目录读取不完整时保留已验证的连接并注明缺口", async () => {
    const directory = await mkdtemp(join(tmpdir(), "bzt-doctor-live-"));
    const config = join(directory, "team.json");
    try {
      await writeFile(
        config,
        JSON.stringify({
          products: {
            "29": { name: "示例产品", state: "other", probeOnly: true },
          },
        }),
      );
      fakeZentao({
        overrides: {
          "/api.php/v1/products": () =>
            Response.json({ products: [], total: 1 }),
        },
      });
      const logSink = vi.fn<(text: string) => void>();
      const result = await getDoctorStatus(env, "24.11.0", {
        live: true,
        clock,
        cli: { config },
        logSink,
      });
      expect(result).toMatchObject({
        ok: false,
        completeness: "partial",
        live: { version: "22.6", URAndSR: true, account: "[已脱敏]" },
        gaps: [{ endpoint: "team-config", code: "ZENTAO_UNAVAILABLE" }],
      });
      expect(result).not.toHaveProperty("live.configFindings");
      assertNoSensitiveData([result, logSink.mock.calls], secrets);
    } finally {
      await rm(directory, { recursive: true, force: true });
    }
  });
});
