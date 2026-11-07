import { EventEmitter } from 'node:events';
import { spawn } from 'node:child_process';
import { createInterface } from 'node:readline';
import { existsSync, readdirSync, statSync, readFileSync } from 'node:fs';
import { homedir } from 'node:os';
import path from 'node:path';
import { containsPath, pathKey, samePath } from './paths.mjs';
import { desktopPermissionSelection, resolveCodexPermissions } from './codex-permissions.mjs';
import { desktopProjectTool } from './codex-desktop.mjs';

export function findCodex() {
  if (process.env.CODEX_SCHEDULER_BINARY) {
    const binary = path.resolve(process.env.CODEX_SCHEDULER_BINARY);
    if (!existsSync(binary)) throw new Error('CODEX_SCHEDULER_BINARY 指向的程序不存在。');
    return { command: binary, args: [] };
  }
  if (process.platform === 'win32') {
    const desktop = path.join(process.env.LOCALAPPDATA || path.join(homedir(), 'AppData', 'Local'), 'OpenAI', 'Codex', 'bin');
    if (existsSync(desktop)) {
      const binaries = readdirSync(desktop, { withFileTypes: true })
        .filter(entry => entry.isDirectory())
        .map(entry => path.join(desktop, entry.name, 'codex.exe'))
        .filter(file => existsSync(file))
        .sort((a, b) => statSync(b).mtimeMs - statSync(a).mtimeMs);
      if (binaries[0]) return { command: binaries[0], args: [] };
    }
    const npmCli = path.join(process.env.APPDATA || path.join(homedir(), 'AppData', 'Roaming'), 'npm', 'node_modules', '@openai', 'codex', 'bin', 'codex.js');
    if (existsSync(npmCli)) return { command: process.execPath, args: [npmCli] };
  }
  return { command: 'codex', args: [] };
}

function redact(text) {
  return text.replace(/(Bearer\s+)[^\s"']+/gi, '$1[redacted]')
    .replace(/\b(?:sk-|sk-proj-)[A-Za-z0-9_-]{12,}/g, '[redacted]')
    .replace(/((?:api[_-]?key|access[_-]?token|refresh[_-]?token)\s*[=:]\s*)[^\s,]+/gi, '$1[redacted]');
}

export class CodexClient extends EventEmitter {
  constructor({ binary = findCodex(), cwd = process.cwd(), requestTimeout = 45000 } = {}) {
    super();
    this.binary = binary;
    this.cwd = cwd;
    this.requestTimeout = requestTimeout;
    this.pending = new Map();
    this.nextId = 0;
    this.proc = null;
    this.connecting = null;
    this.connected = false;
    this.lastError = '';
    this.defaults = {};
    this.closed = false;
  }

  async connect() {
    if (this.connected) return this;
    if (this.connecting) return this.connecting;
    if (this.closed) throw new Error('Codex 连接已关闭。');
    this.connecting = this.#connect().finally(() => { this.connecting = null; });
    return this.connecting;
  }

  async #connect() {
    this.lastError = '';
    const proc = spawn(this.binary.command, [...this.binary.args, '-c', 'thread_unload_delay_secs=0', 'app-server', '--stdio'], {
      cwd: this.cwd, windowsHide: true, stdio: ['pipe', 'pipe', 'pipe'], env: process.env,
    });
    this.proc = proc;
    const lines = createInterface({ input: proc.stdout });
    lines.on('line', line => this.#message(line));
    proc.stderr.on('data', data => { this.lastError = redact((this.lastError + data.toString('utf8')).slice(-4000)); });
    proc.stdin.on('error', () => {});
    proc.on('error', error => this.#disconnected(proc, error));
    proc.on('exit', code => this.#disconnected(proc, new Error(this.lastError || `Codex 接口退出，代码 ${code}。`)));
    try {
      const init = await this.#request('initialize', {
        clientInfo: { name: 'agentdesk', title: 'AgentDesk 智能体工作台', version: '3.0.0' },
        capabilities: { experimentalApi: true },
      });
      this.userAgent = init.userAgent;
      this.notify('initialized', {});
      this.connected = true;
      const config = await this.#request('config/read', { includeLayers: false });
      this.defaults = {
        model: config.config?.model || '', provider: config.config?.model_provider || '',
        effort: config.config?.model_reasoning_effort || '', sandbox: config.config?.sandbox_mode || '',
        reviewer: resolveCodexPermissions(config.config || {}, desktopPermissionSelection()).approvalsReviewer,
        networkAccess: config.config?.sandbox_workspace_write?.network_access === true,
      };
      this.emit('connected');
      return this;
    } catch (error) {
      this.connected = false;
      if (this.proc === proc) this.proc = null;
      if (!proc.killed && proc.exitCode === null) proc.kill();
      throw error;
    }
  }

  #disconnected(proc, error) {
    if (this.proc !== proc) return;
    this.proc = null;
    this.connected = false;
    this.lastError = redact(error.message);
    for (const pending of this.pending.values()) {
      clearTimeout(pending.timer);
      pending.reject(error);
    }
    this.pending.clear();
    this.emit('disconnected', this.lastError);
  }

  #message(line) {
    let message;
    try { message = JSON.parse(line); } catch { return; }
    if (message.method) {
      this.emit(message.id == null ? 'notification' : 'request', message);
      return;
    }
    const pending = this.pending.get(message.id);
    if (!pending) return;
    this.pending.delete(message.id);
    clearTimeout(pending.timer);
    if (message.error) {
      const error = new Error(redact(message.error.message || 'Codex 接口请求失败。'));
      error.rpcCode = message.error.code;
      pending.reject(error);
    } else pending.resolve(message.result);
  }

  #request(method, params) {
    return new Promise((resolve, reject) => {
      if (!this.proc || this.proc.stdin.destroyed) return reject(new Error('Codex 接口尚未连接。'));
      const id = ++this.nextId;
      const timer = setTimeout(() => {
        this.pending.delete(id);
        const error = new Error(`${method} 等待响应超时。${this.lastError ? ' ' + this.lastError : ''}`);
        error.uncertainDelivery = method === 'turn/start';
        reject(error);
      }, this.requestTimeout);
      this.pending.set(id, { resolve, reject, timer });
      this.proc.stdin.write(JSON.stringify({ id, method, params }) + '\n', error => {
        if (!error || !this.pending.has(id)) return;
        clearTimeout(timer);
        this.pending.delete(id);
        reject(error);
      });
    });
  }

  async request(method, params = {}) {
    await this.connect();
    return this.#request(method, params);
  }

  notify(method, params) {
    this.proc?.stdin.write(JSON.stringify({ method, params }) + '\n');
  }

  respond(id, result) {
    if (!this.connected) throw new Error('Codex 已断开，无法提交回答。');
    this.proc.stdin.write(JSON.stringify({ id, result }) + '\n');
  }

  rejectRequest(id, message) {
    this.proc?.stdin.write(JSON.stringify({ id, error: { code: -32601, message } }) + '\n');
  }

  async listProjects() {
    const projects = [], seen = new Set();
    let cursor;
    do {
      const result = await this.request('project/list', { limit: 100, ...(cursor ? { cursor } : {}) });
      if (!Array.isArray(result.data)) throw new Error('Codex 未返回项目列表，请更新客户端后重试。');
      projects.push(...result.data.map(project => ({ ...project, rootPaths: (project.roots || []).map(root => root.path) })));
      cursor = result.nextCursor;
      if (cursor && seen.has(cursor)) throw new Error('Codex 项目列表分页异常，请重新连接。');
      seen.add(cursor);
    } while (cursor);
    return projects;
  }

  async permissionsFor(task) {
    const { config } = await this.request('config/read', { cwd: task.cwd, includeLayers: false });
    const resolved = resolveCodexPermissions(config, desktopPermissionSelection());
    if (resolved.sandboxPolicy.type === 'workspaceWrite') resolved.sandboxPolicy.writableRoots = [...new Set([task.cwd, ...resolved.sandboxPolicy.writableRoots])];
    return resolved;
  }

  async syncDesktopProject(threadId, project) {
    const catalog = await desktopProjectTool('list_projects', {});
    let state = {};
    try { state = JSON.parse(readFileSync(path.join(process.env.CODEX_HOME || path.join(homedir(), '.codex'), '.codex-global-state.json'), 'utf8')); }
    catch (error) { if (error.code !== 'ENOENT') throw error; }
    const aliases = Object.values(state['app-server-project-id-by-legacy-project-id-by-host'] || {}).flatMap(map => Object.entries(map)).filter(([, id]) => id === project.id).map(([id]) => id);
    const matches = catalog.projects.filter(row => row.projectKind === 'local' && row.hostId === 'local' &&
      (aliases.includes(row.projectId) || row.projectId === project.id || row.label === project.name && project.rootPaths.some(root => samePath(row.path, root))));
    if (matches.length !== 1) throw new Error('Codex 客户端项目无法唯一匹配，请刷新项目列表后重试。');
    const projectId = matches[0].projectId;
    const order = state['sidebar-project-thread-orders']?.[projectId]?.threadIds || [];
    const args = { hostId:'local', threadId, projectId,
      ...(!order.includes(threadId) && order.length ? {beforeThreadId:order[0]} : {}),
    };
    let pinnedForImport = false;
    try {
      let result;
      try { result = await desktopProjectTool('move_thread_to_project', args); }
      catch (error) {
        if (!error.message.includes('not available in the sidebar')) throw error;
        // Newly persisted external threads need to enter the desktop task cache.
        // Temporarily registering in its existing sidebar imports the exact ID.
        await desktopProjectTool('move_thread_to_sidebar_section', { hostId:'local', threadId, sectionId:'pinned' });
        pinnedForImport = !(state['pinned-thread-ids'] || []).includes(threadId);
        result = await desktopProjectTool('move_thread_to_project', args);
      }
      if (result.threadId !== threadId || result.projectId !== projectId) throw new Error('Codex 客户端未确认项目归属。');
      return projectId;
    } finally {
      if (pinnedForImport) await desktopProjectTool('move_thread_to_sidebar_section', { hostId:'local', threadId, sectionId:'threads' });
    }
  }

  async resolveProject(cwd, projectId = '', projects = null) {
    projects ||= await this.listProjects();
    const matches = projects.filter(project => (!projectId || project.id === projectId) && project.rootPaths.some(root => containsPath(root, cwd)));
    if (projectId && !matches.length) throw new Error('Codex 项目已移除，或工作目录不属于所选项目，请刷新项目列表。');
    const depth = project => Math.max(...project.rootPaths.filter(root => containsPath(root, cwd)).map(root => pathKey(root).length));
    matches.sort((a, b) => depth(b) - depth(a));
    if (!projectId && matches.length > 1 && depth(matches[0]) === depth(matches[1])) throw new Error('此目录对应多个 Codex 项目，请明确选择项目。');
    return matches[0] || null;
  }

  async listThreads({ cwd, cursor, searchTerm, projectId } = {}) {
    const params = {
      limit: 100, sortKey: 'updated_at', modelProviders: [],
      sourceKinds: ['cli', 'vscode', 'appServer', 'exec', 'unknown'], useStateDbOnly: true,
    };
    if (cwd) params.cwd = cwd;
    if (cursor) params.cursor = cursor;
    if (searchTerm) params.searchTerm = searchTerm;
    if (projectId) params.projectId = projectId;
    return this.request('thread/list', params);
  }

  async releaseThread(threadId, { timeout = 10000 } = {}) {
    // Never start another app-server just to clean up an old connection.
    if (!this.connected) throw new Error('Codex 连接已断开，请在桌面点击重试以核实对话状态。');
    const result = await this.request('thread/unsubscribe', { threadId });
    if (result.status === 'notLoaded') return;
    if (!['unsubscribed', 'notSubscribed'].includes(result.status)) throw new Error('Codex 未确认释放对话，请更新 Codex 后重试。');
    const deadline = Date.now() + timeout;
    do {
      if (!this.connected) throw new Error('释放期间 Codex 连接中断，请在桌面核实对话状态。');
      const loaded = await this.request('thread/loaded/list', {});
      if (!Array.isArray(loaded.data)) throw new Error('Codex 未返回对话连接状态。');
      if (!loaded.data.includes(threadId)) return;
      await new Promise(resolve => setTimeout(resolve, 100));
    } while (Date.now() < deadline);
    throw new Error('Codex 仍在释放对话，请稍后重试。');
  }

  close() {
    this.closed = true;
    this.connected = false;
    const proc = this.proc;
    this.proc = null;
    for (const pending of this.pending.values()) {
      clearTimeout(pending.timer);
      pending.reject(new Error('Codex 连接已关闭。'));
    }
    this.pending.clear();
    proc?.stdin.end();
    if (proc && !proc.killed && proc.exitCode === null) proc.kill();
  }
}
