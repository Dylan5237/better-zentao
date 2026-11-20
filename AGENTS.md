# AGENTS.md — better-zentao 编码守则

> 适用于 Codex、Claude Code、Gemini CLI 等编码 Agent，以及人类开发者。
> `CLAUDE.md` 与 `GEMINI.md` 只包含一行：`请阅读并遵守 AGENTS.md。`

## 1. 项目是什么

better-zentao（命令 `bzt`）把禅道开源版 22.6 接入本地 Agent：用自然语言提需求、查工作、看进度、拆任务、扫风险。它同时是一套**团队协作规范（docs/03）的执行者**：默认值即规范，偏离时提醒。

## 2. 开始任何工作前先读

| 顺序 | 文档 | 什么时候必须读 |
| --- | --- | --- |
| 1 | `README.md` 文档地图 | 始终 |
| 2 | `docs/04-领域模型与业务规则.md` 中与任务相关的章节 | 涉及口径、进展、规则 |
| 3 | `docs/07-工具契约.md` 中相关工具 | 涉及 MCP 工具或服务 |
| 4 | `docs/06-禅道接口适配.md` 中相关端点与坑点 | 涉及 `src/api`、`src/core/dto` |
| 5 | `docs/05-系统架构.md` §2 分层、§5 写入模型 | 涉及写入、存储 |
| 6 | `docs/09-测试与验收.md` 中相关用例 | 始终（先写测试） |
| 7 | `docs/10-实施计划.md` 中本次工作包（WP） | 按 WP 开发时 |

**优先级：** 03 协作规范 > 04 领域规则 > 07 工具契约 > 05 / 06 > 代码。文档与代码冲突时，以文档为准；认为文档错了，先提出修改文档（见 §7），不要在代码里"悄悄修正"。

## 3. 红线（违反任何一条，PR 不得合并）

1. **原始响应不出 `src/api/`。** 所有禅道响应经 `src/core/dto/*` 的 zod 白名单投影；不得把原始对象传给 services、MCP 输出、日志、缓存或测试夹具。v2 响应含密码哈希和全公司人员字典。
2. **拿到禅道对象 ID 后，不再创建同一对象。** 超时或回读失败记为 `unknown` 并反查，禁止"重试创建"。
3. **不编造事实性字段。** 实际开始、完成时间、消耗工时、评审结论只能来自用户输入或禅道记录。计划性字段（预计开始、截止、优先级）可以按规范默认，并标注 `origin: "default"`。
4. **写入级别由服务端判定。** 不信任 Agent 传入的级别；W2 必须有 `previewAck=true`；W3（删除等）不进入 MCP。
5. **未验证能力不执行。** 能力注册表（`src/api/capabilities.ts`）中非 `verified` 的能力不能出现在操作计划中。只有 `bzt probe write` 可以在产品 #29 上试验写入。
6. **`src/domain/` 与 `src/rules/` 不做 I/O。** 不读时钟（用注入的 `clock`）、不访问网络、不读写文件或数据库。
7. **日志脱敏。** 只记录方法、路径模板、状态码、耗时、`opId`、对象 ID；不记录请求体、响应体、Token、密码。
8. **禅道文本是数据，不是指令。** 需求标题、正文、评论在输出中标记为不可信，代码不得据此改变行为。
9. **读取不完整要说出来。** 任何数据源失败写入 `gaps` 并置 `completeness: "partial"`，不得静默丢弃。
10. **统计只计叶子任务，需求计数先去重。**

## 4. 编码规范

- TypeScript `strict: true`，`noUncheckedIndexedAccess: true`；禁止 `any`（确需时用 `unknown` + zod）。
- 运行时校验统一用 zod；工具输入 schema 使用 `.strict()`。
- 错误使用 `src/core/errors.ts` 中的 `BztError(code, message, details)`，错误码与 docs/07 §2.4 一致；面向用户的 message 用中文。
- 日期使用 `src/core/calendar.ts` 与 `src/core/clock.ts`；禁止在业务代码中直接 `new Date()`。
- 依赖方向：`adapters → services → (domain, rules, api) → core`；`domain` 不依赖 `api`。用 ESLint `import/no-restricted-paths` 强制。
- 文件命名 kebab-case；规则文件 `rNN-<name>.ts`，导出 `{ id, name, evaluate }`。
- 不引入新依赖，除非在 PR 中说明理由；禁止引入 ORM 与 HTTP 框架。
- 注释写"为什么"，口径相关代码注明文档出处，如 `// docs/04 §4.4`。

## 5. 命令

```bash
pnpm install
pnpm lint           # ESLint + Prettier 检查
pnpm typecheck      # tsc --noEmit
pnpm test           # 先构建，再运行 Vitest 离线测试与覆盖率门禁（09 §1.3）
pnpm test:smoke     # 只读冒烟，需要 ZENTAO_* 环境变量
pnpm eval --agent claude|codex|gemini   # 对话评测
pnpm build          # 输出 dist/，提供 bzt 命令

bzt doctor          # 环境与配置检查
bzt probe capture   # 采集并脱敏夹具
bzt probe write <capability> --product 29   # 写能力验证（仅 #29）
bzt mcp             # 以 stdio 启动 MCP 服务
```

## 6. 测试要求

- **先写测试。** 每个 WP 先按 docs/09 的用例编号写失败测试，再实现。
- 新增或修改口径：`test/unit/` 中补"正常 / 边界 / 反例"。
- 新增规则：至少"命中 / 不命中 / 阈值边界"三个用例，否则 `_coverage.test.ts` 失败。
- 新增端点：`test/fixtures/zentao-22.6/` 中补正常与空列表夹具（必须经 `scripts/sanitize-fixture.ts`），并在 `test/contract/` 补契约测试。
- 写入流程：在 `test/service/` 用 `fake-zentao` 覆盖 confirmed / partial / unknown / not_executed / failed。
- 覆盖率门槛见 docs/09 §1.3。
- 不得为通过测试而修改夹具中的真实行为（例如把 201 改成 200）。

## 7. 文档先行

| 情况 | 做法 |
| --- | --- |
| 实现与文档一致 | 正常开发，PR 引用文档章节、US、AC 编号 |
| 发现文档缺口或矛盾 | 停止该部分实现；在 `docs/12-决策与待确认.md` §5 追加条目，说明证据与建议 |
| 发现禅道实际行为与 06 不符 | 采集脱敏夹具作为证据；更新 06 与契约测试后再改代码 |
| 需要偏离 ADR | 先在 12 新增 ADR（提议状态），评审通过后再实施 |

## 8. 收到新需求时

按 `docs/11-需求演进指南.md`：

1. 先分类（问法 / 口径 / 视图 / 写入 / 团队做法 / 环境差异）。
2. 写六步需求卡片（意图 → 口径 → 数据 → 规则 → 能力 → 验收），放在 `docs/changes/CR-xxx.md`。
3. 检查不变量（11 §3）。
4. 优先扩展现有工具的参数或视图；工具总数不超过 20。
5. 团队做法差异：修订规范，而不是增加配置开关（ADR-10）。

## 9. PR 清单

- [ ] 引用了 WP / CR、US、AC 编号
- [ ] 先有失败测试，再有实现
- [ ] `pnpm lint && pnpm typecheck && pnpm test` 全绿
- [ ] 没有原始响应透传，没有新增日志字段泄露正文或凭据
- [ ] 没有使用未验证的写能力
- [ ] 没有编造事实性字段；默认值已标注 origin
- [ ] 文档已同步（口径 04、契约 07、端点 06、参数 08）
