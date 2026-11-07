# 从对话查询 AgentDesk

MCP 入口为 `mcp/server.mjs`，通过本机后台查询客户端、项目、普通任务及运行记录。任务督导、验收、纠偏和文件占用功能已移除。原有历史数据保留，旧督导指令不再派发。

## 安装与接入

调度器本身保持无 npm 依赖；MCP 是可选子包，使用锁定的官方 TypeScript SDK 和 Zod。安装一次即可：

```powershell
npm --prefix E:\CodexScheduler\mcp ci --ignore-scripts
```

在希望使用工具的工作空间 `.codex/config.toml` 中合并配置，保留已有服务器。下面使用 `F:\AI_Worker` 工作空间连接 `E:\CodexScheduler`：

```toml
[mcp_servers.agentdesk]
command = "C:/Program Files/nodejs/node.exe"
args = ["E:/CodexScheduler/mcp/server.mjs"]
cwd = "E:/CodexScheduler"
enabled = true
startup_timeout_sec = 30
tool_timeout_sec = 900

[mcp_servers.agentdesk.env]
CODEX_SCHEDULER_URL = "http://127.0.0.1:43127"
CODEX_SCHEDULER_AUTOSTART = "1"
```

项目级配置适用于受信任的工作空间。[Codex 官方 MCP 文档](https://learn.chatgpt.com/docs/extend/mcp?surface=cli)说明配置位置、stdio 接入和桌面 MCP Restart 操作。现有聊天可能需要在设置 → MCP servers 中 Restart，或开启新聊天，才能加载新增工具。用 `/mcp` 检查 `agentdesk` 是否连接。配置已经保存不等于当前聊天已经取得工具。

`CODEX_SCHEDULER_AUTOSTART=1` 时，第一次调用遇到后台未运行，会通过项目现有 `launch.mjs --no-browser` 隐藏启动服务。设成 `0` 则要求手动启动。不会因认证失败、错误端口或另一个项目的服务而启动，也不会重试已发送的写操作。后台启动后会恢复原有调度记录；启动后台不代表会自动创建新的任务。客户端与桌面桥仍须可用，`status` 可检查连接。

可复用 [配置模板](../mcp/codex-config.example.toml) 接入其他工作空间；Node 路径、项目路径和端口按实际环境修改。MCP 不需要 OpenAI API 密钥，不会调用额外的语言模型。

## 当前工具

| 工具 | 用途 |
| --- | --- |
| status | 客户端连接、普通任务与正在执行的运行 |
| list_projects | Codex 或豆包客户端项目 |
| list_sessions | 按客户端、工作目录及项目筛选真实会话，支持分页 |
| list_workbuddy_experts | 只读查询 WorkBuddy 团队与专家目录 |
| get_run | 运行回复、错误及日志 |
| interrupt_run | 经用户授权后停止指定运行 |

创建与安排普通任务请使用面板，或 `node scripts/agentdesk.mjs create --file task.json`。JSON 格式与 `/api/tasks` 相同；保存后会按发送条件执行。WorkBuddy 普通任务可选 `desktopExpertId`，省略沿用客户端默认配置。

Codex 项目从 `project/list` 读取，保存真实项目 ID；新对话通过 `thread/start.projectId` 设置归属，已有未归属对话通过 `thread/metadata/update` 修复。只填目录时按最深匹配根目录选择；多个同级项目需要明确选择。启动时仅修复本面板已有任务所创建、空闲且未归属项目的对话，不移动已分配项目的对话。

## 验证

运行 `npm run test:mcp` 检查 MCP 协议、参数与后端连接边界；`node mcp/verify.mjs` 只查询已启动后台的状态，不派发任务。更换版本后重启 MCP 连接以更新工具目录。
