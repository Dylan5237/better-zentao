---
name: better-zentao
description: 用于禅道需求和任务协作。用户要查我的待办、团队逾期、产品需求或反馈进度，或要预检、创建、批量移交、指派和软删除研发需求时使用。覆盖天宫设计态、OneLink 运行态和运营交付态。
---

# 禅道需求与任务协作

优先调用本地 `better-zentao-mcp`。对方明确要求在终端执行时，使用同名能力的 `bzt` 子命令。环境缺失时只报告缺少的变量名，凭据由启动工具的进程提供。

## 查询

| 用户要做的事 | 调用 |
| --- | --- |
| 核对人员、部门、产品、模块、计划或迭代 | `resolve_context`，指定需要的 `kinds`。查模块和计划时带上产品 |
| 看我的待办和临期事项 | `get_my_dashboard`，按需设 `upcomingDays` |
| 看团队逾期 | `get_team_overdue`，可选团队别名、部门或成员。汇报未解析成员和实际统计范围 |
| 搜索研发需求或用户需求 | `query_stories`，给出筛选条件。用户需求传 `storyType: "requirement"`。回执 `truncated: true` 时说明扫描范围 |
| 给反馈者查进度 | 优先用 `get_story_progress`，从研发需求 ID、用户需求 ID、反馈者中选择一种入口。用 `feedbackSummary` 整理当前阶段、逾期和链接 |

## 提交前确认

1. 先定位目标。天宫平台 `#42` 对应 `design`，OneLink 7.0 `#43` 对应 `runtime`，运营交付平台 `#44` 对应 `delivery`。有重名人员、模糊模块或三态归属不清时，带着候选与 ID 向用户确认。多人同名时请用户选账号。
2. 用 `create_story` 或 `import_stories` 传 `dryRun: true`。核对产品、模块、类别、计划、负责人、需求正文和验收说明。缺少 L3 计划时展示目标产品的候选，确认选哪项或留空。多态建单使用 `states`，逐态核对草稿。`createDevPair` 产生设计类与研发类各一条。若不同产品需要不同模块或计划，按产品分开展示草稿，并说明分别创建后需要补链。
3. 新建日常需求用 `personal`，初始状态为草稿。只有用户明确要求直接激活才传 `skipReview: true`。AI 批量生成用 `strict-ai`，保留 AI 标注和草稿。用户反馈填 `feedbackBy`，同时明确反馈来源，例如 `source: "user"`。已有用户需求可传 `requirementId`，预检时核对其详情。
4. 批量移交接受 1–100 条需求。每条最少含 `title` 和 `spec`，按预检结果补齐禅道要求的模块、负责人和 `verify`。CLI 用 `bzt import --file <path>` 或 `bzt import --stdin`。把逐条草稿及问题交给用户确认，再使用完全相同的输入实写。
5. 指派和软删除先用 `get_story_progress` 预览需求 ID、链接、标题和当前状态，指派另核对目标账号。取得用户对具体操作的明确确认后调用 `assign_story` 或 `delete_story`。只有用户明确确认软删除时才传 `confirm: true`。
6. 获得用户对本次草稿的明确批准后，才能在 `create_story` 和 `import_stories` 传 `dryRun: false`。确认只覆盖用户已查看的产品、条目及字段。草稿发生变化时重新预检和确认。

## 汇报回执

逐条报告产品、标题或类别、ID 和链接、字段回读、指派、关联与待人工处理的情况。批量任务说明已返回 ID 的条数、失败条数和回读未确认条数。

- `readbackConfirmed=false` 或 `assignResult.confirmed=false` 时，禁止重试创建。交给用户已有 `id` / `url`，用现有记录核对字段和实际负责人。若创建响应连 ID 都未取得，先按标题和批次搜索核对。
- 回执有 `linkError` 时保留已建 ID，说明需要核查和人工补链。
- `deleted=true` 才能汇报软删除已确认。管理员可从回收站恢复。
