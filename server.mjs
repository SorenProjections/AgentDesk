import http from 'node:http';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { readFileSync, mkdirSync, existsSync, writeFileSync, unlinkSync } from 'node:fs';
import { randomBytes, timingSafeEqual } from 'node:crypto';
import { spawn } from 'node:child_process';
import { CodexClient } from './lib/codex.mjs';
import { Store } from './lib/store.mjs';
import { Scheduler, validateFolder } from './lib/scheduler.mjs';
import { CommandProvider } from './lib/providers.mjs';
import { AntigravityDesktop, WorkBuddyDesktop } from './lib/desktop.mjs';
import { SystemIntegration } from './lib/system.mjs';
import { NativeCodexObserver } from './lib/native-codex.mjs';
import { NativeWorkBuddyObserver } from './lib/native-workbuddy.mjs';
import { SessionHub } from './lib/sessions.mjs';

const root = path.dirname(fileURLToPath(import.meta.url));
const port = Number(process.env.CODEX_SCHEDULER_PORT || 43127);
if (!Number.isInteger(port) || port < 1024 || port > 65535) throw new Error('面板端口无效。');
const origin = `http://127.0.0.1:${port}`;
const dataDirectory = path.resolve(process.env.CODEX_SCHEDULER_DATA || path.join(root, 'data'));
mkdirSync(dataDirectory, { recursive: true });
const lockFile = path.join(dataDirectory, 'server.lock');
// Acquire the data lock before reading or recovering any tasks.
if (existsSync(lockFile)) {
  let previous;
  try { previous = JSON.parse(readFileSync(lockFile, 'utf8')); } catch {}
  let alive = !!previous?.pid;
  if (alive) { try { process.kill(previous.pid, 0); } catch { alive = false; } }
  if (alive) throw new Error('同一份任务文件已有后台进程，请先停止原来的后台。');
  unlinkSync(lockFile);
}
writeFileSync(lockFile, JSON.stringify({ pid: process.pid, port, root }), { flag: 'wx', mode: 0o600 });
const store = new Store(path.join(dataDirectory, 'tasks.json'));
const sessionSecret = randomBytes(32).toString('hex');
const clients = new Set();
const client = new CodexClient({ cwd: root });
const providers = new Map(['antigravity', 'workbuddy'].map(id => [id, new CommandProvider(id, { cwd: root, binary: store.data.settings.providers?.[id]?.binary || '', verification: store.data.settings.providers?.[id]?.verification || null })]));
for (const provider of [new AntigravityDesktop(), new WorkBuddyDesktop()]) {
  provider.verification = store.data.settings.providers?.[provider.id]?.verification || null;
  providers.set(provider.id, provider);
}
const scheduler = new Scheduler(store, client, { providers });
const system = new SystemIntegration(root);
system.on('change', () => scheduler.emit('change'));
const nativeCodex = new NativeCodexObserver();
const nativeWorkBuddy = new NativeWorkBuddyObserver();
const sessions = new SessionHub(store, { sources: [
  { id: 'codex', name: 'Codex', detail: '最近 250 个会话及已关注会话；只读本机记录', list: known => nativeCodex.listSessions(known), close: () => nativeCodex.close() },
  ...['antigravityDesktop','workbuddyDesktop'].map(id => {
    const provider = providers.get(id); let nextProbe = Date.now() + 60000;
    const source = { id, name: provider.name, detail: '最近 60 个会话、已关注会话及列表中的运行任务', list: async known => {
      if (!provider.available && !provider.checking && Date.now() >= nextProbe) { nextProbe = Date.now() + 60000; await provider.probe(); }
      if (id === 'workbuddyDesktop' && !provider.available) {
        source.detail = '原生记录只读同步：最近 100 个会话及所有标记运行的任务；发送接续需桌面桥';
        const rows = await nativeWorkBuddy.listSessions(known);
        return rows;
      }
      source.detail = '最近 60 个会话、已关注会话及列表中的运行任务';
      return (await provider.listSessions(known)).map(row => ({...row,readOnly:false}));
    } };return source;
  }),
], notifier: (title, detail) => system.notify(title, detail, origin + '/#sessions') });
const snapshot = () => ({ ...scheduler.snapshot(), system: system.snapshot(), sessionHub: sessions.snapshot() });
let shuttingDown = false;
let pickingFolder = false;

function send(response, status, value) {
  response.writeHead(status, { 'Content-Type': 'application/json; charset=utf-8' });
  response.end(JSON.stringify(value));
}

function isAuthenticated(request) {
  const cookie = (request.headers.cookie || '').split(';').map(value => value.trim()).find(value => value.startsWith('scheduler_session='));
  const candidate = cookie?.slice('scheduler_session='.length) || '';
  return candidate.length === sessionSecret.length && timingSafeEqual(Buffer.from(candidate), Buffer.from(sessionSecret));
}

async function body(request) {
  if (!String(request.headers['content-type'] || '').startsWith('application/json')) throw new Error('请求必须使用 JSON 格式。');
  let length = 0;
  const chunks = [];
  for await (const chunk of request) {
    length += chunk.length;
    if (length > 1024 * 1024) throw new Error('请求内容过大。');
    chunks.push(chunk);
  }
  try { return JSON.parse(Buffer.concat(chunks).toString('utf8')); } catch { throw new Error('请求内容无法解析。'); }
}

function chooseFolder(initialFolder = '') {
  if (process.platform !== 'win32') throw new Error('当前文件夹选择器用于 Windows；你也可以直接填写路径。');
  if (pickingFolder) throw new Error('文件夹选择窗口已经打开。');
  pickingFolder = true;
  return new Promise((resolve, reject) => {
    const powershell = path.join(process.env.SystemRoot || 'C:\\Windows', 'System32', 'WindowsPowerShell', 'v1.0', 'powershell.exe');
    const picker = spawn(powershell, ['-NoProfile', '-STA', '-ExecutionPolicy', 'Bypass', '-File', path.join(root, 'lib', 'pick-folder.ps1')], {
      windowsHide: true, env: { ...process.env, CODEX_SCHEDULER_FOLDER: String(initialFolder).slice(0, 4096) },
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    let output = '';
    let errors = '';
    const timer = setTimeout(() => { picker.kill(); }, 300000);
    picker.stdout.on('data', data => { output += data.toString('utf8'); });
    picker.stderr.on('data', data => { errors = (errors + data.toString('utf8')).slice(-3000); });
    picker.on('error', error => { pickingFolder = false; clearTimeout(timer); reject(error); });
    picker.on('close', code => {
      pickingFolder = false;
      clearTimeout(timer);
      if (code !== 0) return reject(new Error('文件夹选择器未完成。' + errors));
      try { resolve(JSON.parse(output.replace(/^\uFEFF/, '').trim())); }
      catch { reject(new Error('文件夹选择器没有返回有效结果。')); }
    });
  });
}

let changeTimer;
scheduler.on('change', () => {
  sessions.syncRuns();
  if (changeTimer) return;
  changeTimer = setTimeout(() => {
    changeTimer = null;
    for (const response of clients) response.write('event: change\ndata: {}\n\n');
  }, 250);
});
scheduler.on('fault', error => console.error(error.message));
sessions.on('change', () => scheduler.emit('change'));
sessions.on('fault', error => console.error(error.message));

const assets = {
  '/': ['index.html', 'text/html; charset=utf-8'],
  '/app.js': ['app.js', 'text/javascript; charset=utf-8'],
  '/api.js': ['api.js', 'text/javascript; charset=utf-8'],
  '/workspace.js': ['workspace.js', 'text/javascript; charset=utf-8'],
  '/providers-view.js': ['providers-view.js', 'text/javascript; charset=utf-8'],
  '/sessions-view.js': ['sessions-view.js', 'text/javascript; charset=utf-8'],
  '/styles.css': ['styles.css', 'text/css; charset=utf-8'],
  '/favicon.svg': ['favicon.svg', 'image/svg+xml'],
};

const server = http.createServer(async (request, response) => {
  response.setHeader('X-Content-Type-Options', 'nosniff');
  response.setHeader('Referrer-Policy', 'no-referrer');
  response.setHeader('Cache-Control', 'no-store');
  response.setHeader('Content-Security-Policy', "default-src 'self'; script-src 'self'; style-src 'self'; connect-src 'self'; img-src 'self' data:; base-uri 'none'; frame-ancestors 'none'; form-action 'self'");
  try {
    if (!['127.0.0.1', '::ffff:127.0.0.1', '::1'].includes(request.socket.remoteAddress)) return send(response, 403, { error: '面板仅供本机访问。' });
    if (request.headers.host !== `127.0.0.1:${port}`) return send(response, 403, { error: '请使用 127.0.0.1 打开面板。' });
    const url = new URL(request.url, origin);
    if (request.method === 'GET' && url.pathname === '/health') return send(response, 200, { type: 'codex-local-scheduler', applicationId: store.data.applicationId, root, active: !!scheduler.active });
    if (request.method === 'GET' && assets[url.pathname]) {
      const [file, contentType] = assets[url.pathname];
      if (url.pathname === '/') response.setHeader('Set-Cookie', `scheduler_session=${sessionSecret}; Path=/; HttpOnly; SameSite=Strict`);
      response.writeHead(200, { 'Content-Type': contentType });
      return response.end(readFileSync(path.join(root, 'web', file)));
    }
    if (!url.pathname.startsWith('/api/')) return send(response, 404, { error: '地址不存在。' });
    if (!isAuthenticated(request)) return send(response, 401, { error: '面板连接已更新，请刷新页面。' });
    if (request.headers.origin && request.headers.origin !== origin) return send(response, 403, { error: '请求来源无效。' });
    if (!['GET', 'HEAD'].includes(request.method) && (request.headers.origin !== origin || request.headers['x-scheduler-request'] !== '1')) return send(response, 403, { error: '请在本机面板中执行此操作。' });

    if (request.method === 'GET' && url.pathname === '/api/state') return send(response, 200, snapshot());
    if (request.method === 'POST' && url.pathname === '/api/sessions/sync') { await sessions.refresh(); return send(response, 200, snapshot()); }
    if (request.method === 'POST' && url.pathname === '/api/sessions/settings') { sessions.configure(await body(request)); return send(response, 200, snapshot()); }
    if (request.method === 'POST' && url.pathname === '/api/notifications/test') {
      await system.notify('AgentDesk 提醒已连接', '任务完成或需要处理时，会在这里提醒你。', origin + '/#sessions');
      return send(response, 200, { ok: true });
    }
    const sessionMatch = url.pathname.match(/^\/api\/sessions\/([^/]+)$/);
    if (request.method === 'PUT' && sessionMatch) return send(response, 200, sessions.update(decodeURIComponent(sessionMatch[1]), await body(request)));
    const notificationMatch = url.pathname.match(/^\/api\/notifications\/([a-zA-Z0-9-]+)\/read$/);
    if (request.method === 'POST' && notificationMatch) { sessions.read(notificationMatch[1]); return send(response, 200, snapshot()); }
    if (request.method === 'POST' && url.pathname === '/api/settings') {
      const input = await body(request);
      if (typeof input.autostart === 'boolean') await system.setAutostart(input.autostart);
      scheduler.configure(input);
      system.setAwake(store.data.settings.keepAwake);
      return send(response, 200, snapshot());
    }
    if (request.method === 'POST' && url.pathname === '/api/queue/reorder') {
      scheduler.reorder((await body(request)).ids);
      return send(response, 200, snapshot());
    }
    if (request.method === 'POST' && url.pathname === '/api/desktop/workbuddy/launch') {
      if (scheduler.active) throw new Error('请等待面板当前任务结束后启动桌面连接。');
      return send(response, 200, await providers.get('workbuddyDesktop').launch());
    }
    const providerMatch = url.pathname.match(/^\/api\/providers\/(antigravity|workbuddy|antigravityDesktop|workbuddyDesktop)$/);
    if (request.method === 'POST' && providerMatch) {
      if (scheduler.active) throw new Error('请等待当前运行结束再调整接入。');
      const input = await body(request);
      const provider = providers.get(providerMatch[1]);
      if (provider.checking || scheduler.maintenance) throw new Error('Agent 正在验证接入，请等待完成。');
      provider.checking = true;
      let result;
      if (input.verify) { scheduler.maintenance = true; scheduler.emit('change'); }
      try {
        result = await provider.probe(typeof input.binary === 'string' ? input.binary.trim() : undefined);
        if (input.verify && result.available) result = await provider.verify();
      } finally {
        provider.checking = false;
        if (input.verify) { scheduler.maintenance = false; scheduler.emit('change'); }
      }
      store.data.settings.providers ||= {};
      store.data.settings.providers[provider.id] = { binary: provider.configured, verification: provider.verification };
      store.save();
      scheduler.emit('change');
      return send(response, 200, result);
    }
    if (request.method === 'GET' && url.pathname === '/api/events') {
      response.writeHead(200, { 'Content-Type': 'text/event-stream', Connection: 'keep-alive', 'Cache-Control': 'no-cache' });
      response.write('event: ready\ndata: {}\n\n');
      clients.add(response);
      const heartbeat = setInterval(() => response.write(': keepalive\n\n'), 15000);
      request.on('close', () => { clearInterval(heartbeat); clients.delete(response); });
      return;
    }
    if (request.method === 'GET' && url.pathname === '/api/threads') {
      const provider = url.searchParams.get('provider') || 'codex';
      if (provider !== 'codex') {
        if (!providers.has(provider)) throw new Error('Agent 接入不存在。');
        const folder = url.searchParams.get('cwd');
        if (providers.get(provider).listThreads) return send(response, 200, { threads: await providers.get(provider).listThreads(folder), nextCursor: null });
        const seen = new Set();
        const threads = store.data.runs.slice().reverse().filter(run => {
          if (run.provider !== provider || !run.threadId || seen.has(run.threadId) || (folder && path.normalize(run.cwd).toLowerCase() !== path.normalize(folder).toLowerCase())) return false;
          seen.add(run.threadId); return true;
        }).map(run => ({ id: run.threadId, name: run.taskTitle, cwd: run.cwd, status: run.status }));
        return send(response, 200, { threads, nextCursor: null });
      }
      const folder = url.searchParams.get('cwd');
      const result = await client.listThreads({ cwd: folder ? validateFolder(folder) : undefined, cursor: url.searchParams.get('cursor'), searchTerm: url.searchParams.get('search') });
      const threads = (result.data || []).map(thread => ({
        id: thread.id, name: thread.name || thread.preview?.slice(0, 100) || '未命名对话', cwd: thread.cwd,
        updatedAt: thread.updatedAt, status: thread.status?.type || 'notLoaded',
      }));
      return send(response, 200, { threads, nextCursor: result.nextCursor || null });
    }
    const runMatch = url.pathname.match(/^\/api\/runs\/([a-zA-Z0-9-]+)$/);
    if (request.method === 'GET' && runMatch) {
      const run = store.data.runs.find(run => run.id === runMatch[1]);
      return run ? send(response, 200, run) : send(response, 404, { error: '运行记录不存在。' });
    }
    if (request.method === 'POST' && url.pathname === '/api/connect') {
      await client.connect();
      return send(response, 200, snapshot());
    }
    if (request.method === 'POST' && url.pathname === '/api/folders/pick') return send(response, 200, await chooseFolder((await body(request)).cwd || ''));
    if (request.method === 'POST' && url.pathname === '/api/folders/validate') return send(response, 200, { cwd: validateFolder((await body(request)).cwd) });
    if (request.method === 'POST' && url.pathname === '/api/tasks') return send(response, 201, await scheduler.saveTask(await body(request)));
    const editMatch = url.pathname.match(/^\/api\/tasks\/([a-zA-Z0-9-]+)\/(hold|release)$/);
    if (request.method === 'POST' && editMatch) {
      const input = await body(request);
      scheduler[editMatch[2]](editMatch[1], input.token);
      return send(response, 200, { ok: true });
    }
    const taskMatch = url.pathname.match(/^\/api\/tasks\/([a-zA-Z0-9-]+)(?:\/(pause|resume|run))?$/);
    if (taskMatch) {
      const [, id, action] = taskMatch;
      if (request.method === 'PUT' && !action) return send(response, 200, await scheduler.saveTask(await body(request), id));
      if (request.method === 'DELETE' && !action) { scheduler.remove(id); return send(response, 200, { ok: true }); }
      if (request.method === 'POST' && ['pause', 'resume'].includes(action)) return send(response, 200, scheduler.pause(id, action === 'pause'));
      if (request.method === 'POST' && action === 'run') {
        const run = await scheduler.runNow(id);
        return send(response, 200, { id: run.id, status: run.status, error: run.error });
      }
    }
    const interruptMatch = url.pathname.match(/^\/api\/runs\/([a-zA-Z0-9-]+)\/interrupt$/);
    if (request.method === 'POST' && interruptMatch) { await scheduler.interrupt(interruptMatch[1]); return send(response, 200, { ok: true }); }
    const responseMatch = url.pathname.match(/^\/api\/requests\/([a-zA-Z0-9-]+)\/respond$/);
    if (request.method === 'POST' && responseMatch) { scheduler.respond(responseMatch[1], await body(request)); return send(response, 200, { ok: true }); }
    if (request.method === 'POST' && url.pathname === '/api/shutdown') {
      if (scheduler.maintenance) return send(response, 409, { error: 'Agent 正在验证接入，请等待验证结束再停止后台。' });
      if (scheduler.active) return send(response, 409, { error: '有任务正在运行，请先停止运行，再关闭后台。' });
      send(response, 200, { ok: true });
      void shutdown();
      return;
    }
    send(response, 404, { error: '操作不存在。' });
  } catch (error) {
    if (!response.headersSent) send(response, 400, { error: error.message });
    else response.end();
  }
});

async function shutdown() {
  if (shuttingDown) return;
  shuttingDown = true;
  scheduler.stop();
  sessions.close();
  nativeWorkBuddy.close();
  system.close();
  for (const provider of providers.values()) provider.close?.();
  client.close();
  for (const response of clients) response.end();
  server.close();
  clearTimeout(changeTimer);
  try { if (JSON.parse(readFileSync(lockFile, 'utf8')).pid === process.pid) unlinkSync(lockFile); } catch {}
  setTimeout(() => process.exit(0), 200);
}

server.on('error', error => { console.error(error.code === 'EADDRINUSE' ? `端口 ${port} 已被占用。` : error.message); void shutdown(); });
server.listen(port, '127.0.0.1', () => {
  console.log(`AgentDesk: ${origin}`);
  scheduler.start();
  sessions.start();
  void system.inspect().then(() => scheduler.emit('change'));
  system.setAwake(store.data.settings.keepAwake);
  for (const provider of providers.values()) void provider.probe().then(() => scheduler.emit('change'));
  client.connect().catch(error => { console.error(error.message); scheduler.emit('change'); });
});
process.on('SIGINT', shutdown);
process.on('SIGTERM', shutdown);
