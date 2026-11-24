import { expect, it } from "vitest";
import { renderScheduleHtml } from "../../src/adapters/cli/render/schedule-html.ts";
import type { GetMemberScheduleOutput } from "../../src/contracts/tools/get_member_schedule.ts";

const dangerous = `</td><img src=x onerror="alert('x')">&lt; 研发`;
const escaped =
  "&lt;/td&gt;&lt;img src=x onerror=&quot;alert(&#39;x&#39;)&quot;&gt;&amp;lt; 研发";

it("导出离线矩阵，逐处转义不可信文本并拒绝危险 URL", () => {
  const overdue = {
    id: 1,
    name: dangerous,
    status: dangerous,
    url: "java\tscript:alert(1)",
    timeState: "overdue",
    execution: { id: 7, name: dangerous },
    isParent: false,
    left: 0,
  } satisfies GetMemberScheduleOutput["data"]["members"][number]["overdue"][number];
  const result: GetMemberScheduleOutput = {
    ok: true,
    scope: { asOf: "2026-11-24T00:00:00Z", filters: {}, timeBasis: dangerous },
    completeness: "partial",
    gaps: [{ source: dangerous, reason: dangerous }],
    inferences: [],
    hints: [dangerous],
    data: {
      members: [
        {
          account: dangerous,
          realname: dangerous,
          capacityHours: -1,
          buckets: [
            {
              start: "2026-11-24",
              end: "2026-11-30",
              taskCount: 2,
              leftHours: 3.5,
              missingEstimate: 1,
            },
          ],
          overdue: [overdue],
          unscheduled: [
            {
              ...overdue,
              id: 2,
              url: "https://example.test/zentao/task-view-2.html?a=1&b=2",
              timeState: "unscheduled",
              left: undefined,
            },
          ],
        },
      ],
      suggestions: [
        {
          account: dangerous,
          realname: dangerous,
          suggestedDeadline: "2026-12-02",
          reason: dangerous,
        },
      ],
    },
  };
  const html = renderScheduleHtml(result);
  expect(html).toMatch(/^<!doctype html>/iu);
  expect(html).toContain("2026-11-24 至 2026-11-30");
  expect(html).toContain("缺工时 1 项");
  expect(html).toContain("逾期");
  expect(html).toContain("未排期");
  expect(html).toContain("数据不完整");
  expect(html).toContain("禅道可见投入");
  expect(html).toContain(
    'href="https://example.test/zentao/task-view-2.html?a=1&amp;b=2"',
  );
  expect(html.split(escaped).length - 1).toBeGreaterThanOrEqual(9);
  expect(html).not.toMatch(/<img|<script|<link|@import|<iframe|href="java/iu);
  expect(html).not.toContain(dangerous);
});

it("空结果仍可直接打开，并显示明确的空状态", () => {
  const html = renderScheduleHtml({
    ok: true,
    scope: { asOf: "2026-11-24T00:00:00Z", filters: {} },
    completeness: "complete",
    gaps: [],
    inferences: [],
    data: { members: [], suggestions: [] },
  });
  expect(html).toContain("暂无成员排期");
  expect(html).not.toContain("数据不完整");
  expect(html).not.toContain("指派建议");
});
