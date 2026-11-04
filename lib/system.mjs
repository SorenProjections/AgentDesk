import { spawn, execFile } from 'node:child_process';
import path from 'node:path';
import { EventEmitter } from 'node:events';

const registry = 'Software\\Microsoft\\Windows\\CurrentVersion\\Run';
const valueName = 'LocalAgentScheduler';
export function powershellError(stderr, fallback = 'Windows 设置执行失败。') {
  const text=String(stderr || '').trim();
  if(!text.includes('#< CLIXML'))return text || fallback;
  const decode=value=>value.replace(/_x([0-9a-f]{4})_/gi,(_,hex)=>String.fromCharCode(parseInt(hex,16))).replace(/&lt;/g,'<').replace(/&gt;/g,'>').replace(/&quot;/g,'"').replace(/&apos;/g,"'").replace(/&amp;/g,'&');
  const errors=[...text.matchAll(/<S\b[^>]*\bS="Error"[^>]*>([\s\S]*?)<\/S>/g)].map(match=>decode(match[1]));
  return errors.join('').trim().slice(0,2000) || fallback;
}
function powershell(script, env = {}) {
  const wrapped=`$ProgressPreference='SilentlyContinue'; $ErrorActionPreference='Stop'; [Console]::OutputEncoding=[System.Text.UTF8Encoding]::new($false); try { & { ${script} } } catch { [Console]::Error.WriteLine($_.Exception.Message); exit 1 }`;
  return new Promise((resolve, reject) => execFile('powershell.exe', ['-NoProfile', '-NonInteractive', '-EncodedCommand', Buffer.from(wrapped, 'utf16le').toString('base64')], { windowsHide: true, timeout: 15000, encoding:'utf8', env: { ...process.env, ...env } }, (error, stdout, stderr) => error ? reject(new Error(powershellError(stderr,error.message))) : resolve(stdout.trim())));
}

export class SystemIntegration extends EventEmitter {
  constructor(root,{runPowerShell=powershell,platform=process.platform}={}) { super(); this.root = root; this.runPowerShell=runPowerShell;this.platform=platform;this.autostart = false; this.awake = null; this.awakeReady = false; this.error = ''; }
  snapshot() { return { supported: process.platform === 'win32', autostart: this.autostart, keepingAwake: this.awakeReady, error: this.error }; }
  async inspect() {
    if (this.platform !== 'win32') return;
    try {
      const value = await this.runPowerShell(`$key=[Microsoft.Win32.Registry]::CurrentUser.OpenSubKey('${registry}'); if ($null -ne $key) { try { $v=$key.GetValue('${valueName}'); if ($null -ne $v) { [Console]::Write($v) } } finally { $key.Dispose() } }`);
      this.autostart = value === this.startupCommand();
    } catch { this.autostart = false; }
  }
  startupCommand() { return `wscript.exe "${path.join(this.root, 'background.vbs')}" "${process.execPath}"`; }
  async setAutostart(enabled) {
    if (this.platform !== 'win32') throw new Error('登录后自动启动目前支持 Windows。');
    try { await this.runPowerShell(enabled
      ? `$key=[Microsoft.Win32.Registry]::CurrentUser.CreateSubKey('${registry}', $true); try { $key.SetValue('${valueName}', $env:AGENT_SCHEDULER_START_COMMAND, [Microsoft.Win32.RegistryValueKind]::String) } finally { $key.Dispose() }`
      : `$key=[Microsoft.Win32.Registry]::CurrentUser.OpenSubKey('${registry}', $true); if ($null -ne $key) { try { $key.DeleteValue('${valueName}', $false) } finally { $key.Dispose() } }`,
    { AGENT_SCHEDULER_START_COMMAND: this.startupCommand() }); }
    catch(error) { throw new Error('无法'+(enabled?'开启':'关闭')+'登录后自动启动：'+powershellError(error.message)); }
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
