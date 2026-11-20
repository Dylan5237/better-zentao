import { expect, it } from "vitest";
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
