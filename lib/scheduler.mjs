import { EventEmitter } from 'node:events';
import { randomUUID } from 'node:crypto';
import { existsSync, realpathSync, statSync } from 'node:fs';
import path from 'node:path';

const ACTIVE = new Set(['dispatching', 'running', 'waiting']);
const samePath = (a, b) => process.platform === 'win32'
  ? path.normalize(a || '').toLowerCase() === path.normalize(b || '').toLowerCase()
  : path.normalize(a || '') === path.normalize(b || '');

export function validateFolder(input) {
  if (typeof input !== 'string' || !path.isAbsolute(input.trim())) throw new Error('请选择或填写一个完整的本地文件夹路径。');
  const folder = input.trim();
  if (!existsSync(folder) || !statSync(folder).isDirectory()) throw new Error('项目文件夹不存在或无法访问。');
  return realpathSync.native(folder);
}

export class Scheduler extends EventEmitter {
  constructor(store, client, { clock = () => Date.now(), lateThreshold = 60000, providers = new Map() } = {}) {
    super();
    this.store = store;
    this.client = client;
    this.providers = providers;
    this.editing = new Map();
    this.clock = clock;
    this.lateThreshold = lateThreshold;
    this.active = null;
    this.requests = new Map();
    this.ticking = false;
    this.saveTimer = null;
    this.timer = null;
    this.stopping = false;
    this.watching = false;
    this.#recover();
    client.on('notification', message => this.#notification(message));
    client.on('request', message => this.#serverRequest(message));
    client.on('connected', () => this.emit('change'));
    client.on('disconnected', error => {
      if (this.active && this.active.run.provider === 'codex') this.#finish(this.active.run, 'uncertain', `连接中断，无法确认最终状态。请查看对话后决定是否重发。${error}`);
      this.requests.clear();
      this.emit('change');
    });
  }

  #recover() {
    let changed = false;
    for (const task of this.store.data.tasks) {
      const observation = task.trigger?.type === 'afterConversation' && task.trigger.state === 'pending' && task.trigger.observation;
      if (observation && ['running', 'waiting'].includes(observation.status)) {
        observation.status = 'uncertain'; observation.error = '后台曾停止桌面监控，请重新选择正在运行的桌面对话。'; changed = true;
      }
    }
    for (const run of this.store.data.runs) {
      if (!ACTIVE.has(run.status)) continue;
      run.status = 'uncertain';
      run.error = '后台曾在运行中停止。已保留发送记录，不会自动重发，请查看对应对话。';
      run.endedAt = this.clock();
      const task = this.store.data.tasks.find(task => task.id === run.taskId);
      if (task) {
        task.paused = true;
        const slot = task.times.find(slot => slot.id === run.slotId) || (task.trigger?.id === run.slotId ? task.trigger : null);
        if (slot) slot.state = 'uncertain';
      }
      changed = true;
      this.store.data.settings.queuePaused = true;
      this.store.data.settings.pauseReason = '后台中断过运行，请核实结果后恢复队列。';
    }
    if (changed) this.store.save();
  }

  start() {
    if (this.timer) return;
    this.timer = setInterval(() => this.tick().catch(error => this.emit('fault', error)), 1000);
    void this.tick().catch(error => this.emit('fault', error));
  }

  stop() {
    this.stopping = true;
    clearInterval(this.timer);
    this.timer = null;
    clearTimeout(this.saveTimer);
    this.saveTimer = null;
    this.store.save();
  }

  #commit() {
    clearTimeout(this.saveTimer);
    this.saveTimer = null;
    this.store.save();
    this.emit('change');
  }

  #log(run, type, text) {
    if (!text) return;
    const previous = run.logs.at(-1);
    if (type === 'delta' && previous?.type === type) previous.text = (previous.text + text).slice(-200000);
    else run.logs.push({ at: this.clock(), type, text: String(text).slice(0, 200000) });
    if (run.logs.length > 500) run.logs.splice(0, run.logs.length - 500);
    if (!this.saveTimer) this.saveTimer = setTimeout(() => this.#commit(), 500);
  }

  snapshot() {
    const runs = this.store.data.runs.map(({ logs, output, prompt, ...run }) => ({ ...run, outputPreview: (output || '').slice(0, 220) }));
    return {
      applicationId: this.store.data.applicationId,
      serverTime: this.clock(), timezone: 'Asia/Shanghai', tasks: this.store.data.tasks.map(task => ({ ...task, queueStatus: this.readiness(task), editing: this.isEditing(task.id) })), runs,
      settings: this.store.data.settings,
      maintenance: !!this.maintenance,
      providers: [{ id: 'codex', name: 'Codex', available: this.client.connected, detail: this.client.connected ? '本地接口已连接' : this.client.lastError || '正在连接', capabilities: { threads: true, resume: true, captureThread: true, model: true, effort: true } }, ...[...this.providers.values()].map(provider => provider.snapshot())],
      connection: { connected: this.client.connected, error: this.client.connected ? '' : this.client.lastError, defaults: this.client.defaults, userAgent: this.client.userAgent || '' },
      requests: [...this.requests.values()].map(({ message, ...request }) => request),
      activeRunId: this.active?.run.id || null,
    };
  }

  getTask(id) {
    const task = this.store.data.tasks.find(task => task.id === id);
    if (!task) throw new Error('预约任务不存在。');
    return task;
  }

  isEditing(id) {
    const lease = this.editing.get(id);
    if (lease && lease.expiresAt > this.clock()) return true;
    this.editing.delete(id);
    return false;
  }

  hold(id, token) {
    this.getTask(id);
    if (typeof token !== 'string' || !/^[a-zA-Z0-9-]{20,80}$/.test(token)) throw new Error('编辑标识无效。');
    if (this.active?.task.id === id) throw new Error('这个任务正在运行，无法进入编辑。');
    if (this.isEditing(id) && this.editing.get(id).token !== token) throw new Error('任务正在另一个面板中编辑。');
    this.editing.set(id, { token, expiresAt: this.clock() + 90000 });
    this.emit('change');
  }

  release(id, token) {
    if (this.editing.get(id)?.token === token) { this.editing.delete(id); this.emit('change'); }
  }

  configure(input) {
    for (const key of ['queuePaused', 'pauseOnFailure', 'keepAwake']) {
      if (typeof input[key] === 'boolean') this.store.data.settings[key] = input[key];
    }
    if (input.queuePaused === false) this.store.data.settings.pauseReason = '';
    this.#commit();
    return this.store.data.settings;
  }

  reorder(ids) {
    const pending = this.store.data.tasks.filter(task => this.hasPending(task));
    if (!Array.isArray(ids) || ids.length !== pending.length || new Set(ids).size !== ids.length || pending.some(task => !ids.includes(task.id))) throw new Error('队列已变化，请刷新后重新排序。');
    ids.forEach((id, index) => { this.getTask(id).order = index; });
    this.#commit();
  }

  hasPending(task) {
    return task.trigger?.type !== 'time' ? task.trigger?.state === 'pending' : task.times.some(slot => slot.state === 'pending');
  }

  readiness(task) {
    if (!this.hasPending(task)) return { status: 'finished', reason: '已发送' };
    if (task.paused) return { status: 'paused', reason: '任务已暂停' };
    if (this.isEditing(task.id)) return { status: 'editing', reason: '正在编辑，暂不发送' };
    const trigger = task.trigger;
    if (trigger.type === 'afterConversation') {
      const observation = trigger.observation;
      if (!observation || ['running', 'waiting'].includes(observation.status)) return { status: 'pending', reason: '等待桌面端当前运行结束' };
      if (observation.status !== 'completed') return { status: 'blocked', reason: observation.error || '桌面运行状态待核实，接续已阻止' };
      return { status: 'ready', reason: '桌面端当前运行已成功结束' };
    }
    if (trigger.type === 'afterTask') {
      const source = trigger.sourceRunId ? this.store.data.runs.find(run => run.id === trigger.sourceRunId) : this.store.data.runs.slice(trigger.baseline).find(run => run.taskId === trigger.taskId);
      if (!source) return { status: 'pending', reason: '等待前置任务开始' };
      if (ACTIVE.has(source.status)) return { status: 'pending', reason: '等待前置任务结束' };
      if (source.status === 'uncertain' || (source.status !== 'completed' && trigger.onFailure !== 'continue')) return { status: 'blocked', reason: '前置任务未成功，接续已阻止' };
      if (task.threadMode === 'previous' && (!source.threadId || source.provider !== task.provider || !samePath(source.cwd, task.cwd))) return { status: 'blocked', reason: '前置运行没有可沿用的对话，请编辑接续目标' };
      return { status: 'ready', sourceRunId: source.id, reason: '前置任务已结束' };
    }
    if (trigger.type === 'time' && !task.times.some(slot => slot.state === 'pending' && slot.at <= this.clock())) return { status: 'pending', reason: '等待预约时间' };
    return { status: 'ready', reason: '等待轮到这条消息' };
  }

  async saveTask(input, id) {
    const old = id ? this.getTask(id) : null;
    if (old && this.active?.task.id === id) throw new Error('这个任务正在运行，请先停止运行再修改。');
    if (!input || typeof input !== 'object') throw new Error('预约内容无效。');
    const title = String(input.title || '').trim();
    const prompt = String(input.prompt || '').trim();
    if (!title || title.length > 100) throw new Error('请填写不超过 100 个字的任务名称。');
    if (!prompt || prompt.length > 64000) throw new Error('请填写预设消息，最多 64000 个字符。');
    const cwd = validateFolder(input.cwd);
    const provider = input.provider || old?.provider || 'codex';
    if (provider !== 'codex' && !this.providers.has(provider)) throw new Error('Agent 接入不存在。');
    if (old && input.revision != null && input.revision !== old.revision) throw new Error('任务已在其他面板更新，请重新打开。');
    if (old && this.isEditing(id) && this.editing.get(id).token !== input.editToken) throw new Error('任务正在另一个面板中编辑。');
    const kind = input.trigger?.type || 'time';
    if (!['time', 'queue', 'afterTask', 'afterConversation'].includes(kind)) throw new Error('发送条件无效。');
    const previousTrigger = old?.trigger;
    if (previousTrigger && previousTrigger.type !== 'time' && previousTrigger.state !== 'pending') throw new Error('这条消息已经发送，请复制为新任务。');
    let trigger;
    if (kind === 'time') trigger = { type: 'time' };
    else {
      const unchanged = previousTrigger?.type === kind && (kind !== 'afterTask' || (previousTrigger.taskId === input.trigger.taskId && (input.trigger.runId || null) === (previousTrigger.runId || null))) && (kind !== 'afterConversation' || (!input.trigger.rearm && previousTrigger.provider === input.trigger.provider && previousTrigger.threadId === input.trigger.threadId));
      trigger = unchanged ? { ...previousTrigger } : { type: kind, id: randomUUID(), state: 'pending', baseline: this.store.data.runs.length };
      if (kind === 'afterConversation' && !unchanged) {
        const source = this.providers.get(input.trigger.provider);
        if (!source?.snapshot().capabilities.watch) throw new Error('请选择支持状态监控的桌面端。');
        const observed = await source.inspect(String(input.trigger.threadId || ''));
        if (!['running', 'working', 'planning', 'waiting', 'pending'].includes(observed.status)) throw new Error('所选桌面对话当前没有运行中的任务；请先在桌面端启动任务，再保存接续。');
        trigger.provider = source.id; trigger.threadId = observed.id;
        trigger.observation = { status: 'running', version: observed.version, steps: observed.inputStep ?? observed.steps, capturedAt: this.clock() };
      }
      if (kind === 'afterTask') {
        const parent = this.getTask(input.trigger.taskId);
        const visited = new Set(id ? [id] : []);
        let node = parent;
        while (node) {
          if (visited.has(node.id)) throw new Error('不能让任务等待自身，也不能创建循环依赖。');
          visited.add(node.id);
          node = node.trigger?.type === 'afterTask' ? this.store.data.tasks.find(task => task.id === node.trigger.taskId) : null;
        }
        trigger.taskId = parent.id;
        trigger.onFailure = input.trigger.onFailure === 'continue' ? 'continue' : 'stop';
        if (!unchanged) {
          const runId = input.trigger.runId || null;
          const run = runId ? this.store.data.runs.find(run => run.id === runId && run.taskId === parent.id) : this.store.data.runs.find(run => run.taskId === parent.id && ACTIVE.has(run.status));
          if (runId && !run) throw new Error('前置运行记录不存在。');
          trigger.runId = runId;
          trigger.sourceRunId = run?.id || null;
        }
      }
    }
    const mode = input.threadMode;
    if (!['new', 'existing', 'previous'].includes(mode)) throw new Error('请选择使用哪个对话。');
    if (provider !== 'codex' && mode !== 'new' && !this.providers.get(provider).snapshot().capabilities.resume) throw new Error('当前 CLI 不支持续接已有对话，请选择新建对话。');
    if (mode === 'previous') {
      if (kind !== 'afterTask') throw new Error('沿用前置对话需要先选择前置任务。');
      const parent = this.getTask(trigger.taskId);
      if ((parent.provider || 'codex') !== provider || !samePath(parent.cwd, cwd)) throw new Error('沿用前置对话需要相同的 Agent 和项目文件夹。');
      if (provider !== 'codex' && !this.providers.get(provider).snapshot().capabilities.captureThread && !parent.threadId) throw new Error('当前 CLI 无法返回新对话编号，请选择新建对话或填写已有对话编号。');
    }
    let threadId = mode === 'existing' ? String(input.threadId || '').trim() : (old?.threadMode === 'new' && old.provider === provider && samePath(old.cwd, cwd) ? old.threadId : null);
    let threadTitle = mode === 'existing' ? String(input.threadTitle || '') : old?.threadTitle || '';
    if (mode === 'existing') {
      if (!threadId || threadId.length > 120) throw new Error('请选择一个已有对话。');
      if (provider === 'codex') {
        const { thread } = await this.client.request('thread/read', { threadId, includeTurns: false });
        if (!samePath(thread.cwd, cwd)) throw new Error('所选对话的文件夹与项目文件夹不一致，请重新选择。');
        threadTitle = thread.name || thread.preview || threadId;
      } else if (!/^[a-zA-Z0-9][a-zA-Z0-9_:-]{0,119}$/.test(threadId)) throw new Error('对话编号格式无效。');
      else if (this.providers.get(provider).inspect) {
        const inspected = await this.providers.get(provider).inspect(threadId);
        if (!samePath(inspected.cwd, cwd)) throw new Error('桌面对话的项目文件夹与任务不一致。');
      }
    }
    if (old && this.active?.task.id === id) throw new Error('这个任务已经开始运行，请先停止运行再修改。');
    if (old && this.getTask(id) !== old) throw new Error('任务已发生变化，请重新打开后修改。');
    if (old && this.isEditing(id) && this.editing.get(id).token !== input.editToken) throw new Error('任务正在另一个面板中编辑。');
    if (kind === 'time' && (!Array.isArray(input.times) || input.times.length < 1 || input.times.length > 100)) throw new Error('请至少设置一个执行时间，最多 100 个。');
    const seen = new Set();
    const times = (kind === 'time' ? input.times : []).map(value => {
      const at = typeof value === 'object' ? Number(value.at) : Number(value);
      if (!Number.isFinite(at) || at < 0 || at > 8640000000000000) throw new Error('执行日期或时间无效。');
      if (seen.has(at)) throw new Error('请移除重复的执行时间。');
      seen.add(at);
      const existing = old?.times.find(slot => slot.at === at);
      if (!existing && at <= this.clock()) throw new Error('新增的执行时间需要晚于当前时间。');
      return existing || { id: randomUUID(), at, state: 'pending' };
    }).sort((a, b) => a.at - b.at);
    // Keep completed slots in the record even when they are hidden during editing.
    for (const slot of old?.times || []) if (slot.state !== 'pending' && !seen.has(slot.at)) times.push(slot);
    times.sort((a, b) => a.at - b.at);
    const sandbox = input.sandbox || 'workspace-write';
    const approval = input.approval || 'ask';
    if (!['workspace-write', 'read-only'].includes(sandbox) || !['ask', 'deny'].includes(approval)) throw new Error('权限设置无效。');
    const model = String(input.model || '').trim();
    const effort = String(input.effort || '').trim();
    if (model.length > 120 || /[\r\n]/.test(model)) throw new Error('模型名称无效。');
    if (effort && !['none', 'minimal', 'low', 'medium', 'high', 'xhigh', 'max', 'ultra'].includes(effort)) throw new Error('推理强度无效。');
    const task = {
      id: old?.id || randomUUID(), title, cwd, threadMode: mode, threadId, threadTitle, prompt, times, provider, trigger,
      order: old?.order ?? Math.max(-1, ...this.store.data.tasks.map(task => task.order || 0)) + 1,
      revision: (old?.revision || 0) + 1, timeoutMinutes: Math.max(1, Math.min(1440, Number(input.timeoutMinutes) || 120)),
      latePolicy: input.latePolicy === 'skip' ? 'skip' : 'run', sandbox, approval,
      networkAccess: input.networkAccess === true, model, effort,
      paused: old?.paused || false, createdAt: old?.createdAt || this.clock(), updatedAt: this.clock(),
    };
    if (old) this.store.data.tasks[this.store.data.tasks.indexOf(old)] = task;
    else this.store.data.tasks.push(task);
    this.release(task.id, input.editToken);
    this.#commit();
    return task;
  }

  pause(id, paused) {
    const task = this.getTask(id);
    task.paused = !!paused;
    this.#commit();
    return task;
  }

  remove(id) {
    if (this.active?.task.id === id) throw new Error('任务正在运行，请先停止运行。');
    this.getTask(id);
    if (this.store.data.tasks.some(task => task.trigger?.taskId === id && this.hasPending(task))) throw new Error('还有消息等待这个任务，请先修改或删除后续消息。');
    this.store.data.tasks = this.store.data.tasks.filter(task => task.id !== id);
    // Execution records remain available after deleting a future schedule.
    this.#commit();
  }

  async runNow(id) {
    if (this.maintenance) throw new Error('正在验证 Agent 接入，请等待完成。');
    if (this.active || this.ticking) throw new Error('目前有任务在运行或正在发送，请等待完成。');
    const task = this.getTask(id);
    if (task.paused) throw new Error('请先恢复这条任务，再运行。');
    if (this.isEditing(id)) throw new Error('请先保存或结束编辑，再运行。');
    if (task.trigger.type !== 'time') {
      if (this.readiness(task).status !== 'ready') throw new Error('这条消息尚未满足发送条件，或已经发送。');
      return this.#launch(task, task.trigger);
    }
    return this.#launch(task, null);
  }

  async tick() {
    await this.refreshDesktopWatches();
    if (this.stopping || this.ticking || this.active || this.maintenance || this.store.data.settings.queuePaused) return;
    this.ticking = true;
    try {
      const now = this.clock();
      const due = this.store.data.tasks.filter(task => this.readiness(task).status === 'ready')
        .flatMap(task => task.trigger.type === 'time' ? task.times.filter(slot => slot.state === 'pending' && slot.at <= now).map(slot => ({ task, slot })) : [{ task, slot: task.trigger }])
        .sort((a, b) => a.task.order - b.task.order || (a.slot.at || 0) - (b.slot.at || 0));
      for (const { task, slot } of due) {
        if (slot.at && task.latePolicy === 'skip' && now - slot.at > this.lateThreshold) {
          slot.state = 'missed';
          this.#commit();
          continue;
        }
        await this.#launch(task, slot);
        break;
      }
    } finally { this.ticking = false; }
  }

  async refreshDesktopWatches() {
    if (this.stopping || this.watching || this.maintenance) return;
    this.watching = true;
    try {
      for (const task of this.store.data.tasks.filter(t => t.trigger?.type === 'afterConversation' && this.hasPending(t) && !t.paused)) {
        const trigger = task.trigger;
        if (!['running', 'waiting'].includes(trigger.observation?.status)) continue;
        if (this.clock() - (trigger.checkedAt || 0) < 3000) continue;
        trigger.checkedAt = this.clock();
        try {
          const provider = this.providers.get(trigger.provider);
          const current = await provider.inspect(trigger.threadId);
          // Bind to the captured turn. A later manually submitted prompt must not satisfy it.
          if (current.version !== trigger.observation.version) {
            trigger.observation.status = 'uncertain'; trigger.observation.error = '桌面对话已开始另一轮消息，请重新设置等待目标。';
          } else if (['running', 'working', 'planning'].includes(current.status)) trigger.observation.status = 'running';
          else if (['waiting', 'pending'].includes(current.status)) trigger.observation.status = 'waiting';
          else if (current.status === 'idle' || current.status === 'completed') {
            if (provider.result) {
              const result = await provider.result(trigger.threadId, trigger.observation.steps);
              trigger.observation.status = result.status; trigger.observation.error = result.error;
            } else {
              const final = current.last?.state || current.last?.status;
              trigger.observation.status = final === 'completed' ? 'completed' : final === 'error' || final === 'failed' ? 'failed' : 'uncertain';
            }
          } else trigger.observation.status = ['failed', 'interrupted', 'error'].includes(current.status) ? 'failed' : 'uncertain';
          this.#commit();
        } catch (error) {
          trigger.observation.status = 'uncertain'; trigger.observation.error = error.message;
          this.#commit();
        }
      }
    } finally { this.watching = false; }
  }

  async #launch(task, slot) {
    if (this.active || this.stopping) throw new Error('后台目前无法启动新的运行。');
    const ready = this.readiness(task);
    const source = ready.sourceRunId ? this.store.data.runs.find(run => run.id === ready.sourceRunId) : null;
    if (task.threadMode === 'previous' && (!source?.threadId || source.provider !== task.provider || !samePath(source.cwd, task.cwd))) throw new Error('前置运行没有可沿用的对话，请修改接续目标。');
    const run = {
      id: randomUUID(), taskId: task.id, taskTitle: task.title, slotId: slot?.id || null,
      scheduledAt: slot?.at || null, startedAt: this.clock(), endedAt: null,
      cwd: task.cwd, prompt: task.prompt, threadId: task.threadMode === 'previous' ? source.threadId : task.threadId, turnId: null, provider: task.provider || 'codex', sourceRunId: source?.id || null,
      status: 'dispatching', output: '', error: '', logs: [],
    };
    this.active = { task, run };
    if (slot) slot.state = 'dispatching';
    this.store.data.runs.push(run);
    this.#commit(); // Persist the claim before any message can be submitted.
    let sending = false;
    try {
      const cwd = validateFolder(task.cwd);
      if (run.provider !== 'codex') {
        const provider = this.providers.get(run.provider);
        if (!provider) throw new Error('Agent 接入不可用。');
        const handle = provider.start(task, run, {
          log: (type, text) => this.#log(run, type, text),
          thread: id => { run.threadId = task.threadId = id; this.#commit(); },
          output: text => { run.output = String(text).slice(-1000000); this.#commit(); },
          status: status => { if (ACTIVE.has(run.status) && ['waiting', 'running'].includes(status) && run.status !== status) { run.status = status; this.#commit(); } },
        });
        this.active.handle = handle;
        run.turnId = run.id;
        run.status = 'running';
        if (slot) slot.state = 'running';
        this.#commit();
        handle.completion.then(result => { if (ACTIVE.has(run.status)) this.#finish(run, result.status, result.error || ''); }).catch(error => { if (ACTIVE.has(run.status)) this.#finish(run, 'uncertain', error.message); });
        return run;
      }
      await this.client.connect();
      const approvalPolicy = task.approval === 'deny' ? 'never' : 'on-request';
      const params = { cwd, sandbox: task.sandbox, approvalPolicy, approvalsReviewer: 'user' };
      if (task.model) params.model = task.model;
      if (run.threadId) {
        const read = await this.client.request('thread/read', { threadId: run.threadId, includeTurns: false });
        if (!samePath(read.thread.cwd, cwd)) throw new Error('对话的项目文件夹已改变，已停止发送。');
        if (read.thread.status?.type === 'active') throw new Error('所选对话已有运行中的任务，请稍后手动运行。');
        const resumed = await this.client.request('thread/resume', { ...params, threadId: run.threadId, excludeTurns: true });
        if (resumed.thread.status?.type === 'active') throw new Error('所选对话正在运行，已停止发送。');
      } else {
        const started = await this.client.request('thread/start', params);
        run.threadId = task.threadId = started.thread.id;
        task.threadTitle = task.title;
        this.#commit();
      }
      const sandboxPolicy = task.sandbox === 'read-only'
        ? { type: 'readOnly', networkAccess: task.networkAccess }
        : { type: 'workspaceWrite', writableRoots: [cwd], networkAccess: task.networkAccess };
      const turnParams = {
        threadId: run.threadId, cwd, input: [{ type: 'text', text: run.prompt }],
        sandboxPolicy, approvalPolicy, approvalsReviewer: 'user', clientUserMessageId: run.id,
      };
      if (task.model) turnParams.model = task.model;
      if (task.effort) turnParams.effort = task.effort;
      this.#log(run, 'system', `发送到本地项目：${cwd}`);
      sending = true;
      const result = await this.client.request('turn/start', turnParams);
      run.turnId = result.turn.id;
      if (ACTIVE.has(run.status)) {
        run.status = this.requests.size ? 'waiting' : 'running';
        if (slot) slot.state = 'running';
        this.#commit();
      }
      return run;
    } catch (error) {
      const uncertain = sending && (error.uncertainDelivery || !this.client.connected);
      if (ACTIVE.has(run.status)) this.#finish(run, uncertain ? 'uncertain' : 'failed', error.message);
      return run;
    }
  }

  #notification({ method, params: p }) {
    const run = this.active?.run;
    if (!run || run.provider !== 'codex' || !p || p.threadId !== run.threadId) return;
    if (method === 'turn/started') {
      run.turnId ||= p.turn?.id;
      return;
    }
    if (p.turnId && run.turnId && p.turnId !== run.turnId) return;
    if (method === 'turn/completed' && (!run.turnId || p.turn?.id === run.turnId)) {
      const status = p.turn?.status;
      this.#finish(run, status === 'completed' ? 'completed' : status === 'interrupted' ? 'interrupted' : 'failed', p.turn?.error?.message || '');
    } else if (method === 'item/agentMessage/delta') {
      this.#log(run, 'delta', p.delta);
    } else if (method === 'item/completed') {
      const item = p.item;
      if (item?.type === 'agentMessage') {
        run.output = (run.output + (run.output ? '\n\n' : '') + (item.text || '')).slice(-1000000);
        this.#log(run, 'answer', item.text);
      } else if (item?.type === 'commandExecution') {
        this.#log(run, 'command', `${item.command || ''}\n${item.aggregatedOutput || ''}\n退出代码：${item.exitCode ?? '未知'}`);
      } else if (item?.type === 'fileChange') {
        this.#log(run, 'files', (item.changes || []).map(change => change.path).join('\n'));
      }
    } else if (method === 'error') this.#log(run, 'error', p.error?.message || p.message);
  }

  #serverRequest(message) {
    const run = this.active?.run;
    if (!run || run.provider !== 'codex' || message.params?.threadId !== run.threadId) {
      this.client.rejectRequest(message.id, 'This client does not own this turn.');
      return;
    }
    const supported = ['item/commandExecution/requestApproval', 'item/fileChange/requestApproval', 'item/permissions/requestApproval', 'item/tool/requestUserInput'];
    if (!supported.includes(message.method)) {
      this.#log(run, 'error', `需要的交互暂不支持：${message.method}。可在 Codex 中手动处理该任务。`);
      this.client.rejectRequest(message.id, 'This interaction is not supported by the local scheduler.');
      return;
    }
    const id = randomUUID();
    this.requests.set(id, { id, runId: run.id, method: message.method, params: message.params, message });
    run.status = 'waiting';
    this.#log(run, 'system', '运行需要你的处理，请在右侧运行记录中回答或确认。');
    this.#commit();
  }

  respond(id, input) {
    const request = this.requests.get(id);
    if (!request) throw new Error('这个请求已经结束或失效。');
    let response;
    if (request.method === 'item/tool/requestUserInput') {
      const answers = {};
      for (const question of request.params.questions || []) {
        const answer = input.answers?.[question.id];
        if (typeof answer !== 'string' || !answer.trim() || answer.length > 10000) throw new Error('请回答所有问题。');
        answers[question.id] = { answers: [answer.trim()] };
      }
      response = { answers };
    } else if (request.method === 'item/permissions/requestApproval') {
      // Grant only the exact permission profile the person has reviewed.
      if (!['accept', 'decline'].includes(input.decision)) throw new Error('确认结果无效。');
      response = { permissions: input.decision === 'accept' ? request.params.permissions : {}, scope: 'turn' };
    } else {
      if (!['accept', 'decline'].includes(input.decision)) throw new Error('确认结果无效。');
      response = { decision: input.decision };
    }
    this.client.respond(request.message.id, response);
    this.requests.delete(id);
    const run = this.active?.run;
    if (run && ![...this.requests.values()].some(request => request.runId === run.id)) run.status = 'running';
    this.#commit();
  }

  async interrupt(runId) {
    const run = this.active?.run;
    if (!run || run.id !== runId) throw new Error('这个运行已经结束。');
    if (this.active.handle) { await this.active.handle.interrupt(); return; }
    if (!run.turnId) throw new Error('消息正在发送，请稍后再停止。');
    await this.client.request('turn/interrupt', { threadId: run.threadId, turnId: run.turnId });
  }

  #finish(run, status, error = '') {
    run.status = status;
    run.error = String(error).slice(0, 8000);
    run.endedAt = this.clock();
    const task = this.store.data.tasks.find(task => task.id === run.taskId);
    const slot = task?.times.find(slot => slot.id === run.slotId) || (task?.trigger?.id === run.slotId ? task.trigger : null);
    if (slot) slot.state = status;
    if (status === 'uncertain' && task) task.paused = true;
    if (status === 'uncertain' || (status !== 'completed' && this.store.data.settings.pauseOnFailure)) {
      this.store.data.settings.queuePaused = true;
      this.store.data.settings.pauseReason = `${run.taskTitle} ${status === 'uncertain' ? '状态待核实' : '未成功完成'}，队列已暂停。`;
    }
    for (const [id, request] of this.requests) if (request.runId === run.id) this.requests.delete(id);
    this.#log(run, 'system', status === 'completed' ? '运行完成。该执行时间已结束，不会自动重复。' : (error || `运行结束：${status}`));
    if (this.active?.run.id === run.id) this.active = null;
    this.#commit();
  }
}
