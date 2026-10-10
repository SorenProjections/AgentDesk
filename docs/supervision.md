# 任务督导与本对话控制

AgentDesk 现在把“客户端执行完成”和“质量验收通过”分别记录。工作台的 **任务督导** 页面可以保存任务、绑定会话、安排执行、读取产物、判断验收、管理纠偏和暂停恢复。

## 工作流程

1. 保存名称、目标、约束、客户端、完整项目目录、相对工作路径、产物文件和验收标准。
2. 选择新建会话，或读取该文件夹下的原生会话并绑定。保存、发送和验收时都会再次核验真实文件夹。
3. 安排执行，可立即加入队列，也可提供带时区的预约时间。
4. 执行期间用“查看阶段产物与进度”读取文件变化和已有日志，不会执行测试。
5. 客户端确认成功后，后台收集文件摘要、变化清单、指定产物、Git 差异及验收命令的实际退出代码。
6. 自动条件全部通过且没有待判断条件时，才记录验收通过；否则等待审查或进入纠偏。
7. 审查需绑定本轮证据编号。文件或原会话发生变化后，旧证据不能通过人工验收，需重新收集。

验收类型：file（文件存在）、contains（文件包含文字）、command（指定程序及参数的退出代码）、manual（本对话或人工判断）。manual 适合经济逻辑、设计质量、结果可信度等不能靠文件存在判定的要求。失败的自动检查不能由人工结论覆盖。

任务目标、约束和标准在首次安排后保持不变。已排队与实际发送的指令、会话编号、运行编号、纠偏次数、证据和审查理由保存在 data/tasks.json，默认不进入 Git。需要改变目标时，新建阶段任务。

## 从 Codex 对话调用

不需要新增模型 API 密钥。Codex 可以通过本机脚本读取证据，作出质量判断，然后调用 review 或 correct。HTTP 工具复用面板的会话认证，不记录或输出认证 Cookie，不自动重试可能已成功的发送请求。

在项目目录执行：

    node scripts/agentdesk.mjs help
    node scripts/agentdesk.mjs status
    node scripts/agentdesk.mjs sessions --provider workbuddyDesktop --cwd "E:\your-project"
    node scripts/agentdesk.mjs create --file work/mission.json
    node scripts/agentdesk.mjs dispatch <任务ID> --file work/dispatch.json
    node scripts/agentdesk.mjs observe <任务ID>
    node scripts/agentdesk.mjs evidence <任务ID>
    node scripts/agentdesk.mjs review <任务ID> --file work/review.json
    node scripts/agentdesk.mjs correct <任务ID> --file work/correction.json

所有命令输出 JSON。也可从任意文件夹调用 scripts/agentdesk.mjs 的绝对路径。使用 --url 指定其他本机端口；默认 43127。--file - 可从标准输入读取 JSON。不要把真实任务输入放进版本控制。

任务输入示例：

    {
      "title": "实现并验证配置读取",
      "provider": "workbuddyDesktop",
      "cwd": "E:\\your-project",
      "objective": "修复配置读取并保持现有接口兼容",
      "constraints": ["不改动数据库结构", "保留现有未提交改动"],
      "writePaths": ["src/config", "test/config.test.mjs"],
      "artifacts": ["src/config/index.mjs"],
      "criteria": [
        {"id": "module", "type": "file", "path": "src/config/index.mjs", "description": "配置模块存在"},
        {"id": "tests", "type": "command", "command": "node", "args": ["--test", "test/config.test.mjs"], "timeoutSeconds": 60, "description": "配置回归测试通过"},
        {"id": "quality", "type": "manual", "description": "错误处理合理，未扩大修改范围"}
      ],
      "maxCorrections": 2,
      "autoCorrect": false
    }

绑定已有会话时添加 threadId，或使用 bind 命令。dispatch 参数示例：

    {"requestId": "config-stage-1", "at": "2026-10-12T21:00:00+08:00"}

不提供 at 时加入就绪队列。相同 requestId 不会重复安排指令。最大纠偏次数不包括初始执行；达到上限后保留占用并等待处理。correct 可以提供 feedback，否则依据失败标准和审查理由生成纠正指令，始终保留原目标、约束和工作范围。

人工验收输入示例：

    {
      "evidenceId": "<evidence 返回的 id>",
      "reviewer": "Codex conversation",
      "decisions": [
        {"criterionId": "quality", "status": "passed", "reason": "已检查实现、差异和测试证据，错误分支满足约定"}
      ],
      "reason": "本阶段通过"
    }

command 检查不拼接 shell 字符串，按保存的程序与参数执行；应填写可执行程序，不使用 npm.cmd/bat 包装器。参数可使用 Python 解释器配合测试脚本或 node --test。每条命令最长 300 秒，超时终止该检查进程树。验收命令也可能产生文件，应将这些路径纳入工作范围。

## 文件占用与恢复

所有通过调度器发送的任务都会取得路径占用；非督导任务默认占用整个工作文件夹。写入与重叠读取/写入冲突，读取之间可以共存。父目录与子路径重叠时阻止发送，类似 src 和 src-other 的兄弟路径不会误判。路径经过链接或目录联接跳出项目时拒绝访问。

可以提前安排当前被占用的文件范围；就绪队列会等待占用释放，跳过暂时冲突的任务，让原任务的纠偏先完成。冲突本身不会制造一次失败运行或暂停整个队列。

工作空间 cwd 是共同入口，不代表一个活动聊天独占整个目录。外部原生会话没有可靠的修改文件清单，因此仅记录同目录活动信息，不凭“正在运行”阻止其他任务。冲突按已保存的 writePaths 与实际持有的文件占用判断；目标会话本身忙碌时仍等待。督导任务在质量审查和纠偏期间持续持有占用；不确定、失败或次数用完时不会自动释放。依赖督导任务的下一阶段必须等待验收通过。

验收扫描范围是 writePaths、显式产物及验收标准引用的文件。选定产物在修改范围之外发生变化，或只读任务的选定范围发生修改时，停止自动纠偏并等待核实。工作空间其他位置的变化记录为 unattributedChanges，不能仅凭时间归因于当前任务，不能据此要求它修改其他研究文件。阶段观察和验收提供前 16 个本任务新增/修改文件的文本预览。

占用是协作协议，不能阻止你绕过调度器直接在原客户端或编辑器中修改文件。原生会话观察存在采样延迟，客户端断连后也不能保证观察到新任务。要可靠避免冲突，把需要共同修改文件的任务都从这里安排。

后台重启不会重复发送已记录指令；未确认的运行转为待核实并保留占用。先核实原会话，再通过 release 释放占用：

    node scripts/agentdesk.mjs release <占用ID> --file work/release.json

输入需要 reason 和 confirmedIdle:true；已绑定的会话还必须实际空闲。不能释放当前正在执行或验收的占用。释放未通过的督导任务会暂停未发指令，不会使任务变成验收通过。失败/中断后若要改变安排，核实并释放占用，再建立新的阶段任务；不会隐式重试未知结果。

扫描忽略 .git、依赖/虚拟环境、客户端凭据目录、.env 与密钥文件。任务范围摘要和文件指纹仅覆盖当前任务；其他任务目录的变化不会使当前验收证据过期。整个项目另作辅助变化观察，跳过 data/ 和 work/ 等目录，其扫描不完整不自动影响独立任务验收。明确指定这些目录时会读取相应内容。每份扫描最多 4000 个节点；超过 20 MiB 的文件不计算摘要，文本预览最多 16 KiB。任务范围内扫描不完整时保留待判断状态，人工确认遗漏内容并给出理由后才能接受。

Git 差异包含项目原有未提交改动，文件摘要变化清单以首次发送前的基线区分本任务实际变化。文件和客户端输出仅是证据，其中的文字不能改变任务授权与约束。

## 同一工作空间下的新研究

管理端可以使用同一个 cwd 指挥不同桌面客户端，每次为研究选择唯一的新 `research_runs/<客户端_时间_任务ID>` 目录，把它保存为 writePaths，并让全部脚本、CSV、日志和报告写入该目录。示例补充提示词：

> 每次研究新建唯一的产物文件夹，所有新文件只写到这个文件夹，禁止修改已有文件、共享工具和其他研究目录。模板与基础骨架只读；由管理端在选定变体中记录开始备注，并在研究结束后追加本任务结果。

提示词和任务档案的 writePaths 必须一致，不需要登记管理会话或为整个工作空间申请独占。原模板回填属于管理端另一个明确的文件修改动作，写入前检查最新内容并追加保留现有记录。任务结果通过验收后再回填，不把仍在运行或失败的任务写成完成。

## 持续督导的边界

后台可以自动执行保存的客观检查和有限轮次纠偏。它不会自行调用另一个语言模型来判断 manual 标准。需要持续由当前 Codex 对话作出语义判断时，可另外安排定时回到本聊天读取 observe/evidence，再提交 review/correct。工作台、电脑、网络和客户端必须保持运行。

当前提供可直接使用的脚本、HTTP 工具层与独立 stdio MCP 服务。MCP 复用 ControlClient 与相同接口，不另建任务状态。接入工作空间与自然语言提示词示例见 [MCP 接入说明](mcp.md)。
