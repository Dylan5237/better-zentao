# Phase 1 (MVP) 精确实现规格说明书

> 本文档为 `better-zentao` Phase 1（MVP）的权威实现契约，供 Codex / Claude Code 按契约编码，并作为评审验收基准。所有接口细节均来自 `docs/research/2026-11-19-zentao-22.6-api-probe.md` 实测结论。

---

## 一、目录结构与包配置

```text
better-zentao/
├── package.json                 # name: "better-zentao", type: "module", bin: bzt & better-zentao-mcp
├── tsconfig.json                # NodeNext / ESM / strict: true / outDir: dist
├── vitest.config.ts
├── .env.example                 # 脱敏配置模板
├── better-zentao.example.json   # 可选业务偏好模板（三态默认产品、双模式、团队别名）
├── src/
│   ├── index.ts                 # 公共库导出（供未来 HTTP Adapter / 脚本复用）
│   ├── core/
│   │   ├── errors.ts            # ZentaoError, ConfigError, InvalidParamError, ZentaoApiError, ZentaoAuthExpiredError, ZentaoCreateUnconfirmedError
│   │   ├── config.ts            # 三级配置解析（参数 > 环境变量 > profile JSON > 默认值）+ personal/strict-ai 双模式
│   │   ├── http.ts              # Token single-flight、401防踩踏、v1/v2路由、超时、安全观测回调
│   │   ├── normalizer.ts        # 用户引用归一化（保留 account + realname）、日期有效性判定、安全DTO裁剪工具
│   │   └── ai-mark.ts           # strict-ai 模式的标题前缀、sourceNote、幂等描述头注入
│   ├── api/
│   │   ├── types.ts             # 干净的领域 DTO 类型（严禁透传 v2 原始大对象）
│   │   ├── org.api.ts           # v1/user(self), v1/departments, v2/users(全量), v2/company/browse(按部门)
│   │   ├── product.api.ts       # v1/products, v1/products/{id}?fields=moduleOptionMenu, v1/products/{id}/plans(展平L2->L3), v2/story/create(只读元数据)
│   │   ├── story.api.ts         # v1/requiredFields, v1/products/{id}/stories(HTTP 201), v1/stories/{id}, v2/product/browse(requirement), v2/requirement/view, create(v1/v2+回读), assign(独立端点+回读), delete(软删+回读), linkStory(互链), requirementLinkStory
│   │   ├── execution.api.ts     # v2/executions(活跃执行), v1/executions/{id}/tasks(分页+status过滤), v1/tasks/{id}(多人任务team详情)
│   │   └── my.api.ts            # v2/my/work, v2/my/contribute（严格 DTO 白名单投影）
│   ├── services/
│   │   ├── directory.service.ts # TTL缓存（用户/部门/产品/模块/L2-L3计划/活跃执行）+ 中文/拼音/模糊解析与歧义标记
│   │   ├── tracking.service.ts  # getMyDashboard, getTeamOverdue, queryStories, getStoryProgress
│   │   └── intake.service.ts    # createStory(单态/多态states/设计+研发双单/用户需求关联/dryRun), importStories, assignStory, deleteStory
│   └── adapters/
│       ├── tools/
│       │   ├── index.ts         # 汇总 9 个 ToolDef（schema + description + handler）
│       │   ├── resolve.tool.ts
│       │   ├── tracking.tools.ts
│       │   └── intake.tools.ts
│       ├── mcp-factory.ts       # createBetterZentaoMcpServer(clientOrFactory, options) — 保留 remote/redaction 扩展点
│       ├── mcp-stdio.ts         # bin: better-zentao-mcp（stdout 纯 JSON-RPC，启动诊断打 stderr）
│       └── cli.ts               # bin: bzt（极薄壳，共享 TOOL_DEFS，支持 --json，退出码 0/1/2）
├── skills/
│   └── better-zentao/
│       └── SKILL.md             # 本地 Agent 通用操作规约（写前 dryRun 确认、三态规则、汇报模板）
├── docs/
│   └── onboarding/
│       └── local-agent-setup.md # Antigravity / Codex / Claude Code 三端接入模板
├── scripts/
│   ├── smoke-local.mjs          # 本地 Mock 禅道 + 真实 stdio MCP + CLI 全链路联调
│   ├── smoke-readonly.mjs       # 内网禅道 22.6 零写入只读验收脚本
│   └── smoke-write-p29.mjs      # 仅在用户显式批准后针对 #29 执行的单条受控写冒烟（用完即删）
└── test/                        # Vitest 单元测试与契约测试（映射 TC-* 用例编号）
```

---

## 二、配置与双模式契约（`src/core/config.ts`）

### 2.1 配置优先级
`构造参数 > 环境变量 > 本地 profile JSON（可选） > 内置默认值`

### 2.2 环境变量
| 变量 | 必填 | 默认值 | 说明 |
| :--- | :--- | :--- | :--- |
| `ZENTAO_BASE_URL` | 是 | - | 禅道根地址，自动去尾 `/` |
| `ZENTAO_ACCOUNT` | 是 | - | 登录账号 |
| `ZENTAO_PASSWORD` | 是（非 tokenOnly 时） | - | 仅从环境注入，绝不落盘、绝不输出 |
| `ZENTAO_PROFILE_PATH` | 否 | `./better-zentao.local.json` | 可选业务偏好文件路径（不存在时静默忽略） |
| `ZENTAO_MODE` | 否 | `personal` | `personal` \| `strict-ai` |
| `ZENTAO_TIMEOUT_MS` | 否 | `30000` | 单请求超时毫秒 |
| `ZENTAO_PRODUCT_ID` | 否 | 无 | 可选显式默认产品 ID |
| `ZENTAO_CACHE_TTL_MS` | 否 | `600000` | DirectoryService 内存缓存 TTL（默认 10 分钟） |

### 2.3 `better-zentao.local.json` 结构（全部字段可选）
```ts
export interface BetterZentaoProfile {
  mode?: "personal" | "strict-ai";
  defaults?: {
    designProductId?: number;   // 默认 42（天宫平台（正式））
    runtimeProductId?: number;  // 默认 43（OneLink 7.0（正式））
    deliveryProductId?: number; // 默认 44（运营交付平台（正式），预留扩展位）
    defaultPri?: 1 | 2 | 3 | 4; // 默认 2
    defaultCategory?: "feature" | "design"; // 默认 "feature"
  };
  aiMark?: {
    source?: string;            // 默认 "ai"
    sourceNotePrefix?: string;  // 默认 "AI-Agent"
    titlePrefix?: string;       // 默认 "[AI创建] "
  };
  teams?: Record<string, { department?: string; members?: string[] }>;
}
```

### 2.4 双模式行为差异
- **`personal`（默认）**：
  - 不加 `[AI创建] ` 标题前缀，不注入描述头 AI 声明；
  - `source` 按传入值写入（缺省为空串）；支持 `feedbackBy`；
  - 默认 `status: "draft"`；若显式传 `skipReview: true` 则传 `status: "active"`（并在回读中核对实际状态）。
- **`strict-ai`**：
  - 强制注入 `[AI创建] ` 标题前缀、`source: "ai"`、`sourceNote`（`${prefix}-${YYYYMMDD}-${batch|HHMMSS}`）与幂等描述头 AI 声明；
  - 强制 `status: "draft"`；传入 `skipReview: true` 时必须直接抛出 `InvalidParamError` 拒绝。
- **两种模式共同红线**：
  - `create_story` / `import_stories` 默认 `dryRun: true`；
  - 写前强制 `/requiredFields` + `moduleOptionMenu` 预检；
  - 写后强制 GET 回读；已返回 ID 但回读或指派未确认时，保留 ID/URL 并禁止重试创建；
  - `delete_story` 必须 `confirm: z.literal(true)`。

---

## 三、禅道 22.6 API 适配层精确规则（`src/api/`）

实现时必须严格遵守以下已实测行为（禁止凭通用 REST 文档臆测）：

1. **HTTP 传输（`src/core/http.ts`）**：
   - Token 获取：`POST /api.php/v1/tokens`（`{ account, password }`），请求头使用 `Token: <token>`；
   - `tokenFlight` single-flight 防并发重复登录；收到 401 时仅当 `this.token === usedToken` 才清空并重取一次；
   - **重要**：`GET /api.php/v1/products/{id}/stories` 成功返回 HTTP **`201`**，所有 `res.ok`（2xx）均视为成功；
   - `tokenOnly` 模式（为 Phase 3 远程服务预留）须设置 `redirect: "error"` 并在 401 时抛 `ZentaoAuthExpiredError`。
2. **DTO 白名单投影（安全红线）**：
   - `org.api.ts`：`v2/users?recPerPage=3000&pageID=1`（按 `pager.pageTotal` 自动翻页以防未来超 3000 人）仅提取 `{ id, account, realname, dept, role, pinyin, deleted }`，过滤 `deleted === 1`；
   - `org.api.ts`：`v2/company/browse?param={deptId}&type=bydept&recPerPage=500` 仅提取上述用户字段；
   - `my.api.ts`：`v2/my/work` 与 `v2/my/contribute` 必须使用 `browseType=` 参数（非 `type=`），**严禁提取或保留 `users` 全量字典与 `user.password` 字段**，仅投影 `todoCount`、`pager` 与精简业务项数组（注意 v2 在单条/多条时列表可能是对象 map `{ "2711": {...} }` 也可能是数组 `[]`，必须兼容 `Array.isArray(x) ? x : Object.values(x ?? {})`！）。
3. **产品与计划树（`product.api.ts`）**：
   - `v1/products/{id}/plans?limit=200` 返回的父计划（`parent: -1`）将 L3 子计划嵌套在 `children[]` 中；适配器须输出保留 `parentId`、`parentTitle`、`level: "L2" | "L3" | "standalone"` 的扁平列表，并从标题 `【([^】]+)】` 提取可选 `ownerHint`；
   - 按月份匹配计划（如 `"2026-11"`）时，优先判定 `[begin, end]` 与目标月份起止区间是否重叠（忽略 `"待定"` / 空日期），无有效日期时再回退标题正则匹配。
4. **需求读写与关联（`story.api.ts`）**：
   - 类别枚举：同时接受 22.6 现网定制枚举 `STORY_WRITE_CATEGORIES = ["feature", "design"]`（注：查询历史需求时容忍任意字符串如 `"interface"`）；
   - 列表查询：`GET /api.php/v1/products/{id}/stories` 仅传 `status=unclosed`（查非关闭）或 `status=all`（查含已关闭），**绝不把 `active/draft/closed/changing/reviewing` 直接传给禅道**，而是在客户端侧过滤；
   - 用户需求（`type="requirement"`）列表查询走 `GET /api.php/v2/product/browse?productID={id}&storyType=requirement&recPerPage=...&pageID=...`；
   - 用户需求详情走 `GET /api.php/v2/requirement/view?storyID={id}`（因 `v1/stories/{reqId}` 返回 400）；
   - 创建需求：
     - 预检 `GET /api.php/v1/requiredFields` + `GET /api.php/v1/products/{id}?fields=moduleOptionMenu`；
     - Payload 必含 `reviewer: []`、`type: "story"`、`status: "draft"`（或 `personal` 模式显式 `skipReview: true` 时 `"active"`）；可选携带 `plan`、`feedbackBy`、`verify`、`pri`、`category`、`source`、`sourceNote`；
     - 当 `requiredFields.story.create.fields` 包含 `assignedTo` 时走 `POST /api.php/v2/stories?productID={productId}`，且**同时写入 `module: moduleId` 和 `modules: [moduleId]`**；否则走 `POST /api.php/v1/products/{productId}/stories`；
     - 响应校验：非对象、无正整数 `id`、或 v2 `status !== "success"` 一律抛 `ZentaoCreateUnconfirmedError`（仅含安全元数据）；
     - 回读确认：`GET /api.php/v1/stories/{id}` 校验 `id / product / title / module / status / verify`（`strict-ai` 额外校验 `source / sourceNote`；若填了 `plan` / `feedbackBy` 则一并核对并报告差异），回读失败不重试，置 `readbackConfirmed: false`；
   - 关联能力：
     - 需求互链：`linkStories(storyId, targetStoryIds)` 走 `POST /api.php/v2/story/linkStory?storyID={storyId}`；
     - 关联用户需求：`linkRequirementToStories(requirementId, storyIds)` 走 `POST /api.php/v2/requirement/linkStory?storyID={requirementId}`；
     - **降级红线**：关联发生在主需求已创建之后；若关联请求失败，**严禁抛出整体失败诱使重试创建**，必须在回执中保留已创建需求 `id`/`url` 并附 `linkError` 与人工补链提示。
5. **执行与任务（`execution.api.ts`）**：
   - 活跃执行列表：`GET /api.php/v2/executions?recPerPage=200&pageID=1`（按 `pager.pageTotal` 翻页），白名单投影 `{ id, name, project, projectName, status, begin, end, delay, progress, totalLeft }`；
   - 执行下任务：`GET /api.php/v1/executions/{id}/tasks?limit=200&page=1[&status=undone|delayed]`（自动翻页，并发池限流默认 `concurrency = 8`）；
   - 多人协作任务详情：`GET /api.php/v1/tasks/{id}` 提取 `team[]` 并用 `DirectoryService` 将 `team[].account` 映射回真实 `realname`（修复禅道 `team[].realname` 返回数字 ID 的 Bug）。

---

## 四、9 个 MVP 工具契约（`src/adapters/tools/`）

每个工具同时暴露为 MCP Tool 和 `bzt` CLI 子命令，均返回结构化 JSON（所有需求/任务/计划条目均附带可点击禅道 Web URL）。

| # | MCP Tool | `bzt` 命令 | 核心入参 | 核心出参要点 |
| :--- | :--- | :--- | :--- | :--- |
| 1 | `resolve_context` | `bzt resolve` | `{ query, kinds?: ("user"\|"department"\|"product"\|"module"\|"plan"\|"execution")[], product? }` | 按类别返回匹配候选（`exact` / `fuzzy`）、`ambiguous: boolean`；查产品时附带其活跃 L3 计划与模块摘要 |
| 2 | `get_my_dashboard` | `bzt me` | `{ upcomingDays?: number (默认 3) }` | `me: { account, realname, deptName }`, `todoCount`, `overdueTasks[]`, `upcomingTasks[]`, `assignedStories[]`, `openedStories[]`, `summary` |
| 3 | `get_team_overdue` | `bzt overdue` | `{ team?, department?, members?: string[], includeParentTasks?: boolean (默认 false), includeMultiUserDetail?: boolean (默认 true) }` | `scope`, `asOfDate`, `totalOverdueTasks`, `affectedMembersCount`, `byMember: [{ account, realname, deptName, overdueCount, maxOverdueDays, tasks[] }]`, `unresolvedMembers[]` |
| 4 | `query_stories` | `bzt stories` | `{ product?, state?: "design"\|"runtime"\|"delivery", keyword?, category?, status?, stage?, plan?, assignedTo?, openedBy?, feedbackBy?, storyType?: "story"\|"requirement" (默认 "story"), limit?: number (默认 30, 最大 200), maxScanPages?: number (默认 10) }` | `product`, `totalScanned`, `truncated: boolean`, `matchedCount`, `stories: [{ id, title, type, category, categoryLabel, status, statusLabel, stage, stageLabel, pri, planId, planTitle, assignedTo, openedBy, feedbackBy, url }]` |
| 5 | `get_story_progress` | `bzt progress` | `{ storyId?, requirementId?, feedbackBy?, product?, includeActions?: boolean (默认 false) }`（三选一必填） | 需求详情 + 中文阶段 + 所属 L3 计划 + 关联任务（**补齐 `deadline`/`left`/`overdueDays`**）+ 逾期统计 + **`feedbackSummary`（面向反馈者的可直接复制进度摘要文本）** |
| 6 | `create_story` | `bzt create` | `{ product?, state?: "design"\|"runtime"\|"delivery", states?: ("design"\|"runtime"\|"delivery")[], createDevPair?: boolean, title, spec, verify?, category?: "feature"\|"design", pri?: 1\|2\|3\|4, module?, plan?, assignTo?, feedbackBy?, source?, batch?, requirementId?, mode?: "personal"\|"strict-ai", skipReview?: boolean, dryRun?: boolean (默认 true) }` | `dryRun=true`: `{ dryRun: true, allOk, warnings[], drafts: [{ product, resolvedModule, resolvedPlan, resolvedAssignTo, payloadPreview, errors[], warnings[], availableModules?, candidatePlans[] }] }`；`dryRun=false`: 每条创建结果含 `id / url / readbackConfirmed / assignResult / linkResult / notice` |
| 7 | `import_stories` | `bzt import` | `{ product?, state?, stories: [...](1..100, strictObject), mode?, dryRun?: boolean (默认 true) }` | 延续旧版移交协议 + 中文实体解析 + L3 计划预警；`dryRun=false` 逐条落库、部分失败不中断、单独报告 `created / failed / readbackUnconfirmed` |
| 8 | `assign_story` | `bzt assign` | `{ storyId, assignedTo (账号或中文名), comment? }` | 独立 `/assign` + GET 回读确认，`confirmed=true` 才代表已落库 |
| 9 | `delete_story` | `bzt delete` | `{ storyId, confirm: true }` | Zod `z.literal(true)` 守卫 + 软删除回读 `deleted` 状态与回收站恢复提示 |

### CLI（`bzt`）规范
- 全局支持 `--json`（输出与 MCP 一致的结构化 JSON）与 `--help`；
- 退出码：`0` 成功；`1` 运行时/API/批量条目级失败；`2` 参数/用法错误（含缺少 `--confirm`、非法或重复 `--dry-run`）；
- `bzt import` 支持 `--file <path>` 或 `--stdin`（二选一），采用单遍严格 `--dry-run` 解析（未传或 `--dry-run=true` 均为 dryRun，仅显式 `--dry-run=false` 实写）。

---

## 五、本地 Agent 接入与 `SKILL.md` 交付要求

1. `skills/better-zentao/SKILL.md` 必须明确规定：
   - 所有写操作（`create_story` / `import_stories` / `delete_story`）必须**先执行 `dryRun=true`（或列草稿）并征得用户明确确认**后再提交实写；
   - 遇到重名人员、模糊模块、未填 L3 计划、或跨三态（天宫 `#42` / OneLink `#43` / 运营交付 `#44`）不明确时，主动结合候选列表向用户确认；
   - `readbackConfirmed=false` 或 `assignResult.confirmed=false` 时，禁止重试创建，必须给出已建 `id`/`url` 让用户核查；
   - 反馈者问进度时优先用 `get_story_progress` 输出简明中文进度卡片。
2. `docs/onboarding/local-agent-setup.md` 提供 Antigravity、Codex（`config.toml` + `env_vars = ["ZENTAO_PASSWORD"]`）、Claude Code（`.mcp.json` / `claude mcp add`）三端即插即用配置模板，**密码只走进程环境转发，绝不写入配置文件**。
