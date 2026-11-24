import { readFileSync } from "node:fs";
import { afterEach, expect, it, vi } from "vitest";
import { z } from "zod";
import { createZentaoReadClient } from "../../src/api/client.ts";
import { writeStory } from "../../src/api/story-write.ts";
import { assertNoSensitiveData } from "../helpers/assert-no-sensitive-data.ts";

afterEach(() => vi.unstubAllGlobals());

it.each([
  ["story.create", "story-create.4850", 4850],
  ["story.create.design", "story-create-design.4851", 4851],
  ["story.create.feedbackBy", "story-create-feedbackBy.4852", 4852],
  ["story.assign", "story-assign.4850", 4850],
  ["story.activate", "story-activate.4850", 4850],
  ["story.edit", "story-edit.4850", 4850],
  ["story.close", "story-close.4850", 4850],
  ["story.comment", "story-comment.4850", 115916],
])("%s 按已验证回执投影", async (action, fixture, responseId) => {
  const { endpoint, status, body } = z
    .object({
      endpoint: z.string(),
      status: z.int(),
      body: z.object({
        request: z.record(z.string(), z.json()),
        response: z.record(z.string(), z.json()),
      }),
    })
    .parse(
      JSON.parse(
        readFileSync(
          new URL(
            `../fixtures/zentao-22.6/writes/${fixture}.json`,
            import.meta.url,
          ),
          "utf8",
        ),
      ),
    );
  const writes: string[] = [];
  const secret = "raw-response-password";
  vi.stubGlobal(
    "fetch",
    vi.fn<typeof fetch>(async (request, init) => {
      const url = new URL(String(request));
      expect(url.origin).toBe("https://write.fixture.test");
      if (url.pathname.endsWith("/tokens"))
        return Response.json({ token: "fixture-session" }, { status: 201 });
      writes.push(`${init?.method} ${url.pathname}${url.search}`);
      expect(JSON.parse(String(init?.body))).toEqual(body.request);
      return Response.json({ ...body.response, password: secret }, { status });
    }),
  );
  const client = createZentaoReadClient({
    baseUrl: "https://write.fixture.test",
    account: "alice",
    password: "offline-password",
    clock: () => 0,
    logSink: () => undefined,
  });
  const result = await writeStory(
    client,
    action,
    29,
    action.startsWith("story.create") ? undefined : 4850,
    body.request,
  );
  expect(writes).toEqual([endpoint]);
  expect(result).toEqual({ status: "accepted", data: { id: responseId } });
  assertNoSensitiveData(result, [secret]);
});

it("创建回执没有 ID 且只有提示时标记结果不明", async () => {
  vi.stubGlobal(
    "fetch",
    vi.fn<typeof fetch>(async (request) => {
      const url = new URL(String(request));
      expect(url.origin).toBe("https://write.fixture.test");
      if (url.pathname.endsWith("/tokens"))
        return Response.json({ token: "fixture-session" }, { status: 201 });
      return Response.json({ message: "保存成功" });
    }),
  );
  const client = createZentaoReadClient({
    baseUrl: "https://write.fixture.test",
    account: "alice",
    password: "offline-password",
    clock: () => 0,
    logSink: () => undefined,
  });
  await expect(
    writeStory(client, "story.create", 29, undefined, {
      product: 29,
      module: 1,
      modules: [1],
      title: "需求",
      category: "feature",
      spec: "说明",
      verify: "验收",
      assignedTo: "alice",
      reviewer: [],
      status: "draft",
    }),
  ).resolves.toMatchObject({ status: "unknown" });
});
