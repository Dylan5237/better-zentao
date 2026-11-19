# Phase 1 (MVP) 测试集与验收门禁清单

> 本测试集是 `better-zentao` Phase 1 的**强制验收标准**。Codex / Claude Code 实现时必须将 Tier 1 ~ Tier 3 全部测试用例落地为自动化 Vitest / 脚本测试，并在测试名称中保留 `TC-*` 编号；验收阶段由架构师逐条核验通过后方可合并至 `main`。

---

## 一、Tier 1：Core 传输、配置、双模式与安全单元测试（`test/core/`）

| 编号 | 测试场景 | 核心断言（验收标准） |
| :--- | :--- | :--- |
| `TC-CORE-01` | 三级配置优先级 | 构造参数 > 环境变量 > `better-zentao.local.json` > 内置默认值（三态默认产品 `42 / 43 / 44`、`mode="personal"`、`defaultPri=2`） |
| `TC-CORE-02` | 必填配置缺失报错 | 缺少 `ZENTAO_BASE_URL` / `ZENTAO_ACCOUNT` / `ZENTAO_PASSWORD` 时抛 `ConfigError`，`missingVars` 列出全部缺失变量名，错误信息绝不含任何凭据值 |
| `TC-CORE-03` | Token single-flight 并发登录 | 10 个并发请求同时触发无 Token 态时，仅发起 **1 次** `POST /api.php/v1/tokens`，所有请求共享同一 Token 且 Header 为 `Token: <val>`（非 `Authorization`） |
| `TC-CORE-04` | 401 自动刷新与防并发踩踏 | 请求 A 与 B 共用旧 Token T1；A 先遇 401 刷新为 T2，随后 B 的迟到 401 **不得清空 T2**；单次请求最多自动重放 1 次 |
| `TC-CORE-05` | `tokenOnly` 远程预留模式安全边界 | `initialToken` 模式下遇到 401 抛 `ZentaoAuthExpiredError`（不尝试用环境密码登录），fetch 显式带 `redirect: "error"` |
| `TC-CORE-06` | HTTP 201 兼容 | `GET /api.php/v1/products/42/stories` 返回 HTTP `201` 时正常解析 JSON，不误判为错误 |
| `TC-CORE-07` | **安全红线：v2 响应 DTO 白名单裁剪** | Mock `/v2/my/work`、`/v2/my/todo`、`/v2/users` 返回含 `user.password`（32 位哈希）及 2,086 人 `users` 字典的原始响应；断言各 API 方法输出中**绝对不存在** `password`、`resetToken` 字段及冗余全量用户字典 |
| `TC-CORE-08` | **安全红线：创建未确认诊断脱敏** | 模拟创建接口返回 HTTP 200 空体、`text/html`、JSON `null`、`{"error":"..."}` 或网络异常；抛 `ZentaoCreateUnconfirmedError`，消息包含安全元数据（status/mediaType/bytes/bodyKind）及“禁止重试创建”，**不包含原始响应正文、Token 或密码** |
| `TC-CORE-09` | `strict-ai` 标注与幂等头 | `strict-ai` 模式下生成 `[AI创建] ` 前缀、`source="ai"`、`sourceNote` 批次号与描述头声明；已有完整声明头重跑时替换为新批次号而非叠加两层头；伪造/残缺前缀不被当作已标注 |
| `TC-CORE-10` | `personal` 模式纯净输出 | `personal` 模式下标题无 `[AI创建] ` 前缀，描述体不被注入 AI 声明头，`source` 保留调用方传值 |

---

## 二、Tier 2：目录缓存、只读业务与写入域单元测试（`test/services/`）

### 2.1 组织与实体目录（`DirectoryService`）

| 编号 | 测试场景 | 核心断言（验收标准） |
| :--- | :--- | :--- |
| `TC-DIR-01` | 全量用户 v2 翻页与缓存 TTL | 模拟 `pager.pageTotal = 2`（使用 `recPerPage` & `pageID`）正确拉齐全部用户，过滤 `deleted=1`；TTL 内二次查询零 HTTP 请求，TTL 过期后重新拉取 |
| `TC-DIR-02` | 中文名 / 拼音 / 账号解析与重名歧义 | 精确匹配账号、中文姓名、拼音；遇到 2 个同姓/重名候选时返回 `ambiguous: true` 与全部候选（含部门路径与角色），禁止静默任选其一 |
| `TC-DIR-03` | 424 节点嵌套部门树展平 | 递归展平 `v1/departments` 的 `items[]`，正确生成完整面包屑路径，支持按部门名模糊查找及返回本部门及子部门成员 |
| `TC-DIR-04` | L2 → L3 计划树展平与负责人提取 | 正确展平 `parent: -1` 父计划下的 `children[]`，保留 `parentId / parentTitle / level`；从 `【张三】2026年11月...` 正确解析 `ownerHint="张三"` |
| `TC-DIR-05` | L3 计划按月匹配（日期重叠优先） | 标题不含“11月”但 `begin="2026-11-02", end="2026-11-30"` 的计划命中 `2026-11`；跨月计划（`11-01`~`01-01`）命中重叠月份；`begin="待定"` 回退标题月份匹配 |
| `TC-DIR-06` | 三态产品与模块解析 | `state="design"` → `#42`，`state="runtime"` → `#43`，`state="delivery"` → `#44`；支持按产品中文关键词（如“天宫”“OneLink”“运营交付”）及模块路径模糊解析 |

### 2.2 个人地盘、团队逾期与需求进度（`TrackingService`）

| 编号 | 测试场景 | 核心断言（验收标准） |
| :--- | :--- | :--- |
| `TC-READ-01` | `get_my_dashboard` 聚合 | 合并 `v1/user` + `v2/my/work`（`browseType=assignedTo`）+ `v2/my/contribute`（`browseType=openedBy`）+ 本人活跃任务，正确区分**已逾期**与**未来 N 天临期**任务，兼容 v2 列表为对象 Map 或数组两种形态 |
| `TC-READ-02` | `get_team_overdue` 部门与团队范围 | 支持按 `department`（默认本部门）、`team`（profile 别名）、`members`（中文名数组）三种方式确定目标成员，无法解析的成员姓名写入 `unresolvedMembers` 不静默吞掉 |
| `TC-READ-03` | **口径红线：父子任务防双算** | 同一执行中父任务（`isParent=1`）与 2 个子任务（`parent=parentId`）均逾期；默认 `includeParentTasks=false` 时计数为 **2**（非 3）；设为 `true` 时明确标记 `isParent: true` |
| `TC-READ-04` | **口径红线：多人任务协作成员与姓名修复** | 遇到 `mode="linear"` / `"multi"` 的逾期任务，补拉 `v1/tasks/{id}` 的 `team[]`，识别实际未完成成员并用目录按 `account` 映射真实中文名（绝不输出禅道错误的数字 ID `realname`） |
| `TC-READ-05` | **口径红线：全未完成状态与无效截止日期** | `status` 为 `wait / doing / pause / changed` 且 `deadline < today` 全部计入逾期；`done / closed / cancel` 排除；`deadline` 为 `null / "" / "0000-00-00"` 排除；按成员聚合后按 `maxOverdueDays` 降序 |
| `TC-READ-06` | `query_stories` 客户端状态过滤与跨页 | 绝不将 `status=active/draft/closed` 拼进禅道查询串（查非关闭传 `status=unclosed`，含关闭传 `status=all`）；跨页拉取受 `maxScanPages` 保护，超限时设置 `truncated: true` |
| `TC-READ-07` | `query_stories` 组合过滤与中文映射 | 支持 `keyword`、`category`（`design`→`设计类`、`feature`→`研发类`）、`stage` 中文标签、`plan`、`assignedTo`/`openedBy`（支持中文名）、`feedbackBy` 模糊过滤 |
| `TC-READ-08` | `query_stories` 查询用户需求（Requirement） | `storyType="requirement"` 时走 `v2/product/browse?storyType=requirement`，不触发 `v1` 混返 600 条 story 的缺陷 |
| `TC-READ-09` | `get_story_progress` 单需求全景补齐 | 拉取 `v1/stories/{id}` 后，针对内嵌 `tasks` 缺少 `deadline`/`left` 的问题，从关联 `executions` 补齐任务截止日期与逾期天数，输出可读 `feedbackSummary` |
| `TC-READ-10` | `get_story_progress` 按反馈者查进度 | 传入 `feedbackBy="反馈人甲"`（含多人字段如 `"反馈人甲、反馈人乙"` 模糊匹配）时，跨主力产品检索匹配需求并汇总生成面向反馈者的状态卡片 |
| `TC-READ-11` | `get_story_progress` 按用户需求 ID 查进度 | 传入 `requirementId` 时走 `v2/requirement/view?storyID=...`（不调用会报 400 的 `v1/stories/{reqId}`），展示其自身状态与已关联研发需求进度 |

### 2.3 标准化提单、批量导入、指派与删除（`IntakeService`）

| 编号 | 测试场景 | 核心断言（验收标准） |
| :--- | :--- | :--- |
| `TC-WRITE-01` | `create_story` 默认 `dryRun=true` 预检 | 未显式传 `dryRun=false` 时零写请求；自动解析中文人名/产品/模块/L3 计划；执行 `/requiredFields` + `moduleOptionMenu` 校验并返回完整草稿预览 |
| `TC-WRITE-02` | L3 计划强提醒（不硬阻塞） | 未传 `plan` 时 `dryRun` 返回 `allOk: true`（若其他必填通过），同时在 `warnings[]` 发出未关联 L3 计划警告并附带目标产品活跃候选 L3 计划列表 |
| `TC-WRITE-03` | `personal` 模式 `draft` 默认与显式 `skipReview` | `personal` 默认提交 `status="draft", reviewer=[]`；传 `skipReview: true` 时提交 `status="active"`；`strict-ai` 传 `skipReview: true` 直接抛 `InvalidParamError` 拒绝 |
| `TC-WRITE-04` | `category="design"` 与交付态 `#44` 支持 | 支持 `category="design"` 与 `"feature"`（拒绝未知枚举）；指定 `state="delivery"` 或 `product="运营交付平台"` 时正确落到产品 `#44` 并校验 `#44` 模块树 |
| `TC-WRITE-05` | 22.6 v2 路由与 `module`/`modules[0]` 双写 | `/requiredFields` 包含 `assignedTo` 时走 `POST /api.php/v2/stories?productID=...`，Payload 同时包含 `module: id`、`modules: [id]`、`reviewer: []`、`assignedTo`、`plan`、`feedbackBy`，且创建已确认指派后**不再重复调用** `/stories/{id}/assign` |
| `TC-WRITE-06` | v1 兼容分支 + 独立指派 | `/requiredFields` 不含 `assignedTo` 时走 `POST /api.php/v1/products/{id}/stories`，随后走 `POST /api.php/v1/stories/{id}/assign` 并回读确认 |
| `TC-WRITE-07` | **防重红线：回读不一致 / 回读失败绝不重试** | 创建返回 ID=9001 但 `GET /v1/stories/9001` 失败或 `module`/`title`/`product` 不一致：返回 `id: 9001`、`url`、`readbackConfirmed: false` 与禁止重试提示，HTTP POST 次数严格等于 **1** |
| `TC-WRITE-08` | **防重红线：创建成功但指派失败降级** | v1 创建成功返回 ID 后 `/assign` 报错：返回已创建 `id`/`url` + `assignError` + `confirmed: false`，POST 创建次数严格为 **1** |
| `TC-WRITE-09` | 多态联动建单（`states: ["design", "runtime"]` / 含 `"delivery"`） | `dryRun=true` 一次输出各目标产品草稿与独立模块/计划预检；`dryRun=false` 依次建单并共享批次号，建完后调 `v2/story/linkStory` 互链；互链失败时保留全部已建 ID 并报告 `linkError`，不重复创建 |
| `TC-WRITE-10` | 设计 + 研发双单（`createDevPair: true`） | 一次预览并创建 1 条 `category="design"` + 1 条 `category="feature"` 需求并尝试互链，双单均执行独立回读确认 |
| `TC-WRITE-11` | 关联已有用户需求（`requirementId`） | 传入 `requirementId` 时在 `dryRun` 阶段先用 `v2/requirement/view` 验证其存在；实写成功后调用 `v2/requirement/linkStory` 自动关联；关联失败时降级返回 `linkError` 不重复建单 |
| `TC-WRITE-12` | `import_stories` 批量安全契约 | 未知字段被 `z.strictObject` 拒绝；默认 `dryRun=true` 汇总 `allOk / issueCount`；实写时单条失败不中断后续条目，分别统计 `created / failed / readbackUnconfirmed` |
| `TC-WRITE-13` | `assign_story` 账号解析与回读确认 | 支持传中文名自动转 `account`；独立调用 `/stories/{id}/assign` 后必须 GET 回读，仅当回读 `assignedTo === requestedAssignedTo` 时 `confirmed: true` |
| `TC-WRITE-14` | `delete_story` 破坏性操作守卫 | 未传 `confirm` 或 `confirm: false` 时 Zod 参数层直接拒绝（零 HTTP 请求）；`confirm: true` 时执行 `DELETE` 并 GET 回读确认 `deleted: true` |

---

## 三、Tier 3：MCP 协议与 CLI 集成测试（`test/adapters/` + `scripts/smoke-local.mjs`）

| 编号 | 测试场景 | 核心断言（验收标准） |
| :--- | :--- | :--- |
| `TC-ADP-01` | stdio MCP 握手与工具发现 | 启动真实 `node dist/adapters/mcp-stdio.js` 子进程，完成 `initialize` → `tools/list`，精确列出全部 **9 个 MVP 工具**，启动日志仅走 `stderr`，`stdout` 保持纯净 JSON-RPC |
| `TC-ADP-02` | 缺配置延迟报错（不阻断工具发现） | 未设 `ZENTAO_PASSWORD` 时 MCP 仍可正常 `initialize` 和 `tools/list`；首次调用需连禅道的工具时返回 `isError: true` 的 `ConfigError`（列出缺失变量名） |
| `TC-ADP-03` | MCP 端到端工具调用与异常安全 | 对接本地 Mock 禅道服务器，跑通 `resolve_context`、`get_my_dashboard`、`get_team_overdue`、`query_stories`、`get_story_progress`、`create_story(dryRun & write)`、`assign_story`、`delete_story(无confirm被拒 & confirm=true)` |
| `TC-ADP-04` | MCP 远程脱敏预留（`remote=true`） | `createBetterZentaoMcpServer(client, { remote: true, redactSecrets: [token] })` 隐藏上游异常细节并将输出中偶然出现的敏感 token 替换为 `[redacted]` |
| `TC-ADP-05` | `bzt` CLI 子命令与 `--json` 一致性 | 9 个 `bzt` 子命令（`resolve / me / overdue / stories / progress / create / import / assign / delete`）加 `--json` 后输出结构与对应 MCP 工具完全一致 |
| `TC-ADP-06` | `bzt` 严格退出码契约 | 成功退出 `0`；运行时/API 错误或 `import` 实写存在条目级失败退出 `1`；参数错误/缺 `--confirm`/非法或重复 `--dry-run` 退出 `2` |
| `TC-ADP-07` | `bzt import` 单遍 `--dry-run` 与管道输入 | 支持 `--file` 与 `--stdin` 二选一；`--dry-run` 缺省/`--dry-run`/`--dry-run=true` 均只校验不落库；重复 `--dry-run` 或 `--dry-run=1` 在读文件前直接以退出码 `2` 拒绝 |
| `TC-ADP-08` | 交付文档与 Skill 完整性检查 | `skills/better-zentao/SKILL.md` 与 `docs/onboarding/local-agent-setup.md`（覆盖 Antigravity / Codex / Claude Code 三端且不含明文密码）齐全且路径准确 |

---

## 四、Tier 4：内网禅道 22.6 现网验收门禁（`scripts/smoke-readonly.mjs` & `smoke-write-p29.mjs`）

### Gate 4A：零写入只读现网冒烟（Codex / Claude Code 可直接运行验证）

| 编号 | 现网验证项 | 验收通过标准 |
| :--- | :--- | :--- |
| `TC-LIVE-01` | 目录初始化与性能 | 真实拉取部门树与全量用户，耗时 `< 2s`，成功解析当前用户所在部门及 `#42 / #43 / #44` 产品 |
| `TC-LIVE-02` | 我的地盘真实调用 | `get_my_dashboard` 正常返回，耗时 `< 1.5s`，输出序列化文本正则扫描**零 `password` / 32 位哈希 / Token 泄露** |
| `TC-LIVE-03` | 团队逾期真实扫描 | `get_team_overdue`（默认当前部门）全量扫描耗时 `< 3s`，父子任务去重生效，无数字 ID 充当 `realname` |
| `TC-LIVE-04` | 三态需求检索与进度视图 | 分别对 `#42`、`#43`、`#44` 执行 `query_stories` 与 `get_story_progress`（含 `storyId`、存在的 `feedbackBy`、及 `#42` 用户需求 `requirementId`），均正常返回且中文状态/阶段完整 |
| `TC-LIVE-05` | 三态 `create_story(dryRun=true)` | 分别对 `#42`、`#43`、`#44` 与 `#29` 及跨态 `states: ["design", "runtime"]` 执行 `dryRun=true`，确认均成功拿到现网 `/requiredFields` 与真实模块/L3 候选计划，且**全程零写请求** |

### Gate 4B：受控写路径冒烟（⚠️ 仅经用户明确批准后在 `#29 禅道研发验证项目` 执行）

| 编号 | 受控写验证项 | 验收通过标准 |
| :--- | :--- | :--- |
| `TC-LIVE-06` | `#29` 单条创建 + 回读确认 | 使用唯一时间戳标题与模块 `564`，先 `dryRun=true` 通过后单次 `create_story(dryRun=false)`，验证 `readbackConfirmed=true`、字段（产品/模块/类别/状态/feedbackBy）逐项一致 |
| `TC-LIVE-07` | `#29` 指派回读 + 软删除守卫 | `delete_story` 不传 `confirm=true` 被拒；`delete_story(confirm=true)` 执行软删除并回读确认 `deleted=true`，验证 `#29` 零残留测试记录 |
| `TC-LIVE-08` | 写后关联验证（按需） | 若批准测试互链/双单（2 条），同样带唯一批次并在验收后逐条按精确 ID 软删除并回读 `deleted=true` |

---

## 五、架构师评审验收流程（交付给评审方时执行）

Codex / Claude Code 完成 Phase 1 并给出自测报告后，评审方按以下顺序做验收：
1. **静态与结构审查**：核对 4 层依赖方向（`adapters -> services -> api -> core`，零反向耦合）、v2 DTO 白名单完整性、零密钥/零 PII 入库。
2. **契约与测试追溯审查**：核对全部 `TC-CORE-01`~`TC-CORE-10`、`TC-DIR-01`~`TC-DIR-06`、`TC-READ-01`~`TC-READ-11`、`TC-WRITE-01`~`TC-WRITE-14`、`TC-ADP-01`~`TC-ADP-08` 均有真实对应测试且无虚假 Mock 放水。
3. **现网只读复验**：独立复跑 `npm run typecheck && npm run build && npm test && npm run smoke:local && npm run smoke:readonly`。
4. **受控写冒烟（获用户批准后）**：复核 `#29` 写回读与清理证据，全部通过后准予合入 `main`。
