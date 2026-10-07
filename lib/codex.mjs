import { EventEmitter } from 'node:events';
import { spawn } from 'node:child_process';
import { createInterface } from 'node:readline';
import { existsSync, readdirSync, statSync } from 'node:fs';
import { homedir } from 'node:os';
import path from 'node:path';

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
    const proc = spawn(this.binary.command, [...this.binary.args, 'app-server', '--stdio'], {
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

  async listThreads({ cwd, cursor, searchTerm } = {}) {
    const params = {
      limit: 100, sortKey: 'updated_at', modelProviders: [],
      sourceKinds: ['cli', 'vscode', 'appServer', 'exec', 'unknown'], useStateDbOnly: true,
    };
    if (cwd) params.cwd = cwd;
    if (cursor) params.cursor = cursor;
    if (searchTerm) params.searchTerm = searchTerm;
    return this.request('thread/list', params);
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
