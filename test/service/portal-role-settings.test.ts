import { execFile } from "node:child_process";
import { mkdtemp, readFile, readdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { z } from "zod";
import { loadFileConfig } from "../../src/core/config.ts";
import { checkPortalSettings, loginPortal } from "../../src/services/portal.ts";
import { draft, fakeZentao } from "../eval/fake-zentao.ts";

type Session = Awaited<ReturnType<typeof loginPortal>>;
const runChild = promisify(execFile);

let home: string;
let now: number;
let fake: ReturnType<typeof fakeZentao>;
let fetchFixture: ReturnType<typeof vi.fn<typeof fetch>>;
const sessions: Session[] = [];

beforeEach(async () => {
  home = await mkdtemp(join(tmpdir(), "bzt-portal-roles-"));
  now = Date.UTC(2026, 10, 25);
  fake = fakeZentao();
  fetchFixture = vi.fn(fake.fake);
  vi.stubGlobal("fetch", fetchFixture);
});

afterEach(async () => {
  for (const session of sessions.splice(0)) session.close();
  vi.unstubAllGlobals();
  await rm(home, { recursive: true, force: true });
});

function runtime(config = join(home, "team.json"), owner?: string) {
  return {
    env: {
      ZENTAO_BASE_URL: "https://eval.fixture.test",
      ZENTAO_ACCOUNT: owner,
      BZT_HOME: home,
      BZT_CONFIG: config,
    },
    clock: () => now,
    logSink: () => undefined,
  };
}

async function login(options = runtime(), localOwner = true) {
  const session = await loginPortal(options, "alice", "fixture-pw", localOwner);
  sessions.push(session);
  return session;
}

function editable(session: Session) {
  const { roleSetup, account } = session.identity;
  const { saveRoles } = session;
  if (!roleSetup || !saveRoles)
    throw new Error(`账号 ${account} 未进入职责设置`);
  return { roleSetup, saveRoles };
}

describe("CR-003 INIT-02 至 INIT-04 本地门户职责设置", () => {
  it("只有本机使用者拥有提需职责时才返回团队已配置的产品和模块选项", async () => {
    const file = join(home, "team.json");
    await writeFile(
      file,
      JSON.stringify({
        roles: { DS: ["alice"] },
        products: { 29: { name: "产品甲", state: "runtime" } },
        modules: { "29:3": { name: "权限", devLead: "bob" } },
        teams: {},
      }),
    );
    const owner = await login(runtime(file, "alice"));
    expect(owner.identity.intakeCatalog).toEqual({
      products: [
        {
          id: 29,
          name: "产品甲",
          modules: [{ id: 3, path: "权限", devLead: "bob" }],
        },
      ],
    });
    const ordinary = await login(runtime(file, "bob"), false);
    expect(ordinary.identity.intakeCatalog).toBeUndefined();
    const { saveRoles, roleSetup } = editable(owner);
    expect(
      (await saveRoles(["QA"], roleSetup.revision)).intakeCatalog,
    ).toBeUndefined();
  });
  it("允许空配置启动。首次保存仅创建角色表并在当前会话与重登后生效", async () => {
    const config = join(home, "config", "team.json");
    const options = runtime(config);
    await expect(
      checkPortalSettings({
        ...options,
        env: { ...options.env, ZENTAO_BASE_URL: undefined },
      }),
    ).resolves.toBeUndefined();
    await expect(loadFileConfig(options)).rejects.toMatchObject({
      code: "INVALID_INPUT",
    });
    const session = await login(options);
    const { roleSetup, saveRoles } = editable(session);

    expect(session.identity.roles).toEqual([]);
    expect(roleSetup.selected).toEqual([]);
    expect(roleSetup.choices.map(({ id }) => id)).toEqual([
      "FB",
      "PM",
      "PJ",
      "DM",
      "DS",
      "RM",
      "RD",
      "QA",
    ]);
    await expect(readFile(config, "utf8")).rejects.toMatchObject({
      code: "ENOENT",
    });

    const saved = await saveRoles(["QA", "FB"], roleSetup.revision);
    expect(saved).toMatchObject({
      account: "alice",
      roles: [{ id: "FB" }, { id: "QA" }],
      roleSetup: { selected: ["FB", "QA"] },
    });
    expect(saved.roleSetup?.revision).not.toBe(roleSetup.revision);
    expect(await session.readIdentity()).toEqual(saved);
    expect(await session.readRoleSetup?.()).toEqual(saved.roleSetup);
    expect(await session.readRoles()).toEqual(saved.roles);
    expect(JSON.parse(await readFile(config, "utf8"))).toEqual({
      roles: { FB: ["alice"], QA: ["alice"] },
    });
    expect(fetchFixture).toHaveBeenCalledTimes(2);
    expect((await login(options)).identity.roles).toEqual(saved.roles);
    expect(fake.writes()).toBe(0);
    expect(fake.unexpected()).toBe(false);
  });

  it("只让预设账号或经本机启动凭据获权的本人维护职责", async () => {
    await writeFile(runtime().env.BZT_CONFIG, "{}");
    const ordinary = await login(runtime(), false);
    const other = await login(runtime(undefined, "bob"));
    const owner = await login(runtime(undefined, "alice"), false);

    for (const session of [ordinary, other]) {
      expect(session.identity.roleSetup).toBeUndefined();
      expect(await session.readIdentity()).toEqual({
        account: "alice",
        displayName: "设计",
        dataMonth: "2026-11",
        roles: [],
      });
      expect(session.readRoleSetup).toBeUndefined();
      expect(session.saveRoles).toBeUndefined();
    }
    expect(editable(owner).roleSetup.selected).toEqual([]);
    expect(fake.writes()).toBe(0);
  });

  it("保留团队配置、其他账号及 QA_LEAD，并让新增 PM 的发布例外权限立即生效", async () => {
    const options = runtime(undefined, "alice");
    const path = options.env.BZT_CONFIG;
    const team = {
      mode: "strict-ai",
      aliases: { "研发主管（后端）": "bob" },
      products: { 29: { name: "产品甲", state: "runtime" } },
      roles: { FB: ["alice", "bob"], QA_LEAD: ["alice", "carla"], QA: ["bob"] },
    };
    await writeFile(path, JSON.stringify(team));
    const session = await login(options, false);
    const { roleSetup, saveRoles } = editable(session);
    const exception = {
      storyId: 31,
      waiver: { rule: "R13", reason: "已完成紧急上线评审" },
    };

    expect(roleSetup).toMatchObject({ selected: ["FB", "QA"], locked: ["QA"] });
    await expect(
      session.call("PM", "set_story_meta", exception),
    ).rejects.toMatchObject({ code: "PERMISSION_DENIED" });
    await expect(saveRoles(["PM"], roleSetup.revision)).rejects.toMatchObject({
      code: "INVALID_INPUT",
    });
    const saved = await saveRoles(["PM", "QA"], roleSetup.revision);
    expect(JSON.parse(await readFile(path, "utf8"))).toEqual({
      ...team,
      roles: { ...team.roles, FB: ["bob"], PM: ["alice"] },
    });
    expect(saved.roleSetup?.selected).toEqual(["PM", "QA"]);
    await expect(
      session.call("PM", "set_story_meta", exception),
    ).resolves.toMatchObject({ ok: true, kind: "set_story_meta", level: "W2" });
    expect(fake.writes()).toBe(0);
    expect(fake.unexpected()).toBe(false);
  });

  it("保留并发胜出的职责，并拒绝覆盖有外部修改或已损坏的文件", async () => {
    const path = runtime().env.BZT_CONFIG;
    const team = { roles: { RD: ["bob"] } };
    await writeFile(path, JSON.stringify(team));
    const first = editable(await login());
    const secondSession = await login();
    const second = editable(secondSession);
    expect(second.roleSetup.revision).toEqual(first.roleSetup.revision);
    const [one, two] = await Promise.allSettled([
      first.saveRoles(["FB"], first.roleSetup.revision),
      second.saveRoles(["PM"], second.roleSetup.revision),
    ]);
    const results = [one, two];
    expect(results.map(({ status }) => status).sort()).toEqual([
      "fulfilled",
      "rejected",
    ]);
    expect(results.find(({ status }) => status === "rejected")).toMatchObject({
      reason: { code: "PLAN_STALE" },
    });
    const selected = one.status === "fulfilled" ? "FB" : "PM";
    const afterSave = { roles: { ...team.roles, [selected]: ["alice"] } };
    expect(JSON.parse(await readFile(path, "utf8"))).toEqual(afterSave);

    const latest = await secondSession.readRoleSetup?.();
    expect(latest?.selected).toEqual([selected]);
    if (!latest) throw new Error("未返回最新版职责表");
    const external = JSON.stringify({ ...afterSave, mode: "strict-ai" });
    await writeFile(path, external);
    await expect(second.saveRoles([], latest.revision)).rejects.toMatchObject({
      code: "PLAN_STALE",
    });
    expect(await readFile(path, "utf8")).toBe(external);
    const broken = '{"roles":{},"roles":{"PM":["alice"]}}';
    await writeFile(path, broken);
    await expect(second.saveRoles([], latest.revision)).rejects.toMatchObject({
      code: "INVALID_INPUT",
    });
    expect(await readFile(path, "utf8")).toBe(broken);
    expect(
      (await readdir(home)).filter((name) => name.endsWith(".tmp")),
    ).toEqual([]);
  });

  it("另一个门户持锁异常退出后可继续保存", async () => {
    const { roleSetup, saveRoles } = editable(await login());
    const script = `
      const { DatabaseSync } = require("node:sqlite");
      const lock = new DatabaseSync(process.argv[1]);
      lock.exec("BEGIN IMMEDIATE");
      process.exit(19);
    `;
    await expect(
      runChild(
        process.execPath,
        ["-e", script, join(home, ".team.json.bzt-roles.lock")],
        {
          windowsHide: true,
        },
      ),
    ).rejects.toMatchObject({ code: 19 });
    await expect(saveRoles(["FB"], roleSetup.revision)).resolves.toMatchObject({
      roleSetup: { selected: ["FB"] },
    });
  });

  it("撤销当前职责后拒绝该职责的旧预览，已展示的其他职责预览仍可确认", async () => {
    const options = runtime();
    await writeFile(
      options.env.BZT_CONFIG,
      JSON.stringify({
        mode: "strict-ai",
        roles: { DM: ["alice"], FB: ["alice"] },
        products: { 29: { name: "产品甲", state: "runtime" } },
        moduleDefaults: { 29: { designLead: "alice", devLead: "bob" } },
      }),
    );
    const session = await login(options);
    const { roleSetup, saveRoles } = editable(session);
    const preview = z.object({ opId: z.string() });
    const { opId } = preview.parse(
      await session.call("DM", "create_story", { ...draft, assignTo: "alice" }),
    );
    const { opId: unaffected } = preview.parse(
      await session.call("FB", "create_story", {
        ...draft,
        title: "本人的待办体验",
        assignTo: "alice",
      }),
    );
    const saved = await saveRoles(["FB"], roleSetup.revision);
    const ack = { opId, previewAck: true };
    now += 3100;
    await expect(
      session.call("DM", "confirm_operation", ack),
    ).rejects.toMatchObject({
      code: "PERMISSION_DENIED",
    });
    await expect(
      session.call("FB", "confirm_operation", {
        opId: unaffected,
        previewAck: true,
      }),
    ).resolves.toMatchObject({ status: "confirmed" });
    const reopened = await saveRoles(["FB", "DM"], saved.roleSetup.revision);
    await expect(
      session.call("DM", "confirm_operation", ack),
    ).rejects.toMatchObject({
      code: "PERMISSION_DENIED",
    });
    const empty = await saveRoles([], reopened.roleSetup.revision);
    expect(empty.roles).toEqual([]);
    expect(await session.readRoles()).toEqual([]);
    expect(fake.writes()).toBe(1);
  });
});
