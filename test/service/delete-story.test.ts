import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { assertCapabilityExecutable } from "../../src/api/capabilities.ts";
import { runDeleteStory } from "../../src/services/delete-story.ts";
import {
  deleteStoryEnv,
  deleteStorySecrets,
  fakeDeleteStory,
} from "../fake-zentao/delete-story.ts";
import { assertNoSensitiveData } from "../helpers/assert-no-sensitive-data.ts";

let homeDir: string;
beforeEach(async () => {
  homeDir = await mkdtemp(join(tmpdir(), "bzt-delete-service-"));
});
afterEach(async () => {
  vi.unstubAllGlobals();
  await rm(homeDir, { recursive: true, force: true });
});

it("AC-84 能力注册表拒绝 MCP 执行删除", () => {
  expect(() =>
    assertCapabilityExecutable("story.delete", { channel: "mcp" }),
  ).toThrow(expect.objectContaining({ code: "CAPABILITY_CLI_ONLY" }));
});

it.each([
  ["timeout", "confirmed", 1],
  ["disconnected", "unknown", 1],
  ["still-present", "unknown", 1],
  ["missing", "not_executed", 0],
  ["wrong-id", "not_executed", 0],
  ["denied", "failed", 1],
] as const)(
  "AC-84 删除服务处理 %s，至多发一次 DELETE",
  async (mode, status, writes) => {
    const requests = fakeDeleteStory(mode);
    const logSink = vi.fn();
    const result = await runDeleteStory({
      story: "31",
      confirm: true,
      env: deleteStoryEnv,
      homeDir,
      clock: () => 0,
      logSink,
    });
    expect(result.status).toBe(status);
    expect(
      requests.filter((request) => request.startsWith("DELETE")),
    ).toHaveLength(writes);
    assertNoSensitiveData([result, logSink.mock.calls], deleteStorySecrets);
  },
);

it("AC-84 团队配置禁用删除时，确认也不能发请求", async () => {
  const requests = fakeDeleteStory();
  const config = join(homeDir, "team.json");
  await writeFile(config, '{"write":{"disableCapabilities":["story.delete"]}}');
  const result = await runDeleteStory({
    story: "31",
    confirm: true,
    config,
    env: deleteStoryEnv,
    homeDir,
    clock: () => 0,
  });
  expect(result).toMatchObject({
    status: "not_executed",
    code: "CAPABILITY_DISABLED",
  });
  expect(requests).toEqual([]);
});
