import {
  mkdir,
  mkdtemp,
  readFile,
  rename,
  rm,
  stat,
  writeFile,
} from "node:fs/promises";
import { dirname, join, resolve } from "node:path";
import { z } from "zod";
import { assertNoConfigCredentials } from "../core/config.ts";
import type { ConfigEnv } from "../core/config.ts";
import { mergeCodexToml } from "./install-agent-toml.ts";

export const agentName = z.enum(["codex", "claude", "gemini"]);
const record = z.record(z.string(), z.json());
const ioError = z.object({ code: z.string() });
const pathControl = /[\p{Cc}\u2028\u2029]/u;
const credentialAssignment =
  /(?:pass(?:word|wd|phrase)|pwd|token|secret|auth(?:orization)?|api[_-]?key|cookie|credential|webhook|private[_-]?key|session[_-]?id|\bkey)["']?\s*[:=]/iu;

interface InstallOptions {
  readonly agent?: string;
  readonly config?: string;
  readonly project?: string;
  readonly dryRun?: boolean;
  readonly homeDir?: string;
  readonly env: ConfigEnv;
}

function safePath(path: string, env: ConfigEnv): boolean {
  if (!path.trim() || pathControl.test(path)) return false;
  try {
    const decoded = path.replace(/(?:%[\da-f]{2})+/giu, (fragment) =>
      decodeURIComponent(fragment),
    );
    assertNoConfigCredentials([path, decoded], env);
    return (
      !pathControl.test(decoded) &&
      !credentialAssignment.test(decoded) &&
      !/^[a-z]+:\/\//iu.test(decoded) &&
      !/^(?:[/\\]{2})[^/\\]*@/u.test(decoded)
    );
  } catch {
    return false;
  }
}

async function readExisting(path: string): Promise<string | undefined> {
  try {
    return await readFile(path, "utf8");
  } catch (error) {
    if (ioError.safeParse(error).data?.code !== "ENOENT") throw error;
    return undefined;
  }
}

function mergeJson(original: string | undefined, config?: string): string {
  const bom = original?.startsWith("\uFEFF") ? "\uFEFF" : "";
  const old =
    original === undefined
      ? {}
      : record.parse(JSON.parse(original.slice(bom.length)));
  const servers = record.parse(
    old.mcpServers === undefined ? {} : old.mcpServers,
  );
  const current = record.parse(
    servers["better-zentao"] === undefined ? {} : servers["better-zentao"],
  );
  const { command, args, env } = current;
  if (
    command === "bzt" &&
    Array.isArray(args) &&
    args.length === 1 &&
    args[0] === "mcp" &&
    (config === undefined ||
      record.parse(env === undefined ? {} : env).BZT_CONFIG === config)
  ) {
    return original ?? "";
  }
  const entry = { ...current, command: "bzt", args: ["mcp"] };
  const updated =
    config === undefined
      ? entry
      : {
          ...entry,
          env: {
            ...record.parse(env === undefined ? {} : env),
            BZT_CONFIG: config,
          },
        };
  const json = JSON.stringify(
    { ...old, mcpServers: { ...servers, "better-zentao": updated } },
    null,
    2,
  );
  return (
    bom +
    (original?.includes("\r\n")
      ? json.replaceAll("\n", "\r\n") + "\r\n"
      : json + "\n")
  );
}

function mergeGuide(original: string, agent: "codex" | "gemini"): string {
  const newline = original.includes("\r\n") ? "\r\n" : "\n";
  const start = "<!-- better-zentao:start -->";
  const end = "<!-- better-zentao:end -->";
  const block = [
    start,
    "处理禅道需求、工作、排期或风险时，请先阅读 " +
      "~/" +
      (agent === "codex" ? ".codex" : ".gemini") +
      "/skills/better-zentao/SKILL.md，再使用 better-zentao MCP。",
    end,
  ].join(newline);
  const positions = [
    ...original.matchAll(/^<!-- better-zentao:(start|end) -->(?=\r?$)/gmu),
  ];
  if (!positions.length) {
    const separator =
      original === ""
        ? ""
        : original.endsWith("\n")
          ? newline
          : newline.repeat(2);
    return original + separator + block + newline;
  }
  const [opening, closing] = positions;
  if (
    positions.length !== 2 ||
    opening?.[1] !== "start" ||
    closing?.[1] !== "end"
  )
    throw new Error("接入说明标记不完整。");
  return (
    original.slice(0, opening.index) +
    block +
    original.slice(closing.index + end.length)
  );
}

interface FileUpdate {
  path: string;
  before: string | undefined;
  after: string;
}

async function publish(updates: FileUpdate[]): Promise<void> {
  const staged = [];
  try {
    for (const { path, before, after } of updates) {
      if (before === after) continue;
      const dir = dirname(path);
      await mkdir(dir, { recursive: true });
      const staging = await mkdtemp(join(dir, ".bzt-install-"));
      const pending = join(staging, "pending");
      staged.push({ path, before, pending, staging });
      const mode =
        before === undefined ? 0o600 : (await stat(path)).mode & 0o777;
      await writeFile(pending, after, { encoding: "utf8", mode, flag: "wx" });
    }
    for (const { path, before } of staged) {
      if ((await readExisting(path)) !== before)
        throw new Error("安装目标已变更。");
    }
    for (const { path, pending } of staged) await rename(pending, path);
  } finally {
    await Promise.all(
      staged.map(({ staging }) =>
        rm(staging, { recursive: true, force: true }),
      ),
    );
  }
}

const skillUrl = new URL(
  "../../skills/better-zentao/SKILL.md",
  import.meta.url,
);

export async function installAgent(options: InstallOptions) {
  const { config: inputConfig, project, homeDir, env, dryRun } = options;
  const parsed = agentName.safeParse(options.agent);
  if (
    !parsed.success ||
    (inputConfig !== undefined && !safePath(inputConfig, env)) ||
    (project !== undefined &&
      (parsed.data !== "claude" || !safePath(project, env)))
  ) {
    return {
      ok: false,
      invalidArgs: true,
      message: "安装参数不合法。请运行 bzt --help。",
    };
  }
  const agent = parsed.data;
  try {
    if (!homeDir) throw new Error("缺少用户目录。");
    const config =
      inputConfig === undefined
        ? undefined
        : /^~(?:[/\\]|$)/u.test(inputConfig)
          ? resolve(homeDir, ...inputConfig.slice(1).split(/[/\\]+/u))
          : resolve(inputConfig);
    if (config !== undefined) assertNoConfigCredentials(config, env);
    const agentDir = resolve(homeDir, "." + agent);
    const configFile =
      agent === "claude"
        ? project === undefined
          ? resolve(homeDir, ".claude.json")
          : resolve(project, ".mcp.json")
        : join(agentDir, agent === "codex" ? "config.toml" : "settings.json");
    const skillFile = join(agentDir, "skills", "better-zentao", "SKILL.md");
    const guideFile = join(
      agentDir,
      agent === "codex" ? "AGENTS.md" : "GEMINI.md",
    );
    const [before, oldSkill, skill, guide] = await Promise.all([
      readExisting(configFile),
      readExisting(skillFile),
      readFile(skillUrl, "utf8"),
      agent === "claude" ? undefined : readExisting(guideFile),
    ]);
    const updates = [
      { path: skillFile, before: oldSkill, after: skill },
      {
        path: configFile,
        before,
        after:
          agent === "codex"
            ? mergeCodexToml(before ?? "", config)
            : mergeJson(before, config),
      },
    ];
    if (agent !== "claude")
      updates.push({
        path: guideFile,
        before: guide,
        after: mergeGuide(guide ?? "", agent),
      });
    if (!dryRun) await publish(updates);
    return {
      ok: true,
      agent,
      dryRun: dryRun ?? false,
      files: updates.map(({ path, before, after }) => ({
        path,
        action:
          before === undefined
            ? "create"
            : before === after
              ? "unchanged"
              : "update",
      })),
    };
  } catch {
    return {
      ok: false,
      invalidArgs: false,
      message: "Agent 接入失败。请检查配置格式、文件权限和安装目录。",
    };
  }
}
