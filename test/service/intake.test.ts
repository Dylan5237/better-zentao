import { mkdtemp, rm, rmdir, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { crc32, deflateRawSync } from "node:zlib";
import { afterEach, expect, it, vi } from "vitest";
import { teamConfigSchema } from "../../src/core/config.ts";
import { BztError } from "../../src/core/errors.ts";
import { openLocalStore } from "../../src/core/store/index.ts";
import { DirectoryService } from "../../src/services/directory.ts";
import { IntakeService } from "../../src/services/intake.ts";
import {
  OperationExecutor,
  type OperationGateway,
} from "../../src/services/operation.ts";
import { mockReadClient } from "../contract/read-fixture.ts";
import { assertNoSensitiveData } from "../helpers/assert-no-sensitive-data.ts";

const alice = {
  id: 1,
  account: "alice",
  realname: "设计甲",
  role: "po",
  dept: 0,
  deleted: false,
};
const bob = {
  id: 2,
  account: "bob",
  realname: "研发甲",
  role: "dev",
  dept: 0,
  deleted: false,
};
const baseUrl = "https://zentao.fixture.test/zentao/";
const input = {
  product: "产品甲",
  module: "权限",
  title: "角色列表支持按部门筛选",
  spec: { background: "角色多时难找", scope: "新增列表筛选" },
  verify: "仅显示该部门角色",
};
const cleanup: (() => void | Promise<void>)[] = [];
afterEach(async () => {
  for (const close of cleanup.splice(0)) await close();
});

function setup(
  options: {
    noPlan?: boolean;
    ambiguous?: boolean;
    account?: string;
    required?: string;
    disableActivate?: boolean;
  } = {},
) {
  let now = Date.UTC(2026, 10, 24);
  const clock = () => now;
  const account = options.account ?? "alice";
  const config = teamConfigSchema.parse({
    products: {
      29: { name: "产品甲", state: "runtime" },
      30: { name: "产品乙", state: "runtime" },
    },
    roles: { DM: ["alice"], RM: ["bob"] },
    moduleDefaults: {
      29: { designLead: "alice", devLead: "bob" },
      30: { designLead: "alice", devLead: "bob" },
    },
    write: {
      disableCapabilities: options.disableActivate ? ["story.activate"] : [],
    },
  });
  const store = openLocalStore({ baseUrl, account, dbPath: ":memory:", clock });
  cleanup.push(() => store.close());
  const planFor = (product: number) => ({
    id: product + 100,
    product,
    title: "【设计甲】权限-2026年11月",
    begin: "2026-11-01",
    end: "2026-11-30",
    parent: 1,
    status: "wait",
    deleted: false,
  });
  const { client, fetch } = mockReadClient((url) => {
    const path = url.pathname;
    if (path.endsWith("/v1/user"))
      return Response.json({ profile: account === "alice" ? alice : bob });
    if (path.endsWith("/v2/users")) {
      const users = options.ambiguous
        ? [alice, bob, { ...bob, id: 3, account: "bob2" }]
        : [alice, bob];
      return Response.json({ users, total: users.length });
    }
    if (path.endsWith("/v1/products"))
      return Response.json({
        products: [
          { id: 29, name: "产品甲", status: "normal", deleted: false },
          { id: 30, name: "产品乙", status: "normal", deleted: false },
        ],
        total: 2,
      });
    if (url.searchParams.get("fields") === "moduleOptionMenu")
      return Response.json({
        id: Number(path.split("/").at(-1)),
        moduleOptionMenu: [{ id: 3, name: "权限" }],
      });
    if (path.endsWith("/plans")) {
      const product = Number(path.split("/").at(-2));
      const plans = options.noPlan ? [] : [planFor(product)];
      return Response.json({ plans, total: plans.length });
    }
    if (path.endsWith("/v2/productplan/view"))
      return Response.json({
        plan: planFor(Number(url.searchParams.get("planID")) - 100),
        planStories: [],
        modulePairs: {},
      });
    if (path.endsWith("/v2/story/create"))
      return Response.json({
        forceReview: false,
        needReview: false,
        needNotReview: true,
        fields: {
          source: { required: false, options: { user: "用户" } },
          category: {
            required: true,
            options: { feature: "研发", design: "设计" },
          },
          ...(options.required
            ? { [options.required]: { required: true } }
            : {}),
        },
      });
    throw new Error(`意外的离线路由 ${path}`);
  });
  const directory = new DirectoryService({ client, config, clock });
  const written = new Map<number, Record<string, unknown>>();
  const write = vi
    .fn<OperationGateway["write"]>()
    .mockImplementation(async ({ seq, id, step }) => {
      const storyId = id ?? 1000 + seq;
      const values = Object.fromEntries(
        Object.entries(step.fields).map(([key, field]) => [key, field.value]),
      );
      written.set(storyId, { ...written.get(storyId), ...values });
      return { id: storyId };
    });
  const executor = new OperationExecutor({
    baseUrl,
    config,
    store,
    clock,
    instanceVersion: "22.6",
    gateway: {
      write,
      readTarget: async (target) => target,
      readback: async ({ zentaoId, step }) => ({
        verified:
          zentaoId !== undefined &&
          Object.entries(step.fields).every(([key, { value }]) =>
            Object.is(written.get(zentaoId)?.[key], value),
          ),
      }),
      reverseLookup: async () => ({ complete: true, matches: [] }),
    },
  });
  const makeService = () =>
    new IntakeService({
      client,
      directory,
      executor,
      store,
      clock,
      config,
      instanceVersion: "22.6",
    });
  const confirm = (opId: string) => {
    now += 3000;
    return executor.confirm({ opId, previewAck: true });
  };
  return {
    service: makeService(),
    makeService,
    executor,
    store,
    fetch,
    write,
    confirm,
  };
}

it("AC-01/04/05 精确列出规范缺项，校验严格输入及服务端必填", async () => {
  const { service, fetch } = setup({ required: "keywords" });
  for (const [payload, missing] of [
    [{ ...input, verify: undefined }, "verify"],
    [{ ...input, spec: { background: "背景" } }, "spec.scope"],
    [
      { ...input, spec: { ...input.spec, designRef: { doc: "设计稿" } } },
      "spec.designRef.section",
    ],
  ])
    await expect(service.createStory(payload)).rejects.toMatchObject({
      code: "MISSING_REQUIRED",
      details: { missing: [missing] },
    });
  await expect(
    service.createStory({ ...input, level: "W1" }),
  ).rejects.toMatchObject({ code: "INVALID_INPUT" });
  expect(fetch).not.toHaveBeenCalled();
  await expect(service.createStory(input)).rejects.toMatchObject({
    code: "MISSING_REQUIRED",
    details: { missing: ["keywords"] },
  });
});

it("AC-01/10 自领草稿为 W1，计划安全降级，生成业务回执并回读落库", async () => {
  const { service, makeService, store, executor, write } = setup();
  const prepared = await service.createStory({
    ...input,
    feedbackBy: "外部反馈者",
    intake: { rawText: "希望按部门查找", channel: "wecom" },
  });
  expect(prepared).toMatchObject({
    level: "W1",
    requiresPreviewAck: false,
    preview: {
      affects: ["alice"],
      steps: [
        {
          action: "story.create.feedbackBy",
          fields: {
            status: { value: "draft", origin: "default" },
            category: { value: "feature", origin: "derived" },
            assignedTo: { value: "alice", origin: "default" },
          },
        },
      ],
    },
  });
  expect(prepared.preview.steps[0]?.fields).not.toHaveProperty("plan");
  expect(prepared.warnings).toEqual(
    expect.arrayContaining([
      {
        code: "CAPABILITY_UNVERIFIED",
        message: expect.stringMatching(/129.*手工/u),
      },
    ]),
  );
  const [receipt] = prepared.intakes;
  expect(receipt?.message).toMatch(/查.*进度/u);
  expect(receipt?.message).not.toMatch(/禅道|研发需求/u);
  expect(store.intake.get(receipt?.intakeId ?? "")).toMatchObject({
    rawText: "希望按部门查找",
    feedbackByText: "外部反馈者",
    channel: "wecom",
  });
  expect(write).not.toHaveBeenCalled();
  const result = await executor.confirm({ opId: prepared.opId });
  expect(result.status).toBe("confirmed");
  makeService().recordConfirmed(prepared.opId, result);
  expect(store.sourceLinks.listTo("story", "1001")).toContainEqual(
    expect.objectContaining({
      fromType: "intake",
      fromId: receipt?.intakeId,
      relation: "source",
    }),
  );
  assertNoSensitiveData([prepared, result]);
});

it("AC-02 返回原样同名候选", async () => {
  const { service } = setup({ ambiguous: true });
  await expect(
    service.createStory({ ...input, maintainer: "研发甲" }),
  ).rejects.toMatchObject({
    code: "AMBIGUOUS_ENTITY",
    details: { candidates: [{ account: "bob" }, { account: "bob2" }] },
  });
});

it("AC-03 缺少 L3 时提示待挂计划及 R06", async () => {
  const { service } = setup({ noPlan: true });
  const prepared = await service.createStory(input);
  expect(prepared.warnings).toContainEqual({
    code: "R06",
    message: expect.stringContaining("待挂计划"),
  });
  expect(prepared.preview.summary).toContain("待挂计划");
});

it("AC-06/07 本地配对与回关联可跨服务重启记录", async () => {
  const { service, makeService, store, confirm } = setup();
  const prepared = await service.createStory({
    ...input,
    category: "feature",
    requirementId: 41,
    pair: { product: "产品乙", module: "权限" },
  });
  expect(prepared).toMatchObject({
    level: "W2",
    preview: {
      steps: [{ action: "story.create" }, { action: "story.create" }],
    },
  });
  const result = await confirm(prepared.opId);
  makeService().recordConfirmed(prepared.opId, result);
  makeService().recordConfirmed(prepared.opId, result);
  for (const [id, pair] of [
    ["1001", "1002"],
    ["1002", "1001"],
  ]) {
    expect(store.sourceLinks.listTo("story", id ?? "")).toContainEqual(
      expect.objectContaining({
        fromType: "requirement",
        fromId: "41",
        relation: "links",
        origin: "local",
      }),
    );
    expect(store.sourceLinks.listFrom("story", id ?? "")).toContainEqual(
      expect.objectContaining({
        toType: "story",
        toId: pair,
        relation: "pairs",
        origin: "local",
      }),
    );
  }
});

it("AC-08 跨模块由发起人维护，接收人为目标模块研发主管", async () => {
  const { service, store, confirm } = setup();
  const prepared = await service.createStory({
    ...input,
    crossModule: true,
    derivesFrom: 77,
  });
  expect(prepared.preview.steps[0]?.fields.spec?.value).toContain(
    "maintainer=alice;receiver=bob",
  );
  const result = await confirm(prepared.opId);
  service.recordConfirmed(prepared.opId, result);
  expect(store.storyRoles.get(1001)).toMatchObject({
    maintainer: "alice",
    receiver: "bob",
  });
  expect(store.sourceLinks.listFrom("story", "1001")).toContainEqual(
    expect.objectContaining({
      toId: "77",
      relation: "derives",
      origin: "local",
    }),
  );
});

it("AC-09 补录只记录调用人提供的实际开工时间，草稿交设计维护", async () => {
  const { service, store } = setup({ account: "bob" });
  const prepared = await service.createStory({
    ...input,
    backfilled: { actualStartedAt: "2026-11-21" },
  });
  expect(prepared.preview.steps[0]?.fields.assignedTo?.value).toBe("alice");
  expect(prepared.preview.steps[0]?.fields).not.toHaveProperty(
    "actualStartedAt",
  );
  expect(store.intake.list()).toMatchObject([
    { backfilled: true, actualStartedAt: Date.UTC(2026, 10, 20, 16) },
  ]);
});

it.each([true, false])(
  "AC-48 检查移交能力再构造步骤（禁用激活=%s）",
  async (disableActivate) => {
    const { service, confirm } = setup({ disableActivate });
    const prepared = await service.createStory({
      ...input,
      states: { activate: true },
    });
    expect(prepared.level).toBe("W2");
    expect(prepared.preview.steps.map(({ action }) => action)).toEqual(
      disableActivate
        ? ["story.create", "story.assign", "story.comment"]
        : ["story.create", "story.activate", "story.assign", "story.comment"],
    );
    if (disableActivate)
      expect(
        prepared.warnings.some(({ message }) => message.includes("手动激活")),
      ).toBe(true);
    await expect(confirm(prepared.opId)).resolves.toMatchObject({
      status: "confirmed",
    });
  },
);

it("AC-11 同一批跳过坏行、确认有效行；dryRun 不落库", async () => {
  const { service, store, executor, confirm, write } = setup();
  const rows = Array.from({ length: 12 }, (_, i) => ({
    ...input,
    title: `筛选 ${i}`,
    module: i % 7 === 0 ? undefined : input.module,
  }));
  const source = { kind: "table", rows };
  const preview = await service.importStories({ source, dryRun: true });
  expect(preview).toMatchObject({
    kind: "import_stories",
    level: "W2",
    requiresPreviewAck: true,
    dryRun: true,
  });
  expect(preview.preview.steps).toHaveLength(10);
  expect(
    preview.warnings
      .filter(({ code }) => code === "skipped")
      .map(({ message }) => message),
  ).toEqual([
    expect.stringContaining("第 1 行"),
    expect.stringContaining("第 8 行"),
  ]);
  expect(store.intake.list()).toEqual([]);
  expect(executor.getOperation({ recent: 10 })).toEqual([]);
  const prepared = await service.importStories({ source });
  expect(write).not.toHaveBeenCalled();
  const result = await confirm(prepared.opId);
  expect(result.status).toBe("confirmed");
  service.recordConfirmed(prepared.opId, result);
  expect(result.created).toHaveLength(10);
  expect(store.intake.list()).toHaveLength(10);
  assertNoSensitiveData([prepared, preview, result]);
  await expect(
    service.importStories({
      source: { ...source, rows: Array(51).fill(input) },
    }),
  ).rejects.toMatchObject({ code: "INVALID_INPUT" });
});

it("本地关联仅登记回读完成的步骤，保留失败和未知创建的原始受理", async () => {
  const { service, store, confirm, executor, write } = setup();
  const firstWrite = write.getMockImplementation();
  if (!firstWrite) throw new Error("测试缺少写入实现");
  write
    .mockImplementationOnce(firstWrite)
    .mockRejectedValueOnce(new BztError("ZENTAO_BUSINESS_ERROR", "离线拒绝"))
    .mockResolvedValueOnce({ id: 1003 });
  const prepared = await service.importStories({
    source: {
      kind: "table",
      rows: [
        { ...input, requirementId: 12 },
        { ...input, title: "第二条", requirementId: 13 },
        { ...input, title: "第三条", requirementId: 14 },
      ],
    },
  });
  const partial = await confirm(prepared.opId);
  expect(partial.steps.map(({ state }) => state)).toEqual([
    "done",
    "failed",
    "pending",
  ]);
  service.recordConfirmed(prepared.opId, partial);
  const result = await executor.confirm({
    opId: prepared.opId,
    previewAck: true,
    resume: true,
  });
  expect(result.steps.map(({ state }) => state)).toEqual([
    "done",
    "failed",
    "unknown",
  ]);
  service.recordConfirmed(prepared.opId, result);
  expect(store.sourceLinks.listFrom("requirement", "12")).toHaveLength(1);
  expect(store.sourceLinks.listFrom("requirement", "13")).toHaveLength(0);
  expect(store.sourceLinks.listTo("story", "1003")).toHaveLength(0);
  expect(store.intake.list()).toHaveLength(3);
  expect(write).toHaveBeenCalledTimes(3);
  assertNoSensitiveData([prepared, result]);
});

function zip(parts: Record<string, string>): Buffer {
  const local: Buffer[] = [];
  const central: Buffer[] = [];
  let offset = 0;
  for (const [filename, xml] of Object.entries(parts)) {
    const name = Buffer.from(filename);
    const raw = Buffer.from(xml);
    const compressed = deflateRawSync(raw);
    const crc = crc32(raw);
    const header = Buffer.alloc(30);
    header.writeUInt32LE(0x04034b50);
    header.writeUInt16LE(20, 4);
    header.writeUInt16LE(8, 8);
    header.writeUInt32LE(crc, 14);
    header.writeUInt32LE(compressed.length, 18);
    header.writeUInt32LE(raw.length, 22);
    header.writeUInt16LE(name.length, 26);
    local.push(header, name, compressed);
    const entry = Buffer.alloc(46);
    entry.writeUInt32LE(0x02014b50);
    entry.writeUInt16LE(20, 4);
    entry.writeUInt16LE(20, 6);
    entry.writeUInt16LE(8, 10);
    entry.writeUInt32LE(crc, 16);
    entry.writeUInt32LE(compressed.length, 20);
    entry.writeUInt32LE(raw.length, 24);
    entry.writeUInt16LE(name.length, 28);
    entry.writeUInt32LE(offset, 42);
    central.push(entry, name);
    offset += header.length + name.length + compressed.length;
  }
  const records = Buffer.concat(central);
  const end = Buffer.alloc(22);
  end.writeUInt32LE(0x06054b50);
  end.writeUInt16LE(central.length / 2, 8);
  end.writeUInt16LE(central.length / 2, 10);
  end.writeUInt32LE(records.length, 12);
  end.writeUInt32LE(offset, 16);
  return Buffer.concat([...local, records, end]);
}

function workbook(rows: string): Buffer {
  const documentNs =
    "http://schemas.openxmlformats.org/spreadsheetml/2006/main";
  const relationNs =
    "http://schemas.openxmlformats.org/officeDocument/2006/relationships";
  const packageNs =
    "http://schemas.openxmlformats.org/package/2006/relationships";
  return zip({
    "[Content_Types].xml":
      '<Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types"><Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/><Override PartName="/xl/workbook.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.sheet.main+xml"/><Override PartName="/xl/worksheets/custom.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.worksheet+xml"/><Override PartName="/xl/sharedStrings.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.sharedStrings+xml"/></Types>',
    "_rels/.rels": `<Relationships xmlns="${packageNs}"><Relationship Id="main" Type="${relationNs}/officeDocument" Target="xl/workbook.xml"/></Relationships>`,
    "xl/workbook.xml": `<workbook xmlns="${documentNs}" xmlns:r="${relationNs}"><sheets><sheet name="需求" sheetId="1" r:id="sheet"/></sheets></workbook>`,
    "xl/_rels/workbook.xml.rels": `<Relationships xmlns="${packageNs}"><Relationship Id="sheet" Type="${relationNs}/worksheet" Target="worksheets/custom.xml"/><Relationship Id="strings" Type="${relationNs}/sharedStrings" Target="sharedStrings.xml"/></Relationships>`,
    "xl/worksheets/custom.xml": `<worksheet xmlns="${documentNs}"><sheetData>${rows}</sheetData></worksheet>`,
    "xl/sharedStrings.xml": `<sst xmlns="${documentNs}"><si><t>筛选 &amp; 过滤</t></si></sst>`,
  });
}

async function importFile(
  format: "csv" | "md" | "xlsx",
  data: string | Buffer,
) {
  const dir = await mkdtemp(join(tmpdir(), "bzt-intake-test-"));
  const path = join(dir, `stories.${format}`);
  await writeFile(path, data);
  cleanup.push(async () => {
    await rm(path);
    await rmdir(dir);
  });
  return { kind: "file", path, format };
}

const sheetHeader =
  '<row r="1"><c r="A1" t="inlineStr"><is><t>title</t></is></c><c r="B1" t="inlineStr"><is><t>spec.scope</t></is></c><c r="C1" t="inlineStr"><is><t>pri</t></is></c></row>';

it.each([
  {
    format: "csv",
    file: 'title,spec.scope,pri\r\n"筛选 & 过滤",按部门筛选,2\r\n',
  },
  {
    format: "md",
    file: "| title | spec.scope | pri |\n| --- | --- | --- |\n| 筛选 & 过滤 | 按部门筛选 | 2 |",
  },
  {
    format: "xlsx",
    file: workbook(
      sheetHeader +
        '<row r="2"><c r="A2" t="s"><v>0</v></c><c r="B2" t="inlineStr"><is><t>按部门筛选</t></is></c><c r="C2"><v>2</v></c></row>',
    ),
  },
])("AC-11 导入 $format、合并嵌套默认值且不落库", async ({ format, file }) => {
  if (format !== "csv" && format !== "md" && format !== "xlsx")
    throw new Error("未知格式");
  const { service, store } = setup();
  const source = await importFile(format, file);
  const prepared = await service.importStories({
    source,
    dryRun: true,
    defaults: {
      product: 29,
      module: 3,
      verify: input.verify,
      spec: { background: "默认背景" },
    },
  });
  expect(prepared.preview.steps).toHaveLength(1);
  expect(prepared.preview.steps[0]?.fields).toMatchObject({
    title: { value: "筛选 & 过滤" },
    spec: { value: expect.stringMatching(/默认背景[\s\S]*按部门筛选/u) },
    pri: { value: 2 },
  });
  expect(store.intake.list()).toEqual([]);
  assertNoSensitiveData(prepared);
});

it("拒绝损坏的 XLSX、超限工作表及过大的文件", async () => {
  const { service, fetch } = setup();
  for (const { format, data } of [
    { format: "xlsx", data: Buffer.from("bad ZIP") },
    { format: "xlsx", data: workbook(sheetHeader + "<row/>".repeat(51)) },
    { format: "csv", data: Buffer.alloc(2 * 1024 * 1024 + 1) },
  ]) {
    if (format !== "xlsx" && format !== "csv") throw new Error("未知格式");
    const source = await importFile(format, data);
    await expect(service.importStories({ source })).rejects.toMatchObject({
      code: "INVALID_INPUT",
    });
  }
  expect(fetch).not.toHaveBeenCalled();
});
