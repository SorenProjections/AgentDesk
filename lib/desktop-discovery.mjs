import { execFile } from 'node:child_process';

const processScript = `[Console]::OutputEncoding=[System.Text.UTF8Encoding]::new($false); $ErrorActionPreference='Stop'; $taskApps=@(Get-Process -Name Antigravity,language_server,WorkBuddy,Doubao -ErrorAction SilentlyContinue); $taskRows=@($taskApps | ForEach-Object { $taskExe=''; try { $taskExe=$_.Path } catch {}; @{pid=$_.Id;name=($_.ProcessName+'.exe');exe=$taskExe} }); ConvertTo-Json -InputObject $taskRows -Depth 3 -Compress`;
const runFile = (command, args) => new Promise((resolve, reject) => execFile(command, args, { windowsHide: true, timeout: 30000, maxBuffer: 1000000 }, (error, output) => error ? reject(error) : resolve(output)));

export function parseDesktopPorts(output, processes) {
  const owned = new Set(processes.map(p => p.pid));
  const ports = [];
  for (const line of output.split(/\r?\n/)) {
    const fields = line.trim().split(/\s+/);
    if (fields.length !== 5 || fields[0] !== 'TCP' || fields[3] !== 'LISTENING') continue;
    const local = fields[1].match(/^127\.0\.0\.1:(\d+)$/);
    const pid = Number(fields[4]), port = Number(local?.[1]);
    if (local && owned.has(pid) && Number.isInteger(port) && port > 0 && port <= 65535) ports.push({ port, pid });
  }
  return ports;
}

// Get-NetTCPConnection uses the Windows management service, which can hang even
// while all apps are healthy. Native netstat does not depend on that service.
export function createDesktopDiscovery({ run = runFile, platform = process.platform, cacheMs = 2000, clock = Date.now } = {}) {
  let pending, cached, cachedAt = -Infinity;
  return function discover({ fresh = false } = {}) {
    if (platform !== 'win32') return Promise.resolve({ processes: [], ports: [] });
    if (pending) return pending;
    if (!fresh && cached && clock() - cachedAt < cacheMs) return Promise.resolve(cached);
    pending = (async () => {
      const results = await Promise.allSettled([
        run('powershell.exe', ['-NoProfile', '-NonInteractive', '-EncodedCommand', Buffer.from(processScript, 'utf16le').toString('base64')]),
        run('netstat.exe', ['-ano', '-p', 'tcp']),
      ]);
      if (results[0].status === 'rejected') throw new Error('无法读取桌面进程：Windows 进程查询失败或超时，请重试检测连接。');
      if (results[1].status === 'rejected') throw new Error('无法读取桌面端口：netstat 查询失败或超时，请重试检测连接。');
      let processes;
      try {
        processes = JSON.parse(results[0].value.replace(/^\uFEFF/, ''));
        if (!Array.isArray(processes) || processes.some(p => !Number.isInteger(p.pid) || typeof p.name !== 'string')) throw new Error();
      } catch { throw new Error('Windows 桌面进程列表格式不匹配，请重试检测连接。'); }
      cached = { processes, ports: parseDesktopPorts(results[1].value, processes) }; cachedAt = clock();
      return cached;
    })().finally(() => { pending = null; });
    return pending;
  };
}

export const discoverWindowsDesktop = createDesktopDiscovery();
