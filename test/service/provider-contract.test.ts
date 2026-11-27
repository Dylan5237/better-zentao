import { existsSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, normalize, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, describe, expect, it, vi } from "vitest";
import { createZentaoReadClient } from "../../src/api/client.ts";
import { teamConfigSchema } from "../../src/core/config.ts";
import { openLocalStore } from "../../src/core/store/index.ts";
import { getStoryProgressOutputSchema } from "../../src/contracts/tools/get_story_progress.ts";
import { OperationExecutor } from "../../src/services/operation.ts";
import type { BusinessProvider } from "../../src/services/ports/business-provider.ts";
import { createInMemoryOperationStore } from "../../src/services/ports/operation-store.ts";
import {
  createMemoryBusinessProvider,
  type MemoryWriteFault,
} from "../../src/services/providers/memory-business-provider.ts";
import { createProviderWorkbench } from "../../src/services/provider-workbench.ts";
import { createZentaoBusinessProvider } from "../../src/services/providers/zentao-business-provider.ts";

/**
 * CR-009 §9.1 验收矩阵：
 * M1-BASE-01 静态与传递依赖、PC-01 读切片、PC-02 双 Provider 同口径写切片、
 * PC-03 存储端口原子回滚与并发互斥。
 */

const baseUrl = "https://zentao.fixture.test/zentao/";
const memoryBaseUrl = "https://memory.fixture.test/";
const start = Date.UTC(2026, 10, 24, 4);
const clock = () => start;

const config = teamConfigSchema.parse({
  products: { 29: { name: "示例产品", state: "runtime", projects: [8] } },
  teams: { dev: { name: "研发", lead: "dev", members: ["other"] } },
  roles: { RM: ["dev"], DM: ["design"] },
  moduleDefaults: { 29: { designLead: "design", devLead: "dev" } },
});

const users = ["dev", "other", "qa", "design"].map((account, index) => ({
  id: index + 1,
  account,
  realname: `同事${index + 1}`,
  role: account,
  dept: 0,
  deleted: false,
}));

const execution = {
  id: 7,
  project: 8,
  name: "【研发】2026年11月迭代",
  type: "sprint",
  status: "doing",
  begin: "2026-11-01",
  end: "2026-11-30",
};

const storySeed = {
  id: 31,
  product: 29,
  module: 2,
  title: "查询能力",
  status: "active",
  category: "feature" as const,
  assignedTo: "dev",
  openedBy: "design",
  spec: "<h3>背景与问题</h3><p>内部背景示例</p><h3>本次实现范围</h3><p>增加查询入口</p>",
  verify: "<p>可以搜索</p>",
  plan: [22],
  executions: [7],
  openedDate: "2026-11-24 10:00:00",
};

const secondStorySeed = {
  ...storySeed,
  id: 32,
  title: "导出能力",
  status: "active",
  assignedTo: "dev",
};

const taskSeed = {
  id: 11,
  execution: 7,
  name: "【研发】查询",
  status: "doing" as const,
  assignedTo: "dev",
  story: 31,
  deadline: "2026-11-19",
  estStarted: "2026-11-17",
};

const bugSeed = {
  id: 81,
  product: 29,
  title: "示例问题",
  status: "active",
  severity: 3,
  story: 31,
};

const planSeed = {
  id: 22,
  product: 29,
  parent: null,
  title: "【负责人】查询-2026年11月",
  begin: "2026-11-01",
  end: "2026-11-30",
};

// ---------------------------------------------------------------------------
// M1-BASE-01：零禅道依赖传递静态断言
// ---------------------------------------------------------------------------

function collectTransitiveImports(entries: readonly string[]): string[] {
  const visited = new Set<string>();
  const queue = entries.map((entry) => normalize(resolve(entry)));
  const importPattern =
    /(?:import|export)\s+(?:type\s+)?[\s\S]*?\sfrom\s+"([^"]+)"/gu;
  while (queue.length > 0) {
    const current = queue.shift();
    if (!current || visited.has(current) || !existsSync(current)) continue;
    visited.add(current);
    const text = readFileSync(current, "utf8");
    for (const match of text.matchAll(importPattern)) {
      const spec = match[1];
      if (!spec || !spec.startsWith(".")) continue;
      const candidate = normalize(resolve(dirname(current), spec));
      const resolved = existsSync(candidate)
        ? candidate
        : existsSync(candidate + ".ts")
          ? candidate + ".ts"
          : existsSync(join(candidate, "index.ts"))
            ? join(candidate, "index.ts")
            : undefined;
      if (resolved && !visited.has(resolved)) queue.push(resolved);
    }
  }
  return [...visited];
}

describe("M1-BASE-01 静态与传递依赖边界", () => {
  const root = resolve(dirname(fileURLToPath(import.meta.url)), "..", "..");

  it("ports / memory-provider / portal-policy / capability-runtime / ai 传递依赖零 src/api", () => {
    const entries = [
      join(root, "src", "services", "ports", "business-provider.ts"),
      join(root, "src", "services", "ports", "operation-store.ts"),
      join(root, "src", "services", "providers", "memory-business-provider.ts"),
      join(root, "src", "services", "portal-policy.ts"),
      join(root, "src", "services", "capability-runtime.ts"),
      join(root, "src", "services", "ai", "contracts.ts"),
      join(root, "src", "services", "ai", "intent-router.ts"),
      join(root, "src", "services", "ai", "personal-model-store.ts"),
      join(root, "src", "services", "ai", "model-gateway.ts"),
      join(root, "src", "services", "ai", "agent-runtime.ts"),
    ];
    const graph = collectTransitiveImports(entries);
    expect(graph.length).toBeGreaterThanOrEqual(entries.length);
    const apiHits = graph.filter((file) => /[\\/]src[\\/]api[\\/]/u.test(file));
    expect(apiHits).toEqual([]);

    const providerWorkbench = readFileSync(
      join(root, "src", "services", "provider-workbench.ts"),
      "utf8",
    );
    expect(providerWorkbench).not.toMatch(/from\s+"\.\.\/api\//u);
  });

  it("operation.ts 零 DatabaseSync / realpathSync / 裸 SQL 导入", () => {
    const operation = readFileSync(
      join(root, "src", "services", "operation.ts"),
      "utf8",
    );
    expect(operation).not.toMatch(/node:sqlite/u);
    expect(operation).not.toMatch(/realpathSync/u);
    expect(operation).not.toMatch(/SELECT .* FROM operations/u);
    expect(operation).not.toMatch(/sqlite-support/u);
  });
});

// ---------------------------------------------------------------------------
// 双 Provider 可写测试夹具（同构契约）
// ---------------------------------------------------------------------------

type AssignFault = "ok" | "reject" | "unknown";

interface ProviderHarness {
  readonly provider: BusinessProvider;
  upstreamWriteCount(): number;
  storyAssignedTo(storyId: number): string | null;
  mutateStory(
    storyId: number,
    patch: { readonly assignedTo?: string | null; readonly status?: string },
  ): void;
}

function buildZentaoHarness(
  options: {
    assignFaults?: readonly AssignFault[];
    version?: string;
  } = {},
): ProviderHarness & { setVersion(version: string): void } {
  let instanceVersion = options.version ?? "22.6";
  const stories = new Map<
    number,
    {
      id: number;
      type: "story";
      product: number;
      module: number;
      title: string;
      status: string;
      category: "feature";
      assignedTo: string | null;
      openedBy: string;
      spec: string;
      verify: string;
      plan: string;
      executions: (typeof execution)[];
      openedDate: string;
    }
  >([
    [
      31,
      {
        ...storySeed,
        type: "story",
        executions: [execution],
        plan: "22",
      },
    ],
    [
      32,
      {
        ...secondStorySeed,
        type: "story",
        executions: [execution],
        plan: "22",
      },
    ],
  ]);
  const assignQueue = [...(options.assignFaults ?? [])];
  let writes = 0;

  const fetcher = vi.fn<typeof globalThis.fetch>(async (input, init) => {
    const url = new URL(input instanceof Request ? input.url : String(input));
    const method = init?.method ?? "GET";
    const path = url.pathname.replace(/^\/zentao/u, "");

    if (method === "POST" && path === "/api.php/v1/tokens") {
      return Response.json({ token: "synthetic-pc02-token" }, { status: 201 });
    }
    if (method === "GET" && path === "/index.php") {
      return Response.json({ version: instanceVersion, URAndSR: true });
    }
    if (new Headers(init?.headers).get("Token") !== "synthetic-pc02-token") {
      return Response.json({ error: "unauthorized" }, { status: 401 });
    }

    const assignMatch = /^\/api\.php\/v1\/stories\/(\d+)\/assign$/u.exec(path);
    if (method === "POST" && assignMatch) {
      const id = Number(assignMatch[1]);
      const story = stories.get(id);
      if (!story) return Response.json({}, { status: 404 });
      const fault = assignQueue.shift() ?? "ok";
      if (fault === "reject") {
        return Response.json({ error: "business_rejected" }, { status: 400 });
      }
      if (fault === "unknown") {
        return Response.json({ error: "upstream_500" }, { status: 500 });
      }
      const body = JSON.parse(String(init?.body ?? "{}")) as {
        assignedTo?: string;
      };
      writes += 1;
      story.assignedTo = body.assignedTo ?? story.assignedTo;
      return Response.json({ id }, { status: 200 });
    }

    const storyMatch = /^\/api\.php\/v1\/stories\/(\d+)$/u.exec(path);
    if (method === "GET" && storyMatch) {
      const id = Number(storyMatch[1]);
      const story = stories.get(id);
      return story
        ? Response.json(story, { status: 200 })
        : Response.json({}, { status: 404 });
    }

    if (method === "GET" && path === "/api.php/v2/story/view") {
      const id = Number(url.searchParams.get("storyID"));
      const story = stories.get(id);
      if (!story) return Response.json({}, { status: 404 });
      return Response.json({
        story,
        actions: [],
        bugs: [],
        relations: [],
      });
    }

    const rows: Record<string, unknown> = {
      "/api.php/v1/user": {
        profile: users.find(({ account }) => account === "dev"),
      },
      "/api.php/v2/users": { users },
      "/api.php/v1/products": {
        products: [
          { id: 29, name: "示例产品", status: "normal", deleted: false },
        ],
      },
      "/api.php/v1/products/29": {
        id: 29,
        moduleOptionMenu: [{ id: 2, name: "/查询" }],
      },
      "/api.php/v1/products/29/stories": { stories: [...stories.values()] },
      "/api.php/v1/products/29/bugs": { bugs: [bugSeed] },
      "/api.php/v1/products/29/plans": { plans: [planSeed] },
      "/api.php/v1/executions": { executions: [execution] },
      "/api.php/v1/executions/7/tasks": { tasks: [taskSeed] },
    };
    return Response.json(rows[path] ?? {}, { status: rows[path] ? 200 : 404 });
  });

  vi.stubGlobal("fetch", fetcher);
  const client = createZentaoReadClient({
    baseUrl,
    account: "dev",
    password: "synthetic-pc02-password",
    clock,
  });
  const provider = createZentaoBusinessProvider({ client, baseUrl });
  return {
    provider,
    upstreamWriteCount: () => writes,
    storyAssignedTo: (storyId) => stories.get(storyId)?.assignedTo ?? null,
    mutateStory(storyId, patch) {
      const story = stories.get(storyId);
      if (!story) return;
      if (patch.assignedTo !== undefined) story.assignedTo = patch.assignedTo;
      if (patch.status !== undefined) story.status = patch.status;
    },
    setVersion(version: string) {
      instanceVersion = version;
    },
  };
}

function buildMemoryHarness(
  options: {
    assignFaults?: readonly AssignFault[];
  } = {},
): ProviderHarness {
  const mapped: MemoryWriteFault[] = (options.assignFaults ?? []).map(
    (kind): MemoryWriteFault =>
      kind === "ok"
        ? { kind: "ok" }
        : kind === "reject"
          ? { kind: "reject", code: "ZENTAO_BUSINESS_ERROR" }
          : { kind: "unknown" },
  );
  const provider = createMemoryBusinessProvider({
    baseUrl: memoryBaseUrl,
    users,
    currentUser: {
      id: 1,
      account: "dev",
      realname: "同事1",
      role: "dev",
      dept: 0,
    },
    products: [
      { id: 29, name: "示例产品", modules: [{ id: 2, name: "/查询" }] },
    ],
    plans: [planSeed],
    executions: [execution],
    stories: [storySeed, secondStorySeed],
    tasks: [taskSeed],
    bugs: [bugSeed],
    ...(mapped.length ? { writeFaults: { "story.assign": mapped } } : {}),
  });
  return {
    provider,
    upstreamWriteCount: () => provider.upstreamWriteCount(),
    storyAssignedTo: (storyId) =>
      provider.inspectStory(storyId)?.assignedTo ?? null,
    mutateStory: (storyId, patch) => provider.mutateStory(storyId, patch),
  };
}

const cleanups: (() => void)[] = [];
afterEach(() => {
  for (const clean of cleanups.splice(0).reverse()) clean();
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
});

interface ProviderCase {
  readonly name: string;
  readonly build: (options?: {
    assignFaults?: readonly AssignFault[];
  }) => ProviderHarness;
}

const providerCases: ProviderCase[] = [
  { name: "ZentaoBusinessProvider", build: buildZentaoHarness },
  { name: "MemoryBusinessProvider", build: buildMemoryHarness },
];

// ---------------------------------------------------------------------------
// PC-01：get_story_progress 与目录读切片
// ---------------------------------------------------------------------------

describe.each(providerCases)(
  "PC-01 get_story_progress 契约 ($name)",
  ({ build }) => {
    it("读取单条需求进展并输出契约一致的结果", async () => {
      const { provider } = build();
      const store = createInMemoryOperationStore({
        instanceHash: provider.instanceHash,
        account: "dev",
        clock,
      });
      const wb = createProviderWorkbench({
        provider,
        config,
        clock,
        store,
      });
      const output = await wb.tracking.getStoryProgress({
        storyId: 31,
        view: "full",
        format: "data",
      });
      const parsed = getStoryProgressOutputSchema.safeParse(output);
      expect(parsed.success).toBe(true);
      if (parsed.success) {
        expect(parsed.data).toMatchObject({ ok: true });
        if ("story" in parsed.data.data && parsed.data.data.story) {
          expect(parsed.data.data.story.id).toBe(31);
          expect(parsed.data.data.story.progress.value).toBeTruthy();
        }
      }
    });

    it("目录解析（人员）走 provider.listUsers", async () => {
      const { provider } = build();
      const store = createInMemoryOperationStore({
        instanceHash: provider.instanceHash,
        account: "dev",
        clock,
      });
      const wb = createProviderWorkbench({
        provider,
        config,
        clock,
        store,
      });
      const output = await wb.directory.resolveContext({ people: ["dev"] });
      expect(output).toMatchObject({
        ok: true,
        data: {
          people: [
            {
              account: "dev",
              realname: expect.any(String),
              roles: expect.arrayContaining(["RM"]),
            },
          ],
        },
        completeness: "complete",
      });
    });

    it("数据源缺失时以 NOT_FOUND 拒绝而非静默空数据", async () => {
      const { provider } = build();
      const store = createInMemoryOperationStore({
        instanceHash: provider.instanceHash,
        account: "dev",
        clock,
      });
      const wb = createProviderWorkbench({
        provider,
        config,
        clock,
        store,
      });
      await expect(
        wb.tracking.getStoryProgress({
          storyId: 9999,
          view: "full",
          format: "data",
        }),
      ).rejects.toMatchObject({ code: "NOT_FOUND" });
    });
  },
);

// ---------------------------------------------------------------------------
// PC-02：assign_story → confirm_operation → get_operation 双实现精确等价契约
// ---------------------------------------------------------------------------

describe.each(providerCases)("PC-02 写入契约 ($name)", ({ build }) => {
  function setup(assignFaults?: readonly AssignFault[]) {
    let now = start;
    const tick = () => now;
    const harness = build(assignFaults ? { assignFaults } : undefined);
    const store = createInMemoryOperationStore({
      instanceHash: harness.provider.instanceHash,
      account: "dev",
      clock: tick,
    });
    const wb = createProviderWorkbench({
      provider: harness.provider,
      config,
      clock: tick,
      store,
    });
    return {
      harness,
      wb,
      advance: (ms: number) => {
        now += ms;
      },
    };
  }

  it("单条指派：预览 → 确认精确返回 confirmed 且目标状态落库", async () => {
    const { harness, wb, advance } = setup();
    const preview = await wb.assignStory({
      storyIds: [31],
      to: "other",
      notify: false,
    });
    expect(preview).toMatchObject({
      ok: true,
      kind: "assign_story",
      opId: expect.stringMatching(/^op_/u),
      requiresPreviewAck: true,
    });
    advance(3_001);
    const receipt = await wb.confirmOperation({
      opId: preview.opId,
      previewAck: true,
    });
    expect(receipt.status).toBe("confirmed");
    expect(harness.upstreamWriteCount()).toBe(1);
    expect(harness.storyAssignedTo(31)).toBe("other");
    expect(wb.getOperation({ opId: preview.opId })).toMatchObject({
      opId: preview.opId,
      status: "confirmed",
    });
  });

  it("批量指派第 2 步显式拒绝：精确返回 partial（第 1 步 done、第 2 步 failed）", async () => {
    const { harness, wb, advance } = setup(["ok", "reject"]);
    const preview = await wb.assignStory({
      storyIds: [31, 32],
      to: "other",
      notify: false,
    });
    advance(3_001);
    const receipt = await wb.confirmOperation({
      opId: preview.opId,
      previewAck: true,
    });
    expect(receipt.status).toBe("partial");
    expect(receipt.steps.map(({ state }) => state)).toEqual(["done", "failed"]);
    expect(harness.storyAssignedTo(31)).toBe("other");
    expect(harness.storyAssignedTo(32)).toBe("dev");
  });

  it("单条显式业务拒绝：精确返回 failed 且目标未变化", async () => {
    const { harness, wb, advance } = setup(["reject"]);
    const preview = await wb.assignStory({
      storyIds: [31],
      to: "other",
      notify: false,
    });
    advance(3_001);
    const receipt = await wb.confirmOperation({
      opId: preview.opId,
      previewAck: true,
    });
    expect(receipt.status).toBe("failed");
    expect(harness.storyAssignedTo(31)).toBe("dev");
  });

  it("上游未知故障且回读未生效：精确返回 unknown（不重试重发）", async () => {
    const { harness, wb, advance } = setup(["unknown"]);
    const preview = await wb.assignStory({
      storyIds: [31],
      to: "other",
      notify: false,
    });
    advance(3_001);
    const receipt = await wb.confirmOperation({
      opId: preview.opId,
      previewAck: true,
    });
    expect(receipt.status).toBe("unknown");
    expect(harness.storyAssignedTo(31)).toBe("dev");
  });

  it("预览与确认间目标被外部修改：拒绝 PLAN_STALE 且上游写入数为 0", async () => {
    const { harness, wb, advance } = setup();
    const preview = await wb.assignStory({
      storyIds: [31],
      to: "other",
      notify: false,
    });
    harness.mutateStory(31, { assignedTo: "qa" });
    advance(3_001);
    await expect(
      wb.confirmOperation({ opId: preview.opId, previewAck: true }),
    ).rejects.toMatchObject({ code: "PLAN_STALE" });
    expect(harness.upstreamWriteCount()).toBe(0);
  });

  it("确认过快（PREVIEW_TOO_FAST）与计划过期（PLAN_EXPIRED）均零上游写入", async () => {
    const { harness, wb, advance } = setup();
    const preview = await wb.assignStory({
      storyIds: [31],
      to: "other",
      notify: false,
    });
    await expect(
      wb.confirmOperation({ opId: preview.opId, previewAck: true }),
    ).rejects.toMatchObject({ code: "PREVIEW_TOO_FAST" });
    expect(harness.upstreamWriteCount()).toBe(0);

    advance(31 * 60_000);
    await expect(
      wb.confirmOperation({ opId: preview.opId, previewAck: true }),
    ).rejects.toMatchObject({ code: "PLAN_EXPIRED" });
    expect(harness.upstreamWriteCount()).toBe(0);
  });

  it("首次异步 assertBeforeDispatch 期间过期：连续两次确认均返回 PLAN_EXPIRED 且零上游写入", async () => {
    let now = start;
    const tick = () => now;
    const harness = build();
    const store = createInMemoryOperationStore({
      instanceHash: harness.provider.instanceHash,
      account: "dev",
      clock: tick,
    });
    let expiredOnce = false;
    const wb = createProviderWorkbench({
      provider: harness.provider,
      config,
      clock: tick,
      store,
      assertBeforeDispatch: async () => {
        if (!expiredOnce) {
          expiredOnce = true;
          now += 31 * 60_000;
        }
      },
    });
    const preview = await wb.assignStory({
      storyIds: [31],
      to: "other",
      notify: false,
    });
    now += 3_001;
    await expect(
      wb.confirmOperation({ opId: preview.opId, previewAck: true }),
    ).rejects.toMatchObject({ code: "PLAN_EXPIRED" });
    await expect(
      wb.confirmOperation({ opId: preview.opId, previewAck: true }),
    ).rejects.toMatchObject({ code: "PLAN_EXPIRED" });
    expect(harness.upstreamWriteCount()).toBe(0);
  });
});

describe("PC-02 能力禁用与实例版本门禁", () => {
  it("内存底座能力被禁用时 prepare 拒绝且上游写入数为 0", async () => {
    const withDisabled = createMemoryBusinessProvider({
      baseUrl: memoryBaseUrl,
      users,
      stories: [storySeed],
      capabilities: [{ id: "story.assign", state: "disabled" }],
    });
    const blockedStore = createInMemoryOperationStore({
      instanceHash: withDisabled.instanceHash,
      account: "dev",
      clock,
    });
    const blockedWb = createProviderWorkbench({
      provider: withDisabled,
      config,
      clock,
      store: blockedStore,
    });
    await expect(
      blockedWb.assignStory({ storyIds: [31], to: "other", notify: false }),
    ).rejects.toMatchObject({ code: "CAPABILITY_DISABLED" });
    expect(withDisabled.upstreamWriteCount()).toBe(0);
  });

  it("禅道底座未验证版本在 prepare 与 confirm 阶段均阻断且零上游写入", async () => {
    let now = start;
    const tick = () => now;
    // 1. prepare 时版本即未验证：拒绝且 0 写入。
    const unverifiedHarness = buildZentaoHarness({ version: "23.0" });
    const unverifiedStore = createInMemoryOperationStore({
      instanceHash: unverifiedHarness.provider.instanceHash,
      account: "dev",
      clock: tick,
    });
    const unverifiedWb = createProviderWorkbench({
      provider: unverifiedHarness.provider,
      config,
      clock: tick,
      store: unverifiedStore,
    });
    await expect(
      unverifiedWb.assignStory({ storyIds: [31], to: "other", notify: false }),
    ).rejects.toMatchObject({ code: "CAPABILITY_UNVERIFIED" });
    expect(unverifiedHarness.upstreamWriteCount()).toBe(0);

    // 2. prepare 时为 22.6，confirm 前实例版本切换为 23.0：confirm 拒绝且 0 写入。
    const switchedHarness = buildZentaoHarness({ version: "22.6" });
    const switchedStore = createInMemoryOperationStore({
      instanceHash: switchedHarness.provider.instanceHash,
      account: "dev",
      clock: tick,
    });
    const switchedWb = createProviderWorkbench({
      provider: switchedHarness.provider,
      config,
      clock: tick,
      store: switchedStore,
    });
    const preview = await switchedWb.assignStory({
      storyIds: [31],
      to: "other",
      notify: false,
    });
    switchedHarness.setVersion("23.0");
    now += 3_001;
    await expect(
      switchedWb.confirmOperation({ opId: preview.opId, previewAck: true }),
    ).rejects.toMatchObject({ code: "CAPABILITY_UNVERIFIED" });
    expect(switchedHarness.upstreamWriteCount()).toBe(0);
    expect(switchedHarness.storyAssignedTo(31)).toBe("dev");
  });
});

// ---------------------------------------------------------------------------
// PC-03：OperationStateStore 端口（原子回滚、并发互斥、LocalStore 双连接）
// ---------------------------------------------------------------------------

describe("PC-03 OperationStateStore 端口", () => {
  function ticking() {
    let now = start;
    return { clock: () => now, advance: () => (now += 3001) };
  }

  it("内存实现满足 executor 契约：prepare → confirm → 重放幂等与 listRecent", async () => {
    const harness = buildMemoryHarness();
    const { clock: tick, advance } = ticking();
    const store = createInMemoryOperationStore({
      instanceHash: harness.provider.instanceHash,
      account: "dev",
      clock: tick,
    });
    const executor = new OperationExecutor({
      store,
      baseUrl: memoryBaseUrl,
      config,
      gateway: harness.provider.createOperationGateway({
        account: "dev",
        storyRoles: store.storyRoles,
      }),
      clock: tick,
      checkCapability: (id, options) =>
        harness.provider.checkCapability(id, options),
      formatObjectUrl: (type, id) => harness.provider.formatObjectUrl(type, id),
    });
    const preview = await executor.prepare({
      kind: "assign_story",
      summary: "指派需求",
      steps: [
        {
          action: "story.assign",
          type: "story",
          id: 31,
          product: 29,
          fields: {
            assignedTo: { value: "other", origin: "user" },
            notify: { value: false, origin: "default" },
          },
          cacheKeys: [],
        },
      ],
    });
    expect(executor.getOperation({ recent: 5 })).toHaveLength(1);
    advance();
    const receipt = await executor.confirm({
      opId: preview.opId,
      previewAck: true,
    });
    expect(receipt.status).toBe("confirmed");
    const replay = await executor.confirm({
      opId: preview.opId,
      previewAck: true,
    });
    expect(replay.opId).toBe(receipt.opId);
    expect(replay.status).toBe("confirmed");
    expect(harness.upstreamWriteCount()).toBe(1);
  });

  it("内存实现 transaction 异常时原子回滚（operations / operationSteps / listRecent 零残留）", () => {
    const store = createInMemoryOperationStore({
      instanceHash: "hash-mem",
      account: "dev",
      clock,
    });
    const opId = "op_00000000000000000000000088";
    expect(() =>
      store.transaction(() => {
        store.operations.insert({
          opId,
          kind: "assign_story",
          actor: "dev",
          level: "W2",
          inputHash: "hash",
          planJson: "{}",
          status: "not_executed",
          createdAt: start,
          expiresAt: start + 1_800_000,
          executedAt: null,
        });
        store.operationSteps.insert({
          opId,
          seq: 1,
          action: "story.assign",
          targetType: "story",
          targetId: "31",
          requestDigest: null,
          zentaoId: null,
          readbackJson: null,
          state: "pending",
          error: null,
        });
        throw new Error("boom mid transaction");
      }),
    ).toThrow("boom mid transaction");

    expect(() => store.operations.get(opId)).toThrow();
    expect(() => store.operationSteps.list(opId)).toThrow();
    expect(store.operations.listRecent("dev", "hash-mem", 10)).toEqual([]);
  });

  it("内存实现同 opId 并发确认互斥（真实在途冲突返回 conflict: true）", async () => {
    const store = createInMemoryOperationStore({
      instanceHash: "hash-mem",
      account: "dev",
      clock,
    });
    const entered = Promise.withResolvers<void>();
    const release = Promise.withResolvers<void>();
    const opId = "op_00000000000000000000000077";

    const first = store.withExclusiveLock(opId, async () => {
      entered.resolve();
      await release.promise;
      return "done";
    });
    await entered.promise;

    await expect(
      store.withExclusiveLock(opId, async () => "second"),
    ).rejects.toMatchObject({
      code: "INVALID_INPUT",
      details: { conflict: true },
    });

    release.resolve();
    await expect(first).resolves.toBe("done");
  });

  it("SQLite LocalStore 满足 OperationStateStore 双连接并发互斥与 ProviderWorkbench 缓存读写契约", async () => {
    const dir = mkdtempSync(join(tmpdir(), "bzt-pc03-"));
    cleanups.push(() => rmSync(dir, { recursive: true, force: true }));
    const dbPath = join(dir, "state.db");
    const first = openLocalStore({
      dbPath,
      baseUrl,
      account: "dev",
      clock,
    });
    const second = openLocalStore({
      dbPath,
      baseUrl,
      account: "dev",
      clock,
    });
    cleanups.push(() => first.close());
    cleanups.push(() => second.close());
    expect(
      first.operations.listRecent("dev", first.location.instanceHash, 10),
    ).toEqual([]);

    // 双独立 SQLite 连接同库互斥（通过 .operation-lock 验证真实锁冲突）。
    const entered = Promise.withResolvers<void>();
    const release = Promise.withResolvers<void>();
    const opId = "op_00000000000000000000000066";
    const holding = first.withExclusiveLock(opId, async () => {
      entered.resolve();
      await release.promise;
      return "first-ok";
    });
    await entered.promise;
    await expect(
      second.withExclusiveLock(opId, async () => "second-ok"),
    ).rejects.toMatchObject({
      code: "INVALID_INPUT",
      details: { conflict: true },
    });
    release.resolve();
    await expect(holding).resolves.toBe("first-ok");

    // ProviderWorkbench 接入真实 SQLite LocalStore 时 cache 方法保留 this 接收者且可正常落库读取。
    const harness = buildZentaoHarness();
    const wb = createProviderWorkbench({
      provider: harness.provider,
      config,
      clock,
      store: first,
    });
    const progress = await wb.tracking.getStoryProgress({
      storyId: 31,
      view: "full",
      format: "data",
    });
    expect(progress).toMatchObject({ ok: true });
    first.cache.set("pc03-probe-key", "pc03-val", 60_000);
    expect(first.cache.get("pc03-probe-key")).toBe("pc03-val");
  });
});
