import { z } from "zod";
import { assertCapabilityExecutable } from "../api/capabilities.ts";
import type { ZentaoReadClient } from "../api/client.ts";
import {
  getStoryDetail,
  getStoryDetailV2,
  listProductStories,
} from "../api/story.ts";
import { listExecutionsIncludingClosed } from "../api/execution.ts";
import { getTaskDetail, listExecutionTasks } from "../api/task.ts";
import {
  closeTask,
  createTask,
  getTaskProjectProducts,
  linkStoryToExecution,
} from "../api/task-write.ts";
import { htmlFragments } from "../domain/html-fragments.ts";
import { writeStory } from "../api/story-write.ts";
import type { OperationStep } from "../contracts/operation.ts";
import type { StoryDetail } from "../core/dto/story.ts";
import type { TaskDetail } from "../core/dto/task.ts";
import { BztError } from "../core/errors.ts";
import { resolveStoryRoles } from "../domain/roles.ts";
import { parseStoryRoleTag } from "../domain/story-html-spec.ts";
import type { OperationGateway, OperationTargetSnapshot } from "./operation.ts";

interface GatewayOptions {
  client: ZentaoReadClient;
  account: string;
  instanceVersion: string | undefined;
  readStepId?: (opId: string, seq: number) => number | null | undefined;
  storyRoles: {
    get: (id: number) => {
      maintainer?: string | null;
      receiver?: string | null;
    };
  };
}

const commentSkewMs = 60_000;
const positiveId = z.int().positive();

function requireId(value: unknown) {
  const parsed = positiveId.safeParse(value);
  if (!parsed.success)
    throw new BztError("INVALID_INPUT", "操作缺少有效的对象编号。");
  return parsed.data;
}

function visibleStage(desc: string | null | undefined) {
  const text = desc ?? "";
  let stage: string | undefined;
  for (const match of text.matchAll(htmlFragments)) {
    const fragment =
      match.groups?.footer ??
      (match.index + match[0].length === text.length ? match[0].trim() : "");
    if (/^\[bzt:stage=[a-z]+\]$/u.test(fragment)) stage = fragment;
  }
  return stage;
}

function taskSnapshot(
  task: TaskDetail,
  product: number,
): OperationTargetSnapshot {
  return {
    id: task.id,
    type: "task",
    product,
    status: task.status,
    assignedTo: task.assignedTo,
    executions: [task.execution],
    lastEditedDate: task.lastEditedDate,
    spec: task.desc,
  };
}

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

  async function readTask(id: number, product: number) {
    const task = await getTaskDetail(client, id);
    if (
      task.id === id &&
      !task.deleted &&
      (!task.product || task.product === product)
    ) {
      if (task.story) {
        await readStory(task.story, product);
        return task;
      }
      const project =
        task.project ??
        (await listExecutionsIncludingClosed(client)).items.find(
          (execution) => execution.id === task.execution,
        )?.project;
      if (
        project &&
        (
          await getTaskProjectProducts(client, project, { includeClosed: true })
        ).includes(product)
      )
        return task;
    }
    throw new BztError("NOT_FOUND", "未确认目标任务属于该产品。");
  }

  function linkTarget(opId: string, step: OperationStep) {
    const { fields } = step;
    if (fields.stories !== undefined) {
      const [target] = z.tuple([positiveId]).parse(fields.stories.value);
      return target;
    }
    return requireId(
      fields.pairFromStep === undefined
        ? fields.derivesFrom?.value
        : options.readStepId?.(opId, requireId(fields.pairFromStep.value)),
    );
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
      if (type === "task")
        return taskSnapshot(await readTask(id, product), product);
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
      const writeOptions = { opId, instanceVersion };
      if (step.type === "task") {
        let receipt;
        if (step.action === "task.create" && id === undefined) {
          const story = await readStory(requireId(fields.story), step.product);
          const execution = requireId(fields.execution);
          if (!story.executions.some(({ id }) => id === execution))
            throw new BztError(
              "RULE_VIOLATION",
              "需求尚未关联到任务所属执行。",
            );
          // title 供执行器反查，禅道任务配方只接收 name。
          delete fields.title;
          receipt = await createTask(client, execution, fields, writeOptions);
        } else if (step.action === "task.close") {
          const task = await readTask(requireId(id), step.product);
          receipt = await closeTask(client, task.id, writeOptions);
        } else {
          throw new BztError("INVALID_INPUT", "任务类型与操作不匹配。");
        }
        return receipt.status === "accepted" ? { id: receipt.data.id } : {};
      }

      if (fields.category === "design")
        assertCapabilityExecutable("story.create.design", capability);
      if (fields.feedbackBy !== undefined)
        assertCapabilityExecutable("story.create.feedbackBy", capability);
      if (step.type !== "story")
        throw new BztError("INVALID_INPUT", "此操作只支持研发需求。");
      if (step.action === "story.linkExecution") {
        const receipt = await linkStoryToExecution(
          client,
          requireId(fields.execution),
          step.product,
          requireId(id),
          writeOptions,
        );
        return receipt.status === "accepted" ? { id: receipt.data.id } : {};
      }
      if (step.action === "story.linkStory") {
        const target = linkTarget(opId, step);
        const linked = await getStoryDetail(client, target);
        if (linked.id !== target || linked.deleted)
          throw new BztError("NOT_FOUND", "未找到待关联的需求。");
        delete fields.derivesFrom;
        delete fields.pairFromStep;
        fields.stories = [target];
      }
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
            "已验证的编辑配方只允许修改关键词或计划。",
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
    async readback({ opId, step, zentaoId, actionId, attemptedAt }) {
      if (zentaoId === undefined) return { verified: false };
      if (step.type === "task") {
        const task = await readTask(zentaoId, step.product);
        const { fields } = step;
        const stage =
          typeof fields.desc?.value === "string"
            ? visibleStage(fields.desc.value)
            : undefined;
        const verified =
          step.action === "task.close"
            ? task.status === "closed"
            : step.action === "task.create" &&
              task.name === fields.name?.value &&
              task.execution === fields.execution?.value &&
              task.story === fields.story?.value &&
              task.assignedTo === fields.assignedTo?.value &&
              task.deadline === fields.deadline?.value &&
              stage !== undefined &&
              visibleStage(task.desc) === stage;
        return verified
          ? { verified, snapshot: taskSnapshot(task, step.product) }
          : { verified };
      }
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
            (step.fields.keywords === undefined ||
              (story.keywords ?? "") === step.fields.keywords.value) &&
            (step.fields.plan === undefined ||
              story.plan?.includes(requireId(step.fields.plan.value)) === true);
          break;
        case "story.close":
          verified =
            story.status === "closed" &&
            story.closedReason === step.fields.closedReason?.value;
          break;
        case "story.linkExecution":
          verified = story.executions.some(
            ({ id }) => id === step.fields.execution?.value,
          );
          break;
        case "story.linkStory": {
          const target = linkTarget(opId, step);
          const [from, to] = await Promise.all([
            getStoryDetailV2(client, zentaoId),
            getStoryDetailV2(client, target),
          ]);
          verified =
            from.story.id === zentaoId &&
            from.story.product === step.product &&
            to.story.id === target &&
            !to.story.deleted &&
            from.relations.some(
              ({ id, type }) => id === target && type === "story",
            ) &&
            to.relations.some(
              ({ id, type }) => id === zentaoId && type === "story",
            );
          break;
        }
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
    async reverseLookup({
      type,
      product,
      title,
      createdBy,
      since,
      until,
      execution,
    }) {
      if (type === "task" && execution !== undefined) {
        const { items, truncated } = await listExecutionTasks(
          client,
          execution,
        );
        const matches = [];
        for (const task of items) {
          const createdAt = task.openedDate;
          if (
            task.deleted ||
            task.execution !== execution ||
            (task.product != null && task.product !== product) ||
            task.name !== title ||
            task.openedBy !== createdBy ||
            createdAt == null ||
            createdAt < since ||
            createdAt > until
          )
            continue;
          // Multiple candidates must stay unknown even if only one matches readback.
          matches.push({ id: task.id, product, title, createdBy, createdAt });
        }
        return { complete: !truncated, matches };
      }
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
