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

const keyPath =
  /^(?:[A-Za-z0-9_-]+|"[A-Za-z0-9_-]+"|'[A-Za-z0-9_-]+')(?:\s*\.\s*(?:[A-Za-z0-9_-]+|"[A-Za-z0-9_-]+"|'[A-Za-z0-9_-]+'))*$/u;

function normalizeKey(key: string): string {
  const name = key.trim();
  return keyPath.test(name) ? name.replace(/[\s'"]/gu, "") : "";
}

function assignment(line: string) {
  const match = /^(\s*[^=\r\n]+?=\s*)([\s\S]*)$/u.exec(line);
  const prefix = match?.[1];
  if (!prefix) return;
  const key = normalizeKey(prefix.split("=")[0] ?? "");
  if (key) return { key, prefix, value: match[2] ?? "" };
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
    const header = /^\s*(\[{1,2})([^[\]\r\n]+)\]{1,2}\s*(?:#.*)?$/u.exec(line);
    if (header) {
      const name = normalizeKey(header[2] ?? "");
      if (header[1] === "[[" && (name === server || name === envTable))
        throw new Error("MCP 配置与 TOML 数组表冲突。");
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
    for (const line of section.body) {
      const entry = assignment(line);
      if (!entry) continue;
      const full = section.name ? section.name + "." + entry.key : entry.key;
      if (
        full === "mcp_servers" ||
        full === server ||
        (section.name !== server &&
          section.name !== envTable &&
          full.startsWith(server + "."))
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
