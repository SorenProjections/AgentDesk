# Windows 桌面入口与图标

运行 `npm run shortcut`，在当前用户桌面创建 `AgentDesk.lnk`。支持桌面被 OneDrive 等服务重定向的情况。不需要管理员权限。

快捷方式使用 `desktop.vbs` 隐藏启动 `launch.mjs`，打开系统默认浏览器中的面板。重复启动复用已有后台；关闭网页不影响后台任务。停止后台仍使用面板、`stop.cmd` 或 `npm stop`。该入口与“登录后自动启动”独立。

安装时记录当前 Node.js 路径、仓库路径及图标路径。移动仓库或更换 Node.js 后重新运行安装命令；覆盖来自另一目录的同名快捷方式需要显式使用 `powershell.exe -NoProfile -ExecutionPolicy Bypass -File scripts/install-shortcut.ps1 -Force`。创建到其他已有目录可传入 `-Destination <目录>`。`.lnk` 含本机绝对路径，不纳入 Git。

- `web/agentdesk.png`：透明 PNG，网页及品牌素材。
- `web/agentdesk.ico`：含 16、24、32、48、64、128、256 像素七档透明图像的 Windows 图标。
- `npm run icons`：从 PNG 重新生成 ICO；使用 Windows 自带 System.Drawing，无额外依赖。

图形以 A 形任务队列、弯曲路由和两个节点表达 AgentDesk 的调度功能。主色为钴蓝，浅蓝节点提供层次；图形外部和内部留白均透明。网页 favicon 与桌面图标使用同一素材，旧 SVG 保留以兼容历史地址。

素材通过内置 imagegen 生成，随后仅做尺寸转换与 ICO 封装。生成与修订提示词见 [icon-prompts.md](icon-prompts.md)。
