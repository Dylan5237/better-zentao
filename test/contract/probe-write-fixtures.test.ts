import { readdirSync, readFileSync } from "node:fs";
import { expect, it } from "vitest";
import { z } from "zod";
import { assertSanitizedJson } from "../../src/api/internal/fixture-sensitivity.ts";
import { assertNoSensitiveData } from "../helpers/assert-no-sensitive-data.ts";

const directory = new URL("../fixtures/zentao-22.6/writes/", import.meta.url);
const files = readdirSync(directory).filter((name) => name.endsWith(".json"));
const fixtureSchema = z.strictObject({
  endpoint: z.string(),
  status: z.int().min(200).max(299),
  body: z.strictObject({ request: z.json(), response: z.json() }),
});

it.each(files)("WP-05 实测写入夹具 %s 保留配方且通过 S01 复扫", (file) => {
  const fixture = fixtureSchema.parse(
    JSON.parse(readFileSync(new URL(file, directory), "utf8")),
  );
  assertSanitizedJson(fixture);
  assertNoSensitiveData(fixture);
  expect(fixture.endpoint).toMatch(/^(?:POST|PUT) \/api\.php\/v[12]\//u);
  if (fixture.endpoint === "POST /api.php/v2/stories?productID=29") {
    expect(fixture.body.request).toMatchObject({
      product: 29,
      status: "draft",
      reviewer: [],
    });
    const storyId = Number(/\.(\d+)\.json$/u.exec(file)?.[1]);
    expect(fixture.body.response).toMatchObject({
      id: storyId,
      status: expect.any(String),
    });
  }
  const closeId = /^POST \/api\.php\/v1\/stories\/(\d+)\/close$/u.exec(
    fixture.endpoint,
  )?.[1];
  if (closeId) {
    expect(fixture.body.response).toMatchObject({
      id: Number(closeId),
      product: 29,
      status: "closed",
    });
  }
});

function readFixture(file: string) {
  return fixtureSchema.parse(
    JSON.parse(readFileSync(new URL(file, directory), "utf8")),
  );
}

it("WP-30 #29 写入夹具锁定 22.6 实测契约", () => {
  expect(files).toEqual(
    expect.arrayContaining([
      "story-edit.4873.json",
      "story-linkStory.4880.json",
      "story-linkExecution.4884.json",
      "task-create.4873.json",
      "task-cancel.4873.json",
      "task-close.4873.json",
    ]),
  );

  const storyEdit = readFixture("story-edit.4873.json");
  expect(storyEdit).toMatchObject({
    endpoint: "PUT /api.php/v1/stories/4873",
    status: 200,
    body: {
      request: { plan: 771 },
      response: {
        id: 4873,
        product: 29,
        plan: "771",
        stage: "planned",
        spec: expect.stringContaining("[bzt:v1 "),
      },
    },
  });

  const linkStory = readFixture("story-linkStory.4880.json");
  expect(linkStory).toMatchObject({
    endpoint: "POST /api.php/v2/story/linkStory?storyID=4879",
    status: 200,
    body: {
      request: { stories: [4880] },
    },
  });

  const linkExecution = readFixture("story-linkExecution.4884.json");
  expect(linkExecution).toMatchObject({
    endpoint: "POST /api.php/v2/execution/linkStory?objectID=315",
    status: 200,
    body: {
      request: { stories: [4884] },
    },
  });

  const taskCreate = readFixture("task-create.4873.json");
  expect(taskCreate).toMatchObject({
    endpoint: "POST /api.php/v1/executions/315/tasks",
    status: 201,
    body: {
      request: {
        execution: 315,
        story: 4884,
        module: 564,
        type: "devel",
      },
      response: {
        id: 4873,
        project: 314,
        execution: 315,
        story: 4884,
        status: "wait",
      },
    },
  });

  const taskCancel = readFixture("task-cancel.4873.json");
  expect(taskCancel).toMatchObject({
    endpoint: "POST /api.php/v2/task/cancel?taskID=4873",
    status: 200,
  });

  const taskClose = readFixture("task-close.4873.json");
  expect(taskClose).toMatchObject({
    endpoint: "POST /api.php/v2/task/close?taskID=4873",
    status: 200,
  });
});
