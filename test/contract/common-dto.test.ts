import { describe, expect, it } from "vitest";
import { z } from "zod";
import {
  brandDto,
  dateTimeSchema,
  parsePlanIds,
  zAccount,
  zBool,
  zCollection,
  zDate,
  zHours,
  zId,
  zNullableId,
  zParentPlanId,
} from "../../src/core/dto/common.ts";
import { pageSchema } from "../../src/api/internal/read-page.ts";
import { createZentaoReadClient } from "../../src/api/client.ts";
import { getReadClient } from "../../src/api/internal/read-client.ts";
import { mockReadClient } from "./read-fixture.ts";

describe("WP-04 公共 DTO 解析契约", () => {
  it("规范化编号、工时、账号和计划关联", () => {
    expect(zId.parse("42")).toBe(42);
    expect(zId.safeParse("42x").success).toBe(false);
    expect(zId.safeParse("0").success).toBe(false);
    expect(
      [0, "0", "", null, "42"].map((value) => zNullableId.parse(value)),
    ).toEqual([null, null, null, null, 42]);
    expect(zParentPlanId.parse("-1")).toBe(-1);
    expect(zHours.parse("1.25")).toBe(1.25);
    expect(zHours.parse("0")).toBe(0);
    expect(zHours.parse("")).toBeNull();
    expect(zHours.safeParse("x").success).toBe(false);
    expect(zAccount.parse({ account: "acct_001", password: "synthetic" })).toBe(
      "acct_001",
    );
    expect(zAccount.parse("closed")).toBe("closed");
    expect(zAccount.parse("")).toBeNull();
    expect(parsePlanIds(",12,13,")).toEqual([12, 13]);
    expect(parsePlanIds("678")).toEqual([678]);
    expect(parsePlanIds("0")).toEqual([]);
    expect(() => parsePlanIds("12,invalid")).toThrow();
  });

  it.each([
    { input: null, expected: [] },
    { input: undefined, expected: [] },
    { input: 0, expected: [] },
    { input: 42, expected: [42] },
    { input: Number.MAX_SAFE_INTEGER, expected: [Number.MAX_SAFE_INTEGER] },
  ])("P1-2 规范化单个计划编号或空值 $input", ({ input, expected }) => {
    expect(parsePlanIds(input)).toEqual(expected);
  });

  it.each([-1, 1.5, Number.NaN, Number.POSITIVE_INFINITY, 2 ** 53])(
    "P1-2 用编号校验拒绝非法数字 %s",
    (input) => {
      expect(() => parsePlanIds(input)).toThrow(z.ZodError);
    },
  );

  it("P1-2 去除计划编号逗号串中的空段和 0 并校验其余编号", () => {
    expect(parsePlanIds(" 0, , 12, 13, 0, ")).toEqual([12, 13]);
    expect(parsePlanIds(" 0, , 0 ")).toEqual([]);
    expect(() => parsePlanIds("12,0,9007199254740992")).toThrow(z.ZodError);
  });

  it.each([-5, "-5"])("P2-2 拒绝负工时（%j）", (input) => {
    expect(zHours.safeParse(input).success).toBe(false);
  });

  it("Q2 字符串 0 和 false 为假，拒绝未知布尔表示", () => {
    for (const value of [true, 1, "1", "true"])
      expect(zBool.parse(value)).toBe(true);
    for (const value of [false, 0, "0", "false", ""])
      expect(zBool.parse(value)).toBe(false);
    expect(zBool.safeParse("no").success).toBe(false);
  });

  it("Q11 解释本地时区、绝对时间和零日期，拒绝非法日与 DST 跳时", () => {
    expect(zDate.parse("2026-11-01")).toBe("2026-11-01");
    expect(zDate.parse("0000-00-00T00:00:00")).toBeNull();
    expect(zDate.parse("0000-00-00T08:00:00Z")).toBeNull();
    expect(zDate.safeParse("2026-02-30").success).toBe(false);
    const shanghai = dateTimeSchema("Asia/Shanghai");
    expect(shanghai.parse("2026-11-01 08:00:00")).toBe(1793491200000);
    expect(shanghai.parse("2026-11-01T00:00:00Z")).toBe(1793491200000);
    expect(shanghai.parse("2026-11-01T08:00:00+08:00")).toBe(1793491200000);
    expect(shanghai.parse("2026-10-31T16:00:00.125-08:00")).toBe(1793491200125);
    expect(shanghai.parse("")).toBeNull();
    expect(shanghai.parse("0000-00-00T08:00:00Z")).toBeNull();
    expect(shanghai.safeParse("2026-11-01 24:00:00").success).toBe(false);
    expect(
      dateTimeSchema("America/New_York").safeParse("2026-03-08 02:30:00")
        .success,
    ).toBe(false);
  });

  it("P2-3 将小写 z 后缀的日期时间按 UTC 解释", () => {
    const shanghai = dateTimeSchema("Asia/Shanghai");
    expect(shanghai.parse("2026-11-01T00:00:00.125z")).toBe(1793491200125);
  });

  it.each([
    "0000-00-00T24:00:00Z",
    "0000-00-00 08:60:00",
    "0000-00-00T08:00:60+08:00",
  ])("P2-3 拒绝时分秒越界的零日期时间 %s", (input) => {
    expect([
      zDate.safeParse(input).success,
      dateTimeSchema("Asia/Shanghai").safeParse(input).success,
    ]).toEqual([false, false]);
  });

  it("集合仅接收数字键，分页吸收 v2 pager 但不返回包裹数据", () => {
    expect(zCollection(z.string()).parse({ 0: "a", 2: "b" })).toEqual([
      "a",
      "b",
    ]);
    expect(zCollection(z.string(), true).safeParse({ 0: "a" }).success).toBe(
      false,
    );
    expect(
      zCollection(z.string()).safeParse({ account: "private" }).success,
    ).toBe(false);
    expect(
      pageSchema("entities", zId).parse({
        entities: { 1: "42" },
        pager: { recTotal: "5", extra: "ignored" },
        users: { example: "ignored" },
      }),
    ).toEqual({ items: [42], total: 5 });
    expect(pageSchema("entities", zId).parse({ entities: [] })).toEqual({
      items: [],
    });
  });

  it("品牌不可枚举、不可改写且不参与序列化", () => {
    const privateBrand = Symbol("ContractFixture");
    const dto = brandDto({ id: 1 }, privateBrand);
    expect(dto[privateBrand]).toBe(true);
    expect(Object.getOwnPropertyDescriptor(dto, privateBrand)).toEqual({
      value: true,
      enumerable: false,
      configurable: false,
      writable: false,
    });
    expect(JSON.stringify(dto)).toBe('{"id":1}');
  });

  it("拒绝无效配置与复制客户端，实例共享登录但只暴露读取", async () => {
    const config = {
      baseUrl: "https://fixture.test/zentao/",
      account: "acct_fixture",
      password: "synthetic-credential",
      clock: () => 0,
    };
    expect(() =>
      createZentaoReadClient({ ...config, timezone: "Invalid/Zone" }),
    ).toThrow(expect.objectContaining({ code: "INVALID_INPUT" }));
    expect(() =>
      createZentaoReadClient({ ...config, baseUrl: "file:///fixture" }),
    ).toThrow(expect.objectContaining({ code: "INVALID_INPUT" }));
    const { client, fetch } = mockReadClient(() =>
      Response.json({ version: "22.6" }),
    );
    expect(Object.keys(client)).toEqual([]);
    expect(() => getReadClient({ ...client })).toThrow(
      expect.objectContaining({ code: "INVALID_INPUT" }),
    );
    const state = getReadClient(client);
    expect(Object.keys(state.http)).toEqual(["read"]);
    const pathTemplate = "/index.php";
    const schema = z.object({ version: z.string() });
    await Promise.all([
      state.http.read({ pathTemplate }, schema),
      state.http.read({ pathTemplate }, schema),
    ]);
    expect(fetch.mock.calls.map(([, init]) => init?.method)).toEqual([
      "POST",
      "GET",
      "GET",
    ]);
  });
});
