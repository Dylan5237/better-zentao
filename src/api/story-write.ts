import { z } from "zod";
import {
  storyCommentReceiptDto,
  storyWriteReceiptDto,
} from "../core/dto/story-write.ts";
import { BztError } from "../core/errors.ts";
import { assertCapabilityExecutable } from "./capabilities.ts";
import type { ZentaoReadClient } from "./client.ts";
import { getReadClient } from "./internal/read-client.ts";
import { getStoryDetail } from "./story.ts";

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
const editBody = z
  .strictObject({
    title: text.optional(),
    keywords: z.string().optional(),
    plan: id.optional(),
  })
  .refine(({ keywords, plan }) => keywords !== undefined || plan !== undefined);
const closeBody = z.strictObject({
  closedReason: z.enum([
    "done",
    "cancel",
    "duplicate",
    "postponed",
    "willnotdo",
  ]),
  comment: z.string().optional(),
});
const linkBody = z.strictObject({ stories: z.tuple([id]) });
const commentBody = z.strictObject({ comment: text });
const discardedDeleteReceipt = z.unknown().transform(() => undefined);

function parse<T>(schema: z.ZodType<T>, input: unknown): T {
  const result = schema.safeParse(input);
  if (!result.success)
    throw new BztError("INVALID_INPUT", "需求写入字段不符合已验证配方。");
  return result.data;
}

// docs/06 §6.4: deletion never enters the MCP write dispatcher.
export async function deleteStory(
  client: ZentaoReadClient,
  storyId: number,
): Promise<"confirmed" | "unknown"> {
  assertCapabilityExecutable("story.delete", { channel: "cli" });
  const objectId = parse(id, storyId);
  const { http } = getReadClient(client, "write");
  try {
    await http.write(
      {
        method: "DELETE",
        pathTemplate: "/api.php/v1/stories/{id}",
        params: { id: objectId },
        objectId,
        allowReceiptMessage: true,
      },
      discardedDeleteReceipt,
    );
  } catch (error) {
    // The story may disappear between the preview and the delete request.
    if (!(error instanceof BztError && error.code === "NOT_FOUND")) throw error;
  }

  try {
    const current = await getStoryDetail(client, objectId);
    return current.id === objectId && current.deleted === true
      ? "confirmed"
      : "unknown";
  } catch (error) {
    return error instanceof BztError && error.code === "NOT_FOUND"
      ? "confirmed"
      : "unknown";
  }
}

export async function writeStory(
  client: ZentaoReadClient,
  action: string,
  product: number,
  storyId: number | undefined,
  fields: Readonly<Record<string, z.infer<z.ZodJSONSchema>>>,
  options?: Readonly<{ opId?: string; instanceVersion?: string }>,
): Promise<
  { status: "accepted"; data: { id: number } } | { status: "unknown" }
> {
  const capability = {
    channel: "mcp",
    instanceVersion: options?.instanceVersion,
  } satisfies Parameters<typeof assertCapabilityExecutable>[1];
  const opLog = options?.opId === undefined ? {} : { opId: options.opId };
  assertCapabilityExecutable(action, capability);
  const { http } = getReadClient(client, "write");
  if (
    action === "story.create" ||
    action === "story.create.design" ||
    action === "story.create.feedbackBy"
  ) {
    if (Object.hasOwn(fields, "plan"))
      assertCapabilityExecutable("story.create.plan", capability);
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
      assertCapabilityExecutable("story.create.design", capability);
    if (body.feedbackBy)
      assertCapabilityExecutable("story.create.feedbackBy", capability);
    return http.write(
      {
        ...opLog,
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
  const target = { params: { id: objectId }, objectId, ...opLog };
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
    case "story.linkStory":
      return http.write(
        {
          ...opLog,
          method: "POST",
          pathTemplate: "/api.php/v2/story/linkStory",
          objectId,
          query: { storyID: objectId },
          body: parse(
            linkBody.refine(({ stories }) => stories[0] !== objectId),
            fields,
          ),
          allowReceiptMessage: true,
        },
        // The relation endpoint acknowledges the request without returning an object ID.
        z
          .object({ status: z.literal("success") })
          .transform(() => ({ id: objectId })),
      );
    case "story.comment":
      return http.write(
        {
          ...opLog,
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
