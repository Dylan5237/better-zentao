import { BztError } from "../core/errors.ts";
import { buildStoryHtmlSpec, type StoryRoleTag } from "./story-html-spec.ts";

interface CategoryInput {
  title: string;
  body?: string | undefined;
  crossProduct?: boolean | undefined;
  crossModule?: boolean | undefined;
}

interface IntakeSpec {
  background?: string | undefined;
  scope?: string | undefined;
  notInScope?: string | undefined;
  designRef?:
    | {
        doc: string;
        section?: string | undefined;
        version?: string | undefined;
      }
    | undefined;
}

interface IntakeSource {
  feedbackBy?: string | undefined;
  channel?: string | undefined;
  source?: string | undefined;
  sourceNote?: string | undefined;
  requirementId?: number | undefined;
  derivesFrom?: number | undefined;
}

// docs/03 N02、N10。跨模块依赖提研发类，跨产品与设计型变更建议设计类。
export function recommendStoryCategory(input: CategoryInput): {
  value: "feature" | "design";
  origin: "derived";
  reason: string;
} {
  if (input.crossModule) {
    return {
      value: "feature",
      origin: "derived",
      reason: "跨模块依赖按 N10 提研发类需求",
    };
  }
  const text = [input.title, input.body].join("\n");
  const reason =
    input.crossProduct || /跨(?:产品|模块)|多个(?:产品|模块)/u.test(text)
      ? "涉及多个产品或模块"
      : /新(?:增)?(?:功能|页面)|交互(?:流程|调整|变更)|流程(?:调整|变更)|(?:需要|待)评审|方案待定/u.test(
            text,
          )
        ? "涉及新功能、新页面、流程变更或方案评审"
        : undefined;
  return reason
    ? { value: "design", origin: "derived", reason }
    : {
        value: "feature",
        origin: "derived",
        reason: "现有信息未显示需要另行设计",
      };
}

function missingSpecFields(spec?: IntakeSpec): string[] {
  const missing: string[] = [];
  if (!spec?.scope?.trim()) missing.push("spec.scope");
  if (spec?.designRef && !spec.designRef.section?.trim())
    missing.push("spec.designRef.section");
  return missing;
}

function requireFields(missing: string[]): void {
  if (missing.length)
    throw new BztError("MISSING_REQUIRED", "请补充提需所需的信息。", {
      missing,
    });
}

export function validateIntakeContent(
  spec?: IntakeSpec,
  verify?: string,
): void {
  const missing = missingSpecFields(spec);
  if (!verify?.trim()) missing.push("verify");
  requireFields(missing);
}

// docs/03 N01/N03，docs/12 O-08。原始文字交给公共 HTML 构造器转义。
export function buildIntakeSpec(
  spec: IntakeSpec,
  source: IntakeSource,
  tag: StoryRoleTag,
): string {
  requireFields(missingSpecFields(spec));
  const { designRef } = spec;
  return buildStoryHtmlSpec(
    {
      background: [spec.background ?? ""],
      scope: [
        spec.scope ?? "",
        spec.notInScope ? `不做 / 已实现：${spec.notInScope}` : "",
      ],
      design: designRef
        ? [
            designRef.doc,
            `章节：${designRef.section ?? ""}`,
            designRef.version ? `版本：${designRef.version}` : "",
          ]
        : [],
      source: [
        source.feedbackBy ? `反馈者：${source.feedbackBy}` : "",
        source.channel ? `渠道：${source.channel}` : "",
        source.source ? `来源：${source.source}` : "",
        source.sourceNote ?? "",
        source.requirementId ? `用户需求 #${source.requirementId}` : "",
        source.derivesFrom ? `衍生自 #${source.derivesFrom}` : "",
      ],
    },
    tag,
    "visible",
  );
}

export function formatVersionTag(version: string): string {
  const normalized = version.trim().replace(/^v/iu, "");
  if (!/^\d+\.\d+\.\d+$/u.test(normalized))
    throw new BztError("INVALID_INPUT", "版本应采用 Vx.y.z 格式。");
  return `版本:V${normalized}`;
}

export function formatIntakeReceipt(intakeId: string): string {
  return `已受理，编号 ${intakeId}。后续可以凭此编号查询处理进度。`;
}

export function parseCsv(input: string): string[][] {
  const text = input.replace(/^\uFEFF/u, "");
  const rows: string[][] = [];
  let row: string[] = [];
  let value = "";
  let state: "plain" | "quoted" | "closed" = "plain";
  for (let index = 0; index < text.length; index++) {
    const char = text.charAt(index);
    if (state === "quoted") {
      if (char !== '"') value += char;
      else if (text.charAt(index + 1) === '"') {
        value += '"';
        index++;
      } else state = "closed";
    } else if (char === "," || char === "\r" || char === "\n") {
      row.push(value);
      value = "";
      state = "plain";
      if (char !== ",") {
        rows.push(row);
        row = [];
        if (char === "\r" && text.charAt(index + 1) === "\n") index++;
      }
    } else if (state === "closed" || (char === '"' && value !== "")) {
      throw new BztError("INVALID_INPUT", "CSV 字段的引号格式不合法。");
    } else if (char === '"') {
      state = "quoted";
    } else {
      value += char;
    }
  }
  if (state === "quoted")
    throw new BztError("INVALID_INPUT", "CSV 引号未闭合。");
  if (row.length || value || state === "closed") rows.push([...row, value]);
  return rows;
}

function markdownCells(line: string): string[] {
  const text = line.trim();
  const cells: string[] = [];
  let cell = "";
  for (const [token, escaped] of text.matchAll(/\\([\\|])|./gu)) {
    if (token === "|") {
      cells.push(cell.trim());
      cell = "";
    } else cell += escaped ?? token;
  }
  if (!text.endsWith("|") || cell) cells.push(cell.trim());
  if (text.startsWith("|")) cells.shift();
  return cells;
}

export function parseMarkdownTable(text: string): string[][] {
  const lines = text.split(/\r\n?|\n/u);
  for (let index = 1; index < lines.length; index++) {
    const separator = lines[index] ?? "";
    if (!separator.includes("|")) continue;
    const columns = markdownCells(separator);
    const heading = lines[index - 1] ?? "";
    if (!heading.includes("|")) continue;
    const header = markdownCells(heading);
    if (
      columns.length === 0 ||
      columns.length !== header.length ||
      !columns.every((column) => /^:?-{3,}:?$/u.test(column))
    )
      continue;
    const rows = [header];
    for (const line of lines.slice(index + 1)) {
      if (!line.includes("|")) break;
      rows.push(markdownCells(line));
    }
    return rows;
  }
  throw new BztError("INVALID_INPUT", "未找到合法的 Markdown 表格。");
}
