import { z } from "zod";
import { brandDto, zBool } from "./common.ts";

const requiredFieldsBrand: unique symbol = Symbol("RequiredFieldsMap");
const storyCreateMetadataBrand: unique symbol = Symbol("StoryCreateMetadata");

const requiredFieldNames = z
  .union([z.array(z.string()), z.string().transform((list) => list.split(","))])
  .transform((names) => names.map((name) => name.trim()).filter(Boolean))
  .pipe(z.array(z.string().regex(/^[A-Za-z][A-Za-z0-9_]*$/u)));

const actionFields = z.union([
  requiredFieldNames,
  z
    .object({ method: z.string(), fields: requiredFieldNames })
    .transform(({ fields }) => fields),
]);

export const requiredFieldsDto = z
  .object({
    story: z.object({
      create: actionFields,
      edit: actionFields.optional(),
      change: actionFields.optional(),
      close: actionFields.optional(),
    }),
    task: z.object({
      create: actionFields,
      edit: actionFields.optional(),
      finish: actionFields,
      batchcreate: actionFields,
    }),
    bug: z.object({
      create: actionFields,
      edit: actionFields.optional(),
      batchcreate: actionFields.optional(),
    }),
  })
  .transform((fields) => brandDto(fields, requiredFieldsBrand));

const requiredSetting = z.object({ required: zBool });
const optionalSetting = requiredSetting.optional();

function optionSetting(keys: readonly string[]) {
  const allowedLabels = z.object(
    Object.fromEntries(keys.map((key) => [key, z.string().optional()])),
  );
  // 只保留合法的枚举键，显示标签和其他表单选项不用于预检。
  return requiredSetting.extend({
    options: allowedLabels.transform(Object.keys),
  });
}

export const storyCreateMetadataDto = z
  .object({
    forceReview: zBool,
    needReview: zBool,
    needNotReview: zBool,
    fields: z.object({
      product: optionalSetting,
      module: optionalSetting,
      plan: optionalSetting,
      assignedTo: optionalSetting,
      source: optionSetting([
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
        "ai",
      ]),
      sourceNote: optionalSetting,
      feedbackBy: optionalSetting,
      reviewer: optionalSetting,
      title: optionalSetting,
      category: optionSetting(["feature", "design"]),
      pri: optionalSetting,
      estimate: optionalSetting,
      spec: optionalSetting,
      verify: optionalSetting,
      keywords: optionalSetting,
      mailto: optionalSetting,
    }),
  })
  .transform((metadata) => brandDto(metadata, storyCreateMetadataBrand));

export type RequiredFieldsMap = z.output<typeof requiredFieldsDto>;
export type StoryCreateMetadata = z.output<typeof storyCreateMetadataDto>;
