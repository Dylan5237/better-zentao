import { describe, expect, it } from "vitest";
import {
  assertSanitizedJson,
  createFixtureSanitizer,
} from "../../src/api/internal/fixture-sanitizer.ts";
import { BztError } from "../../src/core/errors.ts";
import { assertNoSensitiveData } from "../helpers/assert-no-sensitive-data.ts";

const account = "contract.user-91";
const realname = "赵测试员";
const hash = "af23e7869cb182c402baef5649d358cd";
const jwt = "eyJhbGciOiJIUzI1NiJ9.eyJzdWIiOiJ0ZXN0In0.testSignature";
const email = "synthetic.person@example.invalid";
const mobile = "13800138000";
const host = "zentao.intranet.invalid";
const url = `https://${host}/home/team/document`;
const webhook =
  "https://hooks.example.invalid/cgi-bin/webhook/send?source=bzt&key=opaque-hook";

describe("WP-03 夹具脱敏（09 §1.1 / 06 Q1）", () => {
  it("删除根层和嵌套的原始凭据和人员字典并保留状态码与类型", () => {
    const raw = {
      endpoint: "/api.php/v1/products/{id}/stories",
      status: 201,
      body: {
        id: "11",
        type: "story",
        stories: [],
        desc: null,
        users: { [account]: { realname, Password_Hash: hash } },
        nested: {
          userPairs: { [account]: realname },
          users: {
            [account]: { account, realname, email },
          },
          profile: {
            account,
            realname,
            deleted: false,
            Password_Hash: hash,
            password: hash,
            email,
            mobile,
            lastIP: "10.1.2.3",
            token: "opaque-fixture-auth",
            zentaosid: "opaque-fixture-session",
            PHPSESSID: "opaque-fixture-php-session",
          },
        },
        token: "opaque-fixture-token",
        spec: `<!-- bzt:stage=dev --><h3>业务标题</h3><p href="${url}">Bearer opaque-fixture-bearer ${hash}</p><ul><li>${jwt}</li><li>${email} ${mobile}</li></ul><span>${webhook}</span>`,
        url,
      },
    };

    const clean = createFixtureSanitizer().sanitize(raw);
    expect(clean).toMatchObject({
      endpoint: raw.endpoint,
      status: 201,
      body: {
        id: "11",
        type: "story",
        stories: [],
        desc: null,
        nested: {
          profile: { account: "acct_001", realname: "人员001", deleted: false },
        },
        url: "https://fixture.example.test",
      },
    });
    const serialized = JSON.stringify(clean);
    expect(serialized).toContain("<!-- bzt:stage=dev --><h3>");
    expect(serialized).toContain("</h3><p>");
    expect(serialized).toContain("</p><ul><li>");
    expect(serialized).toContain("</li><li>");
    expect(serialized).toContain("</li></ul><span>");
    expect(serialized).not.toContain("业务标题");
    assertNoSensitiveData(clean, [
      account,
      realname,
      host,
      email,
      mobile,
      "opaque-fixture",
      "opaque-hook",
    ]);
  });

  it("跨夹具复用账号和姓名，保留正文角色、阶段裁剪和豁免标签的协议", () => {
    const approvedBy = "contract.approver-3";
    const batch = [
      {
        id: 11,
        assignedTo: account,
        title: "【研发】真实研发安排",
        feedbackBy: `${realname}、另一测试员`,
        spec: `<p>实际描述</p><!-- bzt:v1 maintainer=${account};receiver=${approvedBy};intake=intake-from-company -->`,
        actions: [
          {
            comment:
              "<p>[bzt:meta v1] stage.delivery=false | reason=内部交接描述</p>",
          },
          {
            actor: approvedBy,
            comment: `[bzt:waiver v1] rule=R13 | version=V7.0.3 | approvedBy=${approvedBy} | reason=内部放行原因`,
          },
          {
            comment: `<p>[bzt:v1 maintainer=${account};receiver=${approvedBy};intake=intake-from-company]</p>`,
          },
        ],
      },
      {
        users: [
          { id: "51", account, realname, deleted: "0" },
          {
            id: 52,
            account: approvedBy,
            realname: "另一测试员",
            deleted: true,
          },
        ],
        team: [{ account, realname: "123" }],
      },
    ];
    const first = createFixtureSanitizer();
    const clean = first.sanitizeBatch(batch);
    expect(clean).toEqual(createFixtureSanitizer().sanitizeBatch(batch));
    expect(clean).toMatchObject([
      {
        id: 11,
        assignedTo: "acct_001",
        feedbackBy: "人员001、人员002",
        actions: [{}, { actor: "acct_002" }, {}],
      },
      {
        users: [
          { id: "51", account: "acct_001", realname: "人员001", deleted: "0" },
          { id: 52, account: "acct_002", realname: "人员002", deleted: true },
        ],
        team: [{ account: "acct_001", realname: "123" }],
      },
    ]);
    const serialized = JSON.stringify(clean);
    expect(serialized).toContain("【研发】");
    expect(serialized).toContain(
      "<!-- bzt:v1 maintainer=acct_001;receiver=acct_002;intake=intake_001 -->",
    );
    expect(serialized).toContain(
      "[bzt:v1 maintainer=acct_001;receiver=acct_002;intake=intake_001]",
    );
    expect(serialized).toContain(
      "[bzt:meta v1] stage.delivery=false | reason=",
    );
    expect(serialized).toContain(
      "[bzt:waiver v1] rule=R13 | version=V7.0.3 | approvedBy=acct_002 | reason=",
    );
    assertNoSensitiveData(clean, [
      account,
      realname,
      approvedBy,
      "另一测试员",
      "intake-from-company",
      "真实研发安排",
      "实际描述",
      "内部交接描述",
      "内部放行原因",
    ]);
    expect(first.sanitize({ openedBy: approvedBy, realname })).toEqual({
      openedBy: "acct_002",
      realname: "人员001",
    });
  });

  it("只保留已知结构，隐藏未知文本和动态键中出现的身份与业务信息", () => {
    const clean = createFixtureSanitizer().sanitizeBatch([
      {
        data: {
          绝密产品代号: [{ detail: `内部来源 ${account}` }],
          [account]: realname,
          "23": null,
          container: { proprietaryPrivilegeFlag: true },
          message:
            '{"authorization":"opaque-json","email":"private@example.invalid"}',
          title:
            '<script src="file:///very-private-path">脚本描述</script><a href="https://intranet.invalid">链接原文</a>',
          spec: "<!-- bzt:v1 leakKey=secret-free-text;maintainer=contract.user-91 -->",
        },
      },
      { profile: { realname, account } },
    ]);
    expect(clean).toMatchObject([
      {
        data: {
          "23": null,
          message: expect.any(String),
          title: expect.stringContaining("<a>"),
          spec: "<!-- bzt:v1 maintainer=acct_001 -->",
        },
      },
      { profile: { realname: "人员001", account: "acct_001" } },
    ]);
    assertNoSensitiveData(clean, [
      account,
      realname,
      "绝密产品代号",
      "内部来源",
      "proprietaryPrivilegeFlag",
      "opaque-json",
      "very-private-path",
      "intranet.invalid",
      "脚本描述",
      "链接原文",
      "leakKey",
      "secret-free-text",
    ]);
    const serialized = JSON.stringify(clean);
    expect(serialized).not.toContain("<script");
    expect(serialized).toContain("field_");
  });

  it("丢弃请求和响应头，支持使用采集文件的端点标识", () => {
    const clean = createFixtureSanitizer().sanitize({
      endpoint: "story-detail-v2",
      body: {
        headers: { trace: "opaque-echoed-header" },
        requestHeaders: { authorization: "opaque-request-header" },
        responseHeaders: { value: true },
        id: "11",
      },
    });
    expect(clean).toEqual({ endpoint: "story-detail-v2", body: { id: "11" } });
    assertNoSensitiveData(clean, [
      "opaque-echoed-header",
      "opaque-request-header",
    ]);
  });

  it("原输入已含占位形态的身份时仍更换实际账号、姓名与关联值", () => {
    const sanitized = createFixtureSanitizer().sanitize({
      account: "acct_001",
      realname: "人员001",
      spec: "<!-- bzt:v1 maintainer=acct_001;intake=intake_001 -->",
    });
    expect(sanitized).toEqual({
      account: "acct_002",
      realname: "人员002",
      spec: "<!-- bzt:v1 maintainer=acct_002;intake=intake_002 -->",
    });
  });

  it("限制大列表体积并保留首尾、不同状态、删除标记、父子和多人模式", () => {
    const tasks = Array.from({ length: 1800 }, (_, index) => ({
      id: index + 1,
      status: "wait",
    }));
    const source = {
      tasks: [
        ...tasks.slice(0, 100),
        { id: 2901, status: "doing", isParent: "1", deleted: false },
        ...tasks.slice(100, 300),
        {
          id: "2902",
          status: "closed",
          parent: "2901",
          mode: "linear",
          deleted: true,
        },
        ...tasks.slice(300, 1200),
        { id: 2903, status: "changed", mode: "multi" },
        ...tasks.slice(1200),
      ],
    };
    const clean = createFixtureSanitizer({ listLimit: 6 }).sanitize(source);
    expect(clean).toMatchObject({
      tasks: [
        { id: 1 },
        { id: 2 },
        { id: 2901, status: "doing", isParent: "1", deleted: false },
        {
          id: "2902",
          status: "closed",
          parent: "2901",
          mode: "linear",
          deleted: true,
        },
        { id: 2903, status: "changed", mode: "multi" },
        { id: 1800 },
      ],
    });
    expect(
      createFixtureSanitizer({ listLimit: 1 }).sanitize([1, 2, 3]),
    ).toEqual([1]);
    expect(
      createFixtureSanitizer({ listLimit: 2 }).sanitize([1, 2, 3]),
    ).toEqual([1, 3]);
    expect(
      createFixtureSanitizer({ listLimit: 2 }).sanitize([[], [], [null]]),
    ).toEqual([[], [null]]);
  });

  it("保留字段表、端点、版本、枚举和原始日期及数字形态", () => {
    const raw = {
      endpoint: "GET /api.php/v1/products/{id}/stories?status=all",
      status: 404,
      body: {
        requiredFields: {
          story: {
            create: ["title", "spec", "assignedTo", "verify", "module"],
          },
        },
        id: "11",
        parent: "-1",
        deadline: "2026-11-20",
        finishedDate: "0000-00-00 00:00:00",
        consumed: "2.50",
        plan: ",12,13,",
        keywords: "版本:V7.0.3",
        version: "22.6",
        result: "success",
        stage: "testing",
        URAndSR: true,
        mode: "linear",
        users: [{ deleted: "true" }, { deleted: 1 }, { deleted: false }],
      },
    };
    const sanitizer = createFixtureSanitizer();
    expect(sanitizer.sanitize(raw)).toEqual(raw);
    expect(
      sanitizer.sanitize({ title: "", data: 201, paths: [null, [], 0] }),
    ).toEqual({
      title: "",
      data: 201,
      paths: [null, [], 0],
    });
  });

  it("直接捕获的必填字段表保留已知字段名，隐藏未识别文本", () => {
    const fields = {
      story: { create: ["title", "module", "assignedTo"], edit: "spec,verify" },
      task: { create: ["name", "deadline", "opaque-private-label"] },
    };
    const clean = createFixtureSanitizer().sanitize(fields);
    expect(clean).toEqual({
      story: fields.story,
      task: { create: ["name", "deadline", "示例文本"] },
    });
    assertNoSensitiveData(clean, ["opaque-private-label"]);
  });

  it("保留部门树、待办和表单枚举字典的已知结构", () => {
    const raw = {
      deptTree: [{ id: "11", name: "保密组名" }],
      todos: [{ id: 12, status: "active" }],
      category: { feature: "内部研发类型名", design: "内部设计类型名" },
      source: {
        customer: "隐藏客户入口",
        customBusinessSource: "自定义入口名",
      },
    };
    const clean = createFixtureSanitizer().sanitize(raw);
    expect(clean).toEqual({
      deptTree: [{ id: "11", name: "示例文本" }],
      todos: raw.todos,
      category: { feature: "示例文本", design: "示例文本" },
      source: { customer: "示例文本", field_001: "示例文本" },
    });
    assertNoSensitiveData(clean, [
      "保密组名",
      "内部研发类型名",
      "customBusinessSource",
    ]);
  });

  it("对不可表示为 JSON 的输入和非法上限使用安全错误", () => {
    const flow: { body?: unknown } = {};
    flow.body = flow;
    const sanitizer = createFixtureSanitizer();
    for (const input of [undefined, Infinity, new Map(), flow]) {
      expect(() => sanitizer.sanitize(input)).toThrow(
        expect.objectContaining({ code: "INVALID_INPUT" }),
      );
    }
    for (const listLimit of [0, -1, 2.5, Infinity]) {
      expect(() => createFixtureSanitizer({ listLimit })).toThrow(
        expect.objectContaining({ code: "INVALID_INPUT" }),
      );
    }
  });
});

describe("WP-03 独立二次敏感复扫", () => {
  it.each([
    "password",
    "passwd",
    "pwd",
    "Authorization",
    "bearer",
    "credential",
    "secret",
    "X_API-Key",
    "Set-Cookie",
    "zentaosid",
    "PHPSESSID",
    "session_id",
    "private-key",
    "salt",
    "email",
    "phone",
    "mobile",
    "qq",
    "weixin",
    "wechat",
    "dingding",
    "skype",
    "slack",
    "whatsapp",
    "address",
    "zipCode",
    "birthday",
    "gender",
    "avatar",
    "ip",
    "lastIP",
    "loginIP",
    "clientIP",
    "remoteIP",
  ])("检出隐私/凭据键 %s 并隐藏错误细节", (key) => {
    expect(() =>
      assertSanitizedJson({ nested: [{ [key]: "opaque-fixture" }] }),
    ).toThrow(expect.objectContaining({ code: "INVALID_INPUT" }));
  });

  it.each([
    { nested: { users: { localIdentity: "合成姓名" } } },
    { userPairs: { localIdentity: "合成姓名" } },
    { data: "注释：token=opaque-fixture-token" },
    { data: "注释：Bearer opaque-fixture-bearer" },
    { data: "Cookie: zentaosid=opaque-fixture-cookie" },
    { data: "PHPSESSID=opaque-php-cookie" },
    { data: "password: opaque-password" },
    { data: "-----BEGIN OPENSSH PRIVATE KEY-----" },
    { data: "before$2b$10$offline-bcrypt-hash" },
    { data: hash },
    { data: jwt },
    { data: webhook },
    { data: email },
    { data: "手机号 +86 138-0013-8000" },
    { data: mobile },
    { [email]: "key residual" },
    { data: "账号是 private-synthetic-user!" },
    { data: "beforeopaque-offline-passwordafter" },
    { [account]: false },
    { data: '{"session_id":"opaque-json-session"}' },
    { data: '{"status":201}\n{"password":"opaque-json-password"}' },
    { data: "访问 https://internal.invalid/private/identifier" },
    { data: "10.20.30.40" },
  ])("检出转换后仍在值或键中的合成残留 %#", (payload) => {
    expect(() =>
      assertSanitizedJson(payload, [
        "private-synthetic-user",
        "opaque-offline-password",
        account,
      ]),
    ).toThrow(expect.objectContaining({ code: "INVALID_INPUT" }));
  });

  it("保留数值契约会与已知凭据冲突时直接失败，错误不含实际值", () => {
    const credential = "12045";
    try {
      createFixtureSanitizer({ knownSecrets: [credential] }).sanitize({
        id: credential,
      });
      expect.unreachable();
    } catch (error) {
      expect(error).toBeInstanceOf(BztError);
      expect(error).toMatchObject({ code: "INVALID_INPUT" });
      assertNoSensitiveData(error, [credential]);
    }
    expect(() => assertSanitizedJson({ id: 12045 }, [credential])).toThrow(
      expect.objectContaining({ code: "INVALID_INPUT" }),
    );
  });

  it("数字键列表按同一规则裁剪并保留记录键，不裁剪普通命名对象", () => {
    const clean = createFixtureSanitizer({ listLimit: 3 }).sanitize({
      planStories: {
        "30": { id: 30, status: "wait" },
        "31": { id: 31, status: "wait" },
        "32": { id: 32, status: "active", deleted: true, mode: "multi" },
        "33": { id: 33, status: "wait" },
        "34": { id: 34, status: "wait" },
      },
      detail: { "30": "1", id: "11", total: 4, limit: 5 },
    });
    expect(clean).toEqual({
      planStories: {
        "30": { id: 30, status: "wait" },
        "32": { id: 32, status: "active", deleted: true, mode: "multi" },
        "34": { id: 34, status: "wait" },
      },
      detail: { "30": "1", id: "11", total: 4, limit: 5 },
    });
  });

  it("原账号或原密码出现在另一夹具的保留字段时整批复扫失败", () => {
    const accountSample = "81203";
    const passwordSample = "81204";
    for (const batch of [
      [{ id: accountSample }, { account: accountSample }],
      [{ id: passwordSample }, { password: passwordSample }],
    ]) {
      expect(() => createFixtureSanitizer().sanitizeBatch(batch)).toThrow(
        expect.objectContaining({ code: "INVALID_INPUT" }),
      );
    }
  });

  it.each([
    { headers: { token: "12901" } },
    { requestHeaders: { authorization: "Bearer 12901" } },
    { responseHeaders: { "Set-Cookie": "PHPSESSID=12901; HttpOnly" } },
  ])("已删除头部中的凭据重复出现在保留字段时阻止输出 %#", (envelope) => {
    expect(() =>
      createFixtureSanitizer().sanitize({ ...envelope, id: "12901" }),
    ).toThrow(expect.objectContaining({ code: "INVALID_INPUT" }));
  });

  it.each([
    { credentials: { value: "12901" } },
    { token: [null, { value: [12901] }] },
    { headers: { authorization: ["Bearer 12901"] } },
  ])("P1-3 递归采集对象及数组中的凭据并阻止重复的原始 ID %#", (envelope) => {
    const sanitize = () =>
      createFixtureSanitizer().sanitizeBatch([envelope, { id: "12901" }]);
    expect(sanitize).toThrow(
      expect.objectContaining({ code: "INVALID_INPUT" }),
    );
    try {
      sanitize();
    } catch (error) {
      assertNoSensitiveData(error, ["12901"]);
    }
  });

  it("放行脱敏姓名、人员列表、合法字段与目标占位地址", () => {
    expect(() =>
      assertSanitizedJson(
        {
          users: [{ account: "acct_001", realname: "人员001", deleted: true }],
          description: "示例正文",
          skipped: false,
          version: "22.6",
          url: "https://fixture.example.test",
          actions: [
            { comment: "[bzt:meta v1] stage.delivery=false | reason=示例文本" },
          ],
        },
        ["a", "raw-account"],
      ),
    ).not.toThrow();
  });
});
