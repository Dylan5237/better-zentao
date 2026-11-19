# 本地 Agent 接入

在 better-zentao 仓库目录用 Node.js 18 或更高版本运行。

~~~powershell
npm ci
npm run build
node dist/adapters/cli.js --help
~~~

在启动 Agent 的终端给进程设置禅道根地址、账号和密码。下面的地址与账号是占位示例。密码通过提示输入。

~~~powershell
$env:ZENTAO_BASE_URL = 'https://zentao.example.invalid'
$env:ZENTAO_ACCOUNT = 'your-account'
$credential = Get-Credential -UserName $env:ZENTAO_ACCOUNT -Message '输入禅道密码'
$env:ZENTAO_PASSWORD = $credential.GetNetworkCredential().Password
~~~

从带这些变量的环境启动 Agent。已运行的桌面实例需要重新启动才会获得新的进程环境。密码只通过进程环境传递，配置模板仅包含占位信息或变量引用。可选的 `better-zentao.local.json` 用于团队、模式和业务默认值，格式见 `better-zentao.example.json`。跨工作目录使用时，可将 `ZENTAO_PROFILE_PATH` 设为该文件的绝对路径。

以下模板的 `D:/path/to/better-zentao` 替换为实际仓库路径。若客户端的进程找不到 `node`，改用 Node.js 可执行文件的绝对路径。

## Antigravity

在 MCP Servers → Manage MCP Servers → View raw config 中，把这一项添加到现有 `mcpServers`。也可以使用工作区的 `.agents/mcp_config.json`。设有独立启动器时，由启动器向 Antigravity 进程提供密码环境变量。 [Antigravity MCP 文档](https://antigravity.google/docs/mcp?tab=ide)

~~~json
{
  "mcpServers": {
    "better-zentao": {
      "command": "node",
      "args": ["D:/path/to/better-zentao/dist/adapters/mcp-stdio.js"],
      "cwd": "D:/path/to/better-zentao",
      "env": {
        "ZENTAO_BASE_URL": "https://zentao.example.invalid",
        "ZENTAO_ACCOUNT": "your-account"
      }
    }
  }
}
~~~

## Codex

将以下表合并到用户的 `~/.codex/config.toml`。`env_vars` 从启动 Codex 的本地环境转发密码。 [Codex MCP 文档](https://learn.chatgpt.com/docs/extend/mcp?surface=cli)

~~~toml
[mcp_servers.better-zentao]
command = "node"
args = ["D:/path/to/better-zentao/dist/adapters/mcp-stdio.js"]
cwd = "D:/path/to/better-zentao"
env_vars = ["ZENTAO_PASSWORD"]

[mcp_servers.better-zentao.env]
ZENTAO_BASE_URL = "https://zentao.example.invalid"
ZENTAO_ACCOUNT = "your-account"
~~~

## Claude Code

将以下内容合并到当前项目的 `.mcp.json`。从已设置禅道变量的终端启动 Claude Code，并按宿主提示启用此项目的 MCP。 [Claude Code MCP 文档](https://code.claude.com/docs/en/mcp#environment-variable-expansion-in-mcpjson)

~~~json
{
  "mcpServers": {
    "better-zentao": {
      "type": "stdio",
      "command": "node",
      "args": ["D:/path/to/better-zentao/dist/adapters/mcp-stdio.js"],
      "env": {
        "ZENTAO_BASE_URL": "${ZENTAO_BASE_URL}",
        "ZENTAO_ACCOUNT": "${ZENTAO_ACCOUNT}",
        "ZENTAO_PASSWORD": "${ZENTAO_PASSWORD}"
      }
    }
  }
}
~~~

也可以从项目目录用命令写入同样的变量引用。保留单引号，让 Claude Code 在启动服务器时展开变量。

~~~powershell
claude mcp add --scope project --transport stdio --env 'ZENTAO_BASE_URL=${ZENTAO_BASE_URL}' --env 'ZENTAO_ACCOUNT=${ZENTAO_ACCOUNT}' --env 'ZENTAO_PASSWORD=${ZENTAO_PASSWORD}' better-zentao -- node 'D:/path/to/better-zentao/dist/adapters/mcp-stdio.js'
~~~

## 验证接入

在 Agent 中查看 `better-zentao` 的 9 个工具，然后调用 `get_my_dashboard` 做只读验证。命令行也可运行同一能力。

~~~powershell
node dist/adapters/cli.js me --json
node dist/adapters/cli.js stories --state design --limit 5 --json
~~~

向支持 Agent Skills 的宿主提供 `skills/better-zentao/` 目录。需求预检默认只读。CLI 导入读取顶层数组或 `{ "stories": [...] }`，每条按工具契约校验。`--file` 与 `--stdin` 二选一。

~~~powershell
node dist/adapters/cli.js import --file ./stories.json --dry-run --json
~~~

确认草稿后才可将创建或导入命令显式改为 `--dry-run=false`。软删除需要确认目标后再传 `--confirm`。CLI 退出码 `0` 表示成功，`1` 表示运行或实写条目失败，`2` 表示参数或预检校验失败。
