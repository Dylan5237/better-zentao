import {
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { runCli } from "../../src/adapters/cli/run-cli.ts";
import { assertNoSensitiveData } from "../helpers/assert-no-sensitive-data.ts";

let homeDir: string;
const secret = "example-private-value";
const skill = readFileSync(
  new URL("../../skills/better-zentao/SKILL.md", import.meta.url),
  "utf8",
);
const put = (path: string, text: string) => {
  const target = join(homeDir, path);
  mkdirSync(dirname(target), { recursive: true });
  writeFileSync(target, text);
};
const read = (path: string) => readFileSync(join(homeDir, path), "utf8");

beforeEach(() => {
  homeDir = mkdtempSync(join(tmpdir(), "bzt-install-"));
});
afterEach(() => rmSync(homeDir, { recursive: true, force: true }));

async function install(...args: string[]) {
  const stdout = vi.fn<(text: string) => void>();
  const stderr = vi.fn<(text: string) => void>();
  const status = await runCli(["install-agent", ...args], {
    stdout,
    stderr,
    homeDir,
    clock: () => 0,
    nodeVersion: "24.11.0",
    env: { ZENTAO_PASSWORD: secret },
  });
  assertNoSensitiveData([stdout.mock.calls, stderr.mock.calls], [secret]);
  return { status, stdout, stderr };
}

it("WP-21 Codex 保留其他配置和注释，更新已有环境表与说明段落", async () => {
  put(
    ".codex/config.toml",
    '# 用户配置\r\nmodel = "mine"\r\n[mcp_servers."better-zentao"] # 保留\r\ncommand = "old" # 指令\r\nargs = [\r\n  "old", # 参数\r\n]\r\n[mcp_servers.better-zentao.env]\r\nBZT_CONFIG = "old.json"\r\n[mcp_servers.other]\r\ncommand = "mine"\r\n',
  );
  put(
    ".codex/AGENTS.md",
    "用户说明\n<!-- better-zentao:start -->\n旧内容\n<!-- better-zentao:end -->\n后续内容\n",
  );
  const configPath = join(homeDir, "团队.json");
  const args = ["--agent", "codex", "--config", configPath];
  expect((await install(...args)).status).toBe(0);
  const config = read(".codex/config.toml");
  expect(config).toContain('command = "bzt" # 指令');
  expect(config).toContain("# 参数");
  expect(config).toContain('args = ["mcp"]');
  expect(config).toContain("BZT_CONFIG = " + JSON.stringify(configPath));
  expect(config).toContain('[mcp_servers.other]\r\ncommand = "mine"');
  const guide = read(".codex/AGENTS.md");
  expect(guide).toContain("用户说明");
  expect(guide).toContain("后续内容");
  expect(guide).not.toContain("旧内容");
  expect(guide.match(/better-zentao:start/gu)).toHaveLength(1);
  expect(read(".codex/skills/better-zentao/SKILL.md")).toBe(skill);
  expect((await install(...args)).status).toBe(0);
  expect(read(".codex/config.toml")).toBe(config);
  expect(read(".codex/AGENTS.md")).toBe(guide);
});

it("WP-21 Codex 兼容旧模板的内联 env，保留其他成员", async () => {
  put(
    ".codex/config.toml",
    '[mcp_servers.better-zentao]\ncommand = "old"\nargs = []\nenv = { OTHER = "a,b#c", BZT_CONFIG = "old.json" } # 保留\n',
  );
  expect((await install("codex", "--config", "new.json")).status).toBe(0);
  expect(read(".codex/config.toml")).toContain(
    'env = { OTHER = "a,b#c", BZT_CONFIG = ' +
      JSON.stringify(resolve("new.json")) +
      " } # 保留",
  );
  expect((await install("codex")).status).toBe(0);
  const path = ".codex/config.toml";
  expect(read(path)).toContain("new.json");
  expect(
    (
      await install("codex", "--config", "new.json", "--dry-run")
    ).stdout.mock.calls
      .flat()
      .join(),
  ).toContain("unchanged");
});

it.each([
  ["claude", ".claude.json", ".claude"],
  ["gemini", ".gemini/settings.json", ".gemini"],
])("WP-21 %s 合并 JSON 并可幂等重跑", async (agent, config, dir) => {
  put(
    config,
    JSON.stringify({
      settings: { enabled: true },
      mcpServers: {
        other: { command: "mine" },
        "better-zentao": {
          command: "old",
          timeout: 20,
          env: { OTHER: "kept" },
        },
      },
    }),
  );
  if (agent === "gemini") put(".gemini/GEMINI.md", "用户说明\n");
  const args = [agent, "--config", "team.json"];
  expect((await install(...args)).status).toBe(0);
  const first = read(config);
  expect(JSON.parse(first)).toEqual({
    settings: { enabled: true },
    mcpServers: {
      other: { command: "mine" },
      "better-zentao": {
        command: "bzt",
        args: ["mcp"],
        timeout: 20,
        env: { OTHER: "kept", BZT_CONFIG: resolve("team.json") },
      },
    },
  });
  expect(read(join(dir, "skills/better-zentao/SKILL.md"))).toBe(skill);
  expect((await install(...args)).status).toBe(0);
  expect(read(config)).toBe(first);
  if (agent === "gemini")
    expect(read(".gemini/GEMINI.md")).toMatch(
      /^用户说明\n[\s\S]*better-zentao:start/u,
    );
});

it.each(["~/配置/团队.json", "~\\配置\\团队.json"])(
  "N5 将 %s 展开为用户目录下的绝对路径",
  async (path) => {
    expect((await install("claude", "--config", path)).status).toBe(0);
    expect(JSON.parse(read(".claude.json"))).toMatchObject({
      mcpServers: {
        "better-zentao": {
          env: { BZT_CONFIG: join(homeDir, "配置", "团队.json") },
        },
      },
    });
  },
);

it("N4 保留带方括号的引号表名、非 env 子表及其他服务器的数组表", async () => {
  const original = [
    "[mcp_servers.better-zentao]",
    'command = "old"',
    '[mcp_servers.better-zentao."auth[cli]"] # 保留',
    '"键=名" = true',
    'command = "child"',
    "[mcp_servers.better-zentao.env]",
    'OTHER = "kept"',
    '[[mcp_servers."other[server]".fallbacks]]',
    'command = "kept"',
    "",
  ].join("\n");
  put(".codex/config.toml", original);
  expect((await install("codex", "--config", "team.json")).status).toBe(0);
  const updated = read(".codex/config.toml");
  expect(updated).toContain(
    '[mcp_servers.better-zentao."auth[cli]"] # 保留\n"键=名" = true\ncommand = "child"',
  );
  expect(updated).toContain(
    '[[mcp_servers."other[server]".fallbacks]]\ncommand = "kept"',
  );
  expect(updated).toContain('OTHER = "kept"');
  expect(updated.match(/^command = "bzt"$/gmu)).toHaveLength(1);
});

it.each([
  '[[mcp_servers]]\ncommand = "other"\n',
  '[mcp_servers.other]]\ncommand = "other"\n',
  "[unmanaged]\nmalformed line\n",
  "[unmanaged]\nvalue = nonsense\n",
  "[unmanaged]\nvalue = [true false]\n",
])("N4 拒绝冲突或损坏的 TOML，且文件不落盘", async (original) => {
  put(".codex/config.toml", original);
  expect((await install("codex", "--config", "team.json")).status).toBe(1);
  expect(read(".codex/config.toml")).toBe(original);
  expect(() => read(".codex/skills/better-zentao/SKILL.md")).toThrow();
});

it("WP-21 Claude 项目安装只修改项目 MCP 配置与用户 Skill，dry-run 无写入", async () => {
  const args = ["claude", "--project", join(homeDir, "project")];
  const preview = await install(...args, "--dry-run");
  expect(preview.status).toBe(0);
  expect(preview.stdout.mock.calls.flat().join()).toContain("create");
  expect(() => read("project/.mcp.json")).toThrow();
  expect(() => read(".claude/skills/better-zentao/SKILL.md")).toThrow();
  expect((await install(...args)).status).toBe(0);
  expect(JSON.parse(read("project/.mcp.json"))).toMatchObject({
    mcpServers: { "better-zentao": { command: "bzt", args: ["mcp"] } },
  });
  expect(() => read(".claude.json")).toThrow();
});

it.each([
  [],
  ["unknown"],
  ["codex", "--agent", "codex"],
  ["--agent", secret],
  ["gemini", "--project", "."],
  ["claude", "--project", " "],
  ["codex", "--config", "  "],
  ["codex", "--config", "a\nb"],
  ["codex", "--config", "a\tb"],
  ["codex", "--config", secret],
  ["codex", "--config", "https://a:b@example.test"],
  ["codex", "--config", "ZENTAO_PASSWORD=hidden"],
  ["codex", "--config", "team.json?api_key=hidden"],
  ["codex", "--config", "ZENTAO_TOKEN%3Dhidden"],
])("WP-21 / S01 拒绝非法安装参数 %#", async (...args) => {
  expect((await install(...args)).status).toBe(2);
});

it("WP-21 / S01 损坏的 JSON 安全失败，技能文件也不落盘", async () => {
  put(".claude.json", '{"invalid":"' + secret);
  const result = await install("claude");
  expect(result.status).toBe(1);
  expect(result.stderr).toHaveBeenCalledOnce();
  expect(read(".claude.json")).toContain(secret);
  expect(() => read(".claude/skills/better-zentao/SKILL.md")).toThrow();
});
