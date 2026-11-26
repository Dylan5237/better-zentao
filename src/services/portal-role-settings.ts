import { createHash, randomUUID } from "node:crypto";
import { link, lstat, mkdir, rename, rm, writeFile } from "node:fs/promises";
import { basename, dirname, join, resolve } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { z } from "zod";
import {
  assertNoConfigCredentials,
  loadFileConfig,
  type ConfigEnv,
  type TeamConfig,
} from "../core/config.ts";
import { BztError } from "../core/errors.ts";

type RoleTable = TeamConfig["roles"];
type RoleId = Exclude<keyof RoleTable, "QA_LEAD">;
type RoleChoice = { id: RoleId; label: string };

export interface PortalRoleSetup {
  choices: readonly RoleChoice[];
  selected: RoleId[];
  revision: string;
  locked?: RoleId[];
}

const configDocument = z.record(z.string(), z.unknown());
const ioError = z.object({ code: z.string() });
const sqliteError = z.object({ errcode: z.number() });
const SQLITE_BUSY = 5;

function stale(): BztError {
  return new BztError("PLAN_STALE", "职责配置已变更，请刷新后重新选择。");
}

function revisionOf(contents: string | undefined): string {
  return createHash("sha256")
    .update(contents === undefined ? "missing" : "file\0" + contents)
    .digest("hex");
}

async function regularFile(path: string) {
  const info = await lstat(path).catch((error: unknown) => {
    if (ioError.safeParse(error).data?.code === "ENOENT") return undefined;
    throw error;
  });
  if (info && !info.isFile())
    throw new BztError("INVALID_INPUT", "团队配置路径不是普通文件。");
  return info;
}

export function createPortalRoleSettings(
  options: { env: ConfigEnv & { BZT_CONFIG: string }; homeDir?: string },
  account: string,
  choices: readonly RoleChoice[],
) {
  const path = options.env.BZT_CONFIG;
  const directory = dirname(path);
  const filename = basename(path);
  const ids = choices.map(({ id }) => id);
  const selection = z
    .array(z.enum(ids))
    .max(ids.length)
    .refine((value) => new Set(value).size === value.length);

  function describe(table: RoleTable, contents?: string): PortalRoleSetup {
    const locked = table.QA_LEAD?.includes(account) ? ["QA" as const] : [];
    return {
      choices,
      selected: ids.filter(
        (id) =>
          locked.some((role) => role === id) || table[id]?.includes(account),
      ),
      revision: revisionOf(contents),
      ...(locked.length ? { locked } : {}),
    };
  }

  async function read() {
    const { config, stateDir, teamDocument } = await loadFileConfig({
      ...options,
      optionalTeamConfig: true,
      includeTeamDocument: true,
    });
    return {
      table: config.roles,
      stateDir,
      document: teamDocument,
      roleSetup: describe(config.roles, teamDocument?.contents),
    };
  }

  async function save(roles: string[], revision: string) {
    const desired = selection.safeParse(roles);
    if (!desired.success)
      throw new BztError("INVALID_INPUT", "请选择有效且不重复的职责。");
    const lockPath = join(directory, `.${filename}.bzt-roles.lock`);
    try {
      await mkdir(directory, { recursive: true });
      await regularFile(lockPath);
      // 与操作执行器一样，使用进程退出时会自动释放的 SQLite 写锁。
      using lock = new DatabaseSync(lockPath, { timeout: 0 });
      lock.exec("BEGIN IMMEDIATE");
      const info = await regularFile(path);
      const current = await read();
      if (current.roleSetup.revision !== revision) throw stale();
      if (current.stateDir && resolve(current.stateDir, "config.json") === path)
        throw new BztError(
          "INVALID_INPUT",
          "团队配置与个人配置需使用不同文件。",
        );
      const requested = new Set(desired.data);
      const locked = new Set(current.roleSetup.locked);
      if ([...locked].some((id) => !requested.has(id)))
        throw new BztError(
          "INVALID_INPUT",
          "请保留已有测试主管职责对应的测试人员入口。",
        );

      const table = { ...current.table };
      let changed = current.document === undefined;
      for (const id of ids) {
        if (locked.has(id)) continue;
        const members = table[id] ?? [];
        const selected = requested.has(id);
        if (selected === members.includes(account)) continue;
        table[id] = selected
          ? [...members, account]
          : members.filter((member) => member !== account);
        changed = true;
      }
      if (!changed) return current;

      const next = {
        ...configDocument.parse(current.document?.input ?? {}),
        roles: table,
      };
      assertNoConfigCredentials(next, options.env);
      const contents = JSON.stringify(next, null, 2) + "\n";
      const pending = join(
        directory,
        `.${filename}.bzt-roles-${randomUUID()}.tmp`,
      );
      try {
        await writeFile(pending, contents, {
          encoding: "utf8",
          flag: "wx",
          flush: true,
          mode: info ? info.mode & 0o777 : 0o600,
        });
        // 门户进程共用锁，普通编辑器绕过锁时在落盘前再核对原文。
        await regularFile(path);
        if ((await read()).roleSetup.revision !== revision) throw stale();
        if (current.document) await rename(pending, path);
        else await link(pending, path);
      } finally {
        await rm(pending, { force: true });
      }
      return { table, roleSetup: describe(table, contents) };
    } catch (error) {
      if (error instanceof BztError) throw error;
      if (
        sqliteError.safeParse(error).data?.errcode === SQLITE_BUSY ||
        ioError.safeParse(error).data?.code === "EEXIST"
      )
        throw stale();
      throw new BztError("INVALID_INPUT", "无法保存本机门户职责配置。");
    }
  }

  return { read, save };
}
