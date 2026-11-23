export const FIXTURE_TEXT = "示例文本";

const htmlTags = new Set(
  "p h1 h2 h3 h4 h5 h6 ul ol li br hr div span strong em b i u s pre code blockquote table caption thead tbody tfoot tr th td a img dl dt dd sub sup".split(
    " ",
  ),
);
const stages = new Set(
  "design review handoff dev interface test acceptance delivery".split(" "),
);
const stageTitle = /^【(?:设计|评审|传递|研发|接口|测试|验收|交付)】/u;
const fixtureMarkup =
  /<!--[\s\S]*?(?:-->|$)|<\/?[a-z](?:"[^"]*"|'[^']*'|[^"'<>])*>|\[bzt:v1\b[^\]\r\n<]*\]|\[bzt:(?:meta|waiver) v1\](?:(?!\[bzt:)[^\r\n<])*/giu;

interface TagAliases {
  account(value: string): string;
  intake(value: string): string;
}

type TagType = "roles" | "meta" | "waiver";

// docs/04 §2–3 limits retained text to the structure of supported metadata tags.
function tagField(
  key: string,
  value: string,
  tag: TagType,
  aliases: TagAliases,
): string | undefined {
  if (tag === "roles") {
    if (key === "maintainer" || key === "receiver")
      return aliases.account(value);
    if (key === "intake") return aliases.intake(value);
    return undefined;
  }
  if (key === "reason") return value === "" ? "" : FIXTURE_TEXT;
  if (tag === "meta") {
    if (key.startsWith("stage.") && stages.has(key.slice("stage.".length))) {
      return /^(?:true|false)$/u.test(value) ? value : FIXTURE_TEXT;
    }
    return undefined;
  }
  if (key === "approvedBy") return aliases.account(value);
  if (key === "version") {
    return /^v?\d+(?:\.\d+){1,2}$/iu.test(value) ? value : FIXTURE_TEXT;
  }
  if (key === "rule")
    return /^R(?:0[1-9]|1[0-6])$/u.test(value) ? value : FIXTURE_TEXT;
  return undefined;
}

function tagAssignments(
  text: string,
  tag: TagType,
  aliases: TagAliases,
): string {
  const delimiter = tag === "roles" ? ";" : "|";
  const output: string[] = [];
  for (const part of text.split(delimiter)) {
    const field = /^([A-Za-z][A-Za-z\d.]*)\s*=\s*(.*)$/su.exec(part.trim());
    const key = field?.[1];
    const raw = field?.[2];
    if (key === undefined || raw === undefined) continue;
    const value = tagField(key, raw.trim(), tag, aliases);
    if (value !== undefined) output.push(key + "=" + value);
  }
  return output.join(tag === "roles" ? ";" : " | ");
}

function rolesTag(text: string, aliases: TagAliases): string {
  const fields = tagAssignments(text, "roles", aliases);
  return fields === "" ? "bzt:v1" : "bzt:v1 " + fields;
}

function sanitizeMarkup(fragment: string, aliases: TagAliases): string {
  if (fragment.startsWith("<!--")) {
    const end = fragment.endsWith("-->") ? -"-->".length : undefined;
    const comment = fragment.slice("<!--".length, end).trim();
    const stage = /^bzt:stage\s*=\s*([a-z]+)$/u.exec(comment)?.[1];
    if (stage !== undefined && stages.has(stage))
      return "<!-- bzt:stage=" + stage + " -->";
    if (/^bzt:v1(?:\s|$)/u.test(comment)) {
      return (
        "<!-- " + rolesTag(comment.slice("bzt:v1".length), aliases) + " -->"
      );
    }
    return "";
  }
  const visibleRoles = /^\[bzt:v1\b(.*)\]$/su.exec(fragment)?.[1];
  if (visibleRoles !== undefined)
    return "[" + rolesTag(visibleRoles, aliases) + "]";
  const metaTag = /^\[bzt:(meta|waiver) v1\](.*)$/su.exec(fragment);
  const tag = metaTag?.[1];
  const metadata = metaTag?.[2];
  if ((tag === "meta" || tag === "waiver") && metadata !== undefined) {
    const marker = "[bzt:" + tag + " v1]";
    const fields = tagAssignments(metadata, tag, aliases);
    return fields === "" ? marker : marker + " " + fields;
  }

  const html = /^<(\/?)([a-z][a-z\d-]*)(?=[/\s>])/iu.exec(fragment);
  const name = html?.[2]?.toLowerCase();
  return name !== undefined && htmlTags.has(name)
    ? "<" + (html?.[1] ?? "") + name + ">"
    : "";
}

function sanitizePlainText(fragment: string, title: boolean): string {
  return fragment.replace(/[^\r\n]+/gu, (line) => {
    if (line.trim() === "") return line;
    const prefix = title ? stageTitle.exec(line)?.[0] : undefined;
    return (prefix ?? "") + FIXTURE_TEXT;
  });
}

export function sanitizeFixtureText(
  text: string,
  aliases: TagAliases,
  title = false,
): string {
  const fragments: string[] = [];
  let start = 0;
  for (const token of text.matchAll(fixtureMarkup)) {
    fragments.push(sanitizePlainText(text.slice(start, token.index), title));
    fragments.push(sanitizeMarkup(token[0], aliases));
    start = token.index + token[0].length;
  }
  fragments.push(sanitizePlainText(text.slice(start), title));
  return fragments.join("");
}

function metadataIdentityContent(markup: string): string {
  const metadata = /^\[bzt:(meta|waiver) v1\](?: (.*))?$/u.exec(markup);
  if (metadata === null) return markup;
  const [, kind, fields = ""] = metadata;
  return fields
    .split(" | ")
    .map((assignment) => {
      const separator = assignment.indexOf("=");
      if (separator === -1) return assignment;
      const key = assignment.slice(0, separator);
      const value = assignment.slice(separator + 1);
      if (key === "reason") return value === FIXTURE_TEXT ? "" : value;
      if (
        kind === "meta" &&
        key.startsWith("stage.") &&
        stages.has(key.slice(6))
      ) {
        return value === FIXTURE_TEXT || value === "true" || value === "false"
          ? ""
          : value;
      }
      if (kind === "waiver") {
        if (key === "approvedBy") return value;
        if (key === "version" || key === "rule") {
          return value === FIXTURE_TEXT ? "" : value;
        }
      }
      return assignment;
    })
    .join("\n");
}

// The identity scan may ignore exact rendering literals. Tags that carry values stay
// visible to it, and the credential scan still sees the complete original string.
export function fixtureTextIdentityContent(text: string): string {
  function plainText(fragment: string): string {
    return fragment
      .split(/\r?\n/u)
      .filter((line) => line.replace(stageTitle, "") !== FIXTURE_TEXT)
      .join("\n");
  }

  const content: string[] = [];
  let start = 0;
  for (const { 0: markup, index } of text.matchAll(fixtureMarkup)) {
    content.push(plainText(text.slice(start, index)));
    const stage = /^<!-- bzt:stage=([a-z]+) -->$/u.exec(markup)?.[1];
    const html = /^<\/?([a-z][a-z\d]*)>$/u.exec(markup)?.[1];
    if (
      !(stage !== undefined && stages.has(stage)) &&
      !(html !== undefined && htmlTags.has(html))
    ) {
      content.push(metadataIdentityContent(markup));
    }
    start = index + markup.length;
  }
  content.push(plainText(text.slice(start)));
  return content.join("\n");
}
