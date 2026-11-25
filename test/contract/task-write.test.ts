import { readFileSync } from "node:fs";
import { afterEach, expect, it, vi } from "vitest";
import { z } from "zod";
import { createZentaoReadClient } from "../../src/api/client.ts";
import {
  closeTask,
  createTask,
  linkStoryToExecution,
} from "../../src/api/task-write.ts";
import { assertNoSensitiveData } from "../helpers/assert-no-sensitive-data.ts";

const writeFixture = z.object({
  endpoint: z.string(),
  status: z.int(),
  body: z.object({
    request: z.record(z.string(), z.json()),
    response: z.record(z.string(), z.json()),
  }),
});
const readFixture = z.object({ body: z.record(z.string(), z.json()) });
function fixture(name: string) {
  return JSON.parse(
    readFileSync(
      new URL(`../fixtures/zentao-22.6/${name}.json`, import.meta.url),
      "utf8",
    ),
  );
}
const secret = "raw-task-password";
const create = writeFixture.parse(fixture("writes/task-create.4873"));
const cancel = writeFixture.parse(fixture("writes/task-cancel.4873"));
const close = writeFixture.parse(fixture("writes/task-close.4873"));
const link = writeFixture.parse(fixture("writes/story-linkExecution.4884"));
const task = readFixture.parse(fixture("task-detail")).body;
const story = readFixture.parse(fixture("story-detail")).body;

function setup(handler: (url: URL, init?: RequestInit) => Response) {
  const request = vi.fn<typeof fetch>(async (input, init) => {
    const url = new URL(String(input));
    expect(url.origin).toBe("https://write.fixture.test");
    if (url.pathname.endsWith("/tokens"))
      return Response.json({ token: "fixture-session" }, { status: 201 });
    return handler(url, init);
  });
  vi.stubGlobal("fetch", request);
  return {
    request,
    client: createZentaoReadClient({
      baseUrl: "https://write.fixture.test",
      account: "alice",
      password: "offline-password",
      clock: () => 0,
      logSink: () => undefined,
    }),
  };
}

function writeReply(
  url: URL,
  init: RequestInit | undefined,
  row: z.infer<typeof writeFixture>,
) {
  expect(`${init?.method} ${url.pathname}${url.search}`).toBe(row.endpoint);
  expect(JSON.parse(String(init?.body))).toEqual(row.body.request);
  return Response.json(
    {
      ...row.body.response,
      // The fixture sanitizer masks the successful v2 envelope's status.
      ...(row.status === 200 ? { status: "success" } : {}),
      password: secret,
    },
    { status: row.status },
  );
}

afterEach(() => vi.unstubAllGlobals());

it("WP-33 用 v2 关联需求，且只返回白名单回执（S01）", async () => {
  const { client } = setup((url, init) =>
    url.pathname === "/api.php/v1/stories/4884"
      ? Response.json({
          ...story,
          id: 4884,
          product: 29,
          status: "active",
          executions: [],
        })
      : writeReply(url, init, link),
  );
  const result = await linkStoryToExecution(client, 315, 29, 4884);
  expect(result).toEqual({ status: "accepted", data: { id: 4884 } });
  assertNoSensitiveData(result, [secret]);
});

it("WP-33 以 HTTP 201 创建单级任务，仅投影根对象 id（S01）", async () => {
  const { client } = setup((url, init) => writeReply(url, init, create));
  const result = await createTask(client, 315, create.body.request);
  expect(result).toEqual({ status: "accepted", data: { id: 4873 } });
  assertNoSensitiveData(result, [secret]);
});

it("需求已关联目标执行时只读取需求，不重复发送关联", async () => {
  const { client, request } = setup((url, init) => {
    expect(url.pathname).toBe("/api.php/v1/stories/4884");
    expect(init?.method).toBe("GET");
    return Response.json({
      ...story,
      id: 4884,
      product: 29,
      status: "active",
      executions: [{ id: 315, name: "目标执行" }],
    });
  });
  await expect(linkStoryToExecution(client, 315, 29, 4884)).resolves.toEqual({
    status: "accepted",
    data: { id: 4884 },
  });
  expect(request).toHaveBeenCalledTimes(2);
});

it("无任务 ID 时只发送一次创建请求并返回 unknown", async () => {
  const { client, request } = setup(() =>
    Response.json({ message: "保存成功" }, { status: 201 }),
  );
  await expect(createTask(client, 315, create.body.request)).resolves.toEqual({
    status: "unknown",
  });
  expect(request).toHaveBeenCalledTimes(2);
});

it("版本漂移、父任务字段、执行号不一致及非法日期在发送前拒绝", async () => {
  const { client, request } = setup(() => {
    throw new Error("意外请求");
  });
  await expect(
    createTask(client, 315, create.body.request, { instanceVersion: "22.7" }),
  ).rejects.toMatchObject({ code: "CAPABILITY_UNVERIFIED" });
  for (const body of [
    { ...create.body.request, parent: 1 },
    { ...create.body.request, execution: 123 },
    { ...create.body.request, deadline: "2026-02-30" },
    { ...create.body.request, deadline: "2026-11-24" },
  ]) {
    await expect(createTask(client, 315, body)).rejects.toMatchObject({
      code: "INVALID_INPUT",
    });
  }
  expect(request).not.toHaveBeenCalled();
});

it.each(["wait", "doing", "pause", "changed", "cancel", "done", "closed"])(
  "关闭 %s 任务按状态走 v2 配方并核对回读",
  async (initial) => {
    let state = initial;
    const calls: string[] = [];
    const { client } = setup((url, init) => {
      if (url.pathname === "/api.php/v1/tasks/4873") {
        calls.push(`read:${state}`);
        return Response.json({
          ...task,
          id: 4873,
          status: state,
          deleted: false,
        });
      }
      if (url.pathname.endsWith("/cancel")) {
        calls.push("cancel");
        if (state === "done") return Response.json({ status: "fail" });
        state = "cancel";
        return writeReply(url, init, cancel);
      }
      calls.push("close");
      state = "closed";
      return writeReply(url, init, close);
    });
    const result = await closeTask(client, 4873);
    expect(result).toEqual({ status: "accepted", data: { id: 4873 } });
    expect(calls).toEqual(
      initial === "closed"
        ? ["read:closed"]
        : initial === "cancel" || initial === "done"
          ? [`read:${initial}`, "close", "read:closed"]
          : [
              `read:${initial}`,
              "cancel",
              "read:cancel",
              "close",
              "read:closed",
            ],
    );
    assertNoSensitiveData(result, [secret]);
  },
);

it("取消后未读到 cancel 时不发送关闭请求", async () => {
  const { client, request } = setup((url, init) =>
    url.pathname.endsWith("/cancel")
      ? writeReply(url, init, cancel)
      : Response.json({ ...task, id: 4873, status: "doing", deleted: false }),
  );
  await expect(closeTask(client, 4873)).resolves.toEqual({ status: "unknown" });
  expect(request).toHaveBeenCalledTimes(4);
});

it.each([
  { initial: "doing", route: "cancel" },
  { initial: "done", route: "close" },
])(
  "v2 $route 业务拒绝且回读状态未变时返回 unknown",
  async ({ initial, route }) => {
    const attempted: string[] = [];
    const { client } = setup((url) => {
      if (url.pathname === "/api.php/v1/tasks/4873")
        return Response.json({
          ...task,
          id: 4873,
          status: initial,
          deleted: false,
        });
      attempted.push(url.pathname);
      return Response.json({ status: "fail" });
    });
    await expect(closeTask(client, 4873)).resolves.toEqual({
      status: "unknown",
    });
    expect(attempted).toEqual([`/api.php/v2/task/${route}`]);
  },
);
