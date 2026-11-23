import { describe, expect, it } from "vitest";
import { createFixtureSanitizer } from "../../src/api/internal/fixture-sanitizer.ts";

const example = "示例文本";

describe("WP-03 夹具接口形态（06 §3、§6；09 §1.1）", () => {
  it("保留实例配置、分页、评审、项目、任务及缺陷字段的结构和类型", () => {
    const raw = {
      requestType: "GET",
      sessionName: "zentaosid",
      sessionID: "offline-only-cookie-value",
      requestFix: "custom-request-separator",
      moduleVar: "custom-module-param",
      methodVar: "custom-method-param",
      viewVar: "custom-view-param",
      grade: "2",
      model: "scrum",
      executionCount: 3,
      storyCount: "20",
      teamMembers: [{ account: "fixture-member" }],
      totalEstimate: "52.50",
      totalConsumed: 42,
      todoCount: 12,
      pager: { recTotal: "35", pageTotal: 4 },
      forceReview: false,
      needReview: true,
      needNotReview: "1",
      currentConsumed: "1.5",
      extra: { source: "ai" },
      storyTitle: "2026-11-23",
      openedBuild: "14",
      confirmed: "1",
      resolvedBuild: 19,
      changedBy: "fixture-member",
      changedDate: "2026-11-22 17:30:00",
      reviewedDate: "0000-00-00",
    };

    const { sessionID: _credential, ...shape } = raw;
    const sanitizer = createFixtureSanitizer();
    expect(sanitizer.sanitize(raw)).toEqual({
      ...shape,
      requestFix: example,
      moduleVar: example,
      methodVar: example,
      viewVar: example,
      teamMembers: [{ account: "acct_001" }],
      storyTitle: example,
      changedBy: "acct_001",
    });
    expect(
      sanitizer.sanitize({ requestType: "POST", sessionName: "PHPSESSID" }),
    ).toEqual({ requestType: "POST", sessionName: "PHPSESSID" });
    expect(
      sanitizer.sanitize({ sessionName: "custom-session-not-allowed" }),
    ).toEqual({ sessionName: example });
  });

  it("保留包裹和直接返回的必填动作、已知字段与原始数组或字符串类型", () => {
    const form = {
      task: {
        finish: ["realStarted", "finishedDate", "currentConsumed"],
        batchcreate: ["name", "type"],
        close: "finishedDate,closedReason",
      },
      story: { change: { fields: ["title", "spec", "changedDate"] } },
      bug: {
        create: ["title", "openedBuild", "module", "assignedTo", "type"],
      },
    };
    const sanitizer = createFixtureSanitizer();
    expect(sanitizer.sanitize({ requiredFields: form })).toEqual({
      requiredFields: form,
    });
    expect(
      sanitizer.sanitize({
        ...form,
        task: { ...form.task, batchCreate: ["name", "unlisted-private-label"] },
      }),
    ).toEqual({
      ...form,
      task: { ...form.task, batchCreate: ["name", example] },
    });
  });

  it("保留来源与表单枚举键并统一遮盖标签，不生成账号占位值", () => {
    const sources = ["dev", "forum", "ai", "bug"];
    const rows = sources.map((source) => ({ source }));
    const sanitizer = createFixtureSanitizer();
    expect(
      sanitizer.sanitize({
        rows,
        source: {
          dev: "研发来源",
          forum: "论坛来源",
          ai: "自动来源",
          bug: "缺陷来源",
          po: "产品角色名称",
          privateSourceName: "自定义标签",
        },
        sourceList: {
          po: "来源角色 1",
          pm: "来源角色 2",
          rd: "来源角色 3",
          qd: "来源角色 4",
        },
        category: { feature: "2026-11-23", design: "" },
        categoryList: { feature: "<b>名称</b>", design: "设计" },
        priList: { 1: "1", 2: "紧急", 3: "一般", 4: "低" },
        stageList: { design: "设计阶段", closed: "关闭" },
        statusList: { active: "开启", closed: "关闭" },
        account: "fixture-account",
      }),
    ).toEqual({
      rows,
      source: {
        dev: example,
        forum: example,
        ai: example,
        bug: example,
        po: example,
        field_001: example,
      },
      sourceList: { po: example, pm: example, rd: example, qd: example },
      category: { feature: example, design: example },
      categoryList: { feature: example, design: example },
      priList: { 1: example, 2: example, 3: example, 4: example },
      stageList: { design: example, closed: example },
      statusList: { active: example, closed: example },
      account: "acct_001",
    });
  });

  it("裁剪模块字典时保留键 0 根路径以及代表性模块路径深度", () => {
    const raw = {
      0: "/",
      1: "/内部模块",
      2: "/同层第二项",
      3: "/同层第三项",
      4: "/内部模块/第二层/第三层",
      5: "/内部模块/不同的第二层",
      6: "/同层最后一项",
    };
    const representative = {
      0: "/",
      1: "/示例文本",
      4: "/示例文本/示例文本/示例文本",
      5: "/示例文本/示例文本",
    };

    expect(
      createFixtureSanitizer({ listLimit: 4 }).sanitize({
        moduleOptionMenu: raw,
        modulePairs: raw,
      }),
    ).toEqual({
      moduleOptionMenu: representative,
      modulePairs: representative,
    });
    expect(
      createFixtureSanitizer({ listLimit: 1 }).sanitize({ modulePairs: raw }),
    ).toEqual({ modulePairs: { 0: "/" } });
    expect(
      createFixtureSanitizer({ listLimit: 3 }).sanitize({
        modulePairs: { 6: "部门/小组", 7: null, 8: "" },
      }),
    ).toEqual({ modulePairs: { 6: "/示例文本/示例文本", 7: null, 8: "" } });
  });

  it("先遮盖未知字段里的手机号字符串，并保留正常 ID、工时和日期类型", () => {
    expect(
      createFixtureSanitizer().sanitize({
        unlisted: "13800138000",
        unknownValues: ["13900139000", "82"],
        id: "000278",
        parent: -1,
        currentConsumed: "2.50",
        estimate: 4,
        reviewedDate: "2026-11-23 10:30:00",
      }),
    ).toEqual({
      field_001: example,
      field_002: [example, "82"],
      id: "000278",
      parent: -1,
      currentConsumed: "2.50",
      estimate: 4,
      reviewedDate: "2026-11-23 10:30:00",
    });
  });
});
