import type { BetterZentaoConfig, Mode } from "./config.js";
import { localDate } from "./normalizer.js";

const titleMarker = "[AI创建] ";
const priorHeader = /^<p>【AI创建】本需求由 AI 通过 (?:better-zentao|zentao-mcp) 自动提交（批次：[^<\r\n]+，时间：\d{4}-\d{2}-\d{2} \d{2}:\d{2}:\d{2}），请人工评审确认后再流转。<\/p>/;

function html(value: string): string {
  return value.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
}

export function batchDetails(prefix: string, batch: string | undefined, now: Date) {
  const date = localDate(now);
  const time = [now.getHours(), now.getMinutes(), now.getSeconds()]
    .map(value => String(value).padStart(2, "0")).join(":");
  const label = batch?.trim().toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-|-$/g, "").slice(0, 32);
  return {
    sourceNote: prefix + "-" + date.replaceAll("-", "") + "-" + (label || time.replaceAll(":", "")),
    timestamp: date + " " + time,
  };
}

export function markStory(
  input: { title: string; spec: string; source?: string },
  mode: Mode,
  config: BetterZentaoConfig["aiMark"],
  batch: ReturnType<typeof batchDetails>,
  shareBatch = false,
) {
  if (mode === "personal") {
    return { title: input.title, spec: input.spec, source: input.source ?? "", sourceNote: shareBatch ? batch.sourceNote : undefined };
  }
  const prefix = config.titlePrefix.startsWith(titleMarker) ? config.titlePrefix : titleMarker + config.titlePrefix;
  const unmarked = input.title.startsWith(titleMarker) ? input.title.slice(titleMarker.length) : input.title;
  const title = input.title.startsWith(prefix) ? input.title : prefix + unmarked;
  const header = "<p>【AI创建】本需求由 AI 通过 better-zentao 自动提交（批次：" +
    html(batch.sourceNote) + "，时间：" + batch.timestamp + "），请人工评审确认后再流转。</p>";
  const body = input.spec.trimStart();
  return {
    title, spec: header + (priorHeader.test(body) ? body.replace(priorHeader, "") : input.spec),
    source: "ai", sourceNote: batch.sourceNote,
  };
}
