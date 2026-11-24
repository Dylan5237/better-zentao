import type { GetMemberScheduleOutput } from "../../../contracts/tools/get_member_schedule.ts";

type Data = GetMemberScheduleOutput["data"];
type TaskItem = Data["members"][number]["overdue"][number];

function escapeHtml(value: string | number): string {
  return String(value)
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;")
    .replaceAll("'", "&#39;");
}

function taskLabel(task: TaskItem): string {
  const label = `#${escapeHtml(task.id)} ${escapeHtml(task.name)}`;
  const url = URL.parse(task.url);
  if (
    !url ||
    (url.protocol !== "https:" && url.protocol !== "http:") ||
    url.username ||
    url.password
  )
    return label;
  return `<a href="${escapeHtml(url.href)}" rel="noreferrer">${label}</a>`;
}

function taskList(tasks: TaskItem[]): string {
  if (!tasks.length) return "—";
  return `<ul>${tasks
    .map(
      (task) => `<li>${taskLabel(task)}
    <small>${escapeHtml(task.execution.name)} · ${escapeHtml(task.status)} ·
    ${task.left === undefined ? "缺工时" : `剩余 ${escapeHtml(task.left)} 小时`}
    ${task.deadline ? ` · 截止 ${escapeHtml(task.deadline)}` : ""}</small></li>`,
    )
    .join("")}</ul>`;
}

function scheduleTable(members: Data["members"]): string {
  const first = members[0];
  if (!first) return "<p>暂无成员排期。</p>";
  const dates = first.buckets
    .map(
      ({ start, end }) =>
        `<th scope="col">${escapeHtml(start)}${start === end ? "" : ` 至 ${escapeHtml(end)}`}</th>`,
    )
    .join("");
  const rows = members
    .map((member) => {
      const buckets = member.buckets
        .map(
          ({ leftHours, taskCount, missingEstimate }) =>
            `<td>${escapeHtml(taskCount)} 项 · ${escapeHtml(leftHours)} 小时
      ${missingEstimate ? `<small>缺工时 ${escapeHtml(missingEstimate)} 项</small>` : ""}</td>`,
        )
        .join("");
      return `<tr><th scope="row">${escapeHtml(member.realname)} <small>${escapeHtml(member.account)}</small></th>
      <td>${escapeHtml(member.capacityHours)} 小时</td>${buckets}
      <td>${taskList(member.overdue)}</td><td>${taskList(member.unscheduled)}</td></tr>`;
    })
    .join("");
  return `<div class="matrix" tabindex="0"><table>
    <thead><tr><th scope="col">成员</th><th scope="col">剩余容量</th>${dates}
    <th scope="col">逾期</th><th scope="col">未排期</th></tr></thead>
    <tbody>${rows}</tbody></table></div>`;
}

export function renderScheduleHtml(result: GetMemberScheduleOutput): string {
  const { data, scope, gaps, completeness, hints } = result;
  const notices =
    completeness === "partial"
      ? `<section><h2>数据不完整</h2><ul>${gaps
          .map(
            ({ source, reason }) =>
              `<li>${escapeHtml(source)} · ${escapeHtml(reason)}</li>`,
          )
          .join("")}</ul></section>`
      : "";
  const notes = hints?.length
    ? `<ul>${hints.map((hint) => `<li>${escapeHtml(hint)}</li>`).join("")}</ul>`
    : "";
  const suggestions = data.suggestions?.length
    ? `<section><h2>指派建议</h2><ol>${data.suggestions
        .map(
          (item) =>
            `<li><strong>${escapeHtml(item.realname)}（${escapeHtml(item.account)}）</strong>
        · 建议截止 ${escapeHtml(item.suggestedDeadline)}<p>${escapeHtml(item.reason)}</p></li>`,
        )
        .join("")}</ol></section>`
    : "";
  // 动态内容只进入文本和经协议校验的链接属性。
  return `<!doctype html>
<html lang="zh-CN">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<meta http-equiv="Content-Security-Policy" content="default-src 'none'; style-src 'unsafe-inline'; base-uri 'none'; form-action 'none'">
<title>成员排期</title>
<style>
  body { max-width: 100rem; margin: 2rem auto; padding: 0 1rem; font: 1rem/1.55 system-ui, sans-serif; color: #19263a; }
  h1 { margin-bottom: .25rem; }
  .matrix { overflow: auto; }
  table { border-collapse: collapse; width: 100%; }
  th, td { border: 1px solid #ccd6e0; padding: .55rem .75rem; text-align: left; vertical-align: top; min-width: 7rem; }
  th { background: #edf3f8; }
  small { display: block; color: #435365; }
  td ul { margin: 0; padding-left: 1.1rem; }
  a { color: #145397; }
  section { margin-top: 1.5rem; }
</style>
</head>
<body><main>
<h1>成员排期</h1>
<p>禅道可见投入（不含禅道外工作）</p>
<p>数据时间 ${escapeHtml(scope.asOf)}${scope.timeBasis ? ` · ${escapeHtml(scope.timeBasis)}` : ""}</p>
${notices}
${scheduleTable(data.members)}
${notes}
${suggestions}
</main></body>
</html>
`;
}
