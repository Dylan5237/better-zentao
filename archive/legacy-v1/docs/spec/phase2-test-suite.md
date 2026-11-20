# Phase 2 测试集与验收门禁清单

> 本测试集为 `better-zentao` Phase 2 的**强制验收标准**，在保持 Phase 1 全部 **67 个测试（49 个 `TC-*`）100% 回归通过**的基础上，新增 **36 个编号测试用例（`TC-P2-*`）**。实现时所有 Tier 1 ~ Tier 3 用例必须落地为自动化测试且标题包含对应 `TC-P2-*` 编号。

---

## 一、Tier 1：纯逻辑、配置与复合分类器单元测试（`test/core/` & `test/services/classifier.test.mjs`）

| 编号 | 测试场景 | 核心断言（验收标准） |
| :--- | :--- | :--- |
| `TC-P2-CORE-01` | `riskRules` 配置默认值与覆盖 | 零配置时 `devDoneWithoutTestGraceWorkdays=1`、`staleUnassignedDays=3`、4 组默认关键词齐备；支持通过 `better-zentao.local.json` 与构造参数部分覆盖 |
| `TC-P2-CORE-02` | 工作日计算 `workdaysBetween` | 跨普通工作日正确计数；周五→周一计为 **1 个工作日**（排除周六日）；周五→周日计为 **0 个工作日**；同日或逆序返回 `0` |
| `TC-P2-CORE-03` | 复合环节分类：默认 `type=devel` 防误报 | 现网真实混用场景：`type="devel"` + 标题含“原型设计评审”判为 `design`；`type="devel"` + 标题含“功能验收”判为 `acceptance`；`type="devel"` + 标题含“操作手册交付”判为 `delivery`；`type="devel"` + 普通开发标题判为 `devel` |
| `TC-P2-CORE-04` | 复合环节分类：显式类型与设计迭代优先级 | `type="test"` 必判 `test`；`storyCategory="design"` 或迭代名含 `【设计】` 下未命中测试/验收/交付的任务判为 `design`；自定义 `stageKeywords` 覆盖生效 |
| `TC-P2-CORE-05` | Phase 2 v2 接口 DTO 白名单裁剪 | Mock `v2/productplan/view`、`v2/task/create`、`v2/task/batchCreate`、`v2/execution/linkStory` 返回含 `password` 哈希与 2,086 人 `users` 字典；断言 API 层输出**绝对不含**敏感字段与冗余用户字典 |

---

## 二、Tier 2：管理视角引擎与拆任务领域单元测试（`test/services/`）

### 2.1 L3 计划看板（`get_plan_progress`）

| 编号 | 测试场景 | 核心断言（验收标准） |
| :--- | :--- | :--- |
| `TC-P2-PLAN-01` | 按月份（日期重叠优先）统计 L3 计划完成率 | 展平 L2→L3 树，命中本月有效日期计划（含标题无月份字样者），正确统计 `designStories / featureStories / completedStories / completionRate` |
| `TC-P2-PLAN-02` | 按负责人 `owner` 与 L2 父计划 `l2Plan` 过滤 | `owner` 匹配 `【负责人】` 前缀；`l2Plan` 支持传 L2 ID 或标题关键词过滤子计划，正确输出 `byL2` 分组汇总 |
| `TC-P2-PLAN-03` | L3 计划下任务与逾期聚合（父子去重） | 关联活跃迭代任务按 `storyId` 聚合到对应 L3 计划，父任务（`isParent=true`）不与子任务双算逾期；`includeTasks=false` 时零任务请求 |
| `TC-P2-PLAN-04` | 已归档计划过滤与未挂计划活跃需求统计 | 默认 `includeClosedPlans=false` 排除 `closed/done` 计划；`includeClosedPlans=true` 包含之；顶层准确报告产品内 `unplannedActiveStoriesCount` |

### 2.2 研发主管月度 3 桶过滤与迭代力度（`get_monthly_dev_queue`）

| 编号 | 测试场景 | 核心断言（验收标准） |
| :--- | :--- | :--- |
| `TC-P2-DEV-01` | 3 桶互斥分层准确性 | 同一产品下同时存在：① 本月 L3 研发需求未拆任务 → 进 `pendingDecomposition`；② 本月研发迭代已拆开发任务 → 进 `inProgressThisMonth`；③ 上月 L3/历史未关闭迭代遗留需求 → 进 `carryoverFromPrevious`；已关闭与 `category="design"` 设计类需求全部排除 |
| `TC-P2-DEV-02` | 待拆解队列滞留告警 | `pendingDecomposition` 准确计算 `openedDaysAgo` 并按 `staleDays` 标记 `isStale: true`，附上解析后的中文指派人与所属 L3 计划 |
| `TC-P2-DEV-03` | 默认排除设计迭代 & 显式包含切换 | 默认 `includeDesignExecutions=false` 排除 `【设计】`/`UI设计` 迭代；设为 `true` 时纳入统计 |
| `TC-P2-DEV-04` | 迭代力度指标与成员负载 | `iterationIntensity` 准确计算 `storyDecompositionRate`、`leafTaskCount`、`overdueRate`、`totalEstimate/Consumed/Left`、`carryoverStoryRatio` 与按人分组的 `memberLoads`（父子任务去重、中文姓名补全） |

### 2.3 复合规则 5 类流程风险巡检（`scan_workflow_risks`）

| 编号 | 测试场景 | 核心断言（验收标准） |
| :--- | :--- | :--- |
| `TC-P2-RISK-01` | `dev_done_no_test` 精确命中与工作日宽限期 | 研发类需求下 `devel` 任务全部 `done/closed` 且无 `test` 任务：周五完成、周一巡检（=1 个工作日）触发 `high` 告警；周五完成、周日巡检（=0 个工作日）**不误报**；已有 `test` 任务不报警 |
| `TC-P2-RISK-02` | `dev_done_no_test` 排除设计类与混用 `type=devel` 的设计/验收任务 | `category="design"` 需求下虽有 `type="devel"` 的“原型设计”已完成，**绝不误报** `dev_done_no_test`；研发需求仅完成“功能验收”（被分类为 `acceptance` 而非 `devel`）不误报 |
| `TC-P2-RISK-03` | `tasks_done_story_open` 与下游缺失提示 | 活跃需求下所有叶子任务已 `done/closed/cancel` 但需求未关闭 → 命中 `tasks_done_story_open`，`evidence` 明确提示缺少验收或交付任务 |
| `TC-P2-RISK-04` | `story_no_plan` 与 `story_no_tasks` | 未挂任何计划的活跃需求命中 `story_no_plan`；已入本月/已开始计划满 `staleDays` 仍零任务的活跃需求命中 `story_no_tasks`；刚入计划不足 `staleDays` 不误报 |
| `TC-P2-RISK-05` | `design_stalled` 设计类卡点 | 设计类需求下设计任务逾期报 `high`；无任务且滞留超 `staleDays` 仍处 `wait/designing` 报 `medium`；已 `designed` 不误报 |
| `TC-P2-RISK-06` | `riskTypes` 子集筛选与范围限定 | 支持只扫描指定 `riskTypes`、限定 `month` / `plan` / `execution`；输出按 `high` 优先排序且 `summaryByType` 合计等于 `totalRisks` |

### 2.4 高效拆任务与 L4 子任务（`decompose_story_to_tasks`）

| 编号 | 测试场景 | 核心断言（验收标准） |
| :--- | :--- | :--- |
| `TC-P2-TASK-01` | 默认 `dryRun=true` 预检与 9 项必填校验 | 零写请求；拉取 `/requiredFields`（`task.create`）与 `v2/task/create`（`modulePairs` / `stories`）；缺失 `estStarted`/`deadline`/`assignTo`/`desc` 时准确列出缺项并返回候选模块 |
| `TC-P2-TASK-02` | `single` 模式 1-to-1 快捷转任务 | 自动继承需求标题、模块、优先级与 `storyId`；`design` 需求默认 `type="design"`，`feature` 需求默认 `type="devel"`；实写走 `POST /v1/executions/{eid}/tasks`（兼容 HTTP 201）并 GET 回读确认 |
| `TC-P2-TASK-03` | `design_template` 5 步设计规范模板 | 自动生成需求调研/概要设计/原型设计/设计评审/需求传递 5 条草稿（`type="design"`），支持 `defaultAssignTo` 中文名转账号及单条覆盖 |
| `TC-P2-TASK-04` | `dev_handoff` 5 种下游流转模式 | `dev` / `cross_team_api` / `test` / `acceptance` / `delivery` 分别生成对应类型与规范前缀任务（如 `test`→`type="test"`、`acceptance` 含“验收”、`delivery` 含“交付培训”） |
| `TC-P2-TASK-05` | 自动关联需求到执行（`needsExecutionLink`） | 需求不在 `taskCreateMeta.stories` 中时，`dryRun` 标明 `needsExecutionLink: true`；实写时先调用 `POST /v2/execution/linkStory?objectID={eid}`（body `{ stories: [storyId] }`）再建任务；若关联失败则**中止建任务**并报告错误（零孤立任务） |
| `TC-P2-TASK-06` | `subtasks` L4 子任务创建与父任务校验 | 缺失 `parentTaskId` 或父任务不属于目标执行/已删除时拒绝；实写走 `POST /v2/task/batchCreate?executionID=...&taskID={parentTaskId}` 并回读父任务与子任务确认，不走不支持 `parent` 的 v1 创建接口 |
| `TC-P2-TASK-07` | **防重红线：任务创建未确认 / 回读失败绝不重试** | 单条任务 POST 返回非任务对象/空体/网络异常抛 `ZentaoCreateUnconfirmedError`；返回 ID 但 GET 回读失败或字段不一致时保留 `id`/`url` 置 `readbackConfirmed: false`，POST 严格只发 1 次；多条拆解单条失败继续处理后续并逐条报告 |

---

## 三、Tier 3：Adapter、CLI 与 Skill 集成测试（`test/adapters/` + `scripts/smoke-local.mjs`）

| 编号 | 测试场景 | 核心断言（验收标准） |
| :--- | :--- | :--- |
| `TC-P2-ADP-01` | MCP 13 工具发现与元数据 | 真实 stdio `better-zentao-mcp` 握手 `tools/list` 精确列出全部 **13 个工具**（原 9 + 新 4），前 3 个新工具 `readOnlyHint: true`，`decompose_story_to_tasks` `readOnlyHint: false` |
| `TC-P2-ADP-02` | MCP 端到端调用 4 个新工具 | 对接本地 Mock 禅道跑通 `get_plan_progress`、`get_monthly_dev_queue`、`scan_workflow_risks`、`decompose_story_to_tasks`（`dryRun` + `single` + `subtasks`） |
| `TC-P2-ADP-03` | `bzt` 新增 4 子命令与 MCP JSON 一致性 | `bzt plan-progress`、`bzt dev-queue`、`bzt risks`、`bzt decompose` 加 `--json` 输出与对应 MCP 工具完全一致 |
| `TC-P2-ADP-04` | `bzt decompose` 参数解析与安全退出码 | 支持 `--tasks-file` / `--tasks-stdin` 二选一；非法或重复 `--dry-run` 早于文件读取退出码 `2`；`dryRun` 校验不通过退出码 `2`；实写条目失败退出码 `1` |
| `TC-P2-ADP-05` | `SKILL.md` 更新完整性 | `skills/better-zentao/SKILL.md` 覆盖全部 13 个工具名称，明确要求 `decompose_story_to_tasks` 写前必须 `dryRun: true` 预览确认，且无凭据泄露 |

---

## 四、Tier 4：内网禅道 22.6 现网验收门禁（`scripts/smoke-readonly.mjs` 扩展）

### Gate 4A：零写入只读现网冒烟（全自动运行，零写请求）

| 编号 | 现网验证项 | 验收通过标准 |
| :--- | :--- | :--- |
| `TC-P2-LIVE-01` | `#42` 天宫 L3 计划看板 | `get_plan_progress({ state: "design", month: "2026-11" })` 返回真实 L2→L3 计划与需求完成率，耗时 `< 4s`，零凭据/2086人字典泄露 |
| `TC-P2-LIVE-02` | `#42` & `#43` 研发主管月度队列与迭代力度 | `get_monthly_dev_queue({ state: "design", month: "2026-11" })` 正常输出 3 桶与 `iterationIntensity`，排除 `category="design"` 需求，耗时 `< 5s` |
| `TC-P2-LIVE-03` | `#42` 全链路风险巡检 | `scan_workflow_risks({ state: "design", month: "2026-11" })` 正常返回 5 类统计，确认不把 `category="design"` 误报为 `dev_done_no_test`，耗时 `< 5s` |
| `TC-P2-LIVE-04` | `decompose_story_to_tasks(dryRun=true)` | 针对 `#42` 真实需求 + `#189` 迭代分别执行 `single` / `design_template` / `dev_handoff` 预检，成功拿到 `task.create` 必填规则与 `modulePairs`，**全程零写请求** |

### Gate 4B：任务真实写入受控冒烟（⚠️ 约束）

| 编号 | 受控写验证项 | 验收条件 |
| :--- | :--- | :--- |
| `TC-P2-LIVE-05` | 单任务 + L4 子任务实写回读与清理 | **严禁向 `#179` / `#180` 等正式业务迭代写入测试任务**。仅当专用验证产品 `#29` 下已存在专用验证迭代时方可运行受控写冒烟并即刻软删除清理；若 `#29` 仍无验证迭代，本项标记为 `DEFERRED（无专用验证迭代，已由 Mock 与源码契约全覆盖）` |
