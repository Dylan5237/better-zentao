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
