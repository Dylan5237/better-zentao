import { z } from "zod";
import {
  storyCommentReceiptDto,
  storyWriteReceiptDto,
} from "../core/dto/story-write.ts";
import { BztError } from "../core/errors.ts";
import { assertCapabilityExecutable } from "./capabilities.ts";
import type { ZentaoReadClient } from "./client.ts";
import { getReadClient } from "./internal/read-client.ts";

const id = z.int().positive();
const text = z.string().refine((value) => value.trim() !== "");
const createBody = z.strictObject({
  product: id,
  type: z.literal("story").optional(),
  module: id,
  modules: z.tuple([id]),
  title: text,
  category: z.enum(["feature", "design"]),
  source: text.optional(),
  sourceNote: z.string().optional(),
  feedbackBy: text.optional(),
  pri: z.int().min(1).max(4).optional(),
  estimate: z.literal(0).optional(),
  spec: text,
  verify: text,
  keywords: z.string().optional(),
  assignedTo: text,
  reviewer: z.tuple([]),
  status: z.literal("draft"),
});
const assignBody = z.strictObject({
  assignedTo: text,
  comment: z.string().optional(),
});
const activateBody = z.strictObject({ status: z.literal("active") });
const editBody = z.strictObject({
  title: text.optional(),
  keywords: z.string(),
});
const closeBody = z.strictObject({ closedReason: z.literal("cancel") });
const commentBody = z.strictObject({ comment: text });

function parse<T>(schema: z.ZodType<T>, input: unknown): T {
  const result = schema.safeParse(input);
  if (!result.success)
    throw new BztError("INVALID_INPUT", "需求写入字段不符合已验证配方。");
  return result.data;
}

export async function writeStory(
  client: ZentaoReadClient,
  action: string,
  product: number,
  storyId: number | undefined,
  fields: Readonly<Record<string, z.infer<z.ZodJSONSchema>>>,
): Promise<
  { status: "accepted"; data: { id: number } } | { status: "unknown" }
> {
  assertCapabilityExecutable(action, { channel: "mcp" });
  const { http } = getReadClient(client, "write");
  if (
    action === "story.create" ||
    action === "story.create.design" ||
    action === "story.create.feedbackBy"
  ) {
    if (Object.hasOwn(fields, "plan"))
      assertCapabilityExecutable("story.create.plan");
    const body = parse(createBody, fields);
    if (
      body.product !== product ||
      body.modules[0] !== body.module ||
      storyId !== undefined
    )
      throw new BztError(
        "INVALID_INPUT",
        "新需求的产品或模块与操作计划不一致。",
      );
    if (body.category === "design")
      assertCapabilityExecutable("story.create.design");
    if (body.feedbackBy) assertCapabilityExecutable("story.create.feedbackBy");
    return http.write(
      {
        method: "POST",
        pathTemplate: "/api.php/v2/stories",
        query: { productID: product },
        body,
        allowReceiptMessage: true,
      },
      storyWriteReceiptDto,
    );
  }

  const objectId = parse(id, storyId);
  const target = { params: { id: objectId }, objectId };
  switch (action) {
    case "story.assign":
      return http.write(
        {
          ...target,
          method: "POST",
          pathTemplate: "/api.php/v1/stories/{id}/assign",
          body: parse(assignBody, fields),
        },
        storyWriteReceiptDto,
      );
    case "story.activate":
      return http.write(
        {
          ...target,
          method: "PUT",
          pathTemplate: "/api.php/v1/stories/{id}",
          body: parse(activateBody, fields),
        },
        storyWriteReceiptDto,
      );
    case "story.edit":
      return http.write(
        {
          ...target,
          method: "PUT",
          pathTemplate: "/api.php/v1/stories/{id}",
          body: parse(editBody, fields),
        },
        storyWriteReceiptDto,
      );
    case "story.close":
      return http.write(
        {
          ...target,
          method: "POST",
          pathTemplate: "/api.php/v1/stories/{id}/close",
          body: parse(closeBody, fields),
        },
        storyWriteReceiptDto,
      );
    case "story.comment":
      return http.write(
        {
          method: "POST",
          pathTemplate: "/api.php/v2/action/comment",
          objectId,
          query: { objectType: "story", objectID: objectId },
          body: parse(commentBody, fields),
        },
        storyCommentReceiptDto,
      );
    default:
      throw new BztError(
        "CAPABILITY_UNVERIFIED",
        "该能力没有已验证的需求写入配方。",
      );
  }
}
