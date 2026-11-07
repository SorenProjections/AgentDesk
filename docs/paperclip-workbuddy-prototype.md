# Paperclip × WorkBuddy：外部适配器原型

日期：2026-10-08。

## 已完成

代码在 `packages/paperclip-workbuddy-adapter/`。它是可以独立打包的外部适配器，
不修改 AgentDesk 调度器，也不要求改动 Paperclip 核心代码。

- 按 Paperclip 外部插件约定导出 `createServerAdapter()`。
- 执行 WorkBuddy 已安装的 CLI，使用标准输入传递任务和唤醒上下文。
- 保存会话编号、项目目录、配置目录和 CLI 身份，同一身份才能续接。
- 将 Paperclip 指派的 skill 内容传入运行，支持框架 API 身份和工具网关环境变量。
- 验证明确的本轮最终结果、进程退出状态与权限拒绝，缺失结果不会报成功。
- 支持取消和超时清理；日志与保存的摘要做凭据脱敏。
- 提供配置表单、仅运行 `--help` 的能力检测和两轮真实调用脚本。

## 真实客户端测试

本机 WorkBuddy 桌面版本文件为 `37.10.3-24`。随包 CLI 已检测到，所需的流式执行、
会话恢复和权限参数均存在。首次真实请求返回：

> Authentication required. Please use /login command to sign in to your account

因此，本次验证了程序调用与认证失败处理，尚未验证真实成功回复、真实会话续接，
也尚未在 Paperclip 的完整任务流程中验证自动领取和完成任务。

检测成功与账号可用分别记录。真实失败不会被包装成成功，也不会自动重发。

## 本地验证

在适配器目录运行 `npm run typecheck`、`npm test` 和 `npm pack --dry-run`。
本次类型检查通过，21 项适配器测试全部通过；AgentDesk 原有的 46 项测试也全部通过。
已生成安装包，并在独立目录重新安装，验证了包入口、配置表单、会话编解码和真实调用脚本的存在。
这项安装检查没有启动完整 Paperclip 服务。
测试使用独立模拟客户端，覆盖协议、真实子进程、上下文与身份传递、会话隔离、
权限失败、缺少终态、UTF-8 分段、日志脱敏、取消和进程树超时清理。

使用说明和真实测试命令见适配器目录的 `README.md`。本机配置、运行报告与安装验证
放在被 Git 忽略的 `work/`，不进入发布包。

## 后续贡献范围

建议提案标题：**Add a local WorkBuddy external adapter**。
英文贡献说明草稿见 `docs/paperclip-workbuddy-contribution-draft.md`。

先用这个原型完成 CLI 登录后的两轮测试，再在一次性 Paperclip 实例里验证：
创建任务 → Agent 接收任务 → 用运行身份调用任务 API → 提交结果 → 查看运行记录。
确认流程后，与维护者讨论是否内置，或保留为社区外部适配器。

Antigravity CLI 已有未合并的工作，应避免重复：

- https://github.com/paperclipai/paperclip/pull/14938
- https://github.com/paperclipai/paperclip/pull/12925

相关 CodeBuddy 工作也需要引用并说明与 WorkBuddy 的区别：

- https://github.com/paperclipai/paperclip/issues/11765
- https://github.com/paperclipai/paperclip/pull/11766

“已有桌面对话观察”和“桌面任务结束后唤醒”是后续独立扩展；它们涉及桌面桥、
外部任务归属、内部接口版本兼容与额外状态机，不放入本次适配器原型。

本次没有向 GitHub、Discord 或 npm 发布内容。
