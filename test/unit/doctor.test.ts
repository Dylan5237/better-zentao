import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { getDoctorStatus } from "../../src/services/doctor.ts";
import { assertNoSensitiveData } from "../helpers/assert-no-sensitive-data.ts";

it("CFG-01 / CFG-09 本地检测 SQLite，并把空白环境变量视为缺失", async () => {
  const result = await getDoctorStatus(
    {
      ZENTAO_ACCOUNT: " ",
      ZENTAO_BASE_URL: "https://fixture.test",
    },
    "24.11.0",
  );
  expect(result.sqlite).toMatch(/^\d+\.\d+\.\d+$/u);
  expect(result.missingEnv).toEqual(["ZENTAO_ACCOUNT", "ZENTAO_PASSWORD"]);
  expect(result.ok).toBe(false);
  assertNoSensitiveData(result);
});

it("CFG-01 环境齐全时只报告本地状态", async () => {
  const result = await getDoctorStatus(
    {
      ZENTAO_ACCOUNT: "acct_a",
      ZENTAO_BASE_URL: "https://fixture.test",
      ZENTAO_PASSWORD: "synthetic-secret",
    },
    "24.11.0",
  );
  expect(result).toMatchObject({ ok: true, missingEnv: [] });
  assertNoSensitiveData(result, ["synthetic-secret"]);
});

describe("WP-02 doctor 本地检查", () => {
  const env = {
    ZENTAO_ACCOUNT: "acct_pj",
    ZENTAO_PASSWORD: "fixture-doctor-only",
    ZENTAO_BASE_URL: "https://fixture.test",
  };
  const clock = () => Date.UTC(2026, 11, 31, 16);
  let homeDir: string;
  beforeEach(async () => {
    homeDir = await mkdtemp(join(tmpdir(), "bzt-doctor-"));
  });
  afterEach(async () => {
    await rm(homeDir, { recursive: true, force: true });
  });

  it("CFG-07 团队配置缺当年节假日时提示警告，仍通过本地检查", async () => {
    const path = join(homeDir, "team.json");
    await writeFile(
      path,
      JSON.stringify({ calendar: { holidays: ["2026-12-31"] } }),
    );
    const result = await getDoctorStatus(
      { ...env, BZT_CONFIG: path },
      "24.11.0",
      { homeDir, clock },
    );
    expect(result).toMatchObject({
      ok: true,
      warnings: [
        {
          check: "CFG-07",
          severity: "warning",
          message: expect.stringContaining("2027"),
        },
      ],
    });
    assertNoSensitiveData(result, [env.ZENTAO_PASSWORD, path]);
  });

  it("CFG-07 团队日历包含当年节假日时正常通过", async () => {
    const path = join(homeDir, "team.json");
    await writeFile(
      path,
      JSON.stringify({ calendar: { holidays: ["2027-01-01"] } }),
    );
    const result = await getDoctorStatus(
      { ...env, BZT_CONFIG: path },
      "24.11.0",
      { homeDir, clock },
    );
    expect(result).toMatchObject({ ok: true });
    expect(result).not.toHaveProperty("warnings");
  });

  it("CFG-07 未配置团队和用户文件时保留既有输出", async () => {
    const result = await getDoctorStatus(env, "24.11.0", { homeDir, clock });
    expect(result).toEqual({
      ok: true,
      missingEnv: [],
      requiredNode: ">=24.11.0 <25",
      sqlite: expect.any(String),
    });
  });

  it("CFG-07 只存在用户配置时也检查当年节假日", async () => {
    const stateDir = join(homeDir, ".better-zentao");
    await mkdir(stateDir);
    await writeFile(
      join(stateDir, "config.json"),
      JSON.stringify({ mode: "strict-ai" }),
    );
    const result = await getDoctorStatus(env, "24.11.0", { homeDir, clock });
    expect(result).toMatchObject({ ok: true, warnings: [{ check: "CFG-07" }] });
  });

  it("CFG-01 即使没指定配置文件也校验基础地址", async () => {
    const url = "https://fixture.test/api.php?key=fixture-address-key";
    const result = await getDoctorStatus(
      { ...env, ZENTAO_BASE_URL: url },
      "24.11.0",
      { homeDir, clock },
    );
    expect(result).toMatchObject({
      ok: false,
      missingEnv: [],
      configError: {
        code: "INVALID_INPUT",
        details: { fields: ["ZENTAO_BASE_URL"] },
      },
    });
    assertNoSensitiveData(result, [
      url,
      "fixture-address-key",
      env.ZENTAO_PASSWORD,
    ]);
  });

  it("CFG-08 企微 URL 格式错误时仅报告变量名", async () => {
    const url = "ftp://fixture.test/webhook?key=fixture-wecom-key";
    const result = await getDoctorStatus(
      { ...env, BZT_WECOM_WEBHOOK: url },
      "24.11.0",
      { homeDir, clock },
    );
    expect(result).toMatchObject({
      ok: false,
      configError: {
        code: "INVALID_INPUT",
        details: { fields: ["BZT_WECOM_WEBHOOK"] },
      },
    });
    assertNoSensitiveData(result, [
      url,
      "fixture-wecom-key",
      env.ZENTAO_PASSWORD,
    ]);
  });

  it("CFG-10 / S01 有用户文件时先扫描凭据，即使必填环境变量缺失", async () => {
    const stateDir = join(homeDir, "state");
    await mkdir(stateDir);
    await writeFile(
      join(stateDir, "config.json"),
      JSON.stringify({
        notify: { digest: { secret: env.ZENTAO_PASSWORD } },
      }),
    );
    const result = await getDoctorStatus({ BZT_HOME: stateDir }, "24.11.0", {
      homeDir,
      clock,
    });
    expect(result).toMatchObject({
      ok: false,
      missingEnv: ["ZENTAO_BASE_URL", "ZENTAO_ACCOUNT", "ZENTAO_PASSWORD"],
      configError: {
        code: "INVALID_INPUT",
        message: expect.stringContaining("疑似凭据"),
        details: { fields: ["notify.digest.[已脱敏]"] },
      },
    });
    assertNoSensitiveData(result, [env.ZENTAO_PASSWORD, stateDir]);
  });

  it("CFG-12 拒绝团队探查范围覆盖，仍报告 SQLite 本地检查", async () => {
    const path = join(homeDir, "team.json");
    await writeFile(path, '{"probe":{"productId":"29"}}');
    const result = await getDoctorStatus(
      { ...env, BZT_CONFIG: path },
      "24.11.0",
      { homeDir, clock },
    );
    expect(result).toMatchObject({
      ok: false,
      sqlite: expect.any(String),
      configError: {
        code: "INVALID_INPUT",
        details: { fields: ["probe.productId"] },
      },
    });
    assertNoSensitiveData(result, [env.ZENTAO_PASSWORD, path]);
  });
});
