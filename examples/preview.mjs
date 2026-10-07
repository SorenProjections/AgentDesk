// Isolated UI preview. All data lives in memory; no scheduler or client is started.
import http from 'node:http';
import path from 'node:path';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

const project = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const names = { codex: 'Codex', antigravityDesktop: 'Antigravity', workbuddyDesktop: 'WorkBuddy', antigravity: 'Antigravity CLI', workbuddy: 'WorkBuddy CLI' };
export function fixture() {
  const now = Date.now();
  const specs = [
    ['codex', '优化工作台的会话管理体验', 'running', 'CodexScheduler', '正在调整页面布局与交互细节', true],
    ['antigravityDesktop', '整理项目文档与使用说明', 'running', 'project-docs', '正在检查文档中的示例与链接', false],
    ['workbuddyDesktop', '检查任务队列的异常处理', 'waiting', 'CodexScheduler', '需要在原客户端确认操作权限', false],
    ['codex', '为接续任务补充边界测试', 'running', 'scheduler-tests', '正在运行测试并检查失败项', false],
    ['workbuddyDesktop', '完成本周修改记录', 'completed', 'project-docs', '本轮任务已完成，回复可查看', false],
    ['codex', '梳理桌面客户端连接状态', 'completed', 'desktop-bridge', '本轮任务已完成，回复可查看', true],
    ['antigravityDesktop', '历史验证会话', 'idle', 'sandbox', '已结束观察', false],
  ];
  const sessions = specs.map(([provider, name, status, folder, evidence, pinned], i) => ({ key: provider + ':demo-' + i, nativeId: 'demo-' + i, provider, name, alias: '', note: '', cwd: 'E:\\' + folder, status, evidence, pinned, watched: true, hidden: i === 6, needsAttention: status === 'waiting', disconnected: false, updatedAt: now - i * 96000, lastSeenAt: now, output: status === 'completed' ? '任务已完成。\n\n已整理修改内容，并检查相关结果。' : '', readOnly: provider === 'workbuddyDesktop' }));
  const tasks = [
    ['整理界面优化后的测试结果', 'codex', 'queue', 'ready'],
    ['复查会话列表与提醒流程', 'workbuddyDesktop', 'afterTask', 'pending'],
    ['生成明天的项目进展摘要', 'antigravityDesktop', 'time', 'pending'],
  ].map(([title, provider, type, status], i) => ({ id: 'task-' + i, title, provider, cwd: 'E:\\CodexScheduler', prompt: '检查项目中的相关修改，记录验证结果与需要继续处理的问题。', times: type === 'time' ? [{ at: now + 3600000, state: 'pending' }] : [], trigger: { type, state: 'pending', taskId: 'task-0', onFailure: 'stop' }, threadMode: 'new', threadId: '', sandbox: 'workspace-write', approval: 'ask', latePolicy: 'run', model: '', effort: '', networkAccess: false, order: i, revision: 1, paused: false, createdAt: now - 600000, queueStatus: { status, reason: type === 'afterTask' ? '等待前置任务成功结束' : '' } }));
  const runs = ['completed', 'completed', 'failed'].map((status, i) => ({ id: 'run-' + i, taskId: 'history-' + i, taskTitle: ['整理本周项目修改记录', '验证已有对话的上下文接续', '检测桌面客户端连接'][i], provider: ['codex', 'workbuddyDesktop', 'antigravityDesktop'][i], cwd: 'E:\\CodexScheduler', status, startedAt: now - (5 - i) * 600000, endedAt: now - (5 - i) * 600000 + 93000, output: status === 'failed' ? '' : '检查已完成。\n\n1. 已整理本次修改涉及的文件与行为。\n2. 已验证队列排序、任务接续和会话提醒。\n3. 相关结果已保留，可继续安排下一步任务。', logs: [], prompt: '检查项目中的相关功能，并整理验证结果。', error: status === 'failed' ? '桌面客户端未连接，请打开客户端后重新检测。' : '', threadId: 'demo-run-' + i }));
  const notifications = [
    { id: 'note-0', sessionKey: sessions[2].key, provider: sessions[2].provider, title: '检查任务队列的异常处理', detail: '需要确认操作权限，请在 WorkBuddy 中处理。', at: now - 80000, readAt: null },
    { id: 'note-1', sessionKey: sessions[4].key, provider: sessions[4].provider, title: '完成本周修改记录', detail: '任务已完成，查看回复后可安排下一步。', at: now - 540000, readAt: null },
    { id: 'note-2', sessionKey: sessions[5].key, provider: sessions[5].provider, title: '梳理桌面客户端连接状态', detail: '任务已完成，已保留执行结果。', at: now - 1560000, readAt: now - 100000 },
  ];
  return { serverTime: now, tasks, runs, requests: [], activeRunId: null, settings: { queuePaused: true, pauseOnFailure: true }, system: { supported: true, autostart: false, keepingAwake: false }, connection: { connected: true, defaults: { model: '' } }, providers: Object.entries(names).map(([id, name]) => ({ id, name, available: !['workbuddy', 'antigravity'].includes(id), detail: id === 'codex' ? '本地接口已连接，支持对话续接和权限处理。' : '独立命令行入口，使用本机登录与权限配置。', capabilities: { desktop: id.endsWith('Desktop'), threads: true, resume: true, captureThread: true, watch: true, model: id !== 'workbuddyDesktop' } })), sessionHub: { sessions, notifications, settings: { desktopNotifications: true, quietUntil: 0 }, sources: ['codex', 'antigravityDesktop', 'workbuddyDesktop'].map(id => ({ id, name: names[id], available: true, count: sessions.filter(s => s.provider === id).length, detail: id === 'codex' ? '只读本机记录：最近 250 个会话及已关注会话。' : '同步当前客户端中的会话与任务状态。' })), lastSyncAt: now, counts: { running: 4, attention: 1, unread: 2 } } };
}

export function createPreviewServer({ webRoot = path.join(project, 'web') } = {}) {
  let state = fixture();
  const clients = new Set();
  const send = (res, value, status = 200) => { res.writeHead(status, { 'Content-Type': 'application/json; charset=utf-8' }); res.end(JSON.stringify(value)); };
  const updateCounts = () => {
    const hub = state.sessionHub;
    hub.counts = { running: hub.sessions.filter(s => ['running', 'waiting', 'dispatching'].includes(s.status)).length, attention: hub.sessions.filter(s => !s.hidden && s.needsAttention).length, unread: hub.notifications.filter(n => !n.readAt).length };
    state.serverTime = Date.now();
  };
  const server = http.createServer(async (req, res) => {
    try {
      const url = new URL(req.url, 'http://127.0.0.1');
      const route = decodeURIComponent(url.pathname);
      if (route === '/api/events') {
        res.writeHead(200, { 'Content-Type': 'text/event-stream', 'Cache-Control': 'no-cache' });
        res.write('event: ready\ndata: {}\n\n'); clients.add(res);
        const ping = setInterval(() => res.write(': keepalive\n\n'), 15000);
        req.on('close', () => { clearInterval(ping); clients.delete(res); }); return;
      }
      let input = {};
      if (req.method !== 'GET') { let raw = ''; for await (const chunk of req) raw += chunk; if (raw) input = JSON.parse(raw); }
      if (route === '/__preview/reset') { state = fixture(); return send(res, { ok: true }); }
      if (route === '/__preview/state' && req.method === 'POST') { Object.assign(state, input); updateCounts(); for (const client of clients) client.write('event: change\ndata: {}\n\n'); return send(res, state); }
      if (route === '/api/state') { updateCounts(); return send(res, state); }
      if (route === '/api/threads') return send(res, { threads: state.sessionHub.sessions.map(s => ({ id: s.nativeId, name: s.name, cwd: s.cwd, status: s.status })) });
      if (route.startsWith('/api/runs/')) return send(res, state.runs.find(r => r.id === route.split('/').at(-1)));
      if (route === '/api/sessions/sync') { state.sessionHub.lastSyncAt = Date.now(); return send(res, {}); }
      if (route === '/api/sessions/settings') { if ('quietMinutes' in input) state.sessionHub.settings.quietUntil = input.quietMinutes ? Date.now() + input.quietMinutes * 60000 : 0; if ('desktopNotifications' in input) state.sessionHub.settings.desktopNotifications = input.desktopNotifications; return send(res, {}); }
      if (route.startsWith('/api/sessions/')) { const session = state.sessionHub.sessions.find(s => s.key === route.slice('/api/sessions/'.length)); Object.assign(session, input); return send(res, session); }
      if (route.startsWith('/api/notifications/') && route.endsWith('/read')) { for (const note of state.sessionHub.notifications) if (route.includes('/all/') || route.includes('/' + note.id + '/')) note.readAt = Date.now(); return send(res, {}); }
      if (route === '/api/settings') { Object.assign(state.settings, input); if ('autostart' in input) state.system.autostart = input.autostart; return send(res, {}); }
      if (route === '/api/queue/reorder') { input.ids.forEach((id, i) => { state.tasks.find(t => t.id === id).order = i; }); return send(res, {}); }
      if (route.startsWith('/api/tasks')) {
        const [, , , id, action] = route.split('/');
        let task = state.tasks.find(t => t.id === id);
        if (action) { if (action === 'pause' || action === 'resume') task.paused = action === 'pause'; return send(res, task); }
        if (req.method === 'DELETE') { state.tasks = state.tasks.filter(t => t.id !== id); return send(res, {}); }
        if (!task) { task = { id: 'task-demo-' + state.tasks.length, createdAt: Date.now(), order: state.tasks.length, revision: 1, paused: true, queueStatus: { status: 'paused' } }; state.tasks.push(task); }
        Object.assign(task, input, { times: input.times.map(at => ({ at, state: 'pending' })), trigger: { ...input.trigger, state: 'pending' }, revision: task.revision + 1 }); return send(res, task);
      }
      if (route.startsWith('/api/')) return send(res, { error: '演示模式：此操作不会连接客户端或发送任务。' }, 400);
      const file = route === '/' ? 'index.html' : route.slice(1);
      if (!['index.html', 'styles.css', 'app.js', 'api.js', 'workspace.js', 'providers-view.js', 'sessions-view.js', 'favicon.svg'].includes(file)) return send(res, {}, 404);
      let content = readFileSync(path.join(webRoot, file), 'utf8');
      if (file === 'index.html') content = content.replace('</body>', '<div style="position:fixed;bottom:8px;left:8px;z-index:100;font:11px/1.5 sans-serif;padding:5px 9px;border:1px solid #ccd6e5;border-radius:6px;background:#fff;color:#53637b;pointer-events:none">界面预览 · 演示数据</div></body>');
      const types = { html: 'text/html', css: 'text/css', js: 'text/javascript', svg: 'image/svg+xml' };
      res.writeHead(200, { 'Content-Type': types[file.split('.').at(-1)] + '; charset=utf-8', 'Cache-Control': 'no-store' }); res.end(content);
    } catch (error) { send(res, { error: error.message }, 500); }
  });
  return server;
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  createPreviewServer().listen(43128, '127.0.0.1', () => console.log('UI preview: http://127.0.0.1:43128 (in-memory demo data)'));
}
