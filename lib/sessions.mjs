import { EventEmitter } from 'node:events';
import { randomUUID } from 'node:crypto';

const active = new Set(['running', 'waiting', 'dispatching']);
const terminal = new Set(['completed', 'failed', 'interrupted']);
const actionable = new Set(['waiting', 'failed', 'interrupted', 'uncertain']);
export const sessionKey = (provider, id) => `${provider}:${id}`;
export function normalizeSessionStatus(status) {
  if (['working', 'planning', 'busy', 'active'].includes(status)) return 'running';
  if (['pending', 'waiting', 'waitingForUser', 'waitingOnApproval'].includes(status)) return 'waiting';
  if (['error', 'systemError'].includes(status)) return 'failed';
  if (['cancelled', 'canceled'].includes(status)) return 'interrupted';
  return ['idle', 'running', 'completed', 'failed', 'interrupted', 'uncertain', 'dispatching'].includes(status) ? status : 'uncertain';
}

export class SessionHub extends EventEmitter {
  constructor(store, { sources = [], notifier, clock = Date.now } = {}) {
    super(); this.store = store; this.sources = sources; this.notifier = notifier; this.clock = clock;
    store.data.sessions ||= []; store.data.notifications ||= [];
    store.data.sessionSettings = { desktopNotifications: true, quietUntil: 0, ...store.data.sessionSettings };
    this.sourceStates = []; this.lastSyncAt = null; this.closed = false;
  }
  snapshot() {
    const sessions = this.store.data.sessions.filter(s => !s.internal);
    const keys = new Set(sessions.map(s => s.key));
    const notifications = this.store.data.notifications.filter(n => keys.has(n.sessionKey));
    return { sessions, notifications: notifications.toReversed(), settings: this.store.data.sessionSettings, sources: this.sourceStates, lastSyncAt: this.lastSyncAt, syncing: !!this.pending,
      counts: { running: sessions.filter(s => active.has(s.status)).length, attention: sessions.filter(s => (s.needsAttention || s.disconnected && active.has(s.status)) && !s.hidden).length, unread: notifications.filter(n => !n.readAt).length } };
  }
  save() { if (this.closed) return; this.store.save(); this.emit('change'); }
  ingest(provider, row, { notify = true } = {}) {
    const key = sessionKey(provider, row.id); const list = this.store.data.sessions;
    let session = list.find(s => s.key === key);
    const previous = session && { status: session.status, version: session.version, disconnected: session.disconnected };
    if (!session) { session = { key, provider, nativeId: row.id, watched: true, pinned: false, hidden: false, alias: '', note: '', firstSeenAt: this.clock(), alerts: [] }; list.push(session); }
    const status = normalizeSessionStatus(row.status);
    const { id, ...fields } = row;
    Object.assign(session, fields, { status, lastSeenAt: this.clock(), disconnected: false });
    // A first import establishes a baseline. A later explicit terminal event can
    // notify even when the entire turn ran between two polls.
    const changedTurn = previous && row.version && row.version !== previous.version;
    const changedState = previous && status !== previous.status;
    if(session.needsAttention == null) session.needsAttention = status === 'waiting';
    if(changedState || changedTurn) session.needsAttention = status === 'waiting' || actionable.has(status) && (active.has(previous.status) || !!changedTurn);
    if(session.reviewedVersion === session.version && status !== 'waiting') session.needsAttention = false;
    if(session.internal) session.needsAttention = false;
    if (notify && previous && session.watched && !session.internal && (changedState || changedTurn)) {
      const finished = terminal.has(status) && (active.has(previous.status) || previous.status === 'uncertain' || changedTurn);
      if (finished || status === 'waiting' || (status === 'uncertain' && active.has(previous.status))) this.alert(session, status);
    }
    return session;
  }
  alert(session, kind) {
    const dedupe = `${session.version || 'unknown'}:${kind}`;
    if (session.alerts.includes(dedupe)) return;
    session.alerts.push(dedupe); session.alerts = session.alerts.slice(-80);
    const labels = { completed: '已完成', failed: '运行失败', interrupted: '已停止', waiting: '需要你处理', uncertain: '状态需要核实', disconnected: '连接已中断' };
    this.store.data.notifications.push({ id: randomUUID(), sessionKey: session.key, provider: session.provider, kind, title: `${session.alias || session.name}：${labels[kind]}`, detail: session.error || session.evidence || '', at: this.clock(), readAt: null, delivery: 'pending' });
    // Never discard unread results. Keep the most recent 300 read entries.
    const read = this.store.data.notifications.filter(n => n.readAt).slice(-300);
    this.store.data.notifications = this.store.data.notifications.filter(n => !n.readAt).concat(read).sort((a,b) => a.at - b.at);
  }
  syncRuns() {
    if (this.closed) return false;
    let changed = false;
    const latest = new Map();
    for (const run of this.store.data.runs) latest.set(run.threadId ? sessionKey(run.provider || 'codex', run.threadId) : `queue:${run.id}`, run);
    for (const [key, run] of latest) {
      let session = this.store.data.sessions.find(s => s.key === key);
      const version = run.id;
      if (session?.queueVersion === version && session.queueStatus === run.status) continue;
      const first = !session;
      if (run.threadId) {
        // Scheduler status is authoritative for its own current turn, but old
        // completed queue runs must not overwrite newer native activity.
        if (!active.has(run.status) && session && !active.has(session.queueStatus) && session.lastSeenAt > (run.endedAt || run.startedAt)) {
          session.queueVersion = version; session.queueStatus = run.status; session.runId = run.id; session.taskId = run.taskId; changed = true; continue;
        }
        session = this.ingest(run.provider || 'codex', { id: run.threadId, name: session?.name || run.taskTitle, cwd: run.cwd, status: run.status, version: `queue-${run.id}`, updatedAt: run.endedAt || run.startedAt, startedAt: run.startedAt, error: run.error || '', evidence: '本工作台的执行记录', output: (run.output || '').slice(-6000) });
        this.store.data.sessions = this.store.data.sessions.filter(s => s.key !== `queue:${run.id}`);
      } else {
        if (!session) { session = { key, provider: run.provider || 'codex', nativeId: '', name: run.taskTitle, cwd: run.cwd, watched: true, pinned: false, hidden: false, alias: '', note: '', alerts: [], firstSeenAt: this.clock() }; this.store.data.sessions.push(session); }
        const previous = session.status; Object.assign(session, { status: run.status, version, lastSeenAt: this.clock(), evidence: '本工作台的执行记录', error: run.error || '', needsAttention: run.status === 'waiting' || !first && actionable.has(run.status) });
        if (!first && previous !== run.status && (terminal.has(run.status) || actionable.has(run.status))) this.alert(session, run.status);
      }
      session.queueVersion = version; session.queueStatus = run.status; session.runId = run.id; session.taskId = run.taskId; changed = true;
    }
    if (changed) this.save();
    return changed;
  }
  async refresh() {
    if (this.closed) return;
    if (this.pending) return this.pending;
    this.pending = this.poll().finally(() => { this.pending = null; });
    return this.pending;
  }
  async poll() {
    const results = await Promise.allSettled(this.sources.map(async source => {
      const known = this.store.data.sessions.filter(s => s.provider === source.id && (s.watched || active.has(s.status))).map(s => s.nativeId).filter(Boolean);
      const rows = await source.list(known); return { source, rows };
    }));
    if (this.closed) return;
    this.sourceStates = results.map((result, i) => {
      const source = this.sources[i];
      if (result.status === 'rejected') {
        for (const s of this.store.data.sessions.filter(s => s.provider === source.id)) {
          if (!s.disconnected && active.has(s.status) && s.watched && !s.internal) this.alert(s, 'disconnected');
          s.disconnected = true;
        }
        return { id: source.id, name: source.name, available: false, detail: result.reason.message };
      }
      const seen = new Set();
      for (const row of result.value.rows) {
        seen.add(sessionKey(source.id, row.id));
        const existing = this.store.data.sessions.find(s => s.key === sessionKey(source.id, row.id));
        const run = existing?.runId && this.store.data.runs.find(r => r.id === existing.runId);
        if (run && active.has(run.status)) { existing.lastSeenAt = this.clock(); existing.disconnected = false; existing.queueNativeVersion = row.version; continue; }
        const queueMirror = existing?.version?.startsWith('queue-') && terminal.has(existing.queueStatus) && (row.version === existing.queueNativeVersion || !row.updatedAt || row.updatedAt <= (run?.endedAt || 0));
        const session = this.ingest(source.id, row, { notify: !queueMirror });
        if(queueMirror && terminal.has(row.status)) session.alerts.push(`${row.version || 'unknown'}:${row.status}`);
      }
      for (const s of this.store.data.sessions.filter(s => s.provider === source.id && s.nativeId && !seen.has(s.key))) {
        if(!s.disconnected && active.has(s.status) && s.watched && !s.internal)this.alert(s,'disconnected');
        s.disconnected = true;
      }
      return { id: source.id, name: source.name, available: true, count: result.value.rows.filter(r => !r.internal).length, detail: source.detail || '原生会话已同步' };
    });
    this.lastSyncAt = this.clock(); this.syncRuns(); this.save(); await this.deliver();
  }
  async deliver() {
    if (this.closed || this.delivering || !this.notifier || !this.store.data.sessionSettings.desktopNotifications || this.store.data.sessionSettings.quietUntil > this.clock()) return;
    const pending = this.store.data.notifications.filter(n => !n.readAt && n.delivery === 'pending' && !this.store.data.sessions.find(s => s.key === n.sessionKey)?.internal);
    if (!pending.length) return;
    this.delivering = true;
    // Persist before crossing the OS boundary, avoiding duplicate popups on crash.
    for (const n of pending) n.delivery = 'attempted'; this.save();
    try {
      await this.notifier(pending.length === 1 ? pending[0].title : `${pending.length} 条 Agent 提醒待查看`, pending.length === 1 ? pending[0].detail : pending.slice(-3).map(n => n.title).join('\n'));
      for (const n of pending) n.delivery = 'sent';
    } catch (error) { for (const n of pending) { n.delivery = 'failed'; n.deliveryError = error.message; } }
    finally { this.delivering = false; this.save(); }
  }
  update(key, input) {
    const s = this.store.data.sessions.find(s => s.key === key); if (!s) throw new Error('会话映射不存在。');
    for (const field of ['watched', 'pinned', 'hidden']) if (typeof input[field] === 'boolean') s[field] = input[field];
    for (const [field, limit] of [['alias', 100], ['note', 2000]]) if (typeof input[field] === 'string') s[field] = input[field].trim().slice(0, limit);
    if(input.reviewed === true && !active.has(s.status)){s.reviewedVersion = s.version;s.needsAttention = false;}
    this.save(); return s;
  }
  read(id) {
    const items = id === 'all' ? this.store.data.notifications : this.store.data.notifications.filter(n => n.id === id);
    if (!items.length && id !== 'all') throw new Error('提醒不存在。');
    for (const n of items) n.readAt ||= this.clock(); this.save();
  }
  configure(input) {
    const s = this.store.data.sessionSettings;
    if (typeof input.desktopNotifications === 'boolean') s.desktopNotifications = input.desktopNotifications;
    if (input.quietMinutes != null) { const minutes = Number(input.quietMinutes); if (!Number.isInteger(minutes) || minutes < 0 || minutes > 240) throw new Error('安静时段需为 0–240 分钟。'); s.quietUntil = minutes ? this.clock() + minutes * 60000 : 0; }
    this.save(); void this.deliver();
  }
  start() { this.syncRuns(); void this.refresh().catch(e => this.emit('fault', e)); this.timer = setInterval(() => void this.refresh().catch(e => this.emit('fault', e)), 5000); }
  close() { this.closed = true; clearInterval(this.timer); for (const source of this.sources) source.close?.(); }
}
