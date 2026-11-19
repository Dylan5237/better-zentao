# Phase 2 精确实现规格说明书（管理视角分析引擎 + 高效拆任务）

> 本文档为 `better-zentao` Phase 2 的权威实现契约，建立在已合入 `main` 的 Phase 1 MVP（9 工具 + 4 层架构）之上，新增 **4 个高内聚工具**（总工具数 9 → 13），完整覆盖产品管理 L3 计划视角、研发主管月度 3 桶过滤与迭代力度、复合规则 5 类全链路风险巡检，以及设计/研发高效拆任务与 L4 子任务能力。
>
> 接口与源码实测依据见 `docs/research/2026-11-19-zentao-22.6-api-probe.md`（含第六节 Phase 2 实测补充）。

---

## 一、新增与扩展模块布局（严守 4 层单向依赖）

```text
src/
├── core/
│   ├── config.ts                 # 扩展 optional riskRules（graceWorkdays / staleDays / stageKeywords）
│   └── normalizer.ts             # 补充工作日计算 workdaysBetween(fromDay, toDay)
├── api/
│   ├── types.ts                  # 新增 Project、TaskCreatePayload、SubtaskBatchItem、ExecutionCreateMeta 等 DTO
│   ├── product.api.ts            # 新增 planStories(planId)（走 v2/productplan/view，严格白名单投影）
│   ├── execution.api.ts          # 新增 projects()、executionStories(executionId)、taskRequiredFields()、taskCreateMeta(executionId)、linkStoryToExecution(executionId, storyIds)、createTask(...)、createSubtasks(...)、deleteTask(...)（均为 DTO 白名单 + 回读）
│   └── projection.ts             # 补充 task 的 estStarted、finishedDate、estimate、childrenIds 投影
├── services/
│   ├── directory.service.ts      # 新增 projects() 缓存与 projectExecutions / productExecutions 映射能力
│   ├── inputs.ts                 # 新增 4 个工具的严格 Zod Schema（planProgressInput / devQueueInput / risksInput / decomposeInput）
│   ├── task-classifier.ts        # 纯函数：复合任务环节分类器（design / devel / test / acceptance / delivery / other）+ 工作日判定
│   ├── management.service.ts     # 核心新增：getPlanProgress、getMonthlyDevQueue、scanWorkflowRisks
│   └── task.service.ts           # 核心新增：decomposeStoryToTasks（single / design_template / dev_handoff / subtasks）
└── adapters/
    └── tools/
        ├── management.tools.ts   # 新增 get_plan_progress / get_monthly_dev_queue / scan_workflow_risks
        ├── task.tools.ts         # 新增 decompose_story_to_tasks
        └── index.ts              # 汇总全部 13 个 ToolDef（MCP + bzt CLI 自动共享）
```

**架构红线**：
- `services/management.service.ts`、`services/task.service.ts`、`services/task-classifier.ts` 严禁依赖 MCP SDK 或 `process.argv`；
- 所有新增 v2 接口（`v2/productplan/view`、`v2/task/create`、`v2/task/batchCreate`、`v2/execution/linkStory`）必须在 `src/api/` 做显式 DTO 白名单投影，绝不透传 `users` 全量字典或敏感字段。

---

## 二、配置扩展（`src/core/config.ts`）

在 `BetterZentaoProfile` 与 `BetterZentaoConfig` 中新增可选 `riskRules`（全部有开箱默认值，零配置可跑）：

```ts
export interface RiskRulesConfig {
  devDoneWithoutTestGraceWorkdays: number; // 默认 1（研发完成后超 1 个工作日无测试才告警）
  staleUnassignedDays: number;             // 默认 3（入本月计划超过 3 天未拆任务告警）
  stageKeywords: {
    design: string[];     // 默认 ["调研", "概要", "详设", "原型", "评审", "传递", "UI"]
    test: string[];       // 默认 ["测试", "用例"]
    acceptance: string[]; // 默认 ["验收"]
    delivery: string[];   // 默认 ["交付", "培训", "手册"]
  };
}
```

---

## 三、新增禅道 22.6 API 适配契约（`src/api/`）

1. **`ProductApi.planStories(planId: number)`**：
   - 调用 `GET /api.php/v2/productplan/view?planID={planId}`；
   - 兼容 `planStories` 为对象 Map 或数组，用 `projection.ts` 的 `story()` 投影为 `Story[]`（彻底剥离 `users` 等冗余字段）。
2. **`ExecutionApi.projects()`**：
   - 调用 `GET /api.php/v1/projects?limit=100&page=1`（自动翻页），白名单投影 `{ id, name, status, model, begin, end, pm, executionCount, storyCount }`。
3. **`ExecutionApi.executionStories(executionId: number)`**：
   - 调用 `GET /api.php/v1/executions/{executionId}/stories?limit=200&page=1`（自动翻页），投影为 `Story[]`。
4. **`ExecutionApi.taskRequiredFields()`**：
   - 调用 `GET /api.php/v1/requiredFields`，提取 `task.create.fields`（与 `task.batchcreate.fields`）并校验字段名合法性。
5. **`ExecutionApi.taskCreateMeta(executionId: number)`**：
   - 调用 `GET /api.php/v2/task/create?executionID={executionId}`，仅白名单投影：
     - `modules: Module[]`（从 `modulePairs` 转换）；
     - `linkedStoryIds: number[]`（从 `stories` 键提取正整数 ID）；
     - `memberAccounts: string[]`（从 `members` 键提取）。
6. **`ExecutionApi.linkStoryToExecution(executionId: number, storyIds: readonly number[])`**：
   - 调用 `POST /api.php/v2/execution/linkStory?objectID={executionId}`（**参数名必须为 `objectID`**），body `{ stories: [...storyIds] }`，`replayUnauthorized: false`。
7. **`ExecutionApi.createTask(executionId: number, payload: TaskCreatePayload)`**：
   - 调用 `POST /api.php/v1/executions/{executionId}/tasks`，`replayUnauthorized: false`，**接受 HTTP 200/201**；
   - 无有效正整数 `id` 或响应异常时抛 `ZentaoCreateUnconfirmedError`（安全元数据，禁止重试创建）；
   - 创建返回 ID 后立即调用 `GET /api.php/v1/tasks/{id}` 回读核对 `id / executionId / name / type / assignedTo / storyId / module / estStarted / deadline`，不一致或回读失败保留 `id`/`url` 置 `readbackConfirmed: false`，**严禁重试创建**。
8. **`ExecutionApi.createSubtasks(executionId: number, parentTaskId: number, storyId: number, moduleId: number, items: SubtaskBatchItem[])`**：
   - 调用 `POST /api.php/v2/task/batchCreate?executionID={executionId}&storyID={storyId}&moduleID={moduleId}&taskID={parentTaskId}`，`replayUnauthorized: false`；
   - Payload 按禅道 22.6 表单数组结构组织：`{ parent: items.map(() => parentTaskId), module: ..., story: ..., name: ..., type: ..., assignedTo: ..., estimate: ..., estStarted: ..., deadline: ..., pri: ..., desc: ... }`；
   - 从响应 `changes.objectList`（兼容数组或对象值）提取新建子任务 IDs；随后调用 `GET /api.php/v1/tasks/{parentTaskId}` 与子任务回读确认，失败保留已知 IDs 置 `readbackConfirmed: false`，**严禁重试创建**。
9. **`ExecutionApi.deleteTask(taskId: number)`**：
   - 调用 `DELETE /api.php/v1/tasks/{taskId}`（`replayUnauthorized: false`），并回读 `GET /api.php/v1/tasks/{taskId}` 校验 `deleted === true`（供受控写冒烟清理使用，不在 Phase 2 暴露为无守卫公共删除工具）。

---

## 四、核心业务规则与 4 个新增工具契约

### 4.1 复合任务环节分类器（`src/services/task-classifier.ts`）

因现网实测大量“原型设计”“功能验收”任务沿用了禅道默认 `type="devel"`，所有风险与进度聚合必须使用统一纯函数 `classifyTaskStage(task, context)`：
- **输入**：`task`、`storyCategory`（`"design" | "feature" | string`）、`executionName`、`assigneeRole`、`stageKeywords`；
- **判定优先级**（按顺序命中即止，确保确定性、无歧义）：
  1. `task.type === "test"` 或标题命中 `stageKeywords.test`（且非“测试验收”）→ `"test"`；
  2. 标题命中 `stageKeywords.delivery`（交付/培训/手册）→ `"delivery"`；
  3. 标题命中 `stageKeywords.acceptance`（验收）→ `"acceptance"`；
  4. `task.type === "design" || task.type === "ui" || task.type === "study"`，或 `storyCategory === "design"`，或所在迭代名含 `【设计】`/`设计迭代`/`UI设计`，或标题命中 `stageKeywords.design` → `"design"`；
  5. `task.type === "devel"` → `"devel"`；
  6. 其他 → `"other"`。
- **工作日计算 `workdaysBetween(fromDay, toDay)`**：计算两个 `dayNumber` 之间的工作日差（严格排除周六、周日；`toDay <= fromDay` 返回 `0`）。

### 4.2 工具 10：`get_plan_progress` / `bzt plan-progress`（产品管理 L3 计划看板）

- **入参**：
  ```ts
  {
    product?: string | number,
    state?: "design" | "runtime" | "delivery",
    month?: string,               // YYYY-MM，按日期重叠优先匹配，待定回退标题月份
    owner?: string,               // 按 L3 计划 ownerHint 模糊匹配（如 "负责甲"）
    l2Plan?: string | number,     // 按 L2 父计划 ID 或关键词筛选
    includeClosedPlans?: boolean, // 默认 false
    includeTasks?: boolean,       // 默认 true（关掉可极速只看需求维度）
  }
  ```
- **核心逻辑**：
  1. 定位产品（默认遵循 `chooseProduct`：设计态 `#42`），拉取展平后的 L2/L3 计划列表；
  2. 筛选目标 L3 计划（或无子计划的 standalone 计划），同时拉取目标产品需求（`status="all"`，跨页安全上限默认 20 页）与（若 `includeTasks=true`）产品关联活跃迭代的叶子任务（按 `storyId` 建立索引，排除 `isParent === true`）；
  3. 按每个 L3 计划统计：
     - `totalStories`、`designStories`、`featureStories`；
     - `completedStories`（`status === "closed"` 或 `stage` 在 `["released", "delivered", "closed"]`）、`inProgressStories`、`notStartedStories`、`completionRate`（百分比 0–100，保留 1 位小数）；
     - `leafTaskCount`、`completedLeafTaskCount`、`overdueLeafTaskCount`；
  4. 汇总 `byL2`（按 L2 父计划聚合）与顶层 `summary`（总计划数、总需求数、总完成率、总逾期任务数、以及当前产品下未挂任何计划的活跃需求计数 `unplannedActiveStoriesCount`）。

### 4.3 工具 11：`get_monthly_dev_queue` / `bzt dev-queue`（研发主管月度 3 桶过滤 + 迭代力度）

- **入参**：
  ```ts
  {
    product?: string | number,
    state?: "design" | "runtime" | "delivery",
    month?: string,                  // YYYY-MM，默认当前本地月份
    includeDesignExecutions?: boolean, // 默认 false（过滤掉【设计】/UI设计迭代）
    staleDays?: number,              // 默认来自 riskRules.staleUnassignedDays (3)
  }
  ```
- **核心逻辑**：
  1. 确定目标产品与目标月份 `month`（如 `2026-11`）；
  2. 找出产品下 **本月 L3 计划**（`planMatchesMonth(plan, month)`）与 **上月及更早 L3 计划**；
  3. 找出与目标产品/项目关联的活跃执行（通过执行关联需求或执行 `productID`/`project` 匹配），区分为 **本月研发迭代**（日期重叠 `month` 且默认排除设计迭代）与 **历史未关闭研发迭代**（`end < month-01`）；
  4. 筛选所有**未关闭的研发类需求**（排除 `category === "design"` 与 `status === "closed"`），并发拉取相关迭代任务（叶子任务去重），按 **3 桶** 互斥分层：
     - **`pendingDecomposition`（待拆解队列）**：属于本月 L3 计划（或本月研发迭代），且**尚未拆出任何 `devel` 阶段叶子任务**；附 `assignedTo`、`planTitle`、`openedDaysAgo`、`isStale`（超过 `staleDays`）；
     - **`inProgressThisMonth`（本月迭代在研中）**：已排入本月研发迭代且已有研发/测试任务在推进的研发类需求；附 `taskProgress`（已完成/总叶子任务）、`overdueTaskCount`、`currentStages[]`；
     - **`carryoverFromPrevious`（上月/历史遗留未完结）**：归属早于本月的 L3 计划或历史未关闭研发迭代、但仍未关闭的研发类需求；附 `originPlanTitle` / `originExecutionName`、`overdueTaskCount`；
  5. 输出 **`iterationIntensity`（迭代力度面板）**：按每个命中的研发迭代给出：
     - `executionId / name / projectName / status / begin / end / progress`；
     - `storyCount`、`decomposedStoryCount`、`storyDecompositionRate`（需求拆解覆盖率）；
     - `leafTaskCount`、`unfinishedTaskCount`、`overdueTaskCount`、`overdueRate`；
     - `totalEstimate`、`totalConsumed`、`totalLeft`；
     - `carryoverStoryCount`、`carryoverStoryRatio`（关联早于本月计划或顺延需求占比）；
     - `memberLoads`: `[{ account, realname, leafTaskCount, unfinishedCount, overdueCount, totalLeft }]`（按 `totalLeft` & `overdueCount` 降序）。

### 4.4 工具 12：`scan_workflow_risks` / `bzt risks`（复合规则 5 类全链路风险巡检）

- **入参**：
  ```ts
  {
    product?: string | number,
    state?: "design" | "runtime" | "delivery",
    month?: string,               // 可选，按月限定 L3 计划/迭代范围
    execution?: string | number,  // 可选，限定单迭代
    plan?: string | number,       // 可选，限定单 L3 计划
    riskTypes?: ("dev_done_no_test" | "tasks_done_story_open" | "story_no_plan" | "story_no_tasks" | "design_stalled")[],
    devDoneGraceWorkdays?: number, // 默认取配置 (1)
    staleDays?: number,            // 默认取配置 (3)
  }
  ```
- **5 类风险精确判定口径**（全部基于叶子任务与复合分类器 `classifyTaskStage`）：
  1. **`dev_done_no_test`**（高优 `high`）：
     - 前提：未关闭的**研发类需求**（`story.category !== "design"` 且非纯设计迭代）；
     - 存在 `>= 1` 条 `stage === "devel"` 叶子任务，且**全部** `devel` 任务为 `done / closed`；
     - **不存在**任何 `stage === "test"` 叶子任务；
     - 且最晚一条 `devel` 任务的 `finishedDate`（若缺失则回退 `deadline`）距今日的**工作日差** `workdaysBetween >= devDoneGraceWorkdays`（默认 1 个工作日）；
  2. **`tasks_done_story_open`**（中优 `medium`）：
     - 未关闭需求下存在 `>= 1` 条叶子任务，且**全部**叶子任务均为终态（`done / closed / cancel`）；
     - 额外在 `evidence` 中标出是否缺少 `acceptance`（验收）或 `delivery`（交付）环节任务；
  3. **`story_no_plan`**（中优 `medium`）：
     - `status` 为 `active / reviewing / changing` 的需求，`planIds.length === 0`（违反“所有研发需求都要关联计划”规范）；
  4. **`story_no_tasks`**（中优 `medium`）：
     - 已关联有效 L3 计划（若指定 `month` 则落在该月，否则计划已开始 `begin <= today`）的 `active` 需求，叶子任务数为 `0`，且距需求创建/计划开始已满 `staleDays` 天；
  5. **`design_stalled`**（高/中优）：
     - `story.category === "design"` 的未关闭设计类需求：其下设计任务有逾期（`high`），或无任务且滞留超过 `staleDays` 天仍处于 `wait / designing`（`medium`）。
- **出参**：`{ asOfDate, scope, summaryByType, totalRisks, highRiskCount, risks: [{ riskType, severity, storyId, storyTitle, category, stageLabel, planTitle?, owner, evidence, suggestedAction, url }] }`（按 `severity` 高优先、再按滞留/逾期天数倒序）。

### 4.5 工具 13：`decompose_story_to_tasks` / `bzt decompose`（高效拆任务与 L4 子任务）

- **入参**：
  ```ts
  {
    storyId: number,
    execution: string | number,   // 目标迭代 ID 或名称（走 DirectoryService 解析）
    mode: "single" | "design_template" | "dev_handoff" | "subtasks",
    parentTaskId?: number,        // mode === "subtasks" 时必填
    handoffStage?: "dev" | "cross_team_api" | "test" | "acceptance" | "delivery", // mode === "dev_handoff" 时必填
    tasks?: Array<{               // single/handoff 可选覆盖，subtasks 必填 1..20 条
      name?: string,
      type?: "design" | "devel" | "test" | "study" | "discuss" | "ui" | "affair" | "misc",
      assignTo?: string,          // 中文名/账号
      module?: string | number,   // 默认继承需求 module
      estStarted?: string,        // YYYY-MM-DD
      deadline?: string,          // YYYY-MM-DD
      estimate?: number,
      pri?: 1 | 2 | 3 | 4,
      desc?: string,
    }>,
    defaultAssignTo?: string,     // 模板批量拆解时的默认负责人（可被单条覆盖）
    defaultEstStarted?: string,   // YYYY-MM-DD
    defaultDeadline?: string,     // YYYY-MM-DD
    autoLinkStoryToExecution?: boolean, // 默认 true（实写时若需求未挂入该迭代则先自动 linkStory）
    dryRun?: boolean,             // 默认 true
  }
  ```
- **4 种模式草稿生成规则**：
  - **`single`（设计组 1-to-1 快捷转任务）**：生成 1 条任务，默认 `name = story.title`，`type = story.category === "design" ? "design" : "devel"`，`module = story.moduleId`，`pri = story.pri ?? 2`，`desc` 带入需求链接摘要；
  - **`design_template`（设计规范标准拆解）**：默认生成 5 条标准设计任务（`${title} - 需求调研`、`概要设计`、`原型设计`、`设计评审`、`需求传递`，`type: "design"`），若传入 `tasks` 则按传入项覆盖/裁剪；
  - **`dev_handoff`（研发/测试/验收/交付下游补建）**：
    - `dev` → `【研发】${title}`（`type: "devel"`）
    - `cross_team_api` → `【跨组接口】${title}`（`type: "devel"`）
    - `test` → `【测试】${title}`（`type: "test"`）
    - `acceptance` → `【产品验收】${title}`（`type: "misc"`，标题含“验收”）
    - `delivery` → `【交付培训】${title}`（`type: "misc"`，标题含“交付”“培训”）
  - **`subtasks`（L4 子任务）**：强制校验 `parentTaskId` 存在、未删除且属于目标 `execution`；至少传入 1 条子任务；实写走 `POST /v2/task/batchCreate?executionID=...&taskID={parentTaskId}`。
- **预检与写安全红线**：
  - `dryRun=true`（默认）：零写请求；校验需求存在、执行唯一解析、`task.create`（或 `batchcreate`）动态必填项、`module` 合法性（对照 `v2/task/create` 的 `modulePairs`）、负责人中文名解析、日期合法性（`estStarted <= deadline`），并显式返回 `needsExecutionLink: boolean` 及每条任务的 `payloadPreview`、`errors[]`、`warnings[]`；
  - `dryRun=false`：若 `allOk === false` 拒绝写入；若 `needsExecutionLink && autoLinkStoryToExecution`，先调 `linkStoryToExecution`（失败则直接中止创建并报告，避免产生孤立任务）；随后逐条创建并 GET 回读确认，**单条失败或回读未确认严禁重试创建**，保留所有已建 `id`/`url` 逐条回报。

---

## 五、CLI（`bzt`）与 `SKILL.md` 同步扩展

1. **`bzt` 新增 4 个子命令**（共享 `TOOL_DEFS`，支持 `--json` 与退出码 `0/1/2`）：
   - `bzt plan-progress [--product <p> | --state <s>] [--month YYYY-MM] [--owner <name>] [--l2-plan <ref>] [--include-closed-plans] [--include-tasks=true|false]`
   - `bzt dev-queue [--product <p> | --state <s>] [--month YYYY-MM] [--include-design-executions] [--stale-days <n>]`
   - `bzt risks [--product <p> | --state <s>] [--month YYYY-MM] [--execution <ref>] [--plan <ref>] [--risk-types <list>] [--dev-done-grace-workdays <n>] [--stale-days <n>]`
   - `bzt decompose <storyId> --execution <ref> --mode <single|design_template|dev_handoff|subtasks> [--parent-task-id <id>] [--handoff-stage <stage>] [--tasks-file <path> | --tasks-stdin] [--default-assign-to <user>] [--default-est-started YYYY-MM-DD] [--default-deadline YYYY-MM-DD] [--dry-run=true|false]`
2. **同步更新 `skills/better-zentao/SKILL.md`**：补充 4 个新工具的触发映射、研发主管/产品管理/风险巡检汇报规范，以及 `decompose_story_to_tasks` 必须先 `dryRun: true` 预览确认后再实写的硬门禁。
