import { spawn, execFile } from 'node:child_process';
import path from 'node:path';
import { EventEmitter } from 'node:events';

const registry = 'HKCU:\\Software\\Microsoft\\Windows\\CurrentVersion\\Run';
const valueName = 'LocalAgentScheduler';
function powershell(script, env = {}) {
  return new Promise((resolve, reject) => execFile('powershell.exe', ['-NoProfile', '-NonInteractive', '-EncodedCommand', Buffer.from(script, 'utf16le').toString('base64')], { windowsHide: true, timeout: 15000, env: { ...process.env, ...env } }, (error, stdout, stderr) => error ? reject(new Error(stderr || error.message)) : resolve(stdout.trim())));
}

export class SystemIntegration extends EventEmitter {
  constructor(root) { super(); this.root = root; this.autostart = false; this.awake = null; this.awakeReady = false; this.error = ''; }
  snapshot() { return { supported: process.platform === 'win32', autostart: this.autostart, keepingAwake: this.awakeReady, error: this.error }; }
  async inspect() {
    if (process.platform !== 'win32') return;
    try {
      const value = await powershell(`$v = Get-ItemPropertyValue -LiteralPath '${registry}' -Name '${valueName}' -ErrorAction SilentlyContinue; if ($v) { Write-Output $v }`);
      this.autostart = value === this.startupCommand();
    } catch { this.autostart = false; }
  }
  startupCommand() { return `wscript.exe "${path.join(this.root, 'background.vbs')}" "${process.execPath}"`; }
  async setAutostart(enabled) {
    if (process.platform !== 'win32') throw new Error('登录后自动启动目前支持 Windows。');
    await powershell(enabled
      ? `$ErrorActionPreference = 'Stop'; New-Item -Path '${registry}' -Force | Out-Null; New-ItemProperty -LiteralPath '${registry}' -Name '${valueName}' -Value $env:AGENT_SCHEDULER_START_COMMAND -PropertyType String -Force | Out-Null`
      : `$ErrorActionPreference = 'Stop'; Remove-ItemProperty -LiteralPath '${registry}' -Name '${valueName}' -ErrorAction SilentlyContinue`,
    { AGENT_SCHEDULER_START_COMMAND: this.startupCommand() });
    await this.inspect();
    if (this.autostart !== enabled) throw new Error('Windows 启动设置未能验证，请检查系统权限。');
  }
  setAwake(enabled) {
    if (!enabled) { this.awake?.stdin.end(); this.awake = null; this.awakeReady = false; this.emit('change'); return; }
    if (this.awake || process.platform !== 'win32') return;
    this.error = '';
    const script = `$ProgressPreference = 'SilentlyContinue'; $ErrorActionPreference = 'Stop'; Add-Type -TypeDefinition 'using System.Runtime.InteropServices; public class AgentPower { [DllImport("kernel32.dll")] public static extern uint SetThreadExecutionState(uint flags); }'; if ([AgentPower]::SetThreadExecutionState([uint32]2147483649) -eq 0) { exit 1 }; [Console]::WriteLine('ready'); [Console]::In.ReadLine() | Out-Null; [AgentPower]::SetThreadExecutionState([uint32]2147483648) | Out-Null`;
    const child = spawn('powershell.exe', ['-NoProfile', '-NonInteractive', '-EncodedCommand', Buffer.from(script, 'utf16le').toString('base64')], { windowsHide: true, stdio: ['pipe', 'pipe', 'pipe'] });
    this.awake = child;
    child.stdout.on('data', data => { if (data.toString().includes('ready') && this.awake === child) { this.awakeReady = true; this.emit('change'); } });
    child.stdin.on('error', () => {});
    child.stderr.resume();
    child.on('error', error => { this.error = error.message; if (this.awake === child) { this.awake = null; this.awakeReady = false; this.emit('change'); } });
    child.on('exit', code => { if (code) this.error ||= '保持唤醒未生效。'; if (this.awake === child) { this.awake = null; this.awakeReady = false; this.emit('change'); } });
  }
  close() { this.setAwake(false); }
  async notify(title, detail, url) {
    if (process.platform !== 'win32') throw new Error('系统提醒目前支持 Windows；结果已保存在收件箱。');
    // Text goes through environment variables and XML nodes, never shell source.
    const script = `$ErrorActionPreference='Stop'; [Windows.UI.Notifications.ToastNotificationManager, Windows.UI.Notifications, ContentType=WindowsRuntime] | Out-Null; [Windows.UI.Notifications.ToastNotification, Windows.UI.Notifications, ContentType=WindowsRuntime] | Out-Null; [Windows.Data.Xml.Dom.XmlDocument, Windows.Data.Xml.Dom.XmlDocument, ContentType=WindowsRuntime] | Out-Null; $taskXml=New-Object Windows.Data.Xml.Dom.XmlDocument; $taskXml.LoadXml('<toast activationType="protocol"><visual><binding template="ToastGeneric"><text></text><text></text></binding></visual></toast>'); $taskXml.DocumentElement.SetAttribute('launch',$env:AGENT_REMINDER_URL); $taskNodes=$taskXml.GetElementsByTagName('text'); $taskNodes.Item(0).AppendChild($taskXml.CreateTextNode($env:AGENT_REMINDER_TITLE)) | Out-Null; $taskNodes.Item(1).AppendChild($taskXml.CreateTextNode($env:AGENT_REMINDER_DETAIL)) | Out-Null; $taskToast=[Windows.UI.Notifications.ToastNotification]::new($taskXml); [Windows.UI.Notifications.ToastNotificationManager]::CreateToastNotifier('Microsoft.Windows.PowerShell').Show($taskToast); Write-Output 'sent'`;
    await powershell(script, { AGENT_REMINDER_TITLE: String(title).slice(0,180), AGENT_REMINDER_DETAIL: String(detail).slice(0,500), AGENT_REMINDER_URL: url });
  }
}
