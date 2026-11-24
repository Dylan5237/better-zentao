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
import type { Clock } from "../core/clock.ts";
import { loadConfig, PROBE_PRODUCT_ID } from "../core/config.ts";
import type { ConfigEnv } from "../core/config.ts";
import type { StoryDetail } from "../core/dto/story.ts";
import { BztError } from "../core/errors.ts";
import { buildStoryHtmlSpec } from "../domain/story-html-spec.ts";

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
const executionProbes = ["task.create", "story.linkExecution"] as const;
type StoryProbe = (typeof storyProbes)[number];
type ExecutionProbe = (typeof executionProbes)[number];
type Probe = StoryProbe | ExecutionProbe;
type IdRequest = Exclude<ProbeRequest, { action: "story.create" }>;
type Session = Awaited<ReturnType<typeof createProbeWriteSession>>;

type WriteCli = {
  readonly action: "write";
  readonly product?: string;
  readonly config?: string;
  readonly capability?: string;
  readonly all?: boolean;
  readonly assignee?: string;
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
  return [...storyProbes, ...executionProbes].find((probe) => probe === value);
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

function draftMatches(story: StoryDetail, expected: ProbeDraft) {
  const normalize = (html: string) => html.replace(/\r\n?/gu, "\n").trim();
  const roleComment = /<!-- bzt:v1 [^<>]+ -->/u.exec(expected.spec)?.[0];
  const spec = normalize(story.spec ?? "");
  const roleTag = roleComment !== undefined && spec.includes(roleComment);
  const expectedBody = normalize(expected.spec.replace(roleComment ?? "", ""));
  const htmlStructure =
    normalize(spec.replace(roleComment ?? "", "")) === expectedBody;
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
      htmlStructure &&
      roleTag,
    readback: { htmlStructure, roleTag },
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
    const { matches, readback } = draftMatches(story, body);
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
    if (target !== undefined) state.created.set(target, body);
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
  readonly created: Map<number, ProbeDraft | undefined>;
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
      return probeExisting(
        state,
        [
          {
            ...target,
            action: capability,
            body: { title: body.title, keywords },
          },
        ],
        (story) =>
          story.keywords === keywords &&
          story.title === body.title &&
          story.spec === body.spec,
      );
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
    ),
  };
}

function executionUnavailable(
  capability: ExecutionProbe,
  scope?: ProbeWriteScope,
): Attempt {
  return {
    capability,
    status: "not_executed",
    reason:
      scope?.executionsCount === 0
        ? "#29 无验证迭代。"
        : "本命令没有 #29 执行写入配方。",
  };
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
  if (capability === "task.create" || capability === "story.linkExecution") {
    attempts.push(executionUnavailable(capability, scope));
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
  if (
    capability?.startsWith("story.create.") === true &&
    capability !== "story.create"
  ) {
    if (capability === "story.create.plan" && plan === undefined) {
      attempts.push({
        capability,
        status: "not_executed",
        fields: ["plan"],
        reason: "#29 无可用未关闭计划。",
      });
      return;
    }
    attempts.push(
      await createDraft(
        state,
        capability,
        makeDraft(account, module, reference, capability, plan),
      ),
    );
    return;
  }

  const body = makeDraft(account, module, reference, "story.create");
  const created = await createDraft(state, "story.create", body);
  attempts.push(created);
  if (created.status !== "confirmed" || created.storyId === undefined) return;
  const actions = cli.all
    ? storyProbes.slice(1, 5)
    : capability
      ? [capability]
      : [];
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
  if (!cli.all) return;

  for (const variant of variants) {
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
      makeDraft(account, module, reference, variant, plan),
    );
    attempts.push(result);
    if (result.status === "unknown") return;
  }
  attempts.push(
    ...executionProbes.map((action) => executionUnavailable(action, scope)),
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
    });
    const run: ProbeRun = {
      client,
      session,
      startedAt: clock(),
      created: new Map(),
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
      for (const [id, draft] of run.created)
        cleanup.push(...(await closeStory(run, id, draft)));
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
      attempts.map((attempt) => [attempt.capability, attempt.status]),
    );
    const allowedSkipped = [
      "story.create.plan",
      "task.create",
      "story.linkExecution",
    ];
    const checked = [...terminal.entries()].every(
      ([action, status]) =>
        status === "confirmed" ||
        (cli.action === "write" &&
          cli.all === true &&
          status === "not_executed" &&
          allowedSkipped.includes(action)),
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
