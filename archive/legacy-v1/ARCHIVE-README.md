# `archive/legacy-v1` — 旧版 Phase 1 MVP 归档说明

> **重要提示：本目录仅供历史参考，严禁被新代码导入，也严禁当作当前规范或守则执行。**

## 归档来源

- **来源提交**：`c79636e`
- **Git 归档分支**：`archive/v1-phase1`
- **Git 归档标签**：`archive/v1-phase1-baseline`
- **归档日期**：2026-11-20

## 包含内容

1. **旧版工程与实现**（Phase 1 MVP）：`src/`、`test/`、`scripts/`、`package.json`、`package-lock.json`、`tsconfig*.json`、`vitest.config.ts`、`.env.example`、`better-zentao.example.json`。
2. **旧版设计、规格与自测文档**：`docs/design/`、`docs/onboarding/`、`docs/spec/`、`docs/phase1-mvp-self-test.md` 及 `docs/research/2026-11-19-zentao-22.6-api-probe.md` 备份。
3. **旧版守则与 Skill（已重命名防止误加载）**：`AGENTS.legacy.md`、`CLAUDE.legacy.md`、`skills/better-zentao/SKILL.legacy.md`。

## 当前有效重构基线

所有重构与后续开发必须严格以仓库根目录下的 v3.0 设计基线为准：
- `AGENTS.md`（编码守则与红线）
- `README.md`（文档地图）
- `docs/00-评审摘要.md` ~ `docs/13-术语与追溯.md`
- `docs/research/2026-11-19-zentao-22.6-api-probe.md`（禅道 22.6 只读探查依据 S2）
- `skills/better-zentao/SKILL.md`
