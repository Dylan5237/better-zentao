import { expect, it } from "vitest";
import { z } from "zod";
import { getRequiredFields } from "../../src/api/org.ts";
import { getStoryCreateMetadata } from "../../src/api/story.ts";
import { assertNoSensitiveData } from "../helpers/assert-no-sensitive-data.ts";
import { mockReadFixture } from "./read-fixture.ts";

it("Q8 实例的动作节点投影为动态必填字段列表", async () => {
  const { client } = mockReadFixture("required-fields", {
    path: "/api.php/v1/requiredFields",
  });
  const required = await getRequiredFields(client);
  expect(required).toMatchObject({
    story: {
      create: ["title", "module", "assignedTo", "verify", "spec"],
    },
    task: {
      create: [
        "execution",
        "name",
        "type",
        "module",
        "assignedTo",
        "estStarted",
        "deadline",
        "desc",
        "pri",
      ],
      finish: ["realStarted", "finishedDate", "currentConsumed"],
      batchcreate: ["name", "type"],
    },
    bug: {
      create: [
        "title",
        "openedBuild",
        "module",
        "assignedTo",
        "type",
        "severity",
        "steps",
        "pri",
      ],
    },
  });
  expect(required).not.toHaveProperty("user");
  expect(required.story).not.toHaveProperty("field_132");
  assertNoSensitiveData(required);
});

it("Q8 兼容数组和逗号串表示的必填规则", async () => {
  const { client } = mockReadFixture("required-fields", {
    transform: (body) => {
      const base = z.looseObject({ story: z.looseObject({}) }).parse(body);
      return {
        ...base,
        story: {
          ...base.story,
          create: ", title, module, ,spec, ",
          change: ["title", "verify"],
          edit: { method: "edit", fields: [""] },
        },
      };
    },
  });
  await expect(getRequiredFields(client)).resolves.toMatchObject({
    story: {
      create: ["title", "module", "spec"],
      change: ["title", "verify"],
      edit: [],
    },
  });
});

it("Q8 创建表单保留评审开关、必填规则和合法选项键", async () => {
  const { client } = mockReadFixture("story-create-metadata", {
    path: "/api.php/v2/story/create",
    query: { productID: "42" },
  });
  const result = await getStoryCreateMetadata(client, 42);
  expect(result).toMatchObject({
    forceReview: false,
    needReview: true,
    needNotReview: true,
    fields: {
      module: { required: true },
      title: { required: true },
      assignedTo: { required: true },
      reviewer: { required: false },
      mailto: { required: false },
      spec: { required: true },
      verify: { required: true },
      category: { required: false, options: ["feature", "design"] },
      source: {
        required: false,
        options: [
          "customer",
          "user",
          "po",
          "market",
          "service",
          "operation",
          "support",
          "competitor",
          "partner",
          "dev",
          "tester",
          "bug",
          "forum",
          "other",
        ],
      },
    },
  });
  for (const field of ["assignedTo", "reviewer", "mailto"]) {
    expect(result.fields).not.toHaveProperty([field, "options"]);
  }
  expect(JSON.stringify(result)).not.toContain("acct_");
  assertNoSensitiveData(result);
});
