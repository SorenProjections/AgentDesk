import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import path from 'node:path';
import { ControlClient } from '../lib/control-client.mjs';

export const projectRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const normalized = value => process.platform === 'win32' ? path.resolve(value).toLowerCase() : path.resolve(value);
function refused(error) {
  return error?.code === 'ECONNREFUSED' || (error?.cause && refused(error.cause)) || error?.errors?.some(refused);
}

export function launchBackend(base, { root = projectRoot, spawnProcess = spawn } = {}) {
  const port = new URL(base).port || '80';
  return new Promise((resolve, reject) => {
    // The existing launcher starts a detached, hidden backend and owns its log files.
    const child = spawnProcess(process.execPath, [path.join(root, 'launch.mjs'), '--no-browser'], {
      cwd: root, windowsHide: true, shell: false, stdio: ['ignore', 'ignore', 'ignore'],
      env: { ...process.env, CODEX_SCHEDULER_PORT: port },
    });
    const timer = setTimeout(() => { child.kill(); reject(new Error('后台启动超时，请检查 AgentDesk 本机日志。')); }, 25000);
    child.once('error', error => { clearTimeout(timer); reject(error); });
    child.once('close', code => {
      clearTimeout(timer);
      if (code === 0) resolve();
      else reject(new Error('后台未能启动，请检查 AgentDesk 本机日志或端口占用。'));
    });
  });
}

export class BackendGateway {
  constructor({ base = process.env.CODEX_SCHEDULER_URL || 'http://127.0.0.1:43127',
    autoStart = process.env.CODEX_SCHEDULER_AUTOSTART === '1', root = projectRoot,
    clientFactory = options => new ControlClient(options), launcher = launchBackend } = {}) {
    // Validate configuration even before the first tool call.
    new ControlClient({ base });
    this.base = base; this.autoStart = autoStart; this.root = root;
    this.clientFactory = clientFactory; this.launcher = launcher; this.starting = null;
  }
  async client() {
    // A fresh authenticated client per tool reconnects after a backend restart.
    const client = this.clientFactory({ base: this.base });
    let health;
    try { health = await client.connect(); }
    catch (error) {
      // Never start over another application, an unhealthy server or an auth error.
      if (!this.autoStart || !refused(error)) throw error;
      if (!this.starting) {
        this.starting = this.launcher(this.base, { root: this.root }).finally(() => { this.starting = null; });
      }
      await this.starting;
      health = await client.connect();
    }
    if (!health.root || normalized(health.root) !== normalized(this.root)) throw new Error('目标端口属于另一份 AgentDesk，拒绝操作。');
    return client;
  }
  async request(route, method = 'GET', payload) {
    const client = await this.client();
    // A successful mutation may lose its response. Never retry a sent mutation.
    return client.request(route, method, payload);
  }
}
