// Edit only the managed assignments. Tokenizing strings and nesting keeps
// table-like text inside comments, strings and arrays out of header detection.
const tokens =
  /"""(?:\\[\s\S]|"(?!"")|[^"\\])*"{3,5}|'''(?:'(?!'')|[^'])*'{3,5}|"(?:\\.|[^"\\\r\n])*"|'[^'\r\n]*'|#[^\r\n]*|\r?\n|[[\]{},]|[\s\S]/gu;
const server = "mcp_servers.better-zentao";
const envTable = server + ".env";

function statements(text: string, separator: "\n" | ","): string[] {
  let start = 0;
  const nesting: string[] = [];
  const parts: string[] = [];
  for (const match of text.matchAll(tokens)) {
    const token = match[0];
    if (token === "[" || token === "{") nesting.push(token);
    if (
      (token === "]" && nesting.pop() !== "[") ||
      (token === "}" && nesting.pop() !== "{") ||
      token === '"' ||
      token === "'"
    )
      throw new Error("无法识别 TOML 语句。");
    if (!nesting.length && token.replace("\r", "") === separator) {
      parts.push(text.slice(start, match.index));
      start = match.index + token.length;
    }
  }
  if (nesting.length) throw new Error("TOML 值未结束。");
  parts.push(text.slice(start));
  return parts;
}

const bareKey = /^[A-Za-z0-9_-]+$/u;
const keyPart = /[A-Za-z0-9_-]+|"(?:\\[^\r\n]|[^"\\\r\n])*"|'[^'\r\n]*'/u;
const keyPath =
  "(?:" + keyPart.source + ")(?:[ \\t]*\\.[ \\t]*(?:" + keyPart.source + "))*";
const setting = new RegExp(
  "^([ \\t]*(" + keyPath + ")[ \\t]*=[ \\t]*)([\\s\\S]*)$",
  "u",
);
const table = new RegExp(
  "^[ \\t]*(\\[{1,2})[ \\t]*(" +
    keyPath +
    ")[ \\t]*(\\]{1,2})[ \\t]*(?:#[^\\r\\n]*)?$",
  "u",
);

function syntaxError(): never {
  throw new Error("无法识别 TOML 语句。");
}

const basicEscapes: Readonly<Record<string, string>> = {
  b: "\b",
  t: "\t",
  n: "\n",
  f: "\f",
  r: "\r",
  '"': '"',
  "\\": "\\",
};

function decodeBasicString(text: string, multiline = false): string {
  if (/[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/u.test(text))
    syntaxError();
  return text.replace(
    /\\(?:[ \t]*\r?\n[ \t\r\n]*|u[\da-fA-F]{4}|U[\da-fA-F]{8}|[\s\S]|$)/gu,
    (escape) => {
      if (multiline && escape.includes("\n")) return "";
      if (/^\\[uU][\da-fA-F]{4,8}$/u.test(escape)) {
        const point = Number.parseInt(escape.slice(2), 16);
        if (point > 0x10ffff || (point >= 0xd800 && point <= 0xdfff))
          syntaxError();
        return String.fromCodePoint(point);
      }
      return basicEscapes[escape.slice(1)] ?? syntaxError();
    },
  );
}

function normalizeKey(path: string): string {
  return [...path.matchAll(new RegExp(keyPart.source, "gu"))]
    .map(([key]) => {
      const text = key.startsWith('"')
        ? decodeBasicString(key.slice(1, -1))
        : key.startsWith("'")
          ? key.slice(1, -1)
          : key;
      if (
        key.startsWith("'") &&
        /[\u0000-\u0008\u000b-\u001f\u007f]/u.test(text)
      )
        syntaxError();
      return bareKey.test(text) ? text : JSON.stringify(text);
    })
    .join(".");
}

function assignment(line: string) {
  const [, prefix, path, value] = setting.exec(line) ?? [];
  if (prefix && path && value !== undefined)
    return { key: normalizeKey(path), prefix, value };
}

const tomlNumber =
  /^(?:[+-]?(?:inf|nan|(?:0|[1-9](?:_?\d)*)(?:\.\d(?:_?\d)*)?(?:[eE][+-]?\d(?:_?\d)*)?)|0x[\da-fA-F](?:_?[\da-fA-F])*|0o[0-7](?:_?[0-7])*|0b[01](?:_?[01])*)$/u;
const tomlDate =
  /^(?:\d{4}-\d{2}-\d{2}(?:[Tt ]\d{2}:\d{2}:\d{2}(?:\.\d+)?(?:[Zz]|[+-]\d{2}:\d{2})?)?|\d{2}:\d{2}:\d{2}(?:\.\d+)?)$/u;

function validateValue(raw: string): void {
  const value = [...raw.matchAll(tokens)]
    .map(([token]) => (token.startsWith("#") ? "" : token))
    .join("")
    .trim();
  if (
    value === "true" ||
    value === "false" ||
    tomlNumber.test(value) ||
    tomlDate.test(value)
  )
    return;

  if (value.startsWith("[") && value.endsWith("]")) {
    const items = statements(value.slice(1, -1), ",");
    if (!items.at(-1)?.trim()) items.pop();
    for (const item of items) validateValue(item);
    return;
  }
  if (value.startsWith("{") && value.endsWith("}")) {
    const inner = value.slice(1, -1);
    if (!inner.trim()) return;
    const entries = new Set<string>();
    for (const item of statements(inner, ",")) {
      const entry = assignment(item);
      if (!entry || entries.has(entry.key)) syntaxError();
      entries.add(entry.key);
      validateValue(entry.value);
    }
    return;
  }

  const [string] = value.matchAll(tokens);
  if (string?.[0] !== value || !/^["']/u.test(value)) syntaxError();
  const width = value.startsWith('"""') || value.startsWith("'''") ? 3 : 1;
  const content = value.slice(width, -width);
  if (value.startsWith('"')) decodeBasicString(content, width === 3);
  else if (/[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/u.test(content))
    syntaxError();
}

function replaceAssignment(
  line: string,
  value: string,
  newline: string,
): string {
  const entry = assignment(line);
  if (!entry) throw new Error("无法识别 TOML 键值。");
  const comments = [...entry.value.matchAll(tokens)].filter(([token]) =>
    token.startsWith("#"),
  );
  const trailing = comments.find(
    (comment) => comment.index + comment[0].length === entry.value.length,
  );
  const tail = trailing
    ? (/[ \t]*$/u.exec(entry.value.slice(0, trailing.index))?.[0] || " ") +
      trailing[0]
    : (/[ \t]*$/u.exec(entry.value)?.[0] ?? "");
  return (
    entry.prefix +
    value +
    tail +
    comments
      .filter((comment) => comment !== trailing)
      .map(([comment]) => newline + comment)
      .join("")
  );
}

function findAssignment(lines: string[], key: string): number {
  const indexes = lines.flatMap((line, index) =>
    assignment(line)?.key === key ? [index] : [],
  );
  if (indexes.length > 1) throw new Error("TOML 键重复。");
  return indexes[0] ?? -1;
}

function setAssignment(
  lines: string[],
  key: string,
  value: string,
  newline: string,
): void {
  const index = findAssignment(lines, key);
  const line = lines[index];
  if (line !== undefined)
    lines[index] = replaceAssignment(line, value, newline);
  else lines.unshift(key + " = " + value);
}

function updateInlineEnv(
  line: string,
  config: string,
  newline: string,
): string {
  const entry = assignment(line);
  if (!entry?.value.startsWith("{"))
    throw new Error("无法合并内联 TOML 环境表。");
  // Strip the trailing comment before locating the closing brace.
  const comment = [...entry.value.matchAll(tokens)].find(([token]) =>
    token.startsWith("#"),
  );
  const value = entry.value
    .slice(0, comment?.index ?? entry.value.length)
    .trimEnd();
  if (!value.endsWith("}")) throw new Error("无法合并内联 TOML 环境表。");
  const fields = statements(value.slice(1, -1), ",");
  const index = findAssignment(fields, "BZT_CONFIG");
  const current = fields[index];
  if (current !== undefined)
    fields[index] = replaceAssignment(current, config, newline);
  else if (fields.join("").trim()) fields.push(" BZT_CONFIG = " + config + " ");
  else fields[0] = " BZT_CONFIG = " + config + " ";
  return (
    entry.prefix +
    "{" +
    fields.join(",") +
    "}" +
    entry.value.slice(value.length)
  );
}

export function mergeCodexToml(original: string, config?: string): string {
  const newline = original.includes("\r\n") ? "\r\n" : "\n";
  const bom = original.startsWith("\uFEFF") ? "\uFEFF" : "";
  const lines = statements(original.slice(bom.length), "\n");
  const sections: { name: string; header?: string; body: string[] }[] = [
    { name: "", body: [] },
  ];
  for (const line of lines) {
    const header = table.exec(line);
    if (header) {
      const [, opening, path, closing] = header;
      if (!path || opening?.length !== closing?.length) syntaxError();
      const name = normalizeKey(path);
      if (
        opening === "[[" &&
        (name === "mcp_servers" || name === server || name === envTable)
      )
        throw new Error("MCP 配置与 TOML 数组表冲突。");
      if (
        name === server + ".command" ||
        name.startsWith(server + ".command.") ||
        name === server + ".args" ||
        name.startsWith(server + ".args.") ||
        (config !== undefined &&
          (name === envTable + ".BZT_CONFIG" ||
            name.startsWith(envTable + ".BZT_CONFIG.")))
      )
        throw new Error("MCP 配置键与 TOML 表冲突。");
      sections.push({ name, header: line, body: [] });
    } else sections.at(-1)?.body.push(line);
  }

  const sectionsNamed = (name: string) =>
    sections.filter((section) => section.name === name);
  const managed = sectionsNamed(server);
  const environment = sectionsNamed(envTable);
  if (managed.length > 1 || environment.length > 1)
    throw new Error("MCP 配置表重复。");

  // Dotted definitions can claim the same keys as the tables we write.
  for (const section of sections) {
    const keys = new Set<string>();
    for (const line of section.body) {
      if (!line.trim() || line.trimStart().startsWith("#")) continue;
      const entry = assignment(line);
      if (!entry || keys.has(entry.key)) syntaxError();
      keys.add(entry.key);
      validateValue(entry.value);
      const full = section.name ? section.name + "." + entry.key : entry.key;
      if (
        full === "mcp_servers" ||
        full === server ||
        ((section.name === "" || section.name === "mcp_servers") &&
          full.startsWith(server + ".")) ||
        full.startsWith(server + ".command.") ||
        full.startsWith(server + ".args.") ||
        (config !== undefined && full.startsWith(envTable + ".BZT_CONFIG."))
      )
        throw new Error("MCP 配置与 TOML 点分键冲突。");
    }
  }

  function addSection(name: string) {
    const section = { name, header: "[" + name + "]", body: [""] };
    const end = sections.at(-1)?.body;
    if (end?.at(-1) !== "") end?.push("");
    sections.push(section);
    return section;
  }
  const main = managed[0] ?? addSection(server);
  setAssignment(main.body, "args", '["mcp"]', newline);
  setAssignment(main.body, "command", '"bzt"', newline);
  if (config !== undefined) {
    const value = JSON.stringify(config);
    const inlineIndex = findAssignment(main.body, "env");
    const inline = main.body[inlineIndex];
    if (inline !== undefined) {
      if (environment.length) throw new Error("MCP 环境表重复。");
      main.body[inlineIndex] = updateInlineEnv(inline, value, newline);
    } else if (
      main.body.some((line) => assignment(line)?.key.startsWith("env."))
    ) {
      setAssignment(main.body, "env.BZT_CONFIG", value, newline);
    } else {
      setAssignment(
        (environment[0] ?? addSection(envTable)).body,
        "BZT_CONFIG",
        value,
        newline,
      );
    }
  }
  const result = sections
    .flatMap(({ header, body }) =>
      header === undefined ? body : [header, ...body],
    )
    .join(newline);
  return bom + (original === "" ? result.replace(/^\r?\n/u, "") : result);
}
