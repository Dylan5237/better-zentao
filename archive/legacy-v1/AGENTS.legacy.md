# better-zentao — 工程协作与实现约束（Codex / Claude Code 必读）

## 1. 协作分工

- **架构规划、规格定稿、评审验收**：由架构师 Agent 负责（不直接改动业务实现分支）。
- **编码实现与测试**：由 Codex / Claude Code 在独立主题分支上按规格实现并完成自测，随后提交评审验收。

**动手写代码前，必须按顺序完整阅读以下文档：**
1. `docs/design/architecture-and-domain-plan.md` — 总体 4 层架构与 7 项定稿决策
2. `docs/research/2026-11-19-zentao-22.6-api-probe.md` — 内网禅道 22.6 实测接口与踩坑依据（含 Phase 2 任务/子任务补充）
3. 当前阶段规格文档：`docs/spec/phase1-mvp-spec.md`（已验收合入） / `docs/spec/phase2-spec.md`（当前阶段）
4. 当前阶段测试集与验收门禁：`docs/spec/phase1-mvp-test-suite.md` / `docs/spec/phase2-test-suite.md`

参考实现（仅用于借鉴成熟模式，禁止直接照搬单体结构）：`D:\_projects\tools\zentao-mcp`（可参考其 single-flight token 刷新、`ZentaoCreateUnconfirmedError` 安全诊断、CLI 单遍 `--dry-run` 解析与 AI 标注幂等逻辑）。

## 2. 技术栈与项目约束

- 运行环境：Node.js `>=18`（本地实测 Node 24），TypeScript ESM（`"type": "module"`），严格模式（`strict: true`）。
- 核心依赖：`@modelcontextprotocol/sdk`、`zod`；测试框架：`vitest`。
- 入口命名（避免与旧 `zentao-mcp` 冲突）：
  - CLI：`bzt`（`dist/adapters/cli.js`）
  - stdio MCP：`better-zentao-mcp`（`dist/adapters/mcp-stdio.js`）
- 架构红线：**严禁将业务逻辑塞进 `core/http.ts` 或 `adapters/`**；`services/` 必须完全传输无关（不依赖 MCP SDK 或 `process.argv`）。

## 3. 不可妥协的安全与禅道 22.6 红线

1. **凭据与隐私零泄露**：
   - 严禁提交 `.env`、`better-zentao.local.json`、密码、Token、内网真实 IP 或真实同事隐私信息到 Git。
   - 严禁在错误消息、日志、MCP 返回或 CLI 输出中回传密码、Token 或上游原始错误正文。
2. **v2 响应强制 DTO 白名单投影**：
   - 已实测禅道 22.6 部分 v2 接口返回密码哈希（如 `/v2/my/todo` 的 `user.password`）及 2,086 人完整 `users` 字典。
   - **所有 `src/api/` 方法必须做显式字段白名单裁剪**，严禁把 v2 原始 JSON 透传给上层或调用方。
3. **写操作安全与防重红线**：
   - 未经用户明确批准，**严禁向任何禅道业务产品写入真实数据**；经批准的受控写冒烟**仅允许在 `#29 禅道研发验证项目`** 执行单条测试并用完即软删除回读确认。
   - 需求创建前强制 `/requiredFields` + `moduleOptionMenu` 预检；必填含 `assignedTo` 走 v2 创建并双写 `module` 与 `modules: [module]`，显式传 `reviewer: []`。
   - 创建返回 ID 但回读失败或指派失败时，保留 `id`/`url` 并标明未确认，**严禁自动重试创建**。
   - 独立指派走 `POST /stories/{id}/assign`（禁用 `PUT` 合并指派）；软删除必须 `confirm: z.literal(true)` 守卫。
4. **统计口径准确红线**：
   - 逾期统计默认排除父任务汇总行（`isParent === 1`）防止与子任务双算；
   - 识别多人协作任务（`mode: "linear" | "multi"`）并用目录按 `account` 修正禅道 `team[].realname` 异常；
   - 未完成状态完整涵盖 `wait / doing / pause / changed`；排除空/`0000-00-00` 截止日期。

## 4. Git 工作流与交付验收要求

- 一项阶段任务一个主题分支（如 `feat/phase1-mvp`、`feat/phase2-management`），禁止直接在 `main` 提交实现代码。
- 提交信息使用 `type(scope): 中文简述`，保持原子提交（骨架/core、api、services、adapters、tests、skill/docs 分步提交）。
- 提交评审前必须全部通过并附验证输出：
  1. `npm run typecheck`
  2. `npm run build`
  3. `npm test`（必须保持已合入阶段的全部测试 100% 回归通过，并覆盖当前阶段测试集 `docs/spec/phase1-mvp-test-suite.md` / `docs/spec/phase2-test-suite.md` 中全部 Tier 1~3 `TC-*` / `TC-P2-*` 用例，且测试描述中包含对应编号便于追溯）
  4. `npm run smoke:local`（本地 Mock 禅道 + 真实 stdio MCP + 真实 CLI 进程级联调）
  5. `npm run smoke:readonly`（连接内网禅道 22.6 的零写入只读冒烟，不可达时注明原因）
- 严禁通过放宽断言、跳过测试或伪造 Mock 契约来“凑绿灯”。
