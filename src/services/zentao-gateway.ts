import { assertCapabilityExecutable } from "../api/capabilities.ts";
import type { ZentaoReadClient } from "../api/client.ts";
import {
  getStoryDetail,
  getStoryDetailV2,
  listProductStories,
} from "../api/story.ts";
import { writeStory } from "../api/story-write.ts";
import type { OperationStep } from "../contracts/operation.ts";
import type { StoryDetail } from "../core/dto/story.ts";
import { BztError } from "../core/errors.ts";
import { resolveStoryRoles } from "../domain/roles.ts";
import { parseStoryRoleTag } from "../domain/story-html-spec.ts";
import type { OperationGateway, OperationTargetSnapshot } from "./operation.ts";

interface GatewayOptions {
  client: ZentaoReadClient;
  account: string;
  instanceVersion: string | undefined;
  storyRoles: {
    get: (id: number) => {
      maintainer?: string | null;
      receiver?: string | null;
    };
  };
}

const commentSkewMs = 60_000;

function snapshot(
  story: StoryDetail,
  type: OperationStep["type"],
  maintainer: string | null,
): OperationTargetSnapshot {
  return {
    id: story.id,
    product: story.product,
    type,
    status: story.status,
    maintainer,
    assignedTo: story.assignedTo,
    plan: story.plan,
    executions: story.executions.map(({ id }) => id),
    lastEditedDate: story.lastEditedDate,
    spec: story.spec,
  };
}

function createdStoryMatches(
  story: StoryDetail,
  { fields }: OperationStep,
): boolean {
  const expectedSpec = fields.spec?.value;
  const expectedTag =
    typeof expectedSpec === "string"
      ? parseStoryRoleTag(expectedSpec)
      : undefined;
  return (
    story.title === fields.title?.value &&
    story.module === fields.module?.value &&
    story.status === "draft" &&
    story.assignedTo === fields.assignedTo?.value &&
    story.category === fields.category?.value &&
    (fields.feedbackBy === undefined ||
      story.feedbackBy === fields.feedbackBy.value) &&
    !story.plan?.length &&
    (expectedTag === undefined ||
      JSON.stringify(parseStoryRoleTag(story.spec ?? "")) ===
        JSON.stringify(expectedTag))
  );
}

export function createZentaoGateway(options: GatewayOptions): OperationGateway {
  const { client, account, instanceVersion, storyRoles } = options;
  async function readStory(id: number, product: number) {
    const story = await getStoryDetail(client, id);
    if (story.deleted || story.id !== id || story.product !== product)
      throw new BztError("NOT_FOUND", "未找到目标产品内的需求。");
    return story;
  }

  function storySnapshot(story: StoryDetail, type: OperationStep["type"]) {
    let stored;
    try {
      stored = storyRoles.get(story.id);
    } catch (error) {
      if (!(error instanceof BztError) || error.code !== "NOT_FOUND")
        throw error;
    }
    return snapshot(
      story,
      type,
      resolveStoryRoles({ story, stored }).maintainer,
    );
  }

  return {
    async readTarget({ id, product, type }) {
      if (type !== "story")
        throw new BztError("INVALID_INPUT", "此操作只支持研发需求。");
      return storySnapshot(await readStory(id, product), type);
    },
    async write({ opId, step, id }) {
      const capability = {
        channel: "mcp",
        instanceVersion,
      } satisfies Parameters<typeof assertCapabilityExecutable>[1];
      assertCapabilityExecutable(step.action, capability);
      const fields = Object.fromEntries(
        Object.entries(step.fields).map(([key, field]) => [key, field.value]),
      );
      // 通知意图属于操作计划，禅道指派接口只接受账号与原因。
      delete fields.notify;
      if (fields.category === "design")
        assertCapabilityExecutable("story.create.design", capability);
      if (fields.feedbackBy !== undefined)
        assertCapabilityExecutable("story.create.feedbackBy", capability);
      if (step.type !== "story")
        throw new BztError("INVALID_INPUT", "此操作只支持研发需求。");
      if (id !== undefined) {
        const target = await readStory(id, step.product);
        if (
          step.action === "story.assign" &&
          target.assignedTo === fields.assignedTo &&
          !(typeof fields.comment === "string" && fields.comment.trim() !== "")
        )
          return { id };
        if (
          step.action === "story.edit" &&
          fields.title !== undefined &&
          fields.title !== target.title
        )
          throw new BztError(
            "CAPABILITY_UNVERIFIED",
            "已验证的编辑配方只允许修改关键词。",
          );
      }
      const receipt = await writeStory(
        client,
        step.action,
        step.product,
        id,
        fields,
        { opId, instanceVersion },
      );
      if (receipt.status === "unknown") return {};
      if (step.action === "story.comment") return { actionId: receipt.data.id };
      return { id: receipt.data.id };
    },
    async readback({ step, zentaoId, actionId, attemptedAt }) {
      if (zentaoId === undefined) return { verified: false };
      const story = await readStory(zentaoId, step.product);
      let verified: boolean;
      switch (step.action) {
        case "story.create":
        case "story.create.design":
        case "story.create.feedbackBy":
          verified = createdStoryMatches(story, step);
          break;
        case "story.assign":
          verified = story.assignedTo === step.fields.assignedTo?.value;
          break;
        case "story.activate":
          verified = story.status === "active";
          break;
        case "story.edit":
          verified =
            (story.keywords ?? "") === step.fields.keywords?.value &&
            (step.fields.title === undefined ||
              story.title === step.fields.title.value);
          break;
        case "story.close":
          verified =
            story.status === "closed" && story.closedReason === "cancel";
          break;
        case "story.comment": {
          const comment = step.fields.comment?.value;
          if (typeof comment !== "string") return { verified: false };
          let actions = story.actions;
          if (actions === undefined) {
            const detail = await getStoryDetailV2(client, zentaoId);
            if (
              detail.story.id !== zentaoId ||
              detail.story.product !== step.product
            )
              return { verified: false };
            actions = detail.actions;
          }
          const commentSince =
            attemptedAt === undefined
              ? undefined
              : Math.floor(attemptedAt / 1000) * 1000 - commentSkewMs;
          verified =
            actions.filter(
              (action) =>
                action.actor === account &&
                (actionId === undefined
                  ? action.date !== null &&
                    commentSince !== undefined &&
                    action.date >= commentSince
                  : action.id === actionId) &&
                (action.comment?.trim() === comment.trim() ||
                  action.comment?.trim() === `<p>${comment.trim()}</p>`),
            ).length === 1;
          break;
        }
        default:
          return { verified: false };
      }
      return verified
        ? { verified, snapshot: storySnapshot(story, step.type) }
        : { verified };
    },
    async reverseLookup({ type, product, title, createdBy, since, until }) {
      if (type !== "story") return { complete: false, matches: [] };
      const { items, truncated } = await listProductStories(
        client,
        product,
        "all",
      );
      const matches = items.flatMap((story) => {
        const createdAt = story.openedDate;
        if (
          story.deleted ||
          story.product !== product ||
          story.title !== title ||
          story.openedBy !== createdBy ||
          createdAt == null ||
          createdAt < since ||
          createdAt > until
        )
          return [];
        return [{ id: story.id, product, title, createdBy, createdAt }];
      });
      return { complete: !truncated, matches };
    },
  };
}
