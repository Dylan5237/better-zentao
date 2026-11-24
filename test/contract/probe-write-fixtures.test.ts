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
