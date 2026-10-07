import { open, readdir } from 'node:fs/promises';
import path from 'node:path';
import { homedir } from 'node:os';
import { StringDecoder } from 'node:string_decoder';

// Desktop and CLI use different app-server processes. Their persisted lifecycle
// events are observable without resuming a thread or changing its native state.
export function reduceCodexEvent(state, event) {
  const p = event?.payload;
  if (event?.type !== 'event_msg' || !p) return state;
  const at = Date.parse(event.timestamp);
  if (p.type === 'task_started') return { status: 'running', version: p.turn_id || event.timestamp, startedAt: at, updatedAt: at, output: '' };
  if (['task_complete', 'turn_aborted'].includes(p.type)) {
    if (state.version && p.turn_id && state.version !== p.turn_id) return state;
    return { ...state, version: p.turn_id || state.version || event.timestamp, status: p.type === 'task_complete' ? 'completed' : 'interrupted', updatedAt: at, output: String(p.last_agent_message || '').slice(-6000) };
  }
  // Token activity and item completion are evidence of activity, never success.
  return state.version && (!p.turn_id || p.turn_id === state.version) ? { ...state, updatedAt: Number.isFinite(at) ? at : state.updatedAt } : state;
}

export class NativeCodexObserver {
  constructor({ home = process.env.CODEX_HOME || path.join(homedir(), '.codex'), clock = Date.now } = {}) {
    this.home = home; this.clock = clock; this.cache = new Map();
  }
  async database() {
    if (this.db) return this.db;
    const { DatabaseSync } = await import('node:sqlite');
    const files = (await readdir(this.home)).filter(x => /^state_\d+\.sqlite$/.test(x)).sort((a,b) => Number(b.match(/\d+/)[0]) - Number(a.match(/\d+/)[0]));
    if (!files.length) throw new Error('未找到 Codex 本机会话库。');
    this.db = new DatabaseSync(path.join(this.home, files[0]), { readOnly: true });
    const columns = this.db.prepare('PRAGMA table_info(threads)').all().map(x => x.name);
    this.titleColumn = columns.includes('name') ? 'COALESCE(name,title)' : 'title';
    return this.db;
  }
  async readRollout(file) {
    const fd = await open(file, 'r');
    try {
      const stat = await fd.stat(); let cached = this.cache.get(file);
      if (cached && cached.size === stat.size && cached.mtime === stat.mtimeMs) return cached.state;
      let start = cached && cached.size < stat.size && cached.mtime <= stat.mtimeMs ? cached.size : Math.max(0, stat.size - 512 * 1024);
      let state = start === cached?.size ? cached.state : { status: 'uncertain', version: '', output: '' };
      let pending = start === cached?.size ? cached.pending : '';
      const decoder = start === cached?.size ? cached.decoder : new StringDecoder('utf8');
      // Find the latest lifecycle marker backwards. Bound initial reads at 8 MiB;
      // an unknown older turn remains uncertain instead of guessing completion.
      if (start !== cached?.size) {
        let bytes;
        while (true) {
          bytes = Buffer.alloc(stat.size - start); await fd.read(bytes, 0, bytes.length, start);
          if (start === 0 || /"type"\s*:\s*"(?:task_started|task_complete|turn_aborted)"/.test(bytes.toString('utf8')) || stat.size - start >= 8 * 1024 * 1024) break;
          start = Math.max(0, start - 512 * 1024);
        }
        pending = decoder.write(bytes);
        if (start > 0) pending = pending.slice(pending.indexOf('\n') + 1);
      } else {
        // Read in chunks; a very long log must not allocate an unbounded buffer.
        for (let offset = start; offset < stat.size; offset += 512 * 1024) {
          const bytes = Buffer.alloc(Math.min(512 * 1024, stat.size - offset));
          await fd.read(bytes, 0, bytes.length, offset); pending += decoder.write(bytes);
          const lines = pending.split('\n'); pending = lines.pop();
          for (const line of lines) { try { state = reduceCodexEvent(state, JSON.parse(line)); } catch {} }
        }
      }
      const lines = pending.split('\n'); pending = lines.pop();
      for (const line of lines) { try { state = reduceCodexEvent(state, JSON.parse(line)); } catch {} }
      this.cache.set(file, { size: stat.size, mtime: stat.mtimeMs, state, pending, decoder });
      return state;
    } finally { await fd.close(); }
  }
  async listSessions(known = []) {
    const db = await this.database();
    const select = `SELECT id,rollout_path,cwd,source,${this.titleColumn} AS title,updated_at FROM threads WHERE archived=0 AND COALESCE(source,'') NOT LIKE '%"guardian"%'`;
    const rows = db.prepare(select + ' ORDER BY updated_at DESC LIMIT 250').all();
    const seen = new Set(rows.map(x => x.id));
    const lookup = db.prepare(select + ' AND id=?');
    for (const id of known) if (!seen.has(id)) { const row = lookup.get(id); if (row) rows.push(row); }
    const result = [];
    for (const row of rows) {
      // Only read paths supplied by Codex inside its active sessions directory.
      const relative = path.relative(path.join(this.home, 'sessions'), row.rollout_path);
      if (relative.startsWith('..') || path.isAbsolute(relative)) continue;
      try {
        const state = await this.readRollout(row.rollout_path);
        const stale = state.status === 'running' && this.clock() - (state.updatedAt || 0) > 15 * 60000;
        result.push({ id: row.id, name: row.title || '未命名会话', cwd: row.cwd.replace(/^\\\\\?\\/, ''), internal: /"guardian"/.test(row.source || ''), ...state, status: stale ? 'uncertain' : state.status, evidence: stale ? '本轮没有结束事件，超过 15 分钟无活动，请在 Codex 核实' : state.version ? 'Codex 本机轮次事件（只读）' : '历史记录没有可识别的轮次事件' });
      } catch { result.push({ id: row.id, name: row.title, cwd: row.cwd, status: 'uncertain', evidence: '原生记录暂时不可读' }); }
    }
    const paths = new Set(rows.map(x => x.rollout_path));
    for (const file of this.cache.keys()) if (!paths.has(file)) this.cache.delete(file);
    return result;
  }
  close() { this.db?.close(); this.db = null; }
}
