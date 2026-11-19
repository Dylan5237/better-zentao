#!/usr/bin/env node
import { readFile } from "node:fs/promises";
import { InvalidParamError, ZentaoError } from "../core/errors.js";
import { createBetterZentao, type BetterZentaoClient } from "../index.js";
import { publicError, safeOutput } from "./output.js";
import type { CliField, ToolDef } from "./tools/definition.js";
import { TOOL_DEFS } from "./tools/index.js";

const aliases = new Map(TOOL_DEFS.map(tool => [tool.command, tool]));
const flag = (field: string) => field.replace(/[A-Z]/g, letter => "-" + letter.toLowerCase());

function help(tool?: ToolDef) {
  if (!tool) {
    return "用法 bzt <子命令> [参数] [--json]\n" +
      TOOL_DEFS.map(entry => "  " + entry.command.padEnd(10) + entry.description).join("\n") +
      "\n使用 bzt <子命令> --help 查看参数。";
  }
  const positionals = tool.positional?.map(name => " [" + name + "]").join("") ?? "";
  const source = tool.command === "import" ? " (--file <path> | --stdin)" : "";
  const options = Object.entries(tool.cli).map(([name, type]) =>
    "  --" + flag(name) + (type === "boolean" || type === "dryRun" ? "[=true|false]" : " <值>")).join("\n");
  return "用法 bzt " + tool.command + positionals + source + " [--json]\n" + tool.description +
    "\n" + options + (tool.cli.dryRun ? "\n仅 --dry-run=false 提交真实写入。" : "");
}

function valueOf(type: CliField, value: string | undefined) {
  if (type === "boolean" || type === "dryRun") {
    if (value !== undefined && value !== "true" && value !== "false") {
      throw new InvalidParamError(type === "dryRun" ? "--dry-run 只接受 true 或 false" : "布尔选项只接受 true 或 false");
    }
    return value !== "false";
  }
  if (value === undefined) throw new InvalidParamError("选项缺少参数值");
  if (type === "id" || type === "number") {
    if (!/^\d+$/.test(value)) throw new InvalidParamError("参数必须是整数");
    return Number(value);
  }
  if (type === "list") return value.split(/[,，、]/).map(item => item.trim());
  return value;
}

type ParsedCommand = { json: boolean } & (
  { error: InvalidParamError } | { help: string } | { tool: ToolDef; input: Record<string, unknown>; file?: string }
);

function parse(args: string[]): ParsedCommand {
  let tool: ToolDef | undefined;
  let wantsHelp = false;
  let json = false;
  let error: InvalidParamError | undefined;
  let positionalsOnly = false;
  let file: string | undefined;
  let stdin = false;
  let names = new Map<string, string>();
  const input: Record<string, unknown> = {};
  const positionals: string[] = [];
  const seen = new Set<string>();

  for (let index = 0; index < args.length; index++) {
    const token = args[index];
    if (!positionalsOnly && token === "--") {
      positionalsOnly = true;
      continue;
    }
    // A trailing output flag still applies to an earlier usage error.
    if (!positionalsOnly && token === "--json") json = true;
    if (error) continue;
    try {
      if (!positionalsOnly && token.startsWith("--")) {
        const equals = token.indexOf("=");
        const name = token.slice(2, equals < 0 ? undefined : equals);
        const field = names.get(name) ?? name;
        if (seen.has(field)) {
          throw new InvalidParamError(field === "dryRun" ? "--dry-run 不可重复" : "选项不可重复");
        }
        seen.add(field);
        let value = equals < 0 ? undefined : token.slice(equals + 1);
        if (name === "json" || name === "help" || (name === "stdin" && tool?.command === "import")) {
          if (value !== undefined) throw new InvalidParamError("此选项不接受参数值");
          if (name === "help") wantsHelp = true;
          if (name === "stdin") stdin = true;
          continue;
        }
        const fileOption = name === "file" && tool?.command === "import";
        if (!fileOption && !names.has(name)) throw new InvalidParamError("未知选项，请查看 --help");
        const type = fileOption ? "text" : tool!.cli[field];
        if (type !== "boolean" && type !== "dryRun" && value === undefined) {
          if (!args[index + 1] || args[index + 1].startsWith("--")) throw new InvalidParamError("选项缺少参数值");
          value = args[++index];
        }
        const parsed = valueOf(type, value);
        if (fileOption) file = parsed as string;
        else input[field] = parsed;
        continue;
      }
      if (tool) positionals.push(token);
      else {
        tool = aliases.get(token);
        if (!tool) throw new InvalidParamError("未知子命令，请查看 --help");
        names = new Map(Object.keys(tool.cli).map(key => [flag(key), key]));
        if (names.has("product")) names.set("product-id", "product");
      }
    } catch (caught) {
      if (!(caught instanceof InvalidParamError)) throw caught;
      error = caught;
    }
  }

  if (error) return { error, json };
  if (wantsHelp) return { help: help(tool), json };
  try {
    if (!tool) throw new InvalidParamError("请指定子命令，可用 bzt --help 查看");
    for (const [index, value] of positionals.entries()) {
      const field = tool.positional?.[index];
      if (!field || Object.hasOwn(input, field)) throw new InvalidParamError("多余的位置参数或与选项重复");
      input[field] = valueOf(tool.cli[field], value);
    }
    if (tool.command === "import" && (file === "" || (file !== undefined) === stdin)) {
      throw new InvalidParamError("import 必须在 --file 与 --stdin 中选择一个");
    }
    return { tool, input, file, json };
  } catch (caught) {
    if (!(caught instanceof InvalidParamError)) throw caught;
    return { error: caught, json };
  }
}

async function readStories(file: string | undefined): Promise<unknown> {
  let raw: string;
  try {
    if (file !== undefined) raw = await readFile(file, "utf8");
    else {
      process.stdin.setEncoding("utf8");
      raw = "";
      for await (const chunk of process.stdin) raw += chunk;
    }
  } catch {
    throw new ZentaoError("无法读取需求移交文档或管道输入");
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw.replace(/^\uFEFF/, ""));
  } catch {
    throw new InvalidParamError("需求移交文档必须是有效的 JSON");
  }
  return Array.isArray(parsed) ? parsed : (parsed as { stories?: unknown } | null)?.stories;
}

function resultCode(data: Record<string, unknown>) {
  if (data.allOk === false && data.dryRun === true) return 2;
  if (data.allOk === false || data.confirmed === false) return 1;
  return 0;
}

async function main(args: string[]) {
  let json = false;
  let client: BetterZentaoClient | undefined;
  try {
    const command = parse(args);
    json = command.json;
    if ("error" in command) throw command.error;
    if ("help" in command) {
      process.stdout.write(command.help + "\n");
      return 0;
    }
    if (command.tool.command === "import") command.input.stories = await readStories(command.file);
    const execute = command.tool.prepare(command.input);
    client = createBetterZentao();
    const data = safeOutput(await execute(client), client);
    process.stdout.write(JSON.stringify(data, null, json ? undefined : 2) + "\n");
    return resultCode(data);
  } catch (error) {
    const data = safeOutput({ error: publicError(error) }, client);
    if (json) process.stdout.write(JSON.stringify(data) + "\n");
    else process.stderr.write(JSON.stringify(data) + "\n");
    return error instanceof InvalidParamError ? 2 : 1;
  }
}

process.exitCode = await main(process.argv.slice(2));
