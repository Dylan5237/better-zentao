import { createHash } from "node:crypto";
import { join } from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import { z } from "zod";
import { createZentaoReadClient } from "../api/client.ts";
import {
  sendWecomMessage,
  type WecomMessage,
  type WecomReceipt,
} from "../api/wecom.ts";
import { normalizeZentaoBaseUrl } from "../core/base-url.ts";
import {
  civilDate,
  createWorkCalendar,
  formatLocalDate,
  isWorkday,
} from "../core/calendar.ts";
import type { Clock } from "../core/clock.ts";
import {
  assertNoConfigCredentials,
  loadConfig,
  loadFileConfig,
  resolveZentaoTimeout,
} from "../core/config.ts";
import type { ConfigEnv, TeamConfig } from "../core/config.ts";
import { BztError } from "../core/errors.ts";
import {
  instanceHashOf,
  openLocalStore,
  sanitizeAccount,
} from "../core/store/index.ts";
import type { LocalStore, NotificationRecord } from "../core/store/index.ts";
import { TrackingService } from "./tracking.ts";

const eventKind = z.enum([
  "handoff",
  "decompose",
  "assign_other",
  "release_gate",
]);
const eventLabels = {
  handoff: "移交",
  decompose: "拆解",
  assign_other: "指派",
  release_gate: "发布门禁",
};
const targetSchema = z.object({
  account: z.string().trim().min(1),
  realname: z.string(),
});
const itemSchema = z.object({
  type: z.enum(["story", "task", "release"]),
  id: z.int().positive(),
  title: z.string(),
  status: z.string(),
  deadline: civilDate.nullish(),
  targets: z.array(targetSchema).default([]),
});
const eventSchema = itemSchema.extend({ event: eventKind });
const digestItemSchema = itemSchema.extend({
  category: z.enum(["今日到期", "逾期", "待接收", "可测试"]),
});
const digestOptions = z.strictObject({
  force: z.boolean().optional(),
  dryRun: z.boolean().optional(),
});
type Item = z.output<typeof itemSchema>;
type Target = z.output<typeof targetSchema>;
type DigestItem = z.input<typeof digestItemSchema>;
type Gap = { source: string; reason: string };
type Notice = {
  target: string;
  channel: "wecom";
  state: "sent" | "queued" | "failed";
};
type Outcome = { skipped: boolean; notified: Notice[] };
type DigestOutcome = Outcome & {
  completeness: "complete" | "partial";
  gaps: readonly Gap[];
  preview?: Partial<Record<DigestItem["category"], number>>;
};
type DigestSource = { items: readonly DigestItem[]; gaps?: readonly Gap[] };

export interface SchedulerRuntime {
  readonly env: ConfigEnv;
  readonly homeDir?: string;
  readonly clock: Clock;
  readonly logSink?: (line: string) => void;
}

interface NotifyOptions {
  readonly config: Pick<
    TeamConfig,
    "notify" | "timezone" | "wecomMap" | "calendar"
  >;
  readonly env: ConfigEnv;
  readonly clock: Clock;
  readonly store: {
    notifications: Pick<LocalStore["notifications"], "recordIfAbsent">;
  };
  readonly sender?: (message: WecomMessage) => Promise<WecomReceipt>;
  readonly loadDigest?: (day: string, asOf: number) => Promise<DigestSource>;
  readonly logSink?: (line: string) => void;
  readonly sleep?: (ms: number) => Promise<void>;
}

export function requireCollector(
  account: string | undefined,
  collector: string | undefined,
): void {
  // docs/08 CFG-11
  if (!collector)
    throw new BztError("CONFIG_MISSING", "请先配置唯一采集账号。");
  if (account?.trim() !== collector)
    throw new BztError(
      "PERMISSION_DENIED",
      "请使用配置指定的唯一采集账号执行。",
    );
}

function report(notified: Notice[] = []): Outcome {
  return { skipped: notified.length === 0, notified };
}

function digestReport(
  result: Outcome,
  gaps: readonly Gap[] = [],
): DigestOutcome {
  return {
    ...result,
    completeness: gaps.length ? "partial" : "complete",
    gaps,
  };
}

function notice(target: Target | null, state: Notice["state"]): Notice {
  return { target: target?.account ?? "group", channel: "wecom", state };
}

function targetsFor(item: Item): (Target | null)[] {
  return item.targets.length
    ? [
        ...new Map(
          item.targets.map((target) => [target.account, target]),
        ).values(),
      ]
    : [null];
}

function isQuiet(clockTime: number, config: NotifyOptions["config"]): boolean {
  const [start, end] = config.notify.quietHours;
  const current = new Intl.DateTimeFormat("en-GB", {
    timeZone: config.timezone,
    hour: "2-digit",
    minute: "2-digit",
    hourCycle: "h23",
  }).format(clockTime);
  return start <= end
    ? current >= start && current < end
    : current >= start || current < end;
}

interface Delivery {
  readonly item: Item;
  readonly label: string;
}

export class NotifyService {
  public constructor(private readonly options: NotifyOptions) {}

  public async notifyEvent(raw: unknown): Promise<Outcome> {
    const kind = z.object({ event: eventKind }).safeParse(raw);
    if (!kind.success) throw new BztError("INVALID_INPUT", "通知事件不合法。");
    const { event } = kind.data;
    const { config, env, clock } = this.options;
    if (!config.notify.events.includes(event) || !env.BZT_WECOM_WEBHOOK?.trim())
      return report();
    const parsed = eventSchema.safeParse(raw);
    if (!parsed.success)
      throw new BztError("INVALID_INPUT", "事件通知字段不合法。");
    const now = clock();
    if (isQuiet(now, config))
      return report(
        targetsFor(parsed.data).map((target) => notice(target, "queued")),
      );
    return this.deliver(
      event,
      [{ item: parsed.data, label: eventLabels[event] }],
      now,
    );
  }

  public async sendDailyDigest(raw: unknown = {}): Promise<DigestOutcome> {
    const parsed = digestOptions.safeParse(raw);
    if (!parsed.success)
      throw new BztError("INVALID_INPUT", "摘要参数不合法。");
    const { config, env, clock, loadDigest } = this.options;
    requireCollector(env.ZENTAO_ACCOUNT, config.notify.digest.collector);
    const now = clock();
    const day = formatLocalDate(now, config.timezone);
    const { dryRun, force } = parsed.data;
    if (
      (!dryRun && !env.BZT_WECOM_WEBHOOK?.trim()) ||
      (config.notify.digest.workdaysOnly &&
        !force &&
        !isWorkday(day, createWorkCalendar(config.calendar)))
    )
      return digestReport(report());
    if (!dryRun && isQuiet(now, config))
      return digestReport(report([notice(null, "queued")]));
    if (!loadDigest)
      throw new BztError("CONFIG_MISSING", "缺少摘要数据读取服务。");
    const { items, gaps } = await loadDigest(day, now);
    const selected = z.array(digestItemSchema).safeParse(items);
    if (!selected.success)
      throw new BztError("INVALID_INPUT", "摘要事项字段不合法。");
    if (dryRun) {
      const preview: NonNullable<DigestOutcome["preview"]> = {};
      for (const { category } of selected.data)
        preview[category] = (preview[category] ?? 0) + 1;
      return { ...digestReport(report(), gaps), preview };
    }
    return digestReport(
      await this.deliver(
        "digest",
        selected.data.map((item) => ({ item, label: item.category })),
        now,
      ),
      gaps,
    );
  }

  private async reserve(record: NotificationRecord): Promise<boolean> {
    const { store, sleep = delay } = this.options;
    const waits = [25, 75];
    for (let attempt = 0; ; attempt++) {
      try {
        return store.notifications.recordIfAbsent(record);
      } catch (error) {
        const wait = waits[attempt];
        if (
          wait === undefined ||
          !(error instanceof BztError) ||
          error.details?.errcode !== 5
        )
          throw error;
        await sleep(wait);
      }
    }
  }

  private cleanText(text: string, max: number): string {
    try {
      assertNoConfigCredentials(text, this.options.env);
    } catch {
      return "[已脱敏]";
    }
    const cleaned = text
      .replace(/https?:\/\/\S+/giu, "[链接已省略]")
      .replace(/<@[^>\s]*>?/gu, "")
      .replace(/[\p{Cc}\p{Cf}\u2028\u2029]/gu, " ")
      .trim();
    return [...cleaned].slice(0, max).join("");
  }

  private async deliver(
    event: string,
    items: readonly Delivery[],
    now: number,
  ): Promise<Outcome> {
    if (!items.length) return report();
    const { env, config, clock, logSink } = this.options;
    const base = normalizeZentaoBaseUrl(env.ZENTAO_BASE_URL?.trim() ?? "");
    if (!base) throw new BztError("CONFIG_MISSING", "缺少合法的禅道基础地址。");
    try {
      assertNoConfigCredentials(base.href, env);
    } catch {
      throw new BztError("INVALID_INPUT", "禅道基础地址包含凭据。");
    }
    const webhookUrl = env.BZT_WECOM_WEBHOOK?.trim();
    if (!webhookUrl) return report();
    const sender =
      this.options.sender ??
      ((message: WecomMessage) =>
        sendWecomMessage(message, {
          webhookUrl,
          clock,
          logSink,
          env,
          timeoutMs: resolveZentaoTimeout(env),
        }));
    const day = formatLocalDate(now, config.timezone);
    const notified: Notice[] = [];
    const lines: string[] = [];
    const pending: (Target | null)[] = [];
    async function flush() {
      if (!lines.length) return;
      const mentionedIds = new Set<string>();
      const mentionedPhones = new Set<string>();
      for (const target of pending) {
        if (!target || !Object.hasOwn(config.wecomMap, target.account))
          continue;
        const mapping = config.wecomMap[target.account];
        if (!mapping) continue;
        try {
          assertNoConfigCredentials(mapping, env);
        } catch {
          continue;
        }
        if (/^\+?\d{7,15}$/u.test(mapping)) mentionedPhones.add(mapping);
        else if (/^[\w.@-]+$/u.test(mapping)) mentionedIds.add(mapping);
      }
      let ok = false;
      try {
        ok = (
          await sender({
            content: lines.join("\n"),
            mentionedIds: [...mentionedIds],
            mentionedPhones: [...mentionedPhones],
          })
        ).ok;
      } catch {
        // 发送不确定时保留占位，避免再次触发造成重复群消息。
      }
      notified.push(
        ...pending.map((target) => notice(target, ok ? "sent" : "failed")),
      );
      lines.length = 0;
      pending.length = 0;
    }
    for (const { item, label } of items) {
      const typeLabel = { story: "需求", task: "任务", release: "发布" }[
        item.type
      ];
      const url = new URL(`${item.type}-view-${item.id}.html`, base);
      const summary = `【${label}】${typeLabel} ${this.cleanText(item.title, 120)} ｜ ${this.cleanText(item.status, 40)} ｜ 截止 ${item.deadline ?? "未填写"} ｜ ${url.href}`;
      if (Buffer.byteLength(summary) > 2048)
        throw new BztError("INVALID_INPUT", "事项的通知链接过长。");
      const claimed: (Target | null)[] = [];
      for (const target of targetsFor(item)) {
        const identity = JSON.stringify([
          event,
          item.type,
          item.id,
          target?.account ?? null,
        ]);
        const dedupeKey = `${day}:${createHash("sha256").update(identity).digest("hex")}`;
        if (
          await this.reserve({
            dedupeKey,
            channel: "wecom",
            target: target?.account ?? "group",
            sentAt: now,
            state: "reserved",
          })
        )
          claimed.push(target);
      }
      if (!claimed.length) continue;
      const names = claimed.flatMap((target) =>
        target ? [this.cleanText(target.realname, 32)] : [],
      );
      const suffix = names.length ? ` ｜ ${names.join("、")}` : "";
      const line =
        Buffer.byteLength(summary + suffix) <= 2048
          ? summary + suffix
          : summary;
      if (Buffer.byteLength(lines.join("\n") + "\n" + line) > 2048)
        await flush();
      lines.push(line);
      pending.push(...claimed);
    }
    await flush();
    return report(notified);
  }
}

async function collectDigest(
  tracking: TrackingService,
  members: string[],
): Promise<DigestSource> {
  const [tasks, stories] = await Promise.allSettled([
    tracking.getTeamWork({ members, view: "all_open" }),
    tracking.queryStories({
      category: "feature",
      progress: ["待接收", "待测试", "测试中"],
      limit: 100,
    }),
  ]);
  const items: DigestItem[] = [];
  const gaps: Gap[] = [];
  if (tasks.status === "fulfilled") {
    gaps.push(...tasks.value.gaps);
    for (const { items: group } of tasks.value.data.groups) {
      for (const task of group) {
        if (
          !task.isParent &&
          (task.timeState === "due_today" || task.timeState === "overdue")
        )
          items.push({
            type: "task",
            id: task.id,
            title: task.name,
            status: task.status,
            deadline: task.deadline,
            targets: task.assignedTo ? [task.assignedTo] : [],
            category: task.timeState === "due_today" ? "今日到期" : "逾期",
          });
      }
    }
  } else gaps.push({ source: "任务", reason: "无法读取团队任务。" });
  if (stories.status === "rejected") {
    gaps.push({ source: "需求", reason: "无法读取研发需求。" });
    return { items, gaps };
  }
  gaps.push(...stories.value.gaps);
  if (stories.value.truncated)
    gaps.push({
      source: "需求",
      reason: "摘要读取最多覆盖前 100 条符合条件的研发需求。",
    });
  for (const story of stories.value.data.items) {
    const item = {
      id: story.id,
      title: story.title,
      status: story.progress.value,
      deadline: story.nextDeadline,
    };
    const owner = story.currentOwner ?? story.receiver;
    if (story.progress.value === "待接收") {
      items.push({
        ...item,
        type: "story",
        category: "待接收",
        targets: owner ? [owner] : [],
      });
      continue;
    }
    try {
      const result = await tracking.getStoryProgress({ storyId: story.id });
      gaps.push(...result.gaps);
      if (result.completeness !== "complete") continue;
      if (!("stages" in result.data)) {
        gaps.push({
          source: `需求 #${story.id}`,
          reason: "缺少测试接续依据。",
        });
        continue;
      }
      const dev = result.data.stages.find(({ stage }) => stage === "dev");
      const integration = result.data.stages.find(
        ({ stage }) => stage === "interface",
      );
      const test = result.data.stages.find(({ stage }) => stage === "test");
      if (
        (dev?.state !== "done" && dev?.state !== "waived") ||
        (integration &&
          integration.state !== "done" &&
          integration.state !== "waived" &&
          (integration.required ||
            !["missing", "cancelled"].includes(integration.state))) ||
        !test ||
        !test.required
      )
        continue;
      const leaves = test.tasks.filter((task) => !task.isParent);
      if (
        test.state === "missing" ||
        (test.state === "not_started" && leaves.length > 0)
      )
        items.push({
          ...item,
          type: "story",
          category: "可测试",
          targets: leaves.flatMap((task) =>
            task.assignedTo ? [task.assignedTo] : [],
          ),
        });
    } catch {
      gaps.push({
        source: `需求 #${story.id}`,
        reason: "无法读取测试接续依据。",
      });
    }
  }
  return { items, gaps };
}

export async function runDailyDigest(
  runtime: SchedulerRuntime,
  options: { config?: string; force?: boolean; dryRun?: boolean },
): Promise<DigestOutcome> {
  const { env, clock, logSink } = runtime;
  const cli = { config: options.config };
  const { config: fileConfig } = await loadFileConfig({ ...runtime, cli });
  requireCollector(env.ZENTAO_ACCOUNT, fileConfig.notify.digest.collector);
  if (!options.dryRun && !env.BZT_WECOM_WEBHOOK?.trim())
    return digestReport(report());
  const config = await loadConfig({ ...runtime, cli });
  const { baseUrl, account } = config.zentao;
  const password = env.ZENTAO_PASSWORD;
  if (!password) throw new BztError("CONFIG_MISSING", "缺少必填禅道环境变量。");
  const store = openLocalStore({
    baseUrl,
    account,
    clock,
    dbPath: join(
      config.stateDir,
      instanceHashOf(baseUrl),
      sanitizeAccount(account),
      "state.db",
    ),
  });
  try {
    const service = new NotifyService({
      config,
      env,
      clock,
      store,
      logSink,
      loadDigest: (_day, asOf) => {
        const client = createZentaoReadClient({
          baseUrl,
          account: account.trim(),
          password,
          clock,
          logSink,
          env,
          timezone: config.timezone,
        });
        const tracking = new TrackingService({
          client,
          config,
          clock: () => asOf,
          baseUrl,
          store,
        });
        const members = [
          ...new Set(
            Object.values(config.teams).flatMap(({ lead, members }) => [
              lead,
              ...members,
            ]),
          ),
        ];
        return collectDigest(
          tracking,
          members.length ? members : [account.trim()],
        );
      },
    });
    return await service.sendDailyDigest({
      force: options.force,
      dryRun: options.dryRun,
    });
  } finally {
    store.close();
  }
}
