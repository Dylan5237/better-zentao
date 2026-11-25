import { randomUUID } from "node:crypto";
import { mkdir, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { getCapability } from "../api/capabilities.ts";
import { createZentaoReadClient } from "../api/client.ts";
import type { ZentaoReadClient } from "../api/client.ts";
import { getCurrentUser, getInstanceConfig } from "../api/org.ts";
import { createProbeWriteSession } from "../api/probe-write.ts";
import type {
  ProbeDraft,
  ProbeRequest,
  ProbeWriteResponse,
  ProbeWriteScope,
} from "../api/probe-write.ts";
import { getStoryDetail, listProductStories } from "../api/story.ts";
import { listExecutionTasks } from "../api/task.ts";
import { formatLocalDate } from "../core/calendar.ts";
import type { Clock } from "../core/clock.ts";
import { loadConfig, PROBE_PRODUCT_ID } from "../core/config.ts";
import type { ConfigEnv } from "../core/config.ts";
import type { StoryDetail } from "../core/dto/story.ts";
import type { Task, TaskDetail } from "../core/dto/task.ts";
import { BztError } from "../core/errors.ts";
import {
  buildStoryHtmlSpec,
  parseStoryRoleTag,
} from "../domain/story-html-spec.ts";
import type { StoryRoleTagFormat } from "../domain/story-html-spec.ts";

const storyProbes = [
  "story.create",
  "story.assign",
  "story.comment",
  "story.edit",
  "story.activate",
  "story.close",
  "story.create.plan",
  "story.create.design",
  "story.create.feedbackBy",
] as const;
const executionProbes = [
  "story.linkExecution",
  "task.create",
  "task.close",
] as const;
const relationProbes = ["story.linkStory", "requirement.linkStory"] as const;
type StoryProbe = (typeof storyProbes)[number];
type ExecutionProbe = (typeof executionProbes)[number];
type Probe = StoryProbe | ExecutionProbe | (typeof relationProbes)[number];
type IdRequest = Extract<ProbeRequest, { action: StoryProbe; id: number }>;
type Session = Awaited<ReturnType<typeof createProbeWriteSession>>;

type WriteCli = {
  readonly action: "write";
  readonly product?: string;
  readonly config?: string;
  readonly capability?: string;
  readonly all?: boolean;
  readonly assignee?: string;
  readonly visibleTag?: boolean;
  readonly out?: string;
};
type CleanupCli = {
  readonly action: "cleanup";
  readonly product?: string;
  readonly config?: string;
  readonly story?: string;
};

interface ProbeOptions {
  readonly env: ConfigEnv;
  readonly homeDir?: string;
  readonly clock: Clock;
  readonly logSink: (line: string) => void;
  readonly cli: WriteCli | CleanupCli;
}

interface Attempt {
  readonly capability: Probe;
  readonly status: "confirmed" | "unknown" | "not_executed" | "failed";
  readonly route?: string;
  readonly httpStatus?: number;
  readonly storyId?: number;
  readonly taskId?: number;
  readonly skipped?: boolean;
  readonly fields?: readonly string[];
  readonly readback?: { htmlStructure: boolean; roleTag: boolean };
  readonly reason?: string;
}

interface ProbeReport {
  readonly ok: boolean;
  readonly productId: 29;
  readonly reference?: string;
  readonly scope?: ProbeWriteScope;
  readonly attempts: readonly Attempt[];
  readonly cleanup: readonly Attempt[];
  readonly fixtureCount?: number;
  readonly error?: string;
  readonly invalidArgs?: boolean;
}

function emptyReport(error: string, invalidArgs = false): ProbeReport {
  return {
    ok: false,
    productId: PROBE_PRODUCT_ID,
    attempts: [],
    cleanup: [],
    error,
    invalidArgs,
  };
}

function supportedProbe(value: string | undefined): Probe | undefined {
  return [...storyProbes, ...executionProbes, ...relationProbes].find(
    (probe) => probe === value,
  );
}

function validPath(input?: string): boolean {
  return input === undefined || (input.trim() !== "" && !input.includes("\0"));
}

function validId(input?: string): number | undefined {
  if (input !== undefined && /^[1-9]\d*$/u.test(input)) {
    const id = Number(input);
    if (Number.isSafeInteger(id)) return id;
  }
  return undefined;
}

function errorCode(error: unknown): string {
  return error instanceof BztError ? error.code : "ZENTAO_UNAVAILABLE";
}

function unwrapVisibleFooter(footer: string): string {
  const trimBreaks = (value: string) =>
    value
      .trim()
      .replace(/^(?:<br\s*\/?>\s*)+|(?:\s*<br\s*\/?>)+$/giu, "")
      .trim();
  const wrapper =
    /^<(p|div|span)(?=[\s>])(?:[^"'<>]|"[^"]*"|'[^']*')*>([\s\S]*?)<\/\1\s*>$/iu;
  const unwrap = (value: string) =>
    trimBreaks(wrapper.exec(value)?.[2] ?? value);
  return unwrap(unwrap(trimBreaks(footer)));
}

function storySpecReadback(
  actual: string | null | undefined,
  expected: string,
  format: StoryRoleTagFormat,
): NonNullable<Attempt["readback"]> {
  const normalize = (html: string) => html.replace(/\r\n?/gu, "\n").trim();
  // 构造器把角色标签单独写在正文末行。只容许该页脚的包装变化。
  const expectedBody = normalize(expected.slice(0, expected.lastIndexOf("\n")));
  const spec = normalize(actual ?? "");
  if (!spec.startsWith(expectedBody))
    return { htmlStructure: false, roleTag: false };
  const footer = spec.slice(expectedBody.length).trim();
  if (footer === "") return { htmlStructure: true, roleTag: false };

  const comment = /^<!--\s*bzt:v1\s+[^<>]+-->$/u.test(footer);
  const fragment = comment ? footer : unwrapVisibleFooter(footer);
  const returned =
    comment || /^\[bzt:v1\s+([^[\]\r\n<>]*)\]$/u.test(fragment)
      ? parseStoryRoleTag(fragment)
      : undefined;
  const requested = parseStoryRoleTag(expected);
  return {
    htmlStructure: returned !== undefined,
    roleTag:
      (comment ? "comment" : "visible") === format &&
      returned !== undefined &&
      returned.maintainer === requested?.maintainer &&
      returned.receiver === requested?.receiver &&
      returned.intake === requested?.intake,
  };
}

function draftMatches(
  story: StoryDetail,
  expected: ProbeDraft,
  format: StoryRoleTagFormat,
) {
  const readback = storySpecReadback(story.spec, expected.spec, format);
  const plan = story.plan ?? [];
  return {
    matches:
      story.title === expected.title &&
      story.module === expected.module &&
      story.status === "draft" &&
      story.assignedTo === expected.assignedTo &&
      (expected.plan === undefined
        ? plan.length === 0
        : plan.length === 1 && plan[0] === expected.plan) &&
      story.category === expected.category &&
      (expected.feedbackBy === undefined ||
        story.feedbackBy === expected.feedbackBy) &&
      readback.htmlStructure &&
      readback.roleTag,
    readback,
  };
}

async function ownedStory(
  client: ZentaoReadClient,
  id: number,
): Promise<StoryDetail> {
  const story = await getStoryDetail(client, id);
  if (
    story.id !== id ||
    story.product !== PROBE_PRODUCT_ID ||
    story.deleted === true
  ) {
    throw new BztError("PERMISSION_DENIED", "只允许探查 #29 的研发需求。");
  }
  return story;
}

async function findCreatedStory(
  client: ZentaoReadClient,
  body: ProbeDraft,
  startedAt: number,
): Promise<number | undefined> {
  const { items, truncated } = await listProductStories(
    client,
    PROBE_PRODUCT_ID,
  );
  if (truncated) return undefined;
  const matches = items.filter(
    (story) =>
      story.product === PROBE_PRODUCT_ID &&
      story.deleted !== true &&
      story.title === body.title &&
      story.openedBy === body.assignedTo &&
      typeof story.openedDate === "number" &&
      story.openedDate >= startedAt - 600_000 &&
      story.openedDate <= startedAt + 600_000,
  );
  return matches.length === 1 ? matches[0]?.id : undefined;
}

function isRunDraft(story: StoryDetail, draft: ProbeDraft): boolean {
  return story.title === draft.title && story.openedBy === draft.assignedTo;
}

async function createDraft(
  state: ProbeRun,
  capability: StoryProbe,
  body: ProbeDraft,
): Promise<Attempt> {
  let response: ProbeWriteResponse;
  try {
    response = await state.session.send({
      action: "story.create",
      productId: PROBE_PRODUCT_ID,
      body,
    });
  } catch (error) {
    return { capability, status: "not_executed", reason: errorCode(error) };
  }
  if (response.missingFields)
    return {
      capability,
      status: "not_executed",
      fields: response.missingFields,
    };
  const { route, httpStatus } = response;
  const report = { capability, route, httpStatus };
  let id = response.storyId;
  try {
    id ??= await findCreatedStory(state.client, body, state.startedAt);
    if (id === undefined)
      return response.clearlyRejected
        ? { ...report, status: "failed" }
        : {
            ...report,
            status: "unknown",
            reason: "反查尚未找到唯一需求，请按探查编号核对。",
          };
    // 回执误指其他需求时，仍按探查标题反查真实的新对象。清理前复核身份。
    const story = await ownedStory(state.client, id);
    if (!isRunDraft(story, body)) {
      const found = await findCreatedStory(state.client, body, state.startedAt);
      if (found !== undefined) state.created.set(found, body);
      return {
        ...report,
        storyId: found ?? id,
        status: "unknown",
        reason: "创建回执与本次探查需求不匹配。",
      };
    }
    state.created.set(id, body);
    const { matches, readback } = draftMatches(story, body, state.tagFormat);
    const confirmed =
      response.accepted && response.storyId !== undefined && matches;
    if (confirmed) state.recordFixture(capability, id, response);
    return {
      ...report,
      storyId: id,
      readback,
      status: confirmed ? "confirmed" : "unknown",
    };
  } catch (error) {
    const found = await findCreatedStory(
      state.client,
      body,
      state.startedAt,
    ).catch(() => undefined);
    const target = found ?? id;
    if (target !== undefined && !state.created.has(target))
      state.created.set(target, body);
    return {
      ...report,
      storyId: target,
      status: "unknown",
      reason: errorCode(error),
    };
  }
}

interface ProbeRun {
  readonly client: ZentaoReadClient;
  readonly session: Session;
  readonly startedAt: number;
  readonly tagFormat: StoryRoleTagFormat;
  readonly created: Map<number, ProbeDraft | undefined>;
  readonly tasks: Map<number, TaskIdentity>;
  readonly timezone: string;
  readonly cleanup: Attempt[];
  readonly recordFixture: (
    capability: Probe,
    id: number,
    response: ProbeWriteResponse,
  ) => void;
}

async function probeExisting(
  state: ProbeRun,
  requests: readonly IdRequest[],
  matches: (story: StoryDetail) => boolean,
  unchanged: (story: StoryDetail) => boolean = (story) => !matches(story),
  expectedDraft?: ProbeDraft,
): Promise<Attempt[]> {
  const first = requests[0];
  if (!first) return [];
  const { id, action: capability } = first;
  const report = { capability, storyId: id };
  const attempts: Attempt[] = [];
  try {
    const initial = await ownedStory(state.client, id);
    if (expectedDraft && !isRunDraft(initial, expectedDraft)) {
      return [
        {
          ...report,
          status: "not_executed",
          reason: "无法确认这是本次探查创建的需求。",
        },
      ];
    }
    if (matches(initial)) {
      return [{ ...report, status: "confirmed", skipped: true }];
    }
    for (const request of requests) {
      const response = await state.session.send(request);
      if (response.missingFields)
        return [
          ...attempts,
          { ...report, status: "not_executed", fields: response.missingFields },
        ];
      const receipt = {
        ...report,
        route: response.route,
        httpStatus: response.httpStatus,
      };
      let story: StoryDetail;
      try {
        story = await ownedStory(state.client, id);
      } catch (error) {
        return [
          ...attempts,
          { ...receipt, status: "unknown", reason: errorCode(error) },
        ];
      }
      if (matches(story) && response.accepted) {
        state.recordFixture(capability, id, response);
        return [...attempts, { ...receipt, status: "confirmed" }];
      }
      if (response.clearlyRejected && unchanged(story)) {
        attempts.push({ ...receipt, status: "failed" });
        if (response.candidateUnavailable) continue;
        return attempts;
      }
      return [...attempts, { ...receipt, status: "unknown" }];
    }
    return attempts;
  } catch (error) {
    return [
      ...attempts,
      { ...report, status: "not_executed", reason: errorCode(error) },
    ];
  }
}

async function closeStory(
  state: ProbeRun,
  id: number,
  expectedDraft?: ProbeDraft,
): Promise<Attempt[]> {
  return probeExisting(
    state,
    [
      {
        action: "story.close",
        productId: PROBE_PRODUCT_ID,
        id,
        body: { closedReason: "cancel" },
      },
    ],
    (story) => story.status === "closed",
    undefined,
    expectedDraft,
  );
}

async function cleanupDraft(state: ProbeRun, id: number): Promise<boolean> {
  const draft = state.created.get(id);
  state.created.delete(id);
  const receipts = await closeStory(state, id, draft);
  state.cleanup.push(...receipts);
  return receipts.every(({ status }) => status === "confirmed");
}

async function probeAction(
  state: ProbeRun,
  capability: StoryProbe,
  storyId: number,
  body: ProbeDraft,
  reference: string,
  alternate?: string,
): Promise<Attempt[]> {
  const target: Pick<IdRequest, "id" | "productId"> = {
    id: storyId,
    productId: PROBE_PRODUCT_ID,
  };
  switch (capability) {
    case "story.assign": {
      const self = await probeExisting(
        state,
        [
          {
            ...target,
            action: capability,
            body: { assignedTo: body.assignedTo },
          },
        ],
        (story) => story.assignedTo === body.assignedTo,
      );
      if (self.at(-1)?.status !== "confirmed") return self;
      if (!alternate || alternate === body.assignedTo) {
        return [
          ...self,
          {
            capability,
            status: "not_executed",
            storyId,
            fields: ["assignedTo"],
            reason: "实际改派需要指定另一个有效的测试账号。",
          },
        ];
      }
      return [
        ...self,
        ...(await probeExisting(
          state,
          [{ ...target, action: capability, body: { assignedTo: alternate } }],
          (story) => story.assignedTo === alternate,
        )),
      ];
    }
    case "story.comment": {
      const comment = "WP-05 探查备注 " + reference;
      const request = {
        ...target,
        action: capability,
        body: { comment },
      } as const;
      const containsComment = (story: StoryDetail) =>
        story.actions?.some(
          (action) =>
            action.comment?.trim() === comment ||
            action.comment?.trim() === `<p>${comment}</p>`,
        );
      return probeExisting(
        state,
        [request, { ...request, candidate: "v2" }],
        (story) => containsComment(story) === true,
        (story) =>
          story.actions !== undefined && containsComment(story) === false,
      );
    }
    case "story.edit": {
      const keywords = "WP-05-" + reference;
      const plan = state.session.scope?.openPlanIds[0];
      const results = await probeExisting(
        state,
        [
          {
            ...target,
            action: capability,
            body: {
              title: body.title,
              keywords,
              ...(plan !== undefined ? { plan } : {}),
            },
          },
        ],
        (story) => {
          const { htmlStructure, roleTag } = storySpecReadback(
            story.spec,
            body.spec,
            state.tagFormat,
          );
          return (
            story.keywords === keywords &&
            story.title === body.title &&
            (plan === undefined ||
              (story.plan?.length === 1 && story.plan[0] === plan)) &&
            htmlStructure &&
            roleTag
          );
        },
      );
      return plan === undefined
        ? results.map((attempt) =>
            attempt.status === "confirmed"
              ? {
                  ...attempt,
                  fields: ["plan"],
                  reason: "#29 无可用未关闭计划，已确认关键词且正文完整。",
                }
              : attempt,
          )
        : results;
    }
    case "story.activate":
      return probeExisting(
        state,
        [
          { ...target, action: capability, body: {} },
          {
            ...target,
            action: capability,
            candidate: "put",
            body: { status: "active" },
          },
        ],
        (story) => story.status === "active",
        (story) => story.status === "draft",
      );
    default:
      return [];
  }
}

function makeDraft(
  account: string,
  module: number,
  reference: string,
  capability: StoryProbe,
  format: StoryRoleTagFormat,
  plan?: number,
): ProbeDraft {
  return {
    product: PROBE_PRODUCT_ID,
    type: "story",
    module,
    modules: [module],
    plan: capability === "story.create.plan" ? plan : undefined,
    category: capability === "story.create.design" ? "design" : "feature",
    feedbackBy:
      capability === "story.create.feedbackBy" ? "WP-05 测试反馈" : undefined,
    source: "user",
    title: `【WP-05 探查】${capability} ${reference}`,
    pri: 3,
    assignedTo: account,
    reviewer: [],
    status: "draft",
    verify: "<p>回读字段、HTML 结构与标签并关闭需求。</p>",
    spec: buildStoryHtmlSpec(
      {
        background: ["WP-05 专用产品探查。\n验证正文段落换行。"],
        scope: ["验证结构列表。", "完成后关闭本测试需求。"],
      },
      { maintainer: account, receiver: account, intake: "probe-p0" },
      format,
    ),
  };
}

function notExecuted(capability: Probe, reason: string): Attempt {
  return { capability, status: "not_executed", reason };
}

async function probeRelation(
  state: ProbeRun,
  request: Extract<
    ProbeRequest,
    {
      action:
        "story.linkExecution" | "story.linkStory" | "requirement.linkStory";
    }
  >,
  readback: () => Promise<boolean | undefined>,
): Promise<Attempt> {
  const { action: capability } = request;
  const storyId = request.body.stories[0];
  let result: Attempt = { capability, storyId, status: "not_executed" };
  try {
    if ((await readback()) === true)
      return { ...result, status: "confirmed", skipped: true };
    const candidate =
      request.action === "story.linkExecution"
        ? { ...request, candidate: "v2" as const }
        : request;
    const response = await state.session.send(candidate);
    result = {
      capability,
      storyId,
      route: response.route,
      httpStatus: response.httpStatus,
      status: "unknown",
    };
    const linked = await readback();
    if (linked === true && response.accepted) {
      state.recordFixture(capability, storyId, response);
      return { ...result, status: "confirmed" };
    }
    if (response.clearlyRejected && linked === false)
      return { ...result, status: "failed" };
    return result;
  } catch (error) {
    return { ...result, reason: errorCode(error) };
  }
}

type TaskIdentity = Pick<Task, "name" | "openedBy" | "execution">;

function sameTask(
  task: TaskIdentity & Pick<Task, "deleted">,
  expected: TaskIdentity,
): boolean {
  return (
    !task.deleted &&
    task.name === expected.name &&
    task.openedBy === expected.openedBy &&
    task.execution === expected.execution
  );
}

async function probeTask(
  state: ProbeRun,
  execution: number,
  storyId: number,
  draft: ProbeDraft,
  parent?: number,
): Promise<Attempt> {
  const capability = "task.create";
  const { module, assignedTo } = draft;
  const date = formatLocalDate(state.startedAt, state.timezone);
  const fields = {
    name: `${draft.title} ${parent === undefined ? "父任务" : "子任务"}`,
    type: "devel" as const,
    story: storyId,
    module,
    assignedTo,
    pri: 3,
    estStarted: date,
    deadline: date,
    desc: "<!-- bzt:stage=dev -->\n<p>WP-30 #29 探查任务</p>",
  };
  const identity = { name: fields.name, openedBy: assignedTo, execution };
  let response: ProbeWriteResponse;
  try {
    const target = {
      action: capability,
      productId: PROBE_PRODUCT_ID,
      id: execution,
    } as const;
    response = await state.session.send(
      parent === undefined
        ? { ...target, body: { ...fields, execution } }
        : {
            ...target,
            candidate: "batch",
            parent,
            body: {
              name: [fields.name],
              type: [fields.type],
              story: [storyId],
              module: [module],
              assignedTo: [assignedTo],
              pri: [fields.pri],
              estStarted: [date],
              deadline: [date],
              desc: [fields.desc],
            },
          },
    );
  } catch (error) {
    return {
      capability,
      storyId,
      status: "not_executed",
      reason: errorCode(error),
    };
  }
  if (response.missingFields)
    return {
      capability,
      storyId,
      status: "not_executed",
      fields: response.missingFields,
    };
  const report = {
    capability,
    storyId,
    route: response.route,
    httpStatus: response.httpStatus,
  } as const;
  const ids = response.taskIds ?? [];
  const matched: TaskDetail[] = [];
  for (const id of ids) {
    // 回执若误指本次已登记的其他任务，保留原任务的清理凭据。
    if (state.tasks.has(id)) continue;
    // 先登记回执 ID，清理阶段独立重读并核对创建人和标题。
    state.tasks.set(id, identity);
    const task = await state.session.readTask(id).catch(() => undefined);
    if (task && sameTask(task, identity)) matched.push(task);
    else if (task) state.tasks.delete(id);
  }
  if (ids.length === 1 && matched.length === 1 && response.accepted) {
    const task = matched[0];
    if (
      task &&
      task.story === storyId &&
      task.module === module &&
      task.assignedTo === assignedTo &&
      task.estStarted === date &&
      task.deadline === date &&
      task.parent === (parent ?? null) &&
      task.desc?.includes("<!-- bzt:stage=dev -->")
    ) {
      state.recordFixture(capability, task.id, response);
      return { ...report, status: "confirmed", taskId: task.id };
    }
  }
  // 结果不明时只反查并收尾，禁止重发创建请求。
  const found = await listExecutionTasks(state.client, execution).catch(
    () => undefined,
  );
  const recovered =
    found?.items.filter((task) => sameTask(task, identity)) ?? [];
  for (const task of recovered) {
    if (!state.tasks.has(task.id)) state.tasks.set(task.id, identity);
  }
  const taskId = recovered[0]?.id ?? matched[0]?.id ?? ids[0];
  return {
    ...report,
    status:
      response.clearlyRejected &&
      recovered.length === 0 &&
      found?.truncated === false
        ? "failed"
        : "unknown",
    taskId,
    reason: "创建回读未确认，请按探查编号核对任务。",
  };
}

async function closeTask(
  state: ProbeRun,
  id: number,
  identity: TaskIdentity,
): Promise<Attempt> {
  let report: Attempt = {
    capability: "task.close",
    taskId: id,
    status: "not_executed",
  };
  try {
    const initial = await state.session.readTask(id);
    if (!sameTask(initial, identity))
      return { ...report, reason: "无法确认这是本次探查创建的任务。" };
    if (initial.status === "closed")
      return { ...report, status: "confirmed", skipped: true };
    const response = await state.session.send({
      action: "task.close",
      productId: PROBE_PRODUCT_ID,
      id,
      body: {},
    });
    report = {
      ...report,
      route: response.route,
      httpStatus: response.httpStatus,
      status: "unknown",
    };
    const task = await state.session.readTask(id);
    if (
      sameTask(task, identity) &&
      task.status === "closed" &&
      response.accepted
    ) {
      state.recordFixture("task.close", id, response);
      return { ...report, status: "confirmed" };
    }
    return report;
  } catch (error) {
    return { ...report, reason: errorCode(error) };
  }
}

async function probeExecution(
  state: ProbeRun,
  selected: ExecutionProbe | undefined,
  execution: number,
  storyId: number,
  draft: ProbeDraft,
  disabled: readonly string[],
  attempts: Attempt[],
): Promise<void> {
  if (disabled.includes("story.linkExecution")) {
    attempts.push(
      notExecuted(
        selected ?? "story.linkExecution",
        "前置执行关联能力已禁用。",
      ),
    );
    return;
  }
  if (disabled.includes("story.activate")) {
    attempts.push(
      notExecuted(selected ?? "story.linkExecution", "前置激活能力已禁用。"),
    );
    return;
  }
  // 禅道 22.6 仅允许已激活的研发需求关联执行，关联前先激活草稿需求。
  const activated = await probeExisting(
    state,
    [
      {
        id: storyId,
        productId: PROBE_PRODUCT_ID,
        action: "story.activate",
        candidate: "put",
        body: { status: "active" },
      },
    ],
    (story) => story.status === "active",
    (story) => story.status === "draft",
  );
  attempts.push(...activated);
  if (activated.at(-1)?.status !== "confirmed") return;
  const linked = await probeRelation(
    state,
    {
      action: "story.linkExecution",
      productId: PROBE_PRODUCT_ID,
      id: execution,
      body: { stories: [storyId] },
    },
    () => state.session.hasExecutionStory(execution, storyId),
  );
  attempts.push(linked);
  if (linked.status !== "confirmed" || selected === "story.linkExecution")
    return;
  if (disabled.includes("task.create") || disabled.includes("task.close")) {
    attempts.push(
      notExecuted(selected ?? "task.create", "任务创建或清理能力已禁用。"),
    );
    return;
  }
  const parent = await probeTask(state, execution, storyId, draft);
  attempts.push(parent);
  if (
    parent.status === "confirmed" &&
    parent.taskId !== undefined &&
    selected !== "task.close"
  )
    attempts.push(
      await probeTask(state, execution, storyId, draft, parent.taskId),
    );
}

async function probeStoryRelation(
  state: ProbeRun,
  action: (typeof relationProbes)[number],
  from: number,
  to: number,
): Promise<Attempt> {
  const type = action === "story.linkStory" ? "story" : "requirement";
  return probeRelation(
    state,
    {
      action,
      productId: PROBE_PRODUCT_ID,
      id: from,
      body: { stories: [to] },
    },
    async () => {
      const links = await state.session.readStoryLinks(from, type);
      if (type === "requirement") return links?.includes(to);
      const reverse = await state.session.readStoryLinks(to, "story");
      return links?.includes(to) && reverse?.includes(from);
    },
  );
}

async function probeDrafts(
  state: ProbeRun,
  cli: WriteCli,
  capability: Probe | undefined,
  account: string,
  reference: string,
  disabled: readonly string[],
  attempts: Attempt[],
): Promise<void> {
  const scope = state.session.scope;
  const module = scope?.moduleIds[0];
  const plan = scope?.openPlanIds[0];
  const execution = scope?.executionIds[0];
  const executionProbe = executionProbes.find((probe) => probe === capability);
  if (executionProbe && execution === undefined) {
    attempts.push(notExecuted(executionProbe, "#29 无可用验证迭代。"));
    return;
  }
  const requirement =
    (cli.all && !disabled.includes("requirement.linkStory")) ||
    capability === "requirement.linkStory"
      ? await state.session.findRequirement()
      : undefined;
  if (capability === "requirement.linkStory" && requirement === undefined) {
    attempts.push(notExecuted(capability, "#29 无可用用户需求。"));
    return;
  }
  const main = capability ?? "story.create";
  if (
    module === undefined ||
    disabled.includes("story.create") ||
    disabled.includes("story.close")
  ) {
    attempts.push({
      capability: main,
      status: "not_executed",
      ...(module === undefined
        ? { fields: ["module"], reason: "#29 无可用模块。" }
        : { reason: "探查基础创建或清理能力已禁用。" }),
    });
    return;
  }
  const variants = [...storyProbes].filter((item) =>
    item.startsWith("story.create."),
  );
  const variant = variants.find((item) => item === capability);
  if (variant) {
    if (capability === "story.create.plan" && plan === undefined) {
      attempts.push({
        capability: variant,
        status: "not_executed",
        fields: ["plan"],
        reason: "#29 无可用未关闭计划。",
      });
      return;
    }
    attempts.push(
      await createDraft(
        state,
        variant,
        makeDraft(account, module, reference, variant, state.tagFormat, plan),
      ),
    );
    return;
  }

  const body = makeDraft(
    account,
    module,
    reference,
    "story.create",
    state.tagFormat,
  );
  const created = await createDraft(state, "story.create", body);
  attempts.push(created);
  if (created.status !== "confirmed" || created.storyId === undefined) return;
  const actions = cli.all
    ? storyProbes.slice(1, 5)
    : storyProbes.filter((probe) => probe === capability);
  for (const action of actions) {
    if (disabled.includes(action)) {
      attempts.push({
        capability: action,
        status: "not_executed",
        reason: "此能力已由配置禁用。",
      });
      continue;
    }
    const results = await probeAction(
      state,
      action,
      created.storyId,
      body,
      reference,
      cli.assignee,
    );
    attempts.push(...results);
    if (results.at(-1)?.status === "unknown") return;
  }
  if (cli.all && !(await cleanupDraft(state, created.storyId))) return;
  for (const variant of cli.all ? variants : []) {
    if (
      disabled.includes(variant) ||
      (variant === "story.create.plan" && plan === undefined)
    ) {
      attempts.push({
        capability: variant,
        status: "not_executed",
        reason: disabled.includes(variant)
          ? "此能力已由配置禁用。"
          : "#29 无可用未关闭计划。",
      });
      continue;
    }
    const result = await createDraft(
      state,
      variant,
      makeDraft(account, module, reference, variant, state.tagFormat, plan),
    );
    attempts.push(result);
    if (result.status === "unknown") return;
    if (
      result.storyId !== undefined &&
      !(await cleanupDraft(state, result.storyId))
    )
      return;
  }
  const linkPair =
    (cli.all && !disabled.includes("story.linkStory")) ||
    capability === "story.linkStory";
  const linkRequirement =
    (cli.all && !disabled.includes("requirement.linkStory")) ||
    capability === "requirement.linkStory";
  const useExecution =
    (cli.all || executionProbe !== undefined) && execution !== undefined;
  let target = created;
  let targetDraft = body;
  if (
    cli.all &&
    (useExecution || linkPair || (linkRequirement && requirement !== undefined))
  ) {
    targetDraft = makeDraft(
      account,
      module,
      reference + "-links",
      "story.create",
      state.tagFormat,
    );
    target = await createDraft(state, "story.create", targetDraft);
    attempts.push(target);
    if (target.status !== "confirmed") return;
  }
  const storyId = target.storyId;
  if (storyId === undefined) return;
  if (useExecution) {
    await probeExecution(
      state,
      executionProbe,
      execution,
      storyId,
      targetDraft,
      disabled,
      attempts,
    );
    const last = attempts.at(-1);
    if (last?.status === "unknown" || last?.reason === "PERMISSION_DENIED")
      return;
  } else if (cli.all) {
    attempts.push(
      ...executionProbes.map((probe) => ({
        ...notExecuted(probe, "#29 无可用验证迭代。"),
        skipped: true,
      })),
    );
  }
  if (linkPair) {
    if (disabled.includes("story.create.design")) {
      attempts.push(
        notExecuted("story.linkStory", "设计类测试需求创建已禁用。"),
      );
    } else {
      const peer = await createDraft(
        state,
        "story.create.design",
        makeDraft(
          account,
          module,
          reference + "-pair",
          "story.create.design",
          state.tagFormat,
        ),
      );
      attempts.push(peer);
      if (peer.status !== "confirmed" || peer.storyId === undefined) {
        attempts.push(
          notExecuted("story.linkStory", "未确认设计类测试需求创建成功。"),
        );
        return;
      }
      const linked = await probeStoryRelation(
        state,
        "story.linkStory",
        storyId,
        peer.storyId,
      );
      attempts.push(linked);
      if (linked.status === "unknown" || linked.reason === "PERMISSION_DENIED")
        return;
    }
  }
  if (linkRequirement)
    attempts.push(
      requirement === undefined
        ? {
            ...notExecuted("requirement.linkStory", "#29 无可用用户需求。"),
            skipped: true,
          }
        : await probeStoryRelation(
            state,
            "requirement.linkStory",
            requirement,
            storyId,
          ),
    );
}

/** docs/06 §7.1 中固定 #29 的探查闭环。 */
export async function runProbeWrite({
  env,
  homeDir,
  clock,
  logSink,
  cli,
}: ProbeOptions): Promise<ProbeReport> {
  if (cli.product !== String(PROBE_PRODUCT_ID))
    return emptyReport(
      "PERMISSION_DENIED 探查仅允许显式指定 --product 29。",
      true,
    );
  if (!validPath(cli.config)) return emptyReport("配置文件路径不合法。", true);
  const capability =
    cli.action === "write" ? supportedProbe(cli.capability) : undefined;
  const cleanupId = cli.action === "cleanup" ? validId(cli.story) : undefined;
  if (
    cli.action === "write" &&
    ((cli.all === true
      ? cli.capability !== undefined
      : capability === undefined) ||
      !validPath(cli.out) ||
      (cli.assignee !== undefined && !cli.assignee.trim()))
  )
    return emptyReport("请指定一个支持的探查能力或 --all。", true);
  if (cli.action === "cleanup" && cleanupId === undefined)
    return emptyReport("--story 必须是正整数。", true);

  const attempts: Attempt[] = [];
  const cleanup: Attempt[] = [];
  const reference = randomUUID();
  let count = 0;
  let fixtureFailed = false;
  const outputFiles: { name: string; contents: string }[] = [];
  try {
    const config = await loadConfig({ env, homeDir, cli });
    const disabled = config.write.disableCapabilities;
    if (
      capability &&
      (disabled.includes(capability) ||
        getCapability(capability).state === "disabled")
    ) {
      return emptyReport("CAPABILITY_DISABLED 此探查能力已禁用。");
    }
    const password = env.ZENTAO_PASSWORD ?? "";
    const client = createZentaoReadClient({
      ...config.zentao,
      password,
      timezone: config.timezone,
      clock,
      env: {
        ZENTAO_TIMEOUT_MS: String(config.zentao.timeoutMs),
        BZT_LOG_LEVEL: config.logLevel,
      },
      logSink,
    });
    const { account } = await getCurrentUser(client);
    if (account !== config.zentao.account)
      return emptyReport("AUTH_FAILED 登录身份与配置账号不一致。");
    if (cli.action === "write" && !(await getInstanceConfig(client)).URAndSR) {
      return emptyReport(
        "CAPABILITY_UNVERIFIED 需启用禅道三级需求后再运行探查。",
      );
    }
    const out = cli.action === "write" ? cli.out : undefined;
    const session = await createProbeWriteSession(client, {
      account,
      password,
      clock,
      timeoutMs: config.zentao.timeoutMs,
      capture: out !== undefined,
      cleanupOnly: cleanupId !== undefined,
      discoverExecutions:
        cli.action === "write" &&
        (cli.all === true ||
          executionProbes.some((probe) => probe === capability)),
    });
    const run: ProbeRun = {
      client,
      session,
      startedAt: clock(),
      tagFormat:
        cli.action === "write" && cli.visibleTag ? "visible" : "comment",
      created: new Map(),
      tasks: new Map(),
      timezone: config.timezone,
      cleanup,
      recordFixture(action, id, response) {
        fixtureFailed ||= response.fixtureFailed === true;
        if (!response.fixture) return;
        const { endpoint, status, body } = response.fixture;
        outputFiles.push({
          name: `${action.replaceAll(".", "-")}.${id}.json`,
          contents: JSON.stringify({ endpoint, status, body }, null, 2) + "\n",
        });
      },
    };
    try {
      if (cleanupId !== undefined) run.created.set(cleanupId, undefined);
      else if (cli.action === "write")
        await probeDrafts(
          run,
          cli,
          capability,
          account,
          reference,
          disabled,
          attempts,
        );
    } catch (error) {
      attempts.push({
        capability: capability ?? "story.create",
        status: "not_executed",
        reason: errorCode(error),
      });
    } finally {
      // 子任务晚于父任务创建，按相反顺序关闭并逐个回读。
      for (const [id, identity] of [...run.tasks].reverse()) {
        const closed = await closeTask(run, id, identity);
        run.cleanup.push(closed);
        if (cli.action === "write" && (capability === "task.close" || cli.all))
          attempts.push(closed);
      }
      for (const id of run.created.keys()) await cleanupDraft(run, id);
    }
    if (out !== undefined && outputFiles.length > 0) {
      try {
        await mkdir(out, { recursive: true });
        for (const file of outputFiles) {
          await writeFile(join(out, file.name), file.contents, {
            encoding: "utf8",
            flag: "wx",
          });
          count++;
        }
      } catch {
        fixtureFailed = true;
      }
    }
    const terminal = new Map(
      attempts.map((attempt) => [attempt.capability, attempt]),
    );
    const checked = [...terminal.values()].every(
      ({ capability, status, skipped }) =>
        status === "confirmed" ||
        (cli.action === "write" &&
          cli.all === true &&
          status === "not_executed" &&
          (skipped || capability === "story.create.plan")),
    );
    const closed = cleanup.every(({ status }) => status === "confirmed");
    return {
      ok: checked && closed && !fixtureFailed,
      productId: PROBE_PRODUCT_ID,
      reference: cli.action === "write" ? reference : undefined,
      scope: session.scope,
      attempts,
      cleanup,
      fixtureCount: out === undefined ? undefined : count,
      error: fixtureFailed ? "脱敏夹具校验或保存失败。" : undefined,
    };
  } catch (error) {
    return emptyReport(`${errorCode(error)} 无法完成禅道探查预检。`);
  }
}
