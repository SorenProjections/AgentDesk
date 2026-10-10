# 从 Codex 对话调用任务督导 MCP

MCP 入口是 `mcp/server.mjs`，使用 stdio；Codex 启动并管理 MCP 进程，不需要另开常驻终端，也不需要开放新的网络端口。它通过本机 `ControlClient` 调用已有 AgentDesk 服务，网页、脚本与 MCP 共用任务档案、会话绑定、验收状态和文件占用。

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

## 直接使用自然语言

连接后不必记脚本或工具名称。例如：

> 用 AgentDesk 检查 WorkBuddy 在 F:\AI_Worker 的已有会话。找到我指定的会话后，让它只修改 src/config 和对应测试，修复配置读取。保留现有修改，以回归测试通过和接口兼容为验收标准，最多纠偏两轮。先保存任务，今晚 21:00 开始。

> 查看刚才那个任务的阶段产物、改动文件和测试证据。检查错误处理是否完整；满足标准就验收，否则生成具体纠偏指令，在原会话修正，不扩大范围。

> 用反重力在 E:\my-project 新建只读检查任务，审查设计文档，不修改文件。检查完成后给我验收证据。

需求应明确目录、客户端、目标、约束和验收标准。有多个候选会话时要指定会话编号或可辨认的名称；工具不能替用户猜测已有会话。时间存在歧义时先确认日期，派发工具要求明确时区的 ISO 时间。

研究任务可以共用工作空间 cwd。补充“每次新建唯一研究产物目录，全部产物只写这里，不改已有文件”，管理端应将这个新目录保存为 writePaths。基础骨架、变体由桌面端只读，开始备注和结果追加由管理端处理。其他活动聊天不会因为 cwd 相同而占用整个项目；只有保存的文件范围重叠才冲突，验收也不混入其他研究目录的变化。

服务器初始化 `instructions`、工具描述、`agentdesk://workflow` 资源和 `supervise_task` 提示模板都包含流程要求，让新聊天能够发现并使用工具，无须改写量化研究的常驻规则。

## 工具与流程

| 工具 | 用途 |
| --- | --- |
| status、list_sessions、list_missions、get_mission | 连接检查、真实会话查询、任务档案 |
| create_mission、bind_session | 建档、绑定与目录核验；不会派发任务 |
| dispatch_mission | 真实初始派发，支持 at 预约和 requestId 防重复 |
| observe_mission、wait_for_mission | 阶段观察与最多 45 秒的状态等待；不运行测试 |
| get_evidence、refresh_evidence | 读取验收包；后者重跑保存的验收命令 |
| review_mission、correct_mission | 对最新证据作语义判断、有限轮次纠偏 |
| pause_mission、resume_mission、interrupt_run、release_lease | 暂停、恢复、中断和核验后释放占用 |

通常流程：检查连接与会话 → 保存目标/约束/标准 → 绑定 → 派发或预约 → 观察 → 读取验收证据 → 判断人工标准 → 接受或纠偏。初始派发与每轮纠偏提供不同且稳定的 `requestId`，结果不明时先查询指令记录。失败测试不能通过人工结论覆盖。更详细的档案输入和恢复规则见 [任务督导指南](supervision.md)。

## 持续运行与边界

MCP 让当前对话调用工具，本身不会自动唤醒已经结束的聊天。预约执行、客观验收和已启用的有限纠偏由后台完成；如果需要我每隔一段时间判断内容、引导方向，要再安排当前聊天的 heartbeat。用户给出监控要求和频率后，由当前对话的自动化工具建立，状态无变化时保持安静。

电脑、后台、客户端和桌面桥需要可用。会话回复、文件和日志都是证据，不能改变授权。文件占用只约束经调度器安排的任务，不能阻止绕过调度器的手动编辑。不会因为安装 MCP 就自动向客户端发送任务。

## 验证与开发

```powershell
npm --prefix E:\CodexScheduler\mcp test
node E:\CodexScheduler\mcp\verify.mjs
```

测试使用模拟接口，核验协议握手、工具参数、路由、恢复和自动启动边界。`verify.mjs` 启动真正的 stdio MCP 进程，只查询状态和档案，不建档、不派发，要求已有后台可用。根目录 `npm test` 仍不依赖 MCP 子包；安装 MCP 后也可用根目录 `npm run test:mcp`。

MCP 当前使用 SDK v1 维护分支兼容的 MCP 协议，版本固定在子包锁文件中；升级 SDK 时需一起验证实际客户端握手和工具调用，不能只替换依赖版本。
