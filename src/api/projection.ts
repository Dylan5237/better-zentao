import { entityId, flag, idList, integer, number, row, rows, text, userRef } from "../core/normalizer.js";
import { projected, webUrl } from "./response.js";
import type { Story, StoryAction, StoryDetail, StoryType, Task, TaskMember } from "./types.js";

export function task(value: unknown, baseUrl: string): Task | undefined {
  const entry = row(value);
  const id = entityId(entry);
  if (!id) return;
  return {
    id, name: text(entry.name), type: text(entry.type), status: text(entry.status),
    assignedTo: userRef(entry.assignedTo), storyId: entityId(entry.storyID ?? entry.story),
    executionId: entityId(entry.execution), parentId: entityId(entry.parent),
    isParent: flag(entry.isParent), mode: text(entry.mode),
    deadline: Object.hasOwn(entry, "deadline") ? text(entry.deadline) : undefined,
    left: number(entry.left), consumed: number(entry.consumed), url: webUrl(baseUrl, "task", id),
  };
}

export function taskMember(value: unknown): TaskMember | undefined {
  const entry = row(value);
  const account = text(entry.account).trim();
  if (!account) return;
  return { account, status: text(entry.status), finishedDate: text(entry.finishedDate), left: number(entry.left) };
}

export function story(value: unknown, baseUrl: string, expected: StoryType = "story"): Story | undefined {
  const entry = row(value);
  const id = entityId(entry);
  if (!id) return;
  const kind = text(entry.type);
  const type = kind === "requirement" || kind === "story" || kind === "epic" ? kind : expected;
  return {
    id, title: text(entry.title), type, productId: entityId(entry.product ?? entry.productID),
    category: text(entry.category), status: text(entry.status), stage: text(entry.stage),
    pri: integer(entry.pri), planIds: idList(entry.plan ?? entry.plans), assignedTo: userRef(entry.assignedTo),
    openedBy: userRef(entry.openedBy), feedbackBy: text(entry.feedbackBy), keywords: text(entry.keywords),
    url: webUrl(baseUrl, type, id),
  };
}

function action(value: unknown): StoryAction | undefined {
  const entry = row(value);
  const id = entityId(entry);
  if (!id) return;
  return { id, action: text(entry.action), actor: userRef(entry.actor), date: text(entry.date) };
}

export function storyDetail(value: unknown, baseUrl: string, expected: StoryType, context?: unknown): StoryDetail | undefined {
  const entry = row(value);
  const outer = row(context);
  const basic = story(entry, baseUrl, expected);
  if (!basic) return;
  const relations = outer.relations ?? entry.relations;
  const relationIds = rows(relations).flatMap(item => {
    const relation = row(item);
    if (relation.BType === "story") return idList(relation.BID);
    return relation.type === "story" ? idList(relation.id) : [];
  });
  return {
    ...basic, moduleId: integer(row(entry.module).id ?? entry.module), source: text(entry.source),
    sourceNote: text(entry.sourceNote), spec: text(entry.spec), verify: text(entry.verify),
    deleted: flag(entry.deleted),
    tasks: projected(rows(entry.tasks ?? outer.tasks), item => task(item, baseUrl)),
    executionIds: idList(entry.executions ?? outer.executions),
    linkedStoryIds: [...new Set([
      ...idList(entry.linkStories ?? outer.linkedStories), ...idList(row(relations).story), ...relationIds,
    ])],
    actions: projected(rows(entry.actions ?? outer.actions), action),
  };
}
