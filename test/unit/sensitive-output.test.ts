import { describe, expect, it } from "vitest";
import { assertNoSensitiveData } from "../helpers/assert-no-sensitive-data.ts";

const syntheticToken = "bzt-opaque-test-credential";

describe("S01 安全断言", () => {
  it.each([
    ["嵌套凭据键", { output: [{ Password_Hash: "synthetic" }] }],
    ["配置凭据键", { ZENTAO_PASSWORD: "synthetic" }],
    ["密钥头字段", { headers: { "X-Api-Key": "synthetic" } }],
    ["二进制缓存中的凭据", new TextEncoder().encode('{"token":"synthetic"}')],
    ["Token 键", '{"refreshToken":"synthetic"}'],
    [
      "JWT 特征",
      { detail: "eyJhbGciOiJIUzI1NiJ9.eyJzdWIiOiJ0ZXN0In0.testSignature" },
    ],
    ["明文 Token 标记", "Token: synthetic-token"],
    ["已知不透明凭据", { value: syntheticToken }],
    ["独立密码哈希", { value: "a8d4fa71ec2d4913e40cd3216789abcd" }],
    ["JSON 字符串中的密码哈希", '"a8d4fa71ec2d4913e40cd3216789abcd"'],
    [
      "全量 users 字典",
      { rows: [{ users: { acct_a: { realname: "人员A" } } }] },
    ],
    [
      "NDJSON 中的凭据",
      '{"status":201}\n{"response":{"secret":"synthetic"}}\n',
    ],
  ] as const)("检出%s", (_name, payload) => {
    expect(() => assertNoSensitiveData(payload, [syntheticToken])).toThrow(
      "S01",
    );
  });

  it.each([
    "userPassword",
    "newPassword",
    "apiToken",
    "zentaosid",
    "sessionID",
    "privateKey",
    "qq",
    "weixin",
    "address",
    "birthday",
    "ip",
    "lastIP",
    "zipCode",
  ])("S01 检出隐私字段 %s", (key) => {
    expect(() =>
      assertNoSensitiveData({ nested: { [key]: "synthetic" } }),
    ).toThrow("S01");
  });

  it.each([
    ["userPairs 字典", { userPairs: { acct_a: "人员A" } }],
    ["Bearer 凭据", "before Bearer opaque-test-value after"],
    ["禅道 Cookie 凭据", "Cookie zentaosid=opaque-test-value"],
    ["文本内嵌密码哈希", "before[a8d4fa71ec2d4913e40cd3216789abcd]after"],
  ] as const)("S01 检出%s", (_name, payload) => {
    expect(() => assertNoSensitiveData(payload)).toThrow("S01");
  });

  it("仅报告规则，不在报错里重放凭据", () => {
    try {
      assertNoSensitiveData({ value: syntheticToken }, [syntheticToken]);
      expect.unreachable();
    } catch (error) {
      expect(String(error)).toContain("S01");
      expect(String(error)).not.toContain(syntheticToken);
    }
  });

  it("S01 放行 account、realname、opId、missingEnv 和未含隐私的文本字段", () => {
    expect(() =>
      assertNoSensitiveData({
        users: [{ account: "acct_a", realname: "人员A" }],
        missingEnv: ["ZENTAO_PASSWORD"],
        opId: "e86bc265-68db-46e9-8fe8-73282bfd181c",
        description: "说明",
        skipped: false,
      }),
    ).not.toThrow();
  });
});
