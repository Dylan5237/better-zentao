import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { runDigestCommand } from "../../src/adapters/scheduler/digest.ts";
import { runScheduleTaskCommand } from "../../src/adapters/scheduler/schedule-task.ts";
import { sendWecomMessage } from "../../src/api/wecom.ts";
import { parseZentaoDateTime } from "../../src/core/calendar.ts";
import { teamConfigSchema } from "../../src/core/config.ts";
import { BztError } from "../../src/core/errors.ts";
import { openLocalStore } from "../../src/core/store/index.ts";
import { NotifyService } from "../../src/services/notify.ts";
import { runScheduleTask } from "../../src/services/schedule-task.ts";
import { TrackingService } from "../../src/services/tracking.ts";

const secret = "synthetic-private-value";
const webhook = new URL("https://wecom.example.invalid/cgi-bin/webhook/send");
webhook.searchParams.set("key", secret);
const env = {
  BZT_WECOM_WEBHOOK: webhook.href,
  ZENTAO_BASE_URL: "https://zentao.example.invalid/zentao/",
  ZENTAO_ACCOUNT: "collector",
  ZENTAO_PASSWORD: "synthetic-zentao-password",
};
const event = {
  event: "decompose",
  type: "task",
  id: 45,
  title: "登录重构",
  status: "待研发",
  deadline: "2026-12-09",
  spec: "合成正文探针",
  targets: [
    { account: "alice", realname: "张三" },
    { account: "bob", realname: "李四" },
    { account: "carol", realname: "王五" },
  ],
} satisfies { type: "task"; [field: string]: unknown };
const day = "2026-12-09";
const timestamp = (value: string) => {
  const result = parseZentaoDateTime(value);
  if (result === null) throw new Error("没有测试时间");
  return result;
};
const cleanup: Array<() => void | Promise<void>> = [];
afterEach(async () => {
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
  for (const dispose of cleanup.splice(0).reverse()) await dispose();
});

function setup(
  options?: ConstructorParameters<typeof NotifyService>[0]["config"],
) {
  let now = timestamp(day + " 09:00:00");
  const clock = () => now;
  const store = openLocalStore({
    baseUrl: env.ZENTAO_BASE_URL,
    account: env.ZENTAO_ACCOUNT,
    dbPath: ":memory:",
    clock,
  });
  cleanup.push(() => store.close());
  const sender = vi
    .fn<NonNullable<ConstructorParameters<typeof NotifyService>[0]["sender"]>>()
    .mockResolvedValue({ ok: true, status: 200 });
  const config =
    options ??
    teamConfigSchema.parse({
      notify: { digest: { collector: "collector" } },
      wecomMap: { alice: "wecom_alice", carol: "13800000000" },
    });
  const deps = { env, config, clock, store };
  return {
    deps,
    sender,
    service: new NotifyService({ ...deps, sender }),
    setTime: (value: string) => {
      now = timestamp(value);
    },
  };
}

describe("WP-37 通知服务", () => {
  it("AC-45/80/81 只发摘要，映射缺失时只显示姓名", async () => {
    const { service, sender } = setup();
    expect(await service.notifyEvent(event)).toMatchObject({
      skipped: false,
      notified: event.targets.map(({ account }) => ({
        target: account,
        channel: "wecom",
        state: "sent",
      })),
    });
    expect(sender).toHaveBeenCalledTimes(1);
    const message = sender.mock.calls[0]?.[0];
    expect(message).toMatchObject({
      mentionedIds: ["wecom_alice"],
      mentionedPhones: ["13800000000"],
    });
    expect(message?.content).toContain("登录重构");
    expect(message?.content).toContain("待研发");
    expect(message?.content).toContain(day);
    expect(message?.content).toContain("/zentao/task-view-45.html");
    expect(message?.content).toContain("李四");
    expect(message?.content).not.toContain("@李四");
    expect(message?.content).not.toContain(event.spec);
  });

  it("SV-12 并发抢占后同日只发一次，业务时区跨天后可以再发", async () => {
    const { service, sender, setTime } = setup();
    const [first, second] = await Promise.all([
      service.notifyEvent(event),
      service.notifyEvent(event),
    ]);
    expect([first.skipped, second.skipped].sort()).toEqual([false, true]);
    setTime("2026-12-10 09:00:00");
    expect((await service.notifyEvent(event)).skipped).toBe(false);
    expect(sender).toHaveBeenCalledTimes(2);
  });

  it("静默期起点包含、结束点排除，跨午夜不占发送记录", async () => {
    const { deps, service, sender, setTime } = setup();
    for (const time of [
      "2026-12-09 20:00:00",
      "2026-12-10 00:00:00",
      "2026-12-10 08:29:59",
    ]) {
      setTime(time);
      const { notified } = await service.notifyEvent(event);
      expect(notified).toHaveLength(3);
      expect(notified.every(({ state }) => state === "queued")).toBe(true);
    }
    expect(sender).not.toHaveBeenCalled();
    expect(
      deps.store.notifications.listBySentDateRange(0, Number.MAX_SAFE_INTEGER),
    ).toEqual([]);
    setTime("2026-12-10 08:30:00");
    expect((await service.notifyEvent(event)).notified[0]?.state).toBe("sent");
  });

  it("相等的静默起止时间表示空区间", async () => {
    const { service } = setup(
      teamConfigSchema.parse({
        notify: { quietHours: ["09:00", "09:00"] },
      }),
    );
    expect((await service.notifyEvent(event)).notified[0]?.state).toBe("sent");
  });

  it("仅对 SQLITE_BUSY 有界重试", async () => {
    const { deps, sender } = setup();
    const busy = new BztError("ZENTAO_UNAVAILABLE", "数据库繁忙", {
      errcode: 5,
    });
    const record = vi
      .spyOn(deps.store.notifications, "recordIfAbsent")
      .mockImplementationOnce(() => {
        throw busy;
      });
    const sleep = vi.fn(async () => {});
    const service = new NotifyService({ ...deps, sender, sleep });
    expect((await service.notifyEvent(event)).notified[0]?.state).toBe("sent");
    expect(sleep).toHaveBeenCalledTimes(1);
    record.mockImplementation(() => {
      throw busy;
    });
    await expect(service.notifyEvent({ ...event, id: 46 })).rejects.toBe(busy);
    expect(sleep.mock.calls.length).toBeGreaterThan(1);
    expect(sleep.mock.calls.length).toBeLessThan(6);
    expect(sender).toHaveBeenCalledTimes(1);
  });

  it("配置禁用事件或没有 webhook 时跳过", async () => {
    const { deps, sender } = setup();
    const disabled = new NotifyService({
      ...deps,
      sender,
      config: teamConfigSchema.parse({ notify: { events: [] } }),
    });
    const noWebhook = new NotifyService({
      ...deps,
      sender,
      env: { ...env, BZT_WECOM_WEBHOOK: " " },
    });
    for (const service of [disabled, noWebhook]) {
      expect(await service.notifyEvent(event)).toEqual({
        skipped: true,
        notified: [],
      });
    }
    expect(sender).not.toHaveBeenCalled();
  });

  it("CFG-11 未到采集账号时拒绝摘要并且不读取数据", async () => {
    const { deps, sender } = setup();
    const loadDigest = vi.fn();
    const service = new NotifyService({
      ...deps,
      sender,
      loadDigest,
      env: { ...env, ZENTAO_ACCOUNT: "other" },
    });
    await expect(
      service.sendDailyDigest({ force: true }),
    ).rejects.toMatchObject({
      code: "PERMISSION_DENIED",
    });
    expect(loadDigest).not.toHaveBeenCalled();
    expect(sender).not.toHaveBeenCalled();
  });

  it("AC-80 按工作日读取四类摘要，按事项去重并保留数据缺口", async () => {
    const { deps, setTime, sender } = setup();
    const service = new NotifyService({
      ...deps,
      sender,
      loadDigest: async () => ({
        items: [
          { ...event, id: 1, category: "今日到期" },
          { ...event, id: 2, category: "逾期" },
          { ...event, id: 3, category: "待接收", type: "story" },
          { ...event, id: 4, category: "可测试", type: "story" },
        ],
        gaps: [{ source: "需求", reason: "读取范围不完整。" }],
      }),
    });
    setTime("2026-12-12 09:00:00");
    expect((await service.sendDailyDigest({})).skipped).toBe(true);
    expect(sender).not.toHaveBeenCalled();
    expect(await service.sendDailyDigest({ force: true })).toMatchObject({
      skipped: false,
      completeness: "partial",
    });
    const content = sender.mock.calls[0]?.[0].content;
    for (const category of ["今日到期", "逾期", "待接收", "可测试"])
      expect(content).toContain(category);
    expect(content).not.toContain(event.spec);
    expect((await service.sendDailyDigest({ force: true })).skipped).toBe(true);
    expect(sender).toHaveBeenCalledTimes(1);
  });

  it("消息失败时返回 failed，同日重触发仍保持一次实际尝试", async () => {
    const { service, sender } = setup();
    sender.mockRejectedValueOnce(new Error(webhook.href));
    expect(
      (await service.notifyEvent(event)).notified.map(({ state }) => state),
    ).toEqual(["failed", "failed", "failed"]);
    expect(await service.notifyEvent(event)).toEqual({
      skipped: true,
      notified: [],
    });
    expect(sender).toHaveBeenCalledTimes(1);
  });
});

describe("企微机器人传输", () => {
  it("经过真实传输代码，S01 日志与错误回执仅保留允许字段", async () => {
    const fetcher = vi
      .fn<typeof fetch>()
      .mockResolvedValueOnce(Response.json({ errcode: 0, errmsg: "ok" }))
      .mockResolvedValueOnce(
        Response.json({ errcode: 400, errmsg: webhook.href }),
      )
      .mockRejectedValueOnce(new Error(webhook.href));
    vi.stubGlobal("fetch", fetcher);
    const { deps } = setup();
    const logs: string[] = [];
    const clock = deps.clock;
    const service = new NotifyService({
      ...deps,
      logSink: (line) => logs.push(line),
    });
    expect((await service.notifyEvent(event)).notified[0]?.state).toBe("sent");
    const [, request] = fetcher.mock.calls[0] ?? [];
    expect(request).toMatchObject({
      method: "POST",
      redirect: "error",
      signal: expect.any(AbortSignal),
    });
    expect(request?.body).toContain('"mentioned_list":["wecom_alice"]');
    expect(request?.body).toContain('"mentioned_mobile_list":["13800000000"]');
    expect(request?.body).not.toContain(secret);
    const options = {
      webhookUrl: webhook.href,
      clock,
      logSink: (line: string) => logs.push(line),
    };
    const result = await sendWecomMessage({ content: "测试" }, options);
    expect(result).toMatchObject({ ok: false, status: 200, errcode: 400 });
    await expect(
      sendWecomMessage({ content: "测试" }, options),
    ).resolves.toMatchObject({ ok: false, status: 0 });
    expect(JSON.stringify(result)).not.toContain(secret);
    for (const line of logs) {
      expect(JSON.parse(line)).toEqual({
        pathTemplate: "/cgi-bin/webhook/send",
        status: expect.any(Number),
        method: "POST",
        durationMs: expect.any(Number),
      });
      expect(line).not.toContain(secret);
      expect(line).not.toContain(event.title);
    }
    expect(logs).toHaveLength(3);
  });

  it("无效 webhook 在发请求之前拒绝，错误不含地址", async () => {
    const fetcher = vi.fn();
    vi.stubGlobal("fetch", fetcher);
    const wrongPath = new URL(webhook);
    wrongPath.pathname = "/other";
    const duplicate = new URL(webhook);
    duplicate.searchParams.append("key", "another-synthetic-value");
    const credentials = new URL(webhook);
    credentials.username = "synthetic-user";
    const blank = new URL(webhook);
    blank.searchParams.set("key", " ");
    for (const url of [
      wrongPath.href,
      webhook.href + "#",
      duplicate.href,
      credentials.href,
      blank.href,
    ]) {
      await expect(
        sendWecomMessage(
          { content: "测试" },
          { webhookUrl: url, clock: () => 0 },
        ),
      ).rejects.toMatchObject({
        code: "INVALID_INPUT",
        message: "企微机器人地址不合法。",
      });
    }
    expect(fetcher).not.toHaveBeenCalled();
  });
});

describe("Windows 任务计划", () => {
  async function scheduler() {
    const dir = await mkdtemp(join(tmpdir(), "bzt-notify-"));
    cleanup.push(() => rm(dir, { force: true, recursive: true }));
    const file = join(dir, "team.json");
    await writeFile(
      file,
      JSON.stringify({
        notify: { digest: { collector: "collector", time: "09:15" } },
        snapshot: { collector: "snapshot-collector", day: 3 },
      }),
    );
    return {
      env: { ...env, BZT_HOME: dir, BZT_CONFIG: file },
      clock: () => timestamp(day),
    };
  }

  it("CFG-11 对摘要和快照分别限制安装账号", async () => {
    const runtime = await scheduler();
    await expect(
      runScheduleTask({ ...runtime, action: "install", target: "snapshot" }),
    ).rejects.toMatchObject({ code: "PERMISSION_DENIED" });
    await expect(
      runScheduleTask({
        ...runtime,
        action: "install",
        target: "digest",
        env: { ...runtime.env, ZENTAO_ACCOUNT: "other" },
      }),
    ).rejects.toMatchObject({ code: "PERMISSION_DENIED" });
  });

  it("预览不落盘，安装仅保存 XML，状态与卸载基于本地文件", async () => {
    const runtime = await scheduler();
    const command = { ...runtime, target: "digest" };
    const preview = await runScheduleTask({
      ...command,
      action: "install",
      dryRun: true,
    });
    expect(preview.commandHints[0]).toContain("schtasks /Create /XML");
    expect(
      (await runScheduleTask({ ...command, action: "status" })).exists,
    ).toBe(false);
    const result = await runScheduleTask({ ...command, action: "install" });
    const contents = await readFile(result.xmlPath, "utf8");
    expect(contents).toContain("09:15:00");
    expect(contents).toContain("bzt digest");
    expect(contents).not.toMatch(/\{\{|ZENTAO_|BZT_WECOM/u);
    for (const value of [secret, env.ZENTAO_PASSWORD, webhook.href]) {
      expect(contents).not.toContain(value);
    }
    expect(
      (await runScheduleTask({ ...command, action: "status" })).exists,
    ).toBe(true);
    expect(
      (await runScheduleTask({ ...command, action: "uninstall" }))
        .commandHints[0],
    ).toContain("schtasks /Delete");
    expect(
      (await runScheduleTask({ ...command, action: "status" })).exists,
    ).toBe(false);
    const snapshot = await runScheduleTask({
      ...runtime,
      action: "install",
      target: "snapshot",
      env: { ...runtime.env, ZENTAO_ACCOUNT: "snapshot-collector" },
    });
    const snapshotXml = await readFile(snapshot.xmlPath, "utf8");
    expect(snapshotXml).toContain("<Day>3</Day>");
    expect(snapshotXml).toContain("/d /c bzt snapshot capture");
  });

  it("CLI 适配器对非法参数返回 2", async () => {
    const runtime = {
      ...(await scheduler()),
      stdout: vi.fn(),
      stderr: vi.fn(),
    };
    expect(await runDigestCommand(["--force", "--unknown"], runtime)).toBe(2);
    expect(
      await runScheduleTaskCommand(["status", "digest", "--dry-run"], runtime),
    ).toBe(2);
    expect(
      await runScheduleTaskCommand(["install", "digest", "--dry-run"], runtime),
    ).toBe(0);
  });

  it("CLI 摘要读取服务沿用任务时间口径，读取失败时保留缺口并报告部分成功", async () => {
    const runtime = {
      ...(await scheduler()),
      clock: () => timestamp(day + " 09:00:00"),
      stdout: vi.fn(),
      stderr: vi.fn(),
    };
    const fetcher = vi
      .fn<typeof fetch>()
      .mockImplementation(async () =>
        Response.json({ errcode: 0, errmsg: "ok" }),
      );
    vi.stubGlobal("fetch", fetcher);
    const task = {
      id: 80,
      name: "今日到期测试任务",
      url: new URL("task-view-80.html", env.ZENTAO_BASE_URL).href,
      status: "wait",
      deadline: day,
      isParent: false,
      execution: { id: 1, name: "测试迭代", untrusted: true },
      timeState: "due_today",
      untrusted: true,
    } satisfies Awaited<
      ReturnType<TrackingService["getTeamWork"]>
    >["data"]["groups"][number]["items"][number];
    vi.spyOn(TrackingService.prototype, "getTeamWork").mockResolvedValue({
      ok: true,
      data: {
        groups: [
          {
            key: "collector",
            label: "采集账号",
            untrusted: true,
            count: 2,
            items: [
              task,
              { ...task, id: 82, timeState: "overdue" },
              { ...task, id: 81, name: "父任务不发", isParent: true },
            ],
          },
        ],
        totals: { overdue: 0, dueSoon: 0, open: 1 },
      },
      scope: { asOf: day + "T01:00:00Z", filters: {} },
      completeness: "complete",
      gaps: [],
      inferences: [],
    });
    const query = vi
      .spyOn(TrackingService.prototype, "queryStories")
      .mockRejectedValue(new Error("离线读取失败"));
    expect(await runDigestCommand([], runtime)).toBe(1);
    expect(fetcher).toHaveBeenCalledTimes(1);
    const [, request] = fetcher.mock.calls[0] ?? [];
    expect(request?.body).toContain(task.name);
    expect(request?.body).not.toContain("父任务不发");
    expect(runtime.stdout.mock.calls[0]?.[0]).toContain(
      '"completeness":"partial"',
    );
    expect(runtime.stdout.mock.calls[0]?.[0]).toContain("无法读取研发需求");
    const scope = { asOf: day + "T01:00:00Z", filters: {} };
    const base = {
      scope,
      completeness: "complete",
      gaps: [],
      inferences: [],
    } satisfies Pick<
      Awaited<ReturnType<TrackingService["queryStories"]>>,
      "scope" | "completeness" | "gaps" | "inferences"
    >;
    const waiting = {
      id: 92,
      title: "待接收示例",
      url: new URL("story-view-92.html", env.ZENTAO_BASE_URL).href,
      untrusted: true,
      product: { id: 29, name: "示例产品", untrusted: true },
      status: "active",
      category: "feature",
      progress: { value: "待接收", level: "inferred" },
      riskCodes: [],
    } satisfies Awaited<
      ReturnType<TrackingService["queryStories"]>
    >["data"]["items"][number];
    const testing = {
      ...waiting,
      id: 93,
      progress: { ...waiting.progress, value: "待测试" },
    };
    query.mockResolvedValue({
      ...base,
      ok: true,
      data: {
        items: [waiting, testing],
        countsByProgress: { 待接收: 1, 待测试: 1 },
      },
    });
    vi.spyOn(TrackingService.prototype, "getStoryProgress").mockResolvedValue({
      ...base,
      ok: true,
      data: {
        story: testing,
        progress: { ...testing.progress, basis: "研发已完成" },
        stages: [
          {
            stage: "dev",
            required: true,
            state: "done",
            tasks: [],
            evidence: [],
          },
          {
            stage: "test",
            required: true,
            state: "not_started",
            tasks: [task],
            evidence: [],
          },
        ],
        people: { raisedBy: "collector", untrusted: true },
        related: { bugs: [] },
        risks: [],
        untrusted: true,
      },
    });
    expect(await runDigestCommand(["--dry-run"], runtime)).toBe(0);
    expect(runtime.stdout.mock.lastCall?.[0]).toContain(
      '"preview":{"今日到期":1,"逾期":1,"待接收":1,"可测试":1}',
    );
    expect(fetcher).toHaveBeenCalledTimes(1);
  });
});

it("WP-38 企业微信映射支持 @，标题和映射中的凭据不发送", async () => {
  const { service, sender } = setup(
    teamConfigSchema.parse({
      wecomMap: { alice: "alice@department", carol: secret },
    }),
  );
  await service.notifyEvent({
    ...event,
    title: "Token=" + secret + " " + webhook.href,
  });
  const message = sender.mock.calls[0]?.[0];
  expect(message?.mentionedIds).toEqual(["alice@department"]);
  expect(message?.content).toContain("已脱敏");
  expect(JSON.stringify(message)).not.toContain(secret);
});

it("WP-38 静默期不取摘要，dry-run 只返回分类数量并且不占去重记录", async () => {
  const { deps, sender, setTime } = setup();
  const loadDigest = vi.fn<
    NonNullable<ConstructorParameters<typeof NotifyService>[0]["loadDigest"]>
  >(async () => ({ items: [{ ...event, category: "今日到期" }] }));
  const service = new NotifyService({ ...deps, sender, loadDigest });
  setTime(day + " 20:00:00");
  expect((await service.sendDailyDigest()).notified).toMatchObject([
    { state: "queued" },
  ]);
  expect(loadDigest).not.toHaveBeenCalled();
  expect(await service.sendDailyDigest({ dryRun: true })).toMatchObject({
    preview: { 今日到期: 1 },
    notified: [],
  });
  expect(sender).not.toHaveBeenCalled();
  expect(
    deps.store.notifications.listBySentDateRange(0, Number.MAX_SAFE_INTEGER),
  ).toEqual([]);
  setTime(day + " 09:00:00");
  expect((await service.sendDailyDigest()).notified[0]?.state).toBe("sent");
});
