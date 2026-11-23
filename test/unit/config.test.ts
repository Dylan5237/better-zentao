import {
  copyFile,
  mkdir,
  mkdtemp,
  readFile,
  rm,
  writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { z } from "zod";
import * as config from "../../src/core/config.ts";
import { assertNoSensitiveData } from "../helpers/assert-no-sensitive-data.ts";

const fixtureEnv = {
  ZENTAO_BASE_URL: "https://zentao.fixture.test/zentao",
  ZENTAO_ACCOUNT: "acct_pj",
  ZENTAO_PASSWORD: "bzt-fixture-only-passphrase",
};

let homeDir: string;
beforeEach(async () => {
  homeDir = await mkdtemp(join(tmpdir(), "bzt-config-"));
});
afterEach(async () => {
  await rm(homeDir, { recursive: true, force: true });
});

async function writeJson(path: string, input: unknown) {
  await writeFile(path, JSON.stringify(input), "utf8");
  return path;
}

async function writeUser(
  input: unknown,
  stateDir = join(homeDir, ".better-zentao"),
) {
  await mkdir(stateDir, { recursive: true });
  await writeJson(join(stateDir, "config.json"), input);
}

async function load(
  team?: unknown,
  env: Readonly<Record<string, string | undefined>> = {},
  cli?: { config?: string; product?: string | number },
) {
  const settings: Record<string, string | undefined> = {
    ...fixtureEnv,
    ...env,
  };
  if (team !== undefined)
    settings.BZT_CONFIG = await writeJson(join(homeDir, "team.json"), team);
  return config.loadConfig({ homeDir, env: settings, cli });
}

async function expectInputError(
  operation: () => Promise<unknown>,
  details: { fields: string[] },
  secrets: readonly string[] = [fixtureEnv.ZENTAO_PASSWORD],
): Promise<void> {
  await expect(operation()).rejects.toSatisfy((error: unknown) => {
    expect(error).toMatchObject({
      name: "BztError",
      code: "INVALID_INPUT",
      details,
    });
    assertNoSensitiveData(error, secrets);
    return true;
  });
}

const products = {
  42: { name: "设计平台", state: "design", projects: [179] },
  43: { name: "运行平台", state: "runtime" },
  44: { name: "只读平台", state: "delivery", enabled: false },
  29: { name: "验证平台", state: "other", probeOnly: true },
};

describe("WP-02 配置来源、示例与 schema", () => {
  it("以文档默认值加载且避免携带凭据或虚构人员与产品", async () => {
    const settings = await load();
    expect(settings).toMatchObject({
      version: 1,
      mode: "personal",
      timezone: "Asia/Shanghai",
      products: {},
      modules: {},
      roles: {},
      pairs: [],
      releaseCalendar: [],
      naming: { l3Plan: { matchBy: "dateOverlap" } },
      timeState: { dueSoonWorkdays: 3 },
      calendar: { workdays: [1, 2, 3, 4, 5], holidays: [], extraWorkdays: [] },
      schedule: { dailyHours: 6, weeks: 4, suggestTop: 3 },
      write: {
        planExpiresMinutes: 10,
        minConfirmDelaySeconds: 3,
        importMaxRows: 50,
        disableCapabilities: [],
      },
      http: { concurrency: 8 },
      probe: { productId: 29 },
      snapshot: { day: 1 },
      zentao: {
        baseUrl: "https://zentao.fixture.test/zentao/",
        account: "acct_pj",
        timeoutMs: 15000,
      },
      logLevel: "info",
      stateDir: join(homeDir, ".better-zentao"),
    });
    expect(
      Object.entries(settings.rules)
        .filter(([, value]) => value.enabled)
        .map(([key]) => key),
    ).toEqual(["R01", "R02", "R03", "R04", "R05"]);
    expect(settings.notify.digest.collector).toBeUndefined();
    expect(settings.snapshot.collector).toBeUndefined();
    expect(settings.productId).toBeUndefined();
    assertNoSensitiveData(settings, [fixtureEnv.ZENTAO_PASSWORD]);
  });

  it("真实 JSON 示例过加载器和 S01，JSON Schema 与 strict Zod 输入结构同步", async () => {
    const example = join(homeDir, "example.json");
    await copyFile(
      new URL("../../config/better-zentao.example.json", import.meta.url),
      example,
    );
    const schema = join(homeDir, "schema.json");
    await copyFile(
      new URL("../../config/better-zentao.schema.json", import.meta.url),
      schema,
    );

    const exampleInput: unknown = JSON.parse(await readFile(example, "utf8"));
    const schemaInput: unknown = JSON.parse(await readFile(schema, "utf8"));
    expect(schemaInput).toEqual(
      z.toJSONSchema(config.teamConfigSchema, { io: "input" }),
    );
    const settings = await load(undefined, { BZT_CONFIG: example });
    expect(settings).toMatchObject(exampleInput ?? {});
    assertNoSensitiveData(
      [exampleInput, settings],
      [fixtureEnv.ZENTAO_PASSWORD],
    );
  });

  it("合并五级来源，CLI 文件优先于 BZT_CONFIG，product 只用于本次范围", async () => {
    const stateDir = join(homeDir, "state");
    await writeUser(
      {
        $schema: "./个人配置.json",
        mode: "strict-ai",
        notify: { quietHours: ["22:00", "07:00"] },
      },
      stateDir,
    );
    const cliPath = await writeJson(join(homeDir, "cli-team.json"), {
      $schema: "./better-zentao.schema.json",
      products,
      timezone: "UTC",
      mode: "personal",
      notify: {
        quietHours: ["21:00", "08:00"],
        digest: { time: "10:30", collector: "acct_pj" },
      },
      rules: { R02: { waitAfter: 4 } },
      http: { concurrency: 3 },
    });

    const settings = await load(
      undefined,
      {
        BZT_HOME: stateDir,
        BZT_CONFIG: join(homeDir, "absent.json"),
        ZENTAO_TIMEOUT_MS: " 2300 ",
        BZT_LOG_LEVEL: " WARN ",
      },
      { config: cliPath, product: "43" },
    );
    expect(settings).toMatchObject({
      $schema: "./better-zentao.schema.json",
      mode: "strict-ai",
      timezone: "UTC",
      productId: 43,
      probe: { productId: 29 },
      notify: {
        quietHours: ["22:00", "07:00"],
        digest: { time: "10:30", collector: "acct_pj" },
      },
      write: { planExpiresMinutes: 10 },
      rules: { R02: { enabled: true, missingAfter: 1, waitAfter: 4 } },
      zentao: { timeoutMs: 2300 },
      logLevel: "warn",
      stateDir,
    });
    const teamOnly = await load(
      { http: { concurrency: 3 } },
      { BZT_LOG_LEVEL: "invalid" },
    );
    expect(teamOnly).toMatchObject({
      mode: "personal",
      logLevel: "info",
      http: { concurrency: 3 },
    });
  });

  it("没有团队文件时也读取默认目录的个人配置", async () => {
    await writeUser({
      mode: "strict-ai",
      notify: { quietHours: ["23:30", "06:00"] },
    });
    const settings = await load();
    expect(settings.mode).toBe("strict-ai");
    expect(settings.notify.quietHours).toEqual(["23:30", "06:00"]);
  });

  it("拒绝不存在、不可读或损坏的团队文件，而缺失用户文件可省略", async () => {
    const missing = join(homeDir, "missing.json");
    const corrupted = join(homeDir, "bad.json");
    await writeFile(corrupted, '{ "mode": "' + fixtureEnv.ZENTAO_PASSWORD);
    for (const path of [missing, corrupted, homeDir]) {
      await expectInputError(
        () => load(undefined, { BZT_CONFIG: path }),
        { fields: ["BZT_CONFIG"] },
        [path, fixtureEnv.ZENTAO_PASSWORD],
      );
    }
    await expectInputError(
      () => load({}, {}, { config: missing }),
      { fields: ["--config"] },
      [missing],
    );
    await expectInputError(() => load(undefined, {}, { config: " " }), {
      fields: ["--config"],
    });
    await expect(load()).resolves.toMatchObject({ mode: "personal" });
  });

  it("用户文件存在但 JSON 损坏时报错，隐藏文件位置和原文", async () => {
    const stateDir = join(homeDir, ".better-zentao");
    const path = join(stateDir, "config.json");
    await mkdir(stateDir);
    await writeFile(path, '{ "mode": "' + fixtureEnv.ZENTAO_PASSWORD);
    await expectInputError(() => load(), { fields: ["用户配置"] }, [
      path,
      fixtureEnv.ZENTAO_PASSWORD,
    ]);
  });

  it("拒绝用户降级 strict-ai，并允许保持同一模式", async () => {
    const team = { mode: "strict-ai" };
    await writeUser({ mode: "personal" });
    await expectInputError(() => load(team), { fields: ["mode"] });
    await writeUser({ mode: "strict-ai" });
    await expect(load(team)).resolves.toMatchObject(team);
  });

  it.each([
    [{ rules: {} }, "rules"],
    [{ calendar: {} }, "calendar"],
    [{ modules: {} }, "modules"],
    [{ probe: { productId: 29 } }, "probe"],
    [{ write: {} }, "write"],
    [{ http: {} }, "http"],
    [{ notify: { digest: {} } }, "notify.digest"],
    [{ notify: { personal: true } }, "notify.personal"],
    [{ notify: { quietHours: ["08:60", "21:00"] } }, "notify.quietHours.0"],
    [{ version: 1 }, "version"],
  ])("拒绝越出个人白名单或个人字段非法：%j", async (user, field) => {
    await writeUser(user);
    await expectInputError(() => load(), { fields: [field] });
  });

  it.each([
    [{ version: 2 }, "version"],
    [{ timezone: "Not/A_Timezone" }, "timezone"],
    [{ timezone: "+08:00" }, "timezone"],
    [
      { products: { "042": { name: "重复表示", state: "design" } } },
      "products.042",
    ],
    [
      {
        products: { "9007199254740992": { name: "越界 ID", state: "design" } },
      },
      "products.9007199254740992",
    ],
    [{ products, pairs: [{ design: 41, runtime: 48 }] }, "pairs.0.design"],
    [{ products, pairs: [{ design: 42, runtime: 48 }] }, "pairs.0.runtime"],
    [{ products, modules: { "42:0": { name: "模块" } } }, "modules.42:0"],
    [{ modules: { "42:1": { name: "模块" } } }, "modules.42:1"],
    [{ moduleDefaults: { "43": { devLead: "acct_a" } } }, "moduleDefaults.43"],
    [{ products, moduleDefaults: { "2.1": {} } }, "moduleDefaults.[已脱敏]"],
    [{ rules: { R17: {} } }, "rules.R17"],
    [{ rules: { R02: { beforeRelease: 1 } } }, "rules.R02.beforeRelease"],
    [{ roles: { OTHER: [] } }, "roles.OTHER"],
    [{ versionTag: { pattern: "[" } }, "versionTag.pattern"],
    [
      { legacyReleasePlans: { until: "0000-01-01" } },
      "legacyReleasePlans.until",
    ],
    [
      { legacyReleasePlans: { until: "2028-02-29", titlePattern: "(" } },
      "legacyReleasePlans.titlePattern",
    ],
    [
      {
        releaseCalendar: [
          {
            product: 43,
            version: "V2.0.1",
            date: "2027-02-29",
            owner: "acct_pj",
          },
        ],
      },
      "releaseCalendar.0.date",
    ],
    [{ calendar: { workdays: [1, 1] } }, "calendar.workdays"],
    [{ calendar: { holidays: ["2028-02-30"] } }, "calendar.holidays.0"],
    [
      { calendar: { holidays: ["2028-02-29"], extraWorkdays: ["2028-02-29"] } },
      "calendar.extraWorkdays",
    ],
    [{ notify: { digest: { time: "9:00" } } }, "notify.digest.time"],
    [{ snapshot: { day: 32 } }, "snapshot.day"],
    [{ write: { minConfirmDelaySeconds: 0 } }, "write.minConfirmDelaySeconds"],
    [{ http: { concurrency: 1.5 } }, "http.concurrency"],
  ])("严格校验团队配置路径 %j", async (team, field) => {
    await expect(load(team)).rejects.toSatisfy((error: unknown) => {
      expect(error).toMatchObject({
        code: "INVALID_INPUT",
        details: { fields: expect.arrayContaining([field]) },
      });
      assertNoSensitiveData(error, [fixtureEnv.ZENTAO_PASSWORD]);
      return true;
    });
  });

  it("产品表为空时允许先配置配对。日期接受真实闰日", async () => {
    await expect(
      load({
        pairs: [{ design: 42, runtime: 43 }],
        releaseCalendar: [
          {
            product: 43,
            version: "V2.0.1",
            date: "2028-02-29",
            owner: "acct_pj",
          },
        ],
      }),
    ).resolves.toMatchObject({ pairs: [{ design: 42, runtime: 43 }] });
  });
});

describe("CFG-01 / CFG-08 / CFG-10 / CFG-12 本地环境与配置安全", () => {
  it.each([
    '{"aliases":{"password":"synthetic"},"aliases":{}}',
    '{"aliases":{"name":"a","\\u006eame":"b"}}',
    '{"pairs":[{"design":42,"runtime":43,"design":44}]}',
  ])("CFG-10 拒绝同一对象中的重复键 %s", async (raw) => {
    const path = join(homeDir, "team.json");
    await writeFile(path, raw);
    await expectInputError(() => load(undefined, { BZT_CONFIG: path }), {
      fields: ["BZT_CONFIG"],
    });
  });

  it("CFG-10 独立对象可以使用相同的键，字符串内的标点属于值", async () => {
    const pairs = [
      { design: 42, runtime: 43 },
      { design: 44, runtime: 45 },
    ];
    const aliases = { 标点: '示例 {} "key": []' };
    await expect(load({ pairs, aliases })).resolves.toMatchObject({
      pairs,
      aliases,
    });
  });

  it.each(["/zentao/api.php/v1/products", "/%61pi.PHP/v2"])(
    "CFG-01 拒绝误填的 API 端点 %s",
    async (path) => {
      await expectInputError(
        () =>
          load(undefined, { ZENTAO_BASE_URL: "https://fixture.test" + path }),
        { fields: ["ZENTAO_BASE_URL"] },
      );
    },
  );
  it("CFG-01 允许子目录名含 api.php 字样", async () => {
    await expect(
      load(undefined, {
        ZENTAO_BASE_URL: "https://fixture.test/api.php-files",
      }),
    ).resolves.toMatchObject({
      zentao: { baseUrl: "https://fixture.test/api.php-files/" },
    });
  });

  it.each([
    "/help?key=demo",
    "/cgi-bin/webhook/send",
    "/cgi-bin/webhook/send?key=%20",
    "/cgi-bin/webhook/send?key=a&key=b",
  ])("CFG-08 拒绝错误的机器人发送地址 %s", async (path) => {
    await expectInputError(
      () =>
        load(undefined, {
          BZT_WECOM_WEBHOOK: "https://proxy.fixture.test" + path,
        }),
      { fields: ["BZT_WECOM_WEBHOOK"] },
    );
  });
  it("CFG-01 缺少或纯空白凭据时报缺项", async () => {
    await expect(
      load(undefined, {
        ZENTAO_BASE_URL: undefined,
        ZENTAO_ACCOUNT: "",
        ZENTAO_PASSWORD: " \t ",
      }),
    ).rejects.toMatchObject({
      code: "CONFIG_MISSING",
      details: {
        fields: ["ZENTAO_BASE_URL", "ZENTAO_ACCOUNT", "ZENTAO_PASSWORD"],
      },
    });
  });

  it.each([
    "https://fixture.test/zentao/api.php",
    "https://fixture.test/API.PHP/",
    "https://fixture.test/%61pi.php",
    "https://acct_a:fixture-only@fixture.test/zentao",
    "https://fixture.test?key=synthetic-base-url-key",
    "https://fixture.test/path#fragment",
    "https://fixture.test?",
    "https:fixture.test",
    "ftp://fixture.test",
    "https://fixture.test/path%xx",
  ])("CFG-01 拒绝无效基础地址并只显示变量名", async (url) => {
    await expectInputError(
      () => load(undefined, { ZENTAO_BASE_URL: url }),
      { fields: ["ZENTAO_BASE_URL"] },
      [url, "synthetic-base-url-key", "fixture-only"],
    );
  });

  it.each(["0", "-1", "1.5", "2147483648", "1e3"])(
    "CFG-01 拒绝越界或无效超时 %s",
    async (timeout) => {
      await expectInputError(
        () => load(undefined, { ZENTAO_TIMEOUT_MS: timeout }),
        { fields: ["ZENTAO_TIMEOUT_MS"] },
      );
    },
  );

  it("CFG-08 合法和留空的企微地址通过，地址、密钥和密码均不进入加载结果", async () => {
    const url =
      "https://wecom.fixture.test/cgi-bin/webhook/send?key=wecom-fixture-only";
    const settings = await load(undefined, { BZT_WECOM_WEBHOOK: url });
    assertNoSensitiveData(settings, [
      url,
      "wecom-fixture-only",
      fixtureEnv.ZENTAO_PASSWORD,
    ]);
    await expect(
      load(undefined, { BZT_WECOM_WEBHOOK: " " }),
    ).resolves.toMatchObject({ mode: "personal" });
  });

  it.each([
    "ftp://fixture.test/webhook?key=synthetic-key",
    "https://?key=synthetic-key",
    "wecom.fixture.test/key=synthetic-key",
  ])("CFG-08 拒绝非法地址且不回显", async (url) => {
    await expectInputError(
      () => load(undefined, { BZT_WECOM_WEBHOOK: url }),
      { fields: ["BZT_WECOM_WEBHOOK"] },
      [url, "synthetic-key"],
    );
  });

  it.each([
    "password",
    "passwd",
    "pwd",
    "access_token",
    "mySecret",
    "api-key",
    "Authorization",
    "Cookie",
    "PRIVATE_KEY",
    "zentaoSID",
    "PHPSESSID",
    "webhook",
  ])("CFG-10 / S01 在投影前扫描团队根层或用户嵌套的 %s", async (key) => {
    const secret = "bzt-config-fake-value";
    await expectInputError(
      () => load({ [key]: secret }),
      { fields: ["[已脱敏]"] },
      [secret],
    );
    await writeUser({ notify: { [key]: secret } });
    await expectInputError(() => load(), { fields: ["notify.[已脱敏]"] }, [
      secret,
    ]);
  });

  it.each([
    "前缀 Bearer fixture-only-bearer 后缀",
    "https://wecom.fixture.test/cgi-bin/webhook/send?other=1&key=bzt-fixture-only-key",
    "https://wecom.fixture.test/cgi-bin/webhook/send?%6bey=bzt-fixture-only-key",
    "eyJmaXh0dXJl.eyJkYXRhIn0.c2ln",
    "历史值 d41d8cd98f00b204e9800998ecf8427e 已失效",
  ])("CFG-10 / S01 拦截值与键中的凭据特征", async (sensitive) => {
    await expectInputError(
      () => load({ version: 0, aliases: { 研发主管: sensitive } }),
      { fields: ["aliases.研发主管"] },
      [sensitive],
    );
    await writeUser({ unknown: [{ [sensitive]: "无关" }] });
    await expectInputError(() => load(), { fields: ["unknown.0.[已脱敏]"] }, [
      sensitive,
    ]);
  });

  it("CFG-10 / S01 普通路径指向数组元素，字段路径不能含已知密码或密钥", async () => {
    const key = "webpack-fixture-only";
    await expectInputError(
      () =>
        load(
          {
            safeName: [fixtureEnv.ZENTAO_PASSWORD, key],
            [fixtureEnv.ZENTAO_PASSWORD]: null,
          },
          {
            BZT_WECOM_WEBHOOK: "https://wecom.fixture.test/send?key=" + key,
          },
        ),
      { fields: ["[已脱敏]", "safeName.0", "safeName.1"] },
      [fixtureEnv.ZENTAO_PASSWORD, key],
    );
  });

  it.each([43, "29", null])(
    "CFG-12 拒绝探查产品 %j，CLI 不可覆盖它",
    async (productId) => {
      await expectInputError(
        () => load({ probe: { productId } }, {}, { product: 29 }),
        { fields: ["probe.productId"] },
      );
    },
  );

  it("CFG-12 兼容明确数字 29；CLI 产品范围必须是正整数", async () => {
    await expect(
      load({ probe: { productId: 29 } }, {}, { product: 43 }),
    ).resolves.toMatchObject({
      probe: { productId: 29 },
      productId: 43,
    });
    for (const product of ["0", "2.5", -1, "9007199254740992"]) {
      await expectInputError(() => load(undefined, {}, { product }), {
        fields: ["--product"],
      });
    }
  });
});

describe("CFG-02–CFG-07 / CFG-11 纯校验函数", () => {
  it("CFG-06 区分缺少清单和已确认空清单", async () => {
    const settings = await load({ products });
    const lists = new Map([[42, new Set<number>()]]);
    expect(() => config.checkModuleDevLeads(settings, lists)).toThrow(
      expect.objectContaining({
        code: "CONFIG_MISSING",
        details: expect.objectContaining({ products: [43] }),
      }),
    );
    lists.set(43, new Set());
    expect(() => config.checkModuleDevLeads(settings, lists)).not.toThrow();
  });

  it("CFG-06 普通启用产品标记 probeOnly 仍须有主管", async () => {
    const settings = await load({
      products: { 42: { ...products[42], probeOnly: true } },
    });
    expect(() =>
      config.checkModuleDevLeads(settings, new Map([[42, new Set([3])]])),
    ).toThrow(
      expect.objectContaining({
        code: "CONFIG_MISSING",
        details: { modules: ["42:3"] },
      }),
    );
  });
  it("CFG-02 仅 22.6 且 URAndSR=true 通过，其他情况提示写能力降级", () => {
    expect(
      config.checkZentaoVersion({ version: "22.6", URAndSR: true }),
    ).toEqual({ ok: true });
    for (const instance of [
      { version: "22.7", URAndSR: true },
      { version: "22.6", URAndSR: false },
    ]) {
      expect(config.checkZentaoVersion(instance)).toMatchObject({
        ok: false,
        warning: { check: "CFG-02", severity: "warning" },
        writeCapabilities: "unverified",
      });
    }
  });

  it("CFG-03 比对全部配置产品，包括禁用和探查专用产品", async () => {
    const settings = await load({ products });
    expect(config.findMissingProducts(settings, new Set([42, 43]))).toEqual([
      29, 44,
    ]);
    expect(
      config.findMissingProducts(settings, new Set([29, 42, 43, 44])),
    ).toEqual([]);
  });

  it("CFG-04 按产品核对模块，区分跨产品、缺模块和缺产品", async () => {
    const settings = await load({
      products,
      modules: {
        "42:1": { name: "甲" },
        "42:2": { name: "乙" },
        "43:3": { name: "丙" },
        "44:4": { name: "丁" },
      },
    });
    expect(
      config.findInvalidModuleKeys(
        settings,
        new Map([
          [42, new Set([1])],
          [43, new Set([2])],
        ]),
      ),
    ).toEqual(["42:2", "43:3", "44:4"]);
    expect(
      config.findInvalidModuleKeys(
        settings,
        new Map([
          [42, new Set([1, 2])],
          [43, new Set([3])],
          [44, new Set([4])],
        ]),
      ),
    ).toEqual([]);
  });

  it("CFG-05 汇总各配置来源的账号，去重并排除已删除或目录不存在的账号", async () => {
    const settings = await load({
      products,
      modules: {
        "42:1": {
          name: "模块",
          designLead: "acct_design",
          devLead: "acct_active",
          testLead: "acct_test",
        },
      },
      moduleDefaults: { "42": { devLead: "acct_fallback" } },
      teams: {
        qa: {
          name: "测试团队",
          lead: "acct_teamlead",
          members: ["acct_team", "acct_active"],
        },
      },
      roles: { PM: ["acct_pm", "acct_active"] },
      aliases: { 角色: "acct_alias", 已删除账号: "acct_test" },
      notify: { digest: { collector: "acct_digest" } },
      snapshot: { collector: "acct_snapshot" },
    });
    const invalid = [
      "acct_alias",
      "acct_design",
      "acct_digest",
      "acct_fallback",
      "acct_pm",
      "acct_snapshot",
      "acct_team",
      "acct_teamlead",
      "acct_test",
    ];
    expect(
      config.findInvalidAccounts(settings, [
        { account: "acct_active", deleted: false },
        { account: "acct_test", deleted: true },
      ]),
    ).toEqual(invalid);
    expect(
      config.findInvalidAccounts(
        settings,
        ["acct_active", ...invalid].map((account) => ({
          account,
          deleted: false,
        })),
      ),
    ).toEqual([]);
  });

  it("CFG-06 检查启用产品，优先直接配置，其次按产品兜底", async () => {
    const settings = await load({
      products,
      modules: {
        "42:1": { name: "模块甲", devLead: "acct_rm" },
        "43:2": { name: "模块乙" },
      },
      moduleDefaults: { "43": { devLead: "acct_fallback" } },
    });
    expect(() =>
      config.checkModuleDevLeads(
        settings,
        new Map([
          [42, new Set([1])],
          [43, new Set([2, 3])],
          [44, new Set([5])],
          [29, new Set([6])],
        ]),
      ),
    ).not.toThrow();
    expect(() =>
      config.checkModuleDevLeads(
        settings,
        new Map([
          [42, new Set([1, 4, 7])],
          [43, new Set([2, 3])],
          [44, new Set([5])],
          [29, new Set([6])],
        ]),
      ),
    ).toThrow(
      expect.objectContaining({
        code: "CONFIG_MISSING",
        details: { modules: ["42:4", "42:7"] },
      }),
    );
  });

  it("CFG-07 用注入时钟按业务时区检查当年，跨年时只给警告", async () => {
    const clock = () => Date.UTC(2026, 11, 31, 16);
    const holidays = { calendar: { holidays: ["2026-12-31"] } };
    expect(
      config.checkCalendarYear(
        await load({ ...holidays, timezone: "UTC" }),
        clock,
      ),
    ).toBeUndefined();
    expect(config.checkCalendarYear(await load(holidays), clock)).toMatchObject(
      {
        check: "CFG-07",
        severity: "warning",
        message: expect.stringContaining("2027"),
      },
    );
    expect(
      config.checkCalendarYear(
        await load({ calendar: { holidays: ["2027-01-01"] } }),
        clock,
      ),
    ).toBeUndefined();
  });

  it("CFG-11 摘要和快照分别核对唯一采集账号，缺配置时拒绝执行", async () => {
    const settings = await load({
      notify: { digest: { collector: "acct_digest" } },
      snapshot: { collector: "acct_snapshot" },
    });
    for (const [job, account, other] of [
      ["digest", "acct_digest", "acct_snapshot"],
      ["snapshot", "acct_snapshot", "acct_digest"],
    ] as const) {
      expect(() => config.checkCollector(settings, job, account)).not.toThrow();
      expect(() => config.checkCollector(settings, job, other)).toThrow(
        expect.objectContaining({
          code: "PERMISSION_DENIED",
          details: { collector: account },
        }),
      );
    }
    const defaults = await load();
    expect(() => config.checkCollector(defaults, "digest", undefined)).toThrow(
      expect.objectContaining({
        code: "CONFIG_MISSING",
        details: { fields: ["notify.digest.collector"] },
      }),
    );
    expect(() =>
      config.checkCollector(defaults, "snapshot", "acct_pj"),
    ).toThrow(
      expect.objectContaining({
        code: "CONFIG_MISSING",
        details: { fields: ["snapshot.collector"] },
      }),
    );
  });
});
