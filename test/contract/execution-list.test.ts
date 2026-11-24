import { expect, it } from "vitest";
import {
  listExecutions,
  listExecutionsIncludingClosed,
  listProjects,
} from "../../src/api/execution.ts";
import { mockReadFixture } from "./read-fixture.ts";

it("项目列表投影项目与组织层级", async () => {
  const { client } = mockReadFixture("projects", {
    path: "/api.php/v1/projects",
    query: { limit: 100, page: 1 },
  });
  const result = await listProjects(client);
  expect(result.truncated).toBe(false);
  expect(result.items).toHaveLength(13);
  expect(result.items[0]).toMatchObject({
    id: 20,
    parent: 49,
    name: "示例文本",
    status: "doing",
  });
  expect(result.items.some(({ status }) => status === "closed")).toBe(true);
});

it("v2 执行列表保留项目名、工时、延迟和数值进度", async () => {
  const { client } = mockReadFixture("executions-v2", {
    path: "/api.php/v2/executions",
    query: { recPerPage: 200, pageID: 1 },
  });
  const result = await listExecutions(client);
  expect(result.truncated).toBe(true);
  expect(result.items[0]).toMatchObject({
    id: 116,
    project: 71,
    name: "示例文本",
    projectName: "示例文本",
    type: "sprint",
    status: "doing",
    begin: "2026-04-01",
    end: "2026-04-30",
    delay: 148,
    progress: 100,
    totalLeft: 0,
    totalConsumed: 1386.2,
    totalEstimate: 8,
  });
});

it("v1 执行列表保留已关闭执行和关联项目", async () => {
  const { client } = mockReadFixture("executions-v1", {
    path: "/api.php/v1/executions",
    query: { limit: 200, page: 1 },
  });
  const result = await listExecutionsIncludingClosed(client);
  expect(result.truncated).toBe(true);
  expect(result.items[0]).toMatchObject({
    id: 311,
    project: 180,
    begin: "2026-11-26",
    end: "2026-12-03",
    status: "wait",
    progress: 0,
  });
  expect(result.items.some(({ status }) => status === "closed")).toBe(true);
});

it.each([
  ["projects.empty", listProjects],
  ["executions-v2.empty", listExecutions],
  ["executions-v1.empty", listExecutionsIncludingClosed],
] as const)("%s 保留声明的未取完总数", async (fixture, list) => {
  const { client } = mockReadFixture(fixture);
  await expect(list(client)).resolves.toEqual({ items: [], truncated: true });
});
