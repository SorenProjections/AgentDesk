# Windows 桌面入口与图标

运行 `npm run shortcut`，在当前用户桌面创建 `AgentDesk.lnk`。支持桌面被 OneDrive 等服务重定向的情况。不需要管理员权限。

快捷方式使用 `desktop.vbs` 隐藏启动 `launch.mjs`，打开系统默认浏览器中的面板。重复启动复用已有后台；关闭网页不影响后台任务。停止后台仍使用面板、`stop.cmd` 或 `npm stop`。该入口与“登录后自动启动”独立。

安装时记录当前 Node.js 路径、仓库路径及图标路径。移动仓库或更换 Node.js 后重新运行安装命令；覆盖来自另一目录的同名快捷方式需要显式使用 `powershell.exe -NoProfile -ExecutionPolicy Bypass -File scripts/install-shortcut.ps1 -Force`。创建到其他已有目录可传入 `-Destination <目录>`。`.lnk` 含本机绝对路径，不纳入 Git。

- `web/agentdesk.png`：透明 PNG，网页及品牌素材。
- `web/agentdesk.ico`：含 16、24、32、48、64、128、256 像素七档透明图像的 Windows 图标。
- `npm run icons`：从 PNG 重新生成 ICO；使用 Windows 自带 System.Drawing，无额外依赖。

图形以 A 形任务队列、弯曲路由和两个节点表达 AgentDesk 的调度功能。主色为钴蓝，浅蓝节点提供层次；图形外部和内部留白均透明。网页 favicon 与桌面图标使用同一素材，旧 SVG 保留以兼容历史地址。

素材通过内置 imagegen 生成，随后仅做尺寸转换与 ICO 封装。生成与修订提示词见 [icon-prompts.md](icon-prompts.md)。

## WorkBuddy 与豆包的连接入口

运行 `powershell.exe -NoProfile -ExecutionPolicy Bypass -File scripts/install-client-shortcuts.ps1`，创建 `WorkBuddy (AgentDesk).lnk` 和 `Doubao (AgentDesk).lnk`。这两个入口使用客户端原图标，分别附带 `--remote-debugging-port=9337`、`--remote-debugging-port=9338`，以及 `--remote-debugging-address=127.0.0.1`。原有快捷方式保持不变。自定义安装位置可设置 `WORKBUDDY_DESKTOP_BINARY` 或 `DOUBAO_DESKTOP_BINARY`，指向实际客户端 exe。

首次切换时先保存任务并从托盘完全退出客户端，再从新快捷方式打开。已经运行的进程不能通过再次启动补上调试参数。之后可以先打开客户端、再打开工作台；检测会查找该客户端实际拥有的本机调试端口，无需固定启动顺序。

也可以在工作台点击「打开并连接」：已有可用接口时直接连接；客户端未启动时带参数打开并检测；已经运行但没有开放接口时明确显示原因。面板不会结束任何客户端进程。启动进程成功不代表连接成功，只有聊天界面和控制接口均可用时才显示「已连接」。测试发送另行验证真实回复。
