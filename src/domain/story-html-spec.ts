import { z } from "zod";
import { BztError } from "../core/errors.ts";
import { htmlFragments } from "./html-fragments.ts";

const roleValue = z.string().regex(/^[\p{L}\p{M}\p{N}_.@+-]+$/u);
const storyRoleTagSchema = z
  .strictObject({
    maintainer: roleValue.optional(),
    receiver: roleValue.optional(),
    intake: roleValue.optional(),
  })
  .refine((tag) => Object.values(tag).some((value) => value !== undefined));

export type StoryRoleTag = Readonly<z.output<typeof storyRoleTagSchema>>;
export type StoryRoleTagFormat = "comment" | "visible";

export interface StorySpecTemplate {
  readonly background: readonly string[];
  readonly scope: readonly string[];
  readonly design?: readonly string[];
  readonly source?: readonly string[];
}

// 只识别 HTML 注释或独立的微标签文本，跳过属性、代码示例和非正文元素。
const commentRoleTag = /^<!--\s*bzt:v1\s+([\s\S]*?)\s*-->$/u;
const visibleRoleTag = /^\s*\[bzt:v1\s+([^[\]\r\n<>]*)\]\s*$/u;

interface RoleTagOccurrence {
  readonly format: StoryRoleTagFormat;
  readonly fields: string;
  readonly start: number;
  readonly end: number;
}

function findRoleTags(spec: string): RoleTagOccurrence[] {
  const tags: RoleTagOccurrence[] = [];
  for (const match of spec.matchAll(htmlFragments)) {
    const text = match[0];
    const start = match.index;
    const end = start + text.length;
    const comment = commentRoleTag.exec(text)?.[1];
    if (comment !== undefined) {
      tags.push({ format: "comment", fields: comment, start, end });
      continue;
    }
    const fallback = match.groups?.footer ?? (end === spec.length ? text : "");
    const visible = visibleRoleTag.exec(fallback)?.[1];
    if (visible !== undefined) {
      tags.push({ format: "visible", fields: visible, start, end });
    }
  }
  return tags;
}

function parseFields(fields: string): StoryRoleTag | undefined {
  const values = new Map<string, string>();
  for (const field of fields.split(";")) {
    const [key = "", value, extra] = field
      .split("=")
      .map((part) => part.trim());
    if (value === undefined || extra !== undefined || values.has(key)) return;
    values.set(key, value);
  }
  return storyRoleTagSchema.safeParse(Object.fromEntries(values)).data;
}

// docs/04 §2。只使用最后一条有效注释，注释缺失时使用最后一条有效微标签。
export function parseStoryRoleTag(spec: string): StoryRoleTag | undefined {
  let comment: StoryRoleTag | undefined;
  let visible: StoryRoleTag | undefined;
  for (const tag of findRoleTags(spec)) {
    const roles = parseFields(tag.fields);
    if (roles === undefined) continue;
    if (tag.format === "comment") comment = roles;
    else visible = roles;
  }
  return comment ?? visible;
}

function renderRoleTag(tag: StoryRoleTag, format: StoryRoleTagFormat): string {
  const parsed = storyRoleTagSchema.safeParse(tag);
  if (!parsed.success)
    throw new BztError("INVALID_INPUT", "需求角色标签不合法。");
  const fields = Object.entries(parsed.data)
    .filter(([, value]) => value !== undefined)
    .map(([role, value]) => `${role}=${value}`)
    .join(";");
  const text = `bzt:v1 ${fields}`;
  return format === "comment"
    ? `<!-- ${text} -->`
    : `<p style="color:#999;font-size:12px">[${text}]</p>`;
}

export function replaceStoryRoleTag(
  spec: string,
  tag: StoryRoleTag,
  format: StoryRoleTagFormat = "comment",
): string {
  const parts: string[] = [];
  let position = 0;
  for (const { start, end } of findRoleTags(spec)) {
    parts.push(spec.slice(position, start));
    position = end;
  }
  parts.push(spec.slice(position));
  const body = parts.join("").trimEnd();
  return [body, renderRoleTag(tag, format)].filter(Boolean).join("\n");
}

function escapeText(text: string): string {
  return text
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;")
    .replaceAll("'", "&#39;")
    .replaceAll("[", "&#91;");
}

function renderSection(
  heading: string,
  lines: readonly string[],
  structure: "paragraphs" | "list",
): string {
  const content = lines
    .flatMap((line) => line.split(/\r\n?|\n/u))
    .map((line) => line.trim())
    .filter(Boolean)
    .map(escapeText);
  if (content.length === 0) return "";
  const elements =
    structure === "paragraphs"
      ? content.map((line) => `<p>${line}</p>`)
      : ["<ul>", ...content.map((line) => `<li>${line}</li>`), "</ul>"];
  return [`<h3>${heading}</h3>`, ...elements].join("\n");
}

// docs/03 N03、docs/06 Q14。业务文字逐行转成 HTML 文本，不参与元数据解释。
export function buildStoryHtmlSpec(
  template: StorySpecTemplate,
  tag?: StoryRoleTag,
  format: StoryRoleTagFormat = "comment",
): string {
  const scope = renderSection("本次实现范围", template.scope, "list");
  if (!scope)
    throw new BztError("MISSING_REQUIRED", "本次实现范围不能为空。", {
      missing: ["scope"],
    });
  return [
    renderSection("背景与问题", template.background, "paragraphs"),
    scope,
    renderSection("设计文档", template.design ?? [], "list"),
    renderSection("来源", template.source ?? [], "list"),
    tag === undefined ? "" : renderRoleTag(tag, format),
  ]
    .filter(Boolean)
    .join("\n");
}
