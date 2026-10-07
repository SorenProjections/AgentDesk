import { spawn } from 'node:child_process';
import { mkdirSync, openSync, closeSync, readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = path.dirname(fileURLToPath(import.meta.url));
const port = Number(process.env.CODEX_SCHEDULER_PORT || 43127);
const base = `http://127.0.0.1:${port}`;
const data = path.resolve(process.env.CODEX_SCHEDULER_DATA || path.join(root, 'data'));
const normalize = value => process.platform === 'win32' ? path.normalize(value).toLowerCase() : path.normalize(value);

async function health() {
  const response = await fetch(base + '/health', { signal: AbortSignal.timeout(1500) });
  if (!response.ok) throw new Error(`面板检查失败，HTTP ${response.status}。`);
  const result = await response.json();
  if (result.type !== 'codex-local-scheduler' || normalize(result.root || '') !== normalize(root)) {
    const error = new Error('这个端口属于另一个程序或另一份面板。请停止原来的面板，或设置 CODEX_SCHEDULER_PORT。');
    error.portConflict = true;
    throw error;
  }
  return result;
}

async function stop() {
  await health();
  const opened = await fetch(base, { signal: AbortSignal.timeout(3000) });
  const cookie = opened.headers.get('set-cookie')?.split(';')[0];
  if (!cookie) throw new Error('无法连接到面板会话。');
  const response = await fetch(base + '/api/shutdown', {
    method: 'POST', signal: AbortSignal.timeout(5000),
    headers: { Cookie: cookie, Origin: base, 'X-Scheduler-Request': '1', 'Content-Type': 'application/json' }, body: '{}',
  });
  const result = await response.json();
  if (!response.ok) throw new Error(result.error || '停止后台失败。');
  console.log('后台已停止，预约记录已保留。');
}

function openBrowser() {
  let command;
  let args;
  if (process.platform === 'win32') {
    command = path.join(process.env.SystemRoot || 'C:\\Windows', 'System32', 'rundll32.exe');
    args = ['url.dll,FileProtocolHandler', base];
  } else if (process.platform === 'darwin') {
    command = 'open'; args = [base];
  } else {
    command = 'xdg-open'; args = [base];
  }
  const browser = spawn(command, args, { detached: true, windowsHide: true, stdio: 'ignore' });
  browser.on('error', () => console.log('请在浏览器中打开：' + base));
  browser.unref();
}

async function start() {
  let running = false;
  try { await health(); running = true; }
  catch (error) { if (error.portConflict) throw error; }
  if (!running) {
    mkdirSync(data, { recursive: true });
    const out = openSync(path.join(data, 'backend.log'), 'a');
    const err = openSync(path.join(data, 'backend.error.log'), 'a');
    let child;
    try {
      child = spawn(process.execPath, [path.join(root, 'server.mjs')], {
        cwd: root, env: process.env, detached: true, windowsHide: true, stdio: ['ignore', out, err],
      });
    } finally { closeSync(out); closeSync(err); }
    let spawnError;
    child.on('error', error => { spawnError = error; });
    child.unref();
    const deadline = Date.now() + 20000;
    while (Date.now() < deadline) {
      if (spawnError) throw spawnError;
      try { await health(); running = true; break; }
      catch (error) { if (error.portConflict) throw error; }
      if (child.exitCode !== null) break;
      await new Promise(resolve => setTimeout(resolve, 250));
    }
    if (!running) {
      let log = '';
      try { log = readFileSync(path.join(data, 'backend.error.log'), 'utf8').slice(-3000); } catch {}
      throw new Error('后台未能启动。请查看 data/backend.error.log。\n' + log);
    }
  }
  console.log('面板地址：' + base);
  console.log('项目目录：' + root);
  if (!process.argv.includes('--no-browser')) openBrowser();
}

try {
  const [nodeMajor, nodeMinor] = process.versions.node.split('.').map(Number);
  if (nodeMajor < 22 || nodeMajor === 22 && nodeMinor < 13) throw new Error('需要 Node.js 22.13 或更新版本，以使用内置 SQLite 会话读取功能。');
  if (!Number.isInteger(port) || port < 1024 || port > 65535) throw new Error('CODEX_SCHEDULER_PORT 无效。');
  if (process.argv.includes('--stop')) await stop();
  else await start();
} catch (error) {
  console.error(error.message);
  process.exitCode = 1;
}
