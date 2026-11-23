import { describe, expect, it } from "vitest";
import {
  assertSanitizedJson,
  createFixtureSanitizer,
} from "../../src/api/internal/fixture-sanitizer.ts";
import { assertNoSensitiveData } from "../helpers/assert-no-sensitive-data.ts";

const invalidFixture = expect.objectContaining({ code: "INVALID_INPUT" });
const fixtureUrl = "https://fixture.example.test";

describe("WP-03 P0-1 夹具身份与禅道固定值", () => {
  it("从关闭状态、人员字段和字典中保留系统标记且不占用匿名编号", () => {
    const raw = {
      status: "closed",
      openedBy: "closed",
      assignedTo: "closed,offline-person",
      users: { closed: "Closed", "offline-person": "合成人员甲" },
      profile: { account: "offline-person", realname: "合成人员甲" },
    };

    expect(createFixtureSanitizer().sanitize(raw)).toEqual({
      status: "closed",
      openedBy: "closed",
      assignedTo: "closed,acct_001",
      profile: { account: "acct_001", realname: "人员001" },
    });
  });

  it("单独复扫登录账号的残留，同时保留碰撞的接口结构和枚举值", () => {
    const route = "GET /api.php/v1/user";
    const clean = createFixtureSanitizer({
      configuredAccount: "user",
    }).sanitize({
      endpoint: route,
      body: {
        user: { account: "user", name: "user", openedBy: "status" },
        status: "active",
        creator: { account: "active" },
        title: "【研发】合成标题",
      },
    });
    expect(clean).toMatchObject({
      endpoint: route,
      body: {
        user: { account: "acct_001", name: "示例文本", openedBy: "acct_002" },
        status: "active",
        title: "【研发】示例文本",
      },
    });
    expect(() =>
      createFixtureSanitizer({ configuredAccount: "81203" }).sanitize({
        id: 81203,
      }),
    ).toThrow(invalidFixture);
  });

  it("已知闭环标记同名身份时，仍保留账号字段的系统标记并匿名化显示名", () => {
    expect(
      createFixtureSanitizer({ configuredAccount: "closed" }).sanitize({
        assignedTo: "closed,offline-person",
        openedBy: ["closed"],
        profile: { realname: "closed" },
      }),
    ).toEqual({
      assignedTo: "closed,acct_001",
      openedBy: ["closed"],
      profile: { realname: "人员001" },
    });
  });

  it("中文姓名复扫保留不同名的匿名编号", () => {
    expect(createFixtureSanitizer().sanitize({ realname: "人员" })).toEqual({
      realname: "人员001",
    });
    expect(() =>
      assertSanitizedJson({ realname: "人员001" }, [], ["人员001"]),
    ).toThrow(invalidFixture);
  });

  it.each([
    [
      "已知结构键",
      { user: { status: null }, admin: false },
      ["user", "status", "admin"],
    ],
    [
      "枚举值与标签键",
      { status: "active", category: { design: "示例文本" } },
      ["active", "design"],
    ],
    ["枚举字段中的键", { action: { resolved: "示例文本" } }, ["resolved"]],
    [
      "必填字段名",
      { requiredFields: { story: { create: ["title", "assignedTo"] } } },
      ["title", "assignedTo"],
    ],
    ["合法端点", { endpoint: "GET /api.php/v1/user" }, ["user"]],
    [
      "固定的文本和 URL 占位",
      { description: "示例文本", url: fixtureUrl },
      ["示例文本", fixtureUrl],
    ],
    ["固定标题前缀", { title: "【研发】示例文本" }, ["研发", "示例文本"]],
    [
      "展示字段的固定阶段占位",
      { description: "【研发】示例文本" },
      ["研发", "示例文本"],
    ],
    [
      "正文阶段标记",
      { spec: "<!-- bzt:stage=design --><p>示例文本</p>" },
      ["design", "示例文本"],
    ],
    [
      "元数据阶段与原因占位",
      { spec: "[bzt:meta v1] stage.dev=false | reason=示例文本" },
      ["meta", "dev", "false", "示例文本"],
    ],
    [
      "豁免原因占位",
      {
        comment:
          "[bzt:waiver v1] rule=R13 | approvedBy=acct_001 | reason=示例文本",
      },
      ["waiver", "approvedBy", "示例文本"],
    ],
    [
      "模块菜单的占位路径",
      { moduleOptionMenu: { "12": "/示例文本/示例文本" } },
      ["示例文本"],
    ],
  ] as const)("复扫放行身份碰撞时的%s", (_label, payload, identities) => {
    expect(() => assertSanitizedJson(payload, [], identities)).not.toThrow();
  });

  it.each([
    ["账号字段", { assignedTo: "active" }, "active"],
    ["姓名字段", { realname: "示例文本" }, "示例文本"],
    ["自由文本", { name: "active" }, "active"],
    [
      "必填字段表内的自由正文",
      { requiredFields: { description: "admin" } },
      "admin",
    ],
    [
      "未加空格的中文正文",
      { description: "负责人合成人员甲负责复核" },
      "合成人员甲",
    ],
    [
      "标签中实际的人员",
      { spec: "<!-- bzt:v1 maintainer=active -->" },
      "active",
    ],
    ["未批准的动态键", { body: { "offline-owner": null } }, "offline-owner"],
    ["非枚举映射内的枚举键", { description: { design: null } }, "design"],
    ["枚举映射内的未脱敏标签", { sourceList: { status: "active" } }, "active"],
    [
      "豁免中实际的审批人",
      { comment: "[bzt:waiver v1] approvedBy=active | reason=示例文本" },
      "active",
    ],
    [
      "元数据中实际的原因",
      { spec: "[bzt:meta v1] stage.dev=false | reason=active" },
      "active",
    ],
    ["自由文本中的关闭同名身份", { description: "closed" }, "closed"],
    ["数值 ID", { id: 81203 }, "81203"],
    ["字符串 ID", { id: "81203" }, "81203"],
    [
      "合法端点中的动态 ID",
      { endpoint: "GET /api.php/v1/stories/81203" },
      "81203",
    ],
    [
      "模块菜单的数字键",
      { moduleOptionMenu: { "81203": "/示例文本" } },
      "81203",
    ],
    [
      "包含身份的非占位路径",
      { moduleOptionMenu: { "12": "/示例文本/active" } },
      "active",
    ],
  ] as const)("复扫阻止身份留在%s", (_label, payload, identity) => {
    expect(() => assertSanitizedJson(payload, [], [identity])).toThrow(
      invalidFixture,
    );
  });

  it.each([
    ["结构键", { status: 200 }, "status"],
    ["枚举键", { category: { design: "示例文本" } }, "design"],
    ["枚举值", { status: "active" }, "active"],
    ["端点", { endpoint: "GET /api.php/v1/user" }, "user"],
    ["必填字段", { requiredFields: { story: { create: "title" } } }, "title"],
    ["占位 URL", { url: fixtureUrl }, "fixture.example.test"],
    ["关闭对应的账号标记", { assignedTo: "closed" }, "closed"],
    ["元数据阶段", { spec: "[bzt:meta v1] stage.dev=false" }, "dev"],
    ["模块占位", { moduleOptionMenu: { "12": "/示例文本" } }, "示例文本"],
  ] as const)("复扫在%s中仍检出已知凭据", (_label, payload, secret) => {
    expect(() => assertSanitizedJson(payload, [secret], [secret])).toThrow(
      invalidFixture,
    );
  });
});

describe("WP-03 P0-2 人员记录与原始 users 字典", () => {
  it("保留正整数键的人员记录，递归删除凭据并与人员数组共享匿名身份", () => {
    const sanitized = createFixtureSanitizer().sanitize({
      users: {
        "12": {
          id: 12,
          account: "offline-directory-member",
          realname: "合成人员甲",
          password: "offline-directory-secret",
          profile: { mobile: "13800138000" },
        },
      },
      nested: {
        users: [
          { account: "offline-directory-member", realname: "合成人员甲" },
        ],
      },
    });
    expect(sanitized).toEqual({
      users: {
        "12": { id: 12, account: "acct_001", realname: "人员001", profile: {} },
      },
      nested: {
        users: [{ account: "acct_001", realname: "人员001" }],
      },
    });
    expect(() =>
      assertNoSensitiveData(sanitized, ["offline-directory"]),
    ).not.toThrow();
  });

  it("两种复扫都允许数字键记录，并继续检查其内层字段", () => {
    const users = { "2": { id: "2", account: "acct_001" } };
    expect(() => assertSanitizedJson({ users })).not.toThrow();
    expect(() => assertNoSensitiveData({ users })).not.toThrow();
    const unsafe = { users: { "2": { id: 2, password: "offline-secret" } } };
    expect(() => assertSanitizedJson(unsafe)).toThrow(invalidFixture);
    expect(() => assertNoSensitiveData(unsafe)).toThrow("S01");
  });

  it.each([
    ["空对象", {}],
    ["账号对显示名", { closed: "Closed", member: "合成人员甲" }],
    ["混合键", { "1": { id: 1 }, member: "合成人员甲" }],
    ["字符串记录", { "1": "合成人员甲" }],
    ["缺少自身 id", { "2": { account: "member" } }],
    ["零键", { "0": { id: 0 } }],
    ["负数键", { "-1": { id: -1 } }],
    ["前导零键", { "01": { id: 1 } }],
    ["数组记录", { "1": [{ id: 1 }] }],
  ])("清除%s形式的原始 users 字典并在独立复扫中拒绝", (_label, users) => {
    const payload = { body: { users } };
    expect(createFixtureSanitizer().sanitize(payload)).toEqual({ body: {} });
    expect(() => assertSanitizedJson(payload)).toThrow(invalidFixture);
    expect(() => assertNoSensitiveData(payload)).toThrow("S01");
  });
});
