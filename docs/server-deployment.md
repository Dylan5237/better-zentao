# better-zentao Server 1.0 部署与运维指南

> 对应需求卡：[CR-008](changes/CR-008-server-multi-user.md) ｜ 架构决策：ADR-21、ADR-22、ADR-23（[12-决策与待确认](12-决策与待确认.md)）

## 1. 部署定位与安全边界

- **单进程受控内网部署**：Server 1.0 通过独立命令 `bzt serve --server-config <path>` 启动，复用 Node 24 LTS 与内置 `node:sqlite`（WAL 模式），按 `(instanceHash, canonicalAccountDir)` 物理隔离各账号 `state.db`。
- **禁止公网暴露与多副本共享盘**：仅支持单进程 + 本地持久化磁盘（禁止多副本共用 NFS/SMB）。启动时通过 `<dataDir>/.server.lock` 防止双进程误挂载同一数据目录。
- **HTTPS 与上游网络信任边界**：
  - 生产环境必须经受控内网反向代理终止 HTTPS，并在 `server.json` 中固定 `externalOrigin` 与 `trustedProxies` 白名单。
  - `allowInsecureHttp: true` 仅用于隔离调试或 `fake-zentao` 替身测试，**禁止**在不可信明文链路下使用真实禅道账号密码试跑。
  - 若目标内网禅道本身仅支持 HTTP，部署前须由运维明确服务节点到禅道之间的内网隔离边界与风险。
- **默认只读与最小权限**：
  - 模板配置默认 `readOnly: true`、`notify.enabled: false`。建议先以只读模式完成多用户登录、角色视图与数据隔离验收，再由管理员显式改为 `readOnly: false` 开启两段式受控写入。
  - 集中端永久禁用 `/api/roles` 自助改表、W3 破坏性操作与 `#29` 写能力探查。
  - 进程级 `TargetWriteCoordinator` 仅约束经由该 Server 的并发写入，**不是禅道全局锁**；原生禅道或并行 CLI/MCP 的外部修改仍由目标指纹校验（`PLAN_STALE`）、写后回读与 `unknown` 语义兜底。

## 2. 准备配置

1. 复制 [server.example.json](../config/server.example.json) 为运行态 `server.json`（不入库），填写：
   - `externalOrigin`：固定内网 HTTPS 地址（如 `https://bzt.internal.example`）。
   - `trustedProxies`：反向代理的对端 IP 列表。
   - `dataDir`：本地持久化目录（建议权限 `0700`）。
   - `instances`：管理员登记的禅道实例列表及各自 `team.<id>.json` 路径（可使用 `bzt config-ui` 离线编辑后受控发布）。
2. 核对配置文件中**不含任何密码、Token、Cookie 或 Webhook 密钥**（`loadServerConfig` 会按 CFG-10 拒绝疑似凭据与重复 JSON 键）。

## 3. 启动方式

### 3.1 直接进程运行（Node 24.11+）

```sh
corepack pnpm install --frozen-lockfile
corepack pnpm build
node dist/adapters/cli/bzt.js serve --server-config /etc/bzt/server.json
```

也可通过环境变量 `BZT_SERVER_CONFIG=/etc/bzt/server.json` 传入配置路径。健康检查端点：`GET /healthz` 返回 `{"ok":true,"mode":"server"}`。

### 3.2 Docker Compose（候选交付）

参考 [docker/Dockerfile](../docker/Dockerfile)、[docker/compose.example.yml](../docker/compose.example.yml) 与 [docker/nginx.example.conf](../docker/nginx.example.conf)：

```sh
# 在 docker/ 下准备好只读挂载目录 config-runtime/ 与 certs/ 后启动
docker compose -f docker/compose.example.yml up -d --build
```

## 4. 备份、升级与回滚

- **备份**：
  - 配置文件（`server.json` 与 `team.*.json`）纳入受控配置管理。
  - 用户状态库 `<dataDir>/users/<instanceHash>/<accountKey>/state.db` 建议在维护窗口停服后（或执行 SQLite WAL checkpoint 后）打包备份整个 `dataDir`。
  - 会话与禅道 Token 仅存内存，重启自动失效，无需备份。
- **升级**：
  1. 备份当前 `dataDir` 与配置文件；
  2. 停止旧进程，部署新版本产物并启动；
  3. 已有 `state.db` 会在用户重登打开时按 `src/core/store/migrations.ts` 自动幂等向前迁移。
- **回滚**：
  - **版本回滚**：停止新版本，切回旧版本产物；若新版本引入了更高 schema 迁移版本，同步恢复升级前备份的 `dataDir`。
  - **紧急退回本机模式**：直接停止 `bzt serve` 进程，保留 `dataDir` 备份；团队成员可零改动继续使用本机 `bzt web`、CLI 与 `bzt mcp`（共享 `team.json` 完全兼容）。
