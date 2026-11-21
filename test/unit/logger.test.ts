import { stderr } from "node:process";
import { expect, it, vi } from "vitest";
import { writeHttpLog } from "../../src/core/logger.ts";
import { assertNoSensitiveData } from "../helpers/assert-no-sensitive-data.ts";

it("S01 日志只序列化白名单字段并写到指定的 stderr sink", () => {
  const sink = vi.fn<(line: string) => void>();
  const event = {
    method: "GET" as const,
    pathTemplate: "/api.php/v1/stories/{id}" as const,
    status: 201,
    durationMs: 2,
    objectId: 29,
    headers: { Token: "fake-secret" },
    response: { users: { acct_a: { password: "fake-hash" } } },
  };

  writeHttpLog(event, sink);

  expect(sink).toHaveBeenCalledExactlyOnceWith(
    '{"method":"GET","pathTemplate":"/api.php/v1/stories/{id}","status":201,"durationMs":2,"objectId":29}\n',
  );
  assertNoSensitiveData(sink.mock.calls[0]?.[0]);
});

it("S01 拒绝把含凭据的 URL 当成路径模板", () => {
  const sink = vi.fn();
  expect(() =>
    writeHttpLog(
      {
        method: "GET",
        pathTemplate: "/api.php/v1/stories/29?token=fake",
        status: 200,
        durationMs: 1,
      },
      sink,
    ),
  ).toThrow("日志字段不合法");
  expect(sink).not.toHaveBeenCalled();
});

const baseEvent = { method: "GET", status: 200, durationMs: 1 };

it("默认将结构化日志输出到 stderr", () => {
  const write = vi.spyOn(stderr, "write").mockReturnValue(true);
  try {
    writeHttpLog({ ...baseEvent, pathTemplate: "/index.php" });
    expect(write).toHaveBeenCalledExactlyOnceWith(
      '{"method":"GET","pathTemplate":"/index.php","status":200,"durationMs":1}\n',
    );
  } finally {
    write.mockRestore();
  }
});

it.each([
  "/api.php/v1/tokens",
  "/api.php/v1/products/{id}/plans",
  "/api.php/v2/company/browse",
])("允许受控路径模板 %s", (pathTemplate) => {
  const sink = vi.fn();
  writeHttpLog({ ...baseEvent, pathTemplate }, sink);
  expect(sink).toHaveBeenCalledOnce();
  assertNoSensitiveData(sink.mock.calls);
});

it.each([
  "/index.php?",
  "/api.php/v1/stories/29",
  "/api.php/v1/stories/{29}",
  "/api.php/v2/story/view#tab",
  "/api.php/v2/story/{password}",
  "/api.php/v2/api-key/hidden",
  "/api.php/v2/bearer/hidden",
  "/api.php/v2/story/view=secret",
  "/api.php/v1/tokens/more",
  "/api.php/v2/story/a8d4fa71ec2d4913e40cd3216789abcd",
  "/api.php/v1/stories/%32%39",
  "/api.php/v1/stories/..",
  "/api.php/v1/stories/{id}\n",
  "/api.php/v1/stories/tab\tspace",
  "/api.php/v1/stories/end\0",
  "https://fixture.example.test/api.php/v1/stories/{id}",
])("S01 拒绝不安全的路径模板 %j", (pathTemplate) => {
  const sink = vi.fn();
  expect(() => writeHttpLog({ ...baseEvent, pathTemplate }, sink)).toThrow(
    "日志字段不合法",
  );
  expect(sink).not.toHaveBeenCalled();
});

it("S01 debug 也只输出白名单，忽略正文、头、错误原文和其他字段", () => {
  const password = "offline-password-example";
  const token = "offline-opaque-credential";
  const sink = vi.fn();
  writeHttpLog(
    {
      ...baseEvent,
      pathTemplate: "/api.php/v2/stories",
      status: 0,
      body: { password },
      response: { token },
      headers: { Token: token },
      error: new Error(password),
    },
    sink,
    { BZT_LOG_LEVEL: "debug" },
  );
  expect(sink).toHaveBeenCalledExactlyOnceWith(
    '{"method":"GET","pathTemplate":"/api.php/v2/stories","status":0,"durationMs":1}\n',
  );
  assertNoSensitiveData(sink.mock.calls, [password, token]);
});

it.each([
  ["info", 200, true],
  ["warn", 200, false],
  ["warn", 401, true],
  ["error", 401, false],
  ["error", 503, true],
  ["error", 0, true],
  ["typo", 200, true],
] as const)("%s 级别处理 HTTP 状态 %i（输出 %s）", (level, status, visible) => {
  const sink = vi.fn();
  writeHttpLog(
    { ...baseEvent, pathTemplate: "/api.php/v2/stories", status },
    sink,
    { BZT_LOG_LEVEL: level },
  );
  expect(sink).toHaveBeenCalledTimes(visible ? 1 : 0);
});
