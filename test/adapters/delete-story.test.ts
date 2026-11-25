import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { runCli } from "../../src/adapters/cli/run-cli.ts";
import {
  deleteStoryEnv,
  deleteStorySecrets,
  fakeDeleteStory,
} from "../fake-zentao/delete-story.ts";
import { assertNoSensitiveData } from "../helpers/assert-no-sensitive-data.ts";

let homeDir: string;
beforeEach(async () => {
  homeDir = await mkdtemp(join(tmpdir(), "bzt-delete-cli-"));
});
afterEach(async () => {
  vi.unstubAllGlobals();
  await rm(homeDir, { recursive: true, force: true });
});

async function run(...args: string[]) {
  const stdout: string[] = [];
  const stderr: string[] = [];
  const status = await runCli(args, {
    stdout: (line) => stdout.push(line),
    stderr: (line) => stderr.push(line),
    clock: () => 0,
    nodeVersion: "24.11.0",
    homeDir,
    env: deleteStoryEnv,
  });
  assertNoSensitiveData([stdout, stderr], deleteStorySecrets);
  return { status, stdout: stdout.join(""), stderr: stderr.join("") };
}

it("AC-84 CLI 帮助说明确认步骤", async () => {
  const result = await run("delete", "--help");
  expect(result.status).toBe(0);
  expect(result.stdout).toContain("bzt delete --story ID [--confirm]");
});

it.each([
  [],
  ["--confirm"],
  ["--story"],
  ["--story", "0"],
  ["--story", "3e1"],
  ["--story", "9007199254740992"],
  ["--story", "31", "--story=31"],
  ["--story", "31", "--confirm", "--confirm"],
  ["--story", "31", "--confirm=false"],
  ["--story", "31", "--config", "a", "--config=b"],
  ["--story", "31", "--config", " "],
  ["--story", "31", "--product", "29"],
])("AC-84 CLI 拒绝非法或重复选项 %#", async (...args) => {
  const requests = fakeDeleteStory();
  expect((await run("delete", ...args)).status).toBe(2);
  expect(requests).toEqual([]);
});

it("AC-84 无确认时显示目标预览，只有登录与读取请求", async () => {
  const requests = fakeDeleteStory();
  const result = await run("delete", "--story", "31");
  expect(result.status).toBe(1);
  expect(JSON.parse(result.stdout)).toMatchObject({
    status: "not_executed",
    preview: { storyId: 31, productId: 29 },
    message: expect.stringContaining("--confirm"),
  });
  expect(requests).toEqual([
    "POST /api.php/v1/tokens",
    "GET /api.php/v1/stories/31",
  ]);
});

it("AC-84 确认时读取配置，删除并回读", async () => {
  const requests = fakeDeleteStory();
  const config = join(homeDir, "team.json");
  await writeFile(config, '{"version":1}');
  const result = await run(
    "delete",
    "--story=31",
    "--config",
    config,
    "--confirm",
  );
  expect(result.status).toBe(0);
  expect(JSON.parse(result.stdout)).toEqual({
    status: "confirmed",
    storyId: 31,
  });
  expect(requests).toEqual([
    "POST /api.php/v1/tokens",
    "GET /api.php/v1/stories/31",
    "DELETE /api.php/v1/stories/31",
    "GET /api.php/v1/stories/31",
  ]);
});
