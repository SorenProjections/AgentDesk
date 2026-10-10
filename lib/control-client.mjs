export class ControlClient {
  constructor({ base = process.env.CODEX_SCHEDULER_URL || 'http://127.0.0.1:43127', fetcher = fetch } = {}) {
    const url = new URL(base);
    if (url.protocol !== 'http:' || url.hostname !== '127.0.0.1' || url.username || url.password || url.pathname !== '/' || url.search || url.hash) throw new Error('工具只连接 http://127.0.0.1:<端口> 的本机后台。');
    this.base = url.origin; this.fetcher = fetcher;
  }
  async connect() {
    const response = await this.fetcher(this.base + '/health', { signal: AbortSignal.timeout(5000), redirect: 'error' });
    const health = await response.json();
    if (!response.ok || health.type !== 'codex-local-scheduler') throw new Error('目标端口不是 AgentDesk 后台。');
    const opened = await this.fetcher(this.base + '/', { signal: AbortSignal.timeout(5000), redirect: 'error' });
    this.cookie = opened.headers.get('set-cookie')?.split(';')[0];
    if (!this.cookie?.startsWith('scheduler_session=')) throw new Error('无法建立本机工具会话。');
    return health;
  }
  async request(route, method = 'GET', input) {
    if (!this.cookie) await this.connect();
    const headers = { Cookie: this.cookie, Origin: this.base, 'X-Scheduler-Request': '1' };
    if (method !== 'GET') headers['Content-Type'] = 'application/json';
    const response = await this.fetcher(this.base + '/api/' + route, { method, headers,
      body: method === 'GET' ? undefined : JSON.stringify(input || {}), signal: AbortSignal.timeout(650000), redirect: 'error' });
    const result = await response.json();
    // A lost response may follow a successful dispatch: never automatically retry mutations.
    if (!response.ok) throw new Error(result.error || 'HTTP ' + response.status);
    return result;
  }
}
