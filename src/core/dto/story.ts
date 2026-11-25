import { z } from "zod";
import { actionDtoFor } from "./action.ts";
import {
  brandDto,
  dateTimeSchema,
  parsePlanIds,
  zAccount,
  zBool,
  zCollection,
  zHours,
  zId,
  zNullableId,
} from "./common.ts";

const storySummaryBrand: unique symbol = Symbol("StorySummary");
const storyBrand: unique symbol = Symbol("Story");
const storyDetailBrand: unique symbol = Symbol("StoryDetail");
const storyDetailV2Brand: unique symbol = Symbol("StoryDetailV2");
const requirementDetailBrand: unique symbol = Symbol("RequirementDetail");
const storySubjectBrand: unique symbol = Symbol("StoryDetailSubject");
const storyExecutionBrand: unique symbol = Symbol("StoryExecutionRef");
const storyTaskBrand: unique symbol = Symbol("StoryTaskRef");
const storyBugBrand: unique symbol = Symbol("StoryBugRef");
const storyReferenceBrand: unique symbol = Symbol("StoryRef");

const storyType = z.enum(["story", "requirement", "epic"]);
const nullableText = z
  .string()
  .nullable()
  .transform((value) => (value === "" ? null : value));
const idList = z
  .union([z.string(), z.number(), z.null()])
  .transform((value, context) => {
    try {
      return parsePlanIds(value);
    } catch {
      context.addIssue({ code: "custom", message: "禅道编号列表不合法。" });
      return z.NEVER;
    }
  });

function storySummaryShape(timezone?: string) {
  const dateTime = dateTimeSchema(timezone).optional();
  return z.object({
    id: zId,
    type: storyType,
    product: zId,
    title: z.string(),
    status: z.string(),
    module: zNullableId.optional(),
    parent: z
      .union([
        zNullableId,
        z.literal(-1),
        z.literal("-1"),
        z.tuple([]),
        z.tuple([zId]).transform(([parent]) => parent),
      ])
      .transform((parent) =>
        typeof parent === "number" && parent > 0 ? parent : null,
      )
      .optional(),
    isParent: zBool.optional(),
    moduleTitle: nullableText.optional(),
    plan: idList.optional(),
    category: nullableText.optional(),
    source: nullableText.optional(),
    feedbackBy: nullableText.optional(),
    pri: zNullableId.optional(),
    stage: nullableText.optional(),
    assignedTo: zAccount.optional(),
    openedBy: zAccount.optional(),
    createdBy: zAccount.optional(),
    closedBy: zAccount.optional(),
    lastEditedBy: zAccount.optional(),
    reviewedBy: zAccount.optional(),
    changedBy: zAccount.optional(),
    PO: zAccount.optional(),
    openedDate: dateTime,
    assignedDate: dateTime,
    closedDate: dateTime,
    lastEditedDate: dateTime,
    reviewedDate: dateTime,
    closedReason: nullableText.optional(),
    keywords: nullableText.optional(),
    deleted: zBool.optional(),
    fromStory: zNullableId.optional(),
    linkStories: idList.optional(),
    linkRequirements: idList.optional(),
  });
}

export function storySummaryDtoFor(timezone: string) {
  return storySummaryShape(timezone).transform((story) =>
    brandDto(story, storySummaryBrand),
  );
}

function storyShape(timezone?: string) {
  return storySummaryShape(timezone).extend({ estimate: zHours.optional() });
}

export function storyDtoFor(timezone: string) {
  return storyShape(timezone).transform((story) => brandDto(story, storyBrand));
}

const storyExecutionDto = z
  .object({
    id: zId,
    name: z.string(),
    project: zNullableId.optional(),
    status: z.string().optional(),
    type: z.string().optional(),
  })
  .transform((execution) => brandDto(execution, storyExecutionBrand));

// docs/06 Q4：需求详情中的任务只作索引。完整截止日期和工时取自执行任务。
const storyTaskDto = z
  .object({
    id: zId,
    name: z.string(),
    type: z.string(),
    status: z.string(),
    assignedTo: zAccount,
  })
  .transform((task) => brandDto(task, storyTaskBrand));

const storyBugDto = z
  .object({
    id: zId,
    title: z.string().optional(),
    status: z.string().optional(),
    severity: zId.optional(),
  })
  .transform((bug) => brandDto(bug, storyBugBrand));

const storyReferenceDto = z
  .object({
    id: zId,
    title: z.string().optional(),
    type: storyType.optional(),
    status: z.string().optional(),
  })
  .transform((ref) => brandDto(ref, storyReferenceBrand));
const emptyStoryReference = z.strictObject({}).transform(() => null);
const storyRequirements = zCollection(
  z.union([storyReferenceDto, emptyStoryReference]),
  true,
).transform((items) =>
  items.filter(
    (item): item is z.output<typeof storyReferenceDto> => item !== null,
  ),
);
const relationGroup = zCollection(storyReferenceDto, true).optional();
const groupedRelations = z
  .object({
    story: relationGroup,
    requirement: relationGroup,
    epic: relationGroup,
  })
  .transform((groups) =>
    (["story", "requirement", "epic"] as const).flatMap((groupType) =>
      (groups[groupType] ?? []).map((item) =>
        item.type !== undefined
          ? item
          : brandDto({ ...item, type: groupType }, storyReferenceBrand),
      ),
    ),
  );
const storyRelations = z
  .union([zCollection(storyReferenceDto, true), groupedRelations])
  .default([]);

function storyDetailShape(timezone?: string) {
  return storyShape(timezone).extend({
    spec: nullableText.optional(),
    verify: nullableText.optional(),
    executions: zCollection(storyExecutionDto, true).default([]),
    children: zCollection(storyReferenceDto, true).optional(),
  });
}

function storyDetailV1Shape(timezone?: string) {
  return storyDetailShape(timezone).extend({
    type: z.literal("story"),
    tasks: zCollection(storyTaskDto, true).optional(),
    bugs: zCollection(storyBugDto, true).optional(),
    actions: zCollection(actionDtoFor(timezone), true).optional(),
    requirements: storyRequirements.optional(),
  });
}

export const storyDetailFields = Object.freeze(
  Object.keys(storyDetailV1Shape().shape),
);

export function storyDetailDtoFor(timezone?: string) {
  return storyDetailV1Shape(timezone).transform((detail) =>
    brandDto(detail, storyDetailBrand),
  );
}

const groupedTasks = zCollection(z.array(storyTaskDto), true).transform(
  (groups) => groups.flat(),
);
const reviewerAccounts = z
  .union([zCollection(zAccount), z.literal([null, ""]).transform(() => [])])
  .transform((accounts) => accounts.filter((account) => account !== null));

function storyDetailV2Shape<T extends "story" | "requirement">(
  timezone: string,
  type: T,
) {
  return z
    .object({
      story: storyDetailShape(timezone).extend({
        type: z.literal(type),
        tasks: z.union([groupedTasks, z.array(storyTaskDto)]).default([]),
        reviewer: reviewerAccounts.default([]),
      }),
      actions: zCollection(actionDtoFor(timezone), true).default([]),
      bugs: zCollection(storyBugDto, true).default([]),
      relations: storyRelations,
    })
    .transform(({ story: { reviewer, ...story }, ...detail }) => ({
      ...detail,
      story: brandDto(story, storySubjectBrand),
      reviewers: reviewer,
    }));
}

export function storyDetailV2DtoFor(timezone: string) {
  return storyDetailV2Shape(timezone, "story").transform((detail) =>
    brandDto(detail, storyDetailV2Brand),
  );
}

export function requirementDetailDtoFor(timezone: string) {
  return storyDetailV2Shape(timezone, "requirement").transform((detail) =>
    brandDto(detail, requirementDetailBrand),
  );
}

export const storyDetailDto = storyDetailDtoFor();

export type StorySummary = z.output<ReturnType<typeof storySummaryDtoFor>>;
export type Story = z.output<ReturnType<typeof storyDtoFor>>;
type StoryDetailProjection = z.output<typeof storyDetailDto>;
export type StoryDetail = {
  [Field in keyof StoryDetailProjection]: StoryDetailProjection[Field];
};
export type StoryDetailV2 = z.output<ReturnType<typeof storyDetailV2DtoFor>>;
export type RequirementDetail = z.output<
  ReturnType<typeof requirementDetailDtoFor>
>;
