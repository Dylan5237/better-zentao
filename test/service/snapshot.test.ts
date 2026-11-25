import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { afterEach, describe, expect, it, vi } from "vitest";
import { runSnapshotSchedulerCli } from "../../src/adapters/scheduler/snapshot.ts";
import { teamConfigSchema } from "../../src/core/config.ts";
import {
  openLocalStore,
  resolveStoreLocation,
} from "../../src/core/store/index.ts";
import { SnapshotsRepository } from "../../src/core/store/p2-repositories.ts";
import { compareCommitmentSnapshot } from "../../src/domain/plan-summary.ts";
import {
  SnapshotService,
  runSnapshotCommand,
} from "../../src/services/snapshot.ts";
import { mockReadClient } from "../contract/read-fixture.ts";
import { assertNoSensitiveData } from "../helpers/assert-no-sensitive-data.ts";

const baseUrl = "https://zentao.fixture.test/zentao/";
// 上海已进入 11 月，UTC 仍是 10 月。
const clock = () => Date.UTC(2026, 9, 31, 16);
const config = teamConfigSchema.parse({
  products: {
    4: { name: "示例产品", state: "runtime", projects: [8] },
    5: { name: "停用产品", state: "runtime", enabled: false },
    29: { name: "探针产品", state: "other", probeOnly: true },
  },
  snapshot: { collector: "acct_fixture" },
});
const plan = {
  id: 22,
  parent: 11,
  product: 4,
  title: "内部计划",
  status: "wait",
  begin: "2026-11-01",
  end: "2026-11-30",
  deleted: false,
};
const execution = {
  id: 7,
  project: 8,
  name: "【研发】2026年11月迭代",
  type: "sprint",
  status: "doing",
  begin: plan.begin,
  end: plan.end,
};
const story = {
  id: 31,
  type: "story",
  category: "feature",
  product: 4,
  title: "内部需求标题",
  spec: "<p>内部正文 https://fixture.test/?token=private-value</p>",
  status: "active",
  password: "fixture-secret",
  executions: [execution],
};
const stories = [
  story,
  { ...story, id: 32, executions: [] },
  { ...story, id: 33 },
  { ...story, id: 34, category: "design" },
  { ...story, id: 35, executions: [] },
];
const task = {
  id: 51,
  name: "【研发】内部任务",
  type: "devel",
  status: "doing",
  execution: 7,
  story: 31,
  parent: 0,
  isParent: false,
  mode: "",
  estStarted: "0000-00-00",
  deadline: "0000-00-00",
  estimate: 0,
  consumed: 0,
  left: 0,
};

function fixtureClient({
  failPlan = false,
  truncateTasks = false,
  failDetail = false,
  sharedRequirements = false,
} = {}) {
  return mockReadClient((url) => {
    const path = url.pathname.replace("/zentao/api.php/", "");
    switch (path) {
      case "v1/products/4/plans":
        return Response.json({
          plans: [
            {
              ...plan,
              id: 11,
              parent: -1,
              children: [plan, { ...plan, id: 23 }],
            },
          ],
        });
      case "v2/productplan/view": {
        const id = Number(url.searchParams.get("planID"));
        return id === 23 && failPlan
          ? Response.json({}, { status: 403 })
          : Response.json({
              plan: { ...plan, id },
              planStories:
                id === 22 ? [stories[0], stories[1], stories[3]] : [stories[0]],
              modulePairs: [],
            });
      }
      case "v1/executions":
        return Response.json({ executions: [execution] });
      case "v1/products/4/stories":
        return Response.json({ stories });
      case "v1/products/4/bugs":
        return Response.json({ bugs: [] });
      case "v1/executions/7/tasks":
        return Response.json(
          truncateTasks
            ? { tasks: [task], total: 1000 }
            : {
                tasks: sharedRequirements
                  ? [
                      { ...task, status: "done" },
                      {
                        ...task,
                        id: 52,
                        name: "【测试】快照",
                        type: "test",
                        status: "done",
                      },
                    ]
                  : [task],
              },
        );
      default: {
        const detail = stories.find(({ id }) => path === `v1/stories/${id}`);
        if (detail && !(detail.id === 31 && failDetail))
          return Response.json(
            sharedRequirements && detail.id === 31
              ? {
                  ...detail,
                  actions: [
                    {
                      id: 1,
                      actor: "acct_owner",
                      action: "commented",
                      date: "2026-10-30 09:00:00",
                      comment:
                        '[bzt:meta v1 {"stageRequirements":{"acceptance":{"required":false}}}]',
                    },
                  ],
                }
              : detail,
          );
        return Response.json({}, { status: 404 });
      }
    }
  });
}

const directories: string[] = [];
const stores: ReturnType<typeof openLocalStore>[] = [];

async function temporaryDirectory() {
  const directory = await mkdtemp(join(tmpdir(), "bzt-snapshot-"));
  directories.push(directory);
  return directory;
}

function setup({
  team = config,
  account = "acct_fixture",
  dbPath = ":memory:",
  fixture = {},
}: {
  team?: typeof config;
  account?: string;
  dbPath?: string;
  fixture?: Parameters<typeof fixtureClient>[0];
} = {}) {
  const store = openLocalStore({ baseUrl, account, dbPath, clock });
  stores.push(store);
  const { client, fetch } = fixtureClient(fixture);
  return {
    store,
    fetch,
    service: new SnapshotService({ config: team, clock, store, client }),
  };
}

afterEach(async () => {
  for (const store of stores.splice(0)) store.close();
  await Promise.all(
    directories
      .splice(0)
      .map((dir) => rm(dir, { recursive: true, force: true })),
  );
});

describe("WP-36 月度承诺快照", () => {
  it("AC-65 按业务时区采集当月 L3 和研发迭代的去重并集并记录业务进展", async () => {
    const { service, store } = setup();
    const result = await service.capture({ month: "本月" });
    expect(result).toMatchObject({
      completeness: "complete",
      gaps: [],
      snapshots: [{ month: "2026-11", productId: 4 }],
    });
    expect(
      store.snapshots.listSnapshotsByMonthAndProduct("2026-11", 4),
    ).toMatchObject([
      { source: "local", takenBy: "acct_fixture", takenAt: clock() },
    ]);
    const snapId = result.snapshots[0]?.snapId ?? "";
    expect(store.snapshots.getSnapshot(snapId)?.items).toMatchObject([
      { storyId: 31, planId: 22, executionId: 7, progressAtSnap: "研发中" },
      { storyId: 32, planId: 22, executionId: null, progressAtSnap: "待接收" },
      { storyId: 33, planId: null, executionId: 7, progressAtSnap: "待接收" },
    ]);
  });

  it.each(["上月", "下月", "2026-10"])("规范化采集月份 %s", async (month) => {
    const { service } = setup();
    expect(await service.capture({ month, product: 4 })).toMatchObject({
      snapshots: [{ month: month === "下月" ? "2026-12" : "2026-10" }],
    });
  });

  it.each(["2026-13", "2026-1", "0000-01", "2026-11-01"])(
    "访问禅道前拒绝非法月份 %s",
    async (month) => {
      const { service, fetch } = setup();
      await expect(service.capture({ month })).rejects.toMatchObject({
        code: "INVALID_INPUT",
      });
      expect(fetch).not.toHaveBeenCalled();
    },
  );

  it.each([
    { collector: undefined, account: "acct_fixture", code: "CONFIG_MISSING" },
    { collector: "acct_fixture", account: "other", code: "PERMISSION_DENIED" },
  ])(
    "CFG-11 在联网及写入前拒绝未获授权的采集",
    async ({ collector, account, code }) => {
      const { service, fetch, store } = setup({
        team: { ...config, snapshot: { ...config.snapshot, collector } },
        account,
      });
      await expect(service.capture({ month: "本月" })).rejects.toMatchObject({
        code,
        message: expect.stringContaining("唯一"),
      });
      expect(fetch).not.toHaveBeenCalled();
      expect(
        store.snapshots.listSnapshotsByMonthAndProduct("2026-11", 4),
      ).toEqual([]);
    },
  );

  it("保留可读快照条目并报告计划读取失败与执行任务分页截断", async () => {
    const { service, store } = setup({
      fixture: { failPlan: true, truncateTasks: true },
    });
    const result = await service.capture({ month: "2026-11" });
    expect(result).toMatchObject({
      completeness: "partial",
      gaps: expect.arrayContaining([
        { source: "plan:23", code: "PERMISSION_DENIED" },
        { source: "execution:7:tasks", code: "TRUNCATED" },
      ]),
    });
    expect(
      store.snapshots.listSnapshotsByMonthAndProduct("2026-11", 4),
    ).toHaveLength(1);
  });

  it("缺少需求详情时保留有计划证据的条目且不推断进展", async () => {
    const { service, store } = setup({ fixture: { failDetail: true } });
    const result = await service.capture({ product: 4 });
    expect(result).toMatchObject({
      completeness: "partial",
      gaps: [{ source: "story:31", code: "NOT_FOUND" }],
    });
    expect(
      store.snapshots.getSnapshot(result.snapshots[0]?.snapId ?? "")?.items[0],
    ).toMatchObject({ storyId: 31, planId: 22, progressAtSnap: "无法判断" });
  });

  it("S01 导出只含版本、快照元数据、编号和业务进展", async () => {
    const directory = await temporaryDirectory();
    const { service } = setup({
      team: {
        ...config,
        snapshot: { ...config.snapshot, exportDir: directory },
      },
    });
    const capture = await service.capture({ month: "2026-11" });
    const snapId = capture.snapshots[0]?.snapId ?? "";
    const exported = await service.export({
      snapId,
      out: join(directory, "explicit.json"),
    });
    const contents: unknown = JSON.parse(
      await readFile(join(directory, `${snapId}.json`), "utf8"),
    );
    expect(contents).toEqual(exported);
    expect(Object.keys(exported).sort()).toEqual([
      "items",
      "month",
      "productId",
      "schemaVersion",
      "snapId",
      "takenAt",
      "takenBy",
    ]);
    expect(exported.schemaVersion).toBe(1);
    for (const item of exported.items)
      expect(Object.keys(item).sort()).toEqual([
        "executionId",
        "planId",
        "progressAtSnap",
        "storyId",
      ]);
    expect(() => assertNoSensitiveData(contents)).not.toThrow();
    expect(JSON.stringify(contents)).not.toMatch(
      /内部|private-value|fixture-secret/u,
    );
  });

  it("AC-65 跨账号离线导入，按月可从只读 SQLite 查询，重复导入不覆盖", async () => {
    const directory = await temporaryDirectory();
    const file = join(directory, "export.json");
    const { service } = setup();
    const capture = await service.capture({ month: "2026-11", out: file });
    const snapId = capture.snapshots[0]?.snapId ?? "";
    const stateDir = join(directory, "other-machine");
    const env = {
      ZENTAO_BASE_URL: baseUrl,
      ZENTAO_ACCOUNT: "reader",
      BZT_HOME: stateDir,
    };
    const options = {
      env,
      clock,
      command: { action: "import", input: file },
    } as const;
    const offline = vi.fn(() => {
      throw new Error("导入不得联网");
    });
    vi.stubGlobal("fetch", offline);
    await expect(runSnapshotCommand(options)).resolves.toMatchObject({
      snapId,
      source: "imported",
    });
    await expect(runSnapshotCommand(options)).rejects.toMatchObject({
      code: "INVALID_INPUT",
      message: expect.stringContaining("已存在"),
    });
    expect(
      await runSnapshotSchedulerCli(["export", "--snap", snapId], {
        env,
        clock,
      }),
    ).toMatchObject({ exitCode: 0, output: { snapId, schemaVersion: 1 } });
    expect(offline).not.toHaveBeenCalled();

    const { instanceHash, accountKey } = resolveStoreLocation({
      baseUrl,
      account: "reader",
    });
    const dbPath = join(stateDir, instanceHash, accountKey, "state.db");
    const db = new DatabaseSync(dbPath, { readOnly: true });
    try {
      const snapshots = new SnapshotsRepository(db);
      expect(
        snapshots.listSnapshotsByMonthAndProduct("2026-11", 4),
      ).toMatchObject([{ snapId, source: "imported" }]);
      const ids = snapshots
        .getSnapshot(snapId)
        ?.items.map(({ storyId }) => storyId);
      expect(ids).toEqual([31, 32, 33]);
      expect(
        compareCommitmentSnapshot(
          ids,
          [
            { id: 31, progress: "已完成", inCurrentMonth: true },
            { id: 33, progress: "待接收", inCurrentMonth: true },
            { id: 35, progress: "待接收", inCurrentMonth: true },
          ],
          new Map([[32, "调整排期"]]),
        ),
      ).toMatchObject({
        fulfilled: [31],
        carriedOver: [{ id: 32, reason: "调整排期" }],
        inserted: [35],
      });
    } finally {
      db.close();
    }
  });

  it.each([
    ["超大", Buffer.alloc(8 * 1024 * 1024 + 1)],
    ["非 UTF-8", Buffer.from([0xc3, 0x28])],
    ["畸形 JSON", "{"],
    [
      "额外字段",
      JSON.stringify({
        schemaVersion: 1,
        snapId: "s-1",
        month: "2026-11",
        productId: 4,
        takenAt: clock(),
        takenBy: "acct_fixture",
        items: [],
        title: "内部",
      }),
    ],
    [
      "重复需求",
      JSON.stringify({
        schemaVersion: 1,
        snapId: "s-1",
        month: "2026-11",
        productId: 4,
        takenAt: clock(),
        takenBy: "acct_fixture",
        items: [1, 1].map((storyId) => ({
          storyId,
          planId: 22,
          executionId: null,
          progressAtSnap: "待接收",
        })),
      }),
    ],
  ])("拒绝%s导入文件", async (_name, bytes) => {
    const file = join(await temporaryDirectory(), "invalid.json");
    await writeFile(file, bytes);
    const { service, store } = setup({ account: "reader" });
    await expect(service.import({ input: file })).rejects.toMatchObject({
      code: "INVALID_INPUT",
    });
    expect(
      store.snapshots.listSnapshotsByMonthAndProduct("2026-11", 4),
    ).toEqual([]);
  });

  it.each(
    [
      ["collect"],
      ["capture", "--in", "private-value"],
      ["capture", "--month", "2026-13"],
      ["capture", "--product", "4.5"],
      ["capture", "--product", "4", "--product", "5"],
      ["export"],
      ["export", "--snap", "s-1", "--month", "2026-11"],
      ["import"],
      ["import", "--in", "--config"],
      ["import", "--in", "input.json", "--config", " "],
      ["capture", "--unknown", "private-value"],
    ].map((args) => ({ args })),
  )("CLI 拒绝非法参数 $args", async ({ args }) => {
    const result = await runSnapshotSchedulerCli(args, { env: {}, clock });
    expect(result.exitCode).toBe(2);
    expect(JSON.stringify(result)).not.toContain("private-value");
  });
});

it("WP-38 无子命令与 capture 使用相同的采集入口", async () => {
  const runtime = { env: {}, clock };
  const result = await runSnapshotSchedulerCli([], runtime);
  expect(result).toEqual(await runSnapshotSchedulerCli(["capture"], runtime));
  expect(result.exitCode).toBe(1);
});

it("WP-38 快照用共享评论覆盖本地阶段要求，反映可关闭进展", async () => {
  const { store, service } = setup({ fixture: { sharedRequirements: true } });
  store.stageRequirements.upsert({
    storyId: 31,
    stage: "acceptance",
    required: true,
    waiverReason: null,
    decidedBy: "acct_owner",
    decidedAt: clock(),
  });
  const result = await service.capture({ month: "本月" });
  const snapId = result.snapshots[0]?.snapId ?? "";
  expect(store.snapshots.getSnapshot(snapId)?.items).toContainEqual(
    expect.objectContaining({ storyId: 31, progressAtSnap: "可关闭" }),
  );
});
