# better-zentao 1.0 试用版 · 本地 Agent（Skill + MCP）接入指南

> 适用对象：参与 1.0 试用的设计人员（DS）与研发/产品同事。  
> 分工模式：**外部本地 Agent（Skill + MCP）**负责需求理解、主动澄清、草稿提报与合规任务拆解；**集中 Web 工作台**专注需求/任务进度与状态跟踪（默认只读）。

## 1. 环境准备

- **Node.js**：`24.11.0` 及以上（24.x LTS）。
- **获取并构建仓库**：
  ```bash
  git clone https://github.com/Dylan5237/better-zentao.git
  cd better-zentao
  corepack pnpm install --frozen-lockfile
  corepack pnpm build
  ```
- **获取团队配置文件**：向管理员获取只读团队配置（`team.json`），放到本机受控路径（不要放进公开 Git 仓库）。

## 2. 配置本人禅道凭据（严禁写入配置文件或仓库）

本地 stdio MCP 以**本人禅道账号**身份连接禅道，所有读写权限均受禅道真实 ACL 与 `better-zentao` 规则约束。请通过本机环境变量（而非写入 JSON/TOML 文件）提供凭据：

| 环境变量 | 说明 |
| --- | --- |
| `ZENTAO_BASE_URL` | 内网禅道根地址（例如 `https://zentao.internal.example`） |
| `ZENTAO_ACCOUNT` | 本人禅道账号 |
| `ZENTAO_PASSWORD` | 本人禅道密码（仅由启动环境注入，不落盘） |
| `BZT_CONFIG` | 本机团队配置文件路径（例如 `C:\Users\<你>\.better-zentao\team.json`） |

先运行只读自检，确认环境、版本与权限正常：
```bash
node dist/adapters/cli/bzt.js doctor --live
```

## 3. 一键接入主流本地 Agent

支持 Codex、Claude Code、Gemini CLI，可使用内置命令安装 Skill 与 MCP 配置模板（先 `--dry-run` 核对目标路径）：

```bash
# Codex
node dist/adapters/cli/bzt.js install-agent codex --config "<你的team.json路径>" --dry-run
node dist/adapters/cli/bzt.js install-agent codex --config "<你的team.json路径>"

# Claude Code
node dist/adapters/cli/bzt.js install-agent claude --config "<你的team.json路径>"

# Gemini CLI
node dist/adapters/cli/bzt.js install-agent gemini --config "<你的team.json路径>"
```

## 4. 典型使用方式（脱敏合成示例）

### 示例 A：月初把工作计划整理为研发需求草稿
> 你：这是我下月（2026-12）的工作计划（贴入表格/截图/要点）：
> 1. 权限中心多租户角色矩阵交互优化（天宫平台）
> 2. 协助跟进上月网关续期需求 #3105
> 3. 部门内设计规范分享会
>
> Agent（遵守 Skill 闭环）：
> 1. 自动调用 `resolve_context` 与 `query_stories` 查重，把 3 项分别归类为：① 新增设计类研发需求；② 已有需求 #3105 跟进（不重复建单）；③ 非禅道交付事项（建议跳过）。
> 2. 合并补问第 ① 项缺失的模块、验收标准与反馈方，明确标出目标月份为 `2026-12`（默认）、状态为 `draft`（默认）。
> 3. 调用 `create_story` 生成 W2 预览并完整展示，**等待你下一轮明确回复“确认提交”**后再调用 `confirm_operation(previewAck=true)` 落库，返回需求编号与禅道链接。

### 示例 B：对已激活的设计需求拆解设计阶段任务
> 你：#3101 已经评审激活了，帮我按设计模板拆解任务，我负责设计，主管负责评审。
>
> Agent：先校验 #3101 为 `active` 状态与目标迭代，调用 `decompose_stories(template="design")` 展示任务名称、负责人与计划起止日期预览，经你确认后创建并返回逐项回执。若需求仍为 `draft`，会明确提示先走审核激活，绝不自动激活绕过流程。

## 5. 安全与试用边界说明

- **Web 与本地 MCP 授权独立**：集中 Web 保持只读模式（`readOnly: true`）用于团队跟踪，不影响你通过本地 stdio MCP 使用本人禅道账号执行受控提需；所有 W2 写入均需你明确阅读预览并在下一轮同意后才会执行。
- **禁止的高危能力**：MCP 不提供删除需求、完成任务、创建 Bug 或填报消耗工时工具；这些操作请直接在禅道界面处理。
- **不上传敏感材料**：试用反馈仅归档脱敏后的场景、问题与建议，不上传真实绩效截图、同事账号或内网配置。
