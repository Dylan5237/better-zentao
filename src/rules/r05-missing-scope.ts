import { htmlFragments } from "../domain/html-fragments.ts";
import type { RiskHit, StoryInput } from "./types.ts";

export const id = "R05";
export const name = "需求缺范围";

const scopeHeading = /^本次实现范围(?:\s*[:：]\s*(.*))?$/u;
const designHeading = /^设计文档(?:\s*[:：]\s*(.*))?$/u;
const otherHeading = /^(?:背景与问题|来源|验收标准)(?:\s*[:：].*)?$/u;
const designLocator =
  /(?:章节(?:\s*[/／]\s*版本)?|版本)\s*[:：]\s*(?!(?:待定|待补|暂无|无)(?:\s|$|[，。；]))[\p{L}\p{N}]/u;

function visibleLines(spec: string): string[] {
  const pieces = [...spec.matchAll(htmlFragments)].map(([fragment, hidden]) => {
    if (hidden || /^<!--/u.test(fragment)) return "";
    if (/^<h[1-6](?=[\s>])/iu.test(fragment)) return "\n## ";
    if (/^<\/?(?:h[1-6]|p|div|li|ul|ol|br)(?=[\s/>])/iu.test(fragment))
      return "\n";
    return fragment.startsWith("<") ? "" : fragment;
  });
  return pieces
    .join("")
    .replace(/&nbsp;|&#160;|\u00a0/giu, " ")
    .split(/\r\n?|\n/u);
}

// docs/04 §5 R05、docs/03 N03。只看可见正文；其他段落中的版本不补设计引用。
export function evaluate({ story }: StoryInput): RiskHit[] {
  if (story?.category !== "feature" || story.deleted) return [];
  let section: "scope" | "design" | undefined;
  let hasScope = false;
  const references: string[] = [];
  for (const raw of visibleLines(story.spec ?? "")) {
    const line = raw.trim().replace(/^[-*]\s+/u, "");
    if (!line || /^\[bzt:v1\s/u.test(line)) continue;
    const heading = line.replace(/^#{1,6}\s+/u, "");
    const scope = scopeHeading.exec(heading);
    const design = designHeading.exec(heading);
    if (scope) {
      section = "scope";
      hasScope ||= meaningful(scope[1] ?? "");
    } else if (design) {
      section = "design";
      if (design[1] && meaningful(design[1])) references.push(design[1]);
    } else if (line !== heading || otherHeading.test(line)) {
      section = undefined;
    } else if (section === "design") {
      if (meaningful(line)) references.push(line);
    } else {
      if (section === "scope") hasScope ||= meaningful(line);
      if (/设计文档.*(?:https?:\/\/|链接\s*[:：])/u.test(line))
        references.push(line);
    }
  }
  const missingLocator =
    references.length > 0 &&
    !references.some((line) => designLocator.test(line));
  if (hasScope && !missingLocator) return [];

  return [
    {
      ruleId: id,
      objectType: "story",
      objectId: story.id,
      state: "gap",
      severity: "low",
      confidence: "recorded",
      since: null,
      evidence: [
        ...(!hasScope ? ["缺少本次实现范围段落"] : []),
        ...(missingLocator ? ["设计文档引用缺少章节或版本"] : []),
      ],
      suggestion: "请状态维护人补齐本次实现范围及设计文档的章节或版本。",
    },
  ];
}

function meaningful(text: string): boolean {
  return /[\p{L}\p{N}]/u.test(text);
}
