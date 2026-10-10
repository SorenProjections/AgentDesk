import { EventEmitter } from 'node:events';
import { randomUUID } from 'node:crypto';
import { realpathSync } from 'node:fs';
import path from 'node:path';
import { validateFolder } from './scheduler.mjs';
import { FileLeases, scopedPath, pathKey, overlaps } from './file-leases.mjs';
import { manifest, collectEvidence, fingerprint, evidencePaths, changesSince, artifact, scopedSnapshot } from './evidence.mjs';

const ACTIVE = new Set(['dispatching', 'running', 'waiting']);
const SUPPORTED = new Set(['codex', 'antigravityDesktop', 'workbuddyDesktop']);
const text = (value, label, max = 16000) => {
  if (typeof value !== 'string' || !value.trim() || value.length > max) throw new Error(label + '无效或超过长度限制。');
  return value.trim();
};
function paths(value, fallback) {
  const result = value ?? fallback;
  if (!Array.isArray(result) || result.length > 30 || !result.length) throw new Error('请填写 1–30 条相对路径。');
  return [...new Set(result.map(p => text(p, '路径', 512)))];
}
function criterion(input, index) {
  if (!input || !['file', 'contains', 'command', 'manual'].includes(input.type)) throw new Error('验收类型必须为 file、contains、command 或 manual。');
  const result = { id: input.id ? text(input.id, '验收编号', 80) : 'criterion-' + (index + 1),
    type: input.type, description: text(input.description, '验收标准', 2000) };
  if (['file', 'contains'].includes(input.type)) result.path = text(input.path, '验收文件', 512);
  if (input.type === 'contains') result.contains = text(input.contains, '预期内容', 2000);
  if (input.type === 'command') {
    result.command = text(input.command, '测试程序', 1024);
    if (/\0|\r|\n/.test(result.command) || /\.(cmd|bat)$/i.test(result.command)) throw new Error('测试程序必须是可直接执行的程序，不能是 cmd/bat 包装器。');
    if (!Array.isArray(input.args) || input.args.length > 100 || input.args.some(a => typeof a !== 'string' || a.length > 4000 || a.includes('\0'))) throw new Error('测试参数必须是字符串数组。');
    result.args = input.args;
    result.timeoutSeconds = input.timeoutSeconds ?? 60;
    result.expectedExitCode = input.expectedExitCode ?? 0;
    if (!Number.isInteger(result.timeoutSeconds) || result.timeoutSeconds < 1 || result.timeoutSeconds > 300 ||
        !Number.isInteger(result.expectedExitCode)) throw new Error('测试超时或退出代码无效。');
  }
  return result;
}

export class Supervision extends EventEmitter {
  constructor(store, scheduler, { clock = () => Date.now(), sessionRows = () => [], collect = collectEvidence } = {}) {
    super(); this.store = store; this.scheduler = scheduler; this.clock = clock;
    this.sessionRows = sessionRows; this.collect = collect;
    this.busy = new Set(); this.jobs = new Map(); this.closed = false; this.authorizedDrafts = new WeakSet();
    store.data.missions ||= []; this.leases = new FileLeases(store, { clock });
    scheduler.supervisor = this;
    for (const mission of store.data.missions) {
      if (['running', 'dispatching', 'collecting'].includes(mission.state)) {
        mission.state = 'uncertain'; mission.error = '后台中断，保留占用和已发指令，需核实原会话。';
      }
    }
    this.save();
  }
  save() { this.store.save(); this.emit('change'); }
  get(id) {
    const mission = this.store.data.missions.find(x => x.id === id);
    if (!mission) throw new Error('督导任务不存在。');
    return mission;
  }
  summary(m) {
    const { baseline, workspaceBaseline, reviews, instructions, ...record } = m;
    return { ...record, instructionCount: instructions.length, reviewCount: reviews.length,
      latestReview: reviews.length ? { id: reviews.at(-1).id, state: reviews.at(-1).state, at: reviews.at(-1).at } : null };
  }
  snapshot() {
    return { missions: this.store.data.missions.map(m => this.summary(m)),
      leases: this.store.data.fileLeases.filter(l => l.state === 'held'), collecting: this.jobs.size };
  }
  detail(id) {
    const m = this.get(id), { baseline, workspaceBaseline, ...record } = m;
    return { ...record, lease: this.store.data.fileLeases.find(l => l.owner === id && l.state === 'held') || null };
  }
  async serial(id, operation) {
    if (this.busy.has(id)) throw new Error('这个督导任务正在处理，请稍后重试。');
    this.busy.add(id);
    try { return await operation(); } finally { this.busy.delete(id); }
  }
  async inspect(provider, threadId, cwd) {
    let row;
    if (provider === 'codex') {
      const result = await this.scheduler.client.request('thread/read', { threadId, includeTurns: false });
      row = { id: result.thread.id, cwd: result.thread.cwd, status: result.thread.status?.type || 'unknown' };
    } else {
      const adapter = this.scheduler.providers.get(provider);
      if (!adapter?.snapshot().available) throw new Error('桌面端未连接，请先检测接入。');
      row = await adapter.inspect(threadId);
    }
    if (pathKey(realpathSync.native(row.cwd || '')) !== pathKey(cwd)) throw new Error('目标会话的文件夹与督导任务不一致。');
    return row;
  }
  async create(input) {
    const cwd = validateFolder(input.cwd), provider = input.provider || 'workbuddyDesktop';
    if (!SUPPORTED.has(provider)) throw new Error('督导任务需要 Codex 或可核验会话的桌面端。');
    const constraints = input.constraints ?? [];
    if (!Array.isArray(constraints) || constraints.length > 30) throw new Error('约束必须是最多 30 条的字符串数组。');
    if (!Array.isArray(input.criteria) || !input.criteria.length || input.criteria.length > 20) throw new Error('请填写 1–20 条验收标准。');
    const criteria = input.criteria.map(criterion);
    if (new Set(criteria.map(x => x.id)).size !== criteria.length) throw new Error('验收编号不能重复。');
    const writePaths = paths(input.writePaths, ['.']);
    const artifacts = input.artifacts ?? [];
    if (!Array.isArray(artifacts) || artifacts.length > 24) throw new Error('产物列表最多 24 条。');
    for (const p of [...writePaths, ...artifacts, ...criteria.filter(c => c.path).map(c => c.path)]) scopedPath(cwd, p);
    const maxCorrections = input.maxCorrections ?? 2;
    if (!Number.isInteger(maxCorrections) || maxCorrections < 0 || maxCorrections > 10) throw new Error('最大纠偏次数须为 0–10。');
    const access = input.access || 'write';
    if (!['read', 'write'].includes(access)) throw new Error('文件访问方式无效。');
    const m = { id: randomUUID(), title: text(input.title, '名称', 88), objective: text(input.objective, '目标'),
      constraints: constraints.map(c => text(c, '约束', 2000)), criteria, cwd, provider, access, writePaths,
      artifacts: artifacts.map(p => text(p, '产物路径', 512)), maxCorrections, autoCorrect: input.autoCorrect === true,
      corrections: 0, state: 'draft', binding: null, instructions: [], reviews: [], baseline: null,
      revision: 1, createdAt: this.clock(), updatedAt: this.clock() };
    if (input.threadId) {
      const row = await this.inspect(provider, text(input.threadId, '会话编号', 120), cwd);
      m.binding = { threadId: row.id, cwd, provider, checkedAt: this.clock(), status: row.status, version: row.version || null };
      m.state = 'bound';
    }
    if (this.instructionPrompt(m).length > 64000) throw new Error('目标、约束与验收标准合计超过客户端消息长度限制。');
    this.store.data.missions.push(m); this.save();
    return this.detail(m.id);
  }
  async bind(id, input) {
    return this.serial(id, async () => {
      const m = this.get(id);
      if (m.instructions.length) throw new Error('任务已安排指令，不能改绑会话；请新建下一阶段任务。');
      const row = await this.inspect(m.provider, text(input.threadId, '会话编号', 120), m.cwd);
      m.binding = { threadId: row.id, cwd: m.cwd, provider: m.provider, checkedAt: this.clock(), status: row.status, version: row.version || null };
      m.state = 'bound'; m.updatedAt = this.clock(); this.save(); return this.detail(id);
    });
  }
  instructionPrompt(m, feedback = '') {
    const acceptance = m.criteria.map(c => '- [' + c.id + '] ' + c.description +
      (c.path ? '；文件：' + c.path : '') + (c.contains ? '；预期内容：' + c.contains : '') +
      (c.command ? '；验收命令：' + JSON.stringify([c.command, ...c.args]) : '')).join('\n');
    return ['任务目标：\n' + m.objective, '约束：\n' + (m.constraints.map(c => '- ' + c).join('\n') || '无额外约束'),
      '项目目录：' + m.cwd, '允许' + (m.access === 'read' ? '读取' : '修改') + '的范围：' + m.writePaths.join('、'),
      m.access === 'read' ? '此任务只读，不得修改项目文件。' : '只修改约定范围；不要覆盖其他任务的已有修改。',
      '验收标准：\n' + acceptance, '阶段产物：' + (m.artifacts.join('、') || '请在最终回复列出修改文件、验证结果与未解决问题'),
      '如果遇到阻塞或无法满足约束，停止并说明原因；不要扩大任务范围。',
      feedback ? '本轮纠偏要求（保留上述目标和约束）：\n' + feedback : '执行本阶段，并提供可以核验的结果。'].join('\n\n');
  }
  async dispatch(id, input = {}) {
    return this.serial(id, () => this.queueInstruction(this.get(id), input, false));
  }
  async queueInstruction(m, input, correction) {
    const requestId = text(input.requestId || randomUUID(), '请求编号', 120);
    const existing = m.instructions.find(i => i.requestId === requestId);
    if (existing) return { instruction: existing, mission: this.summary(m) };
    if (this.closed) throw new Error('督导服务正在停止。');
    if (correction) {
      if (m.state !== 'correction_needed') throw new Error('当前没有已确认需要纠偏的验收结果。');
      if (m.corrections >= m.maxCorrections) { m.state = 'exhausted'; this.save(); throw new Error('已达到最大纠偏次数。'); }
    } else if (m.instructions.length || !['draft', 'bound'].includes(m.state)) throw new Error('初始任务已安排，请使用状态查询或纠偏接口，不能重复发送。');
    const feedback = correction ? text(input.feedback || this.correctionFeedback(m), '纠偏要求') : '';
    if (m.binding) {
      const row = await this.inspect(m.provider, m.binding.threadId, m.cwd);
      m.binding.checkedAt = this.clock(); m.binding.status = row.status;
    }
    let trigger = { type: 'queue' }, times = [];
    if (input.at) {
      const at = typeof input.at === 'number' ? input.at : Date.parse(input.at);
      if (!Number.isFinite(at) || at <= this.clock()) throw new Error('预约时间须为未来的时间戳或带时区的 ISO 时间。');
      trigger = { type: 'time' }; times = [at];
    }
    const prompt = this.instructionPrompt(m, feedback);
    const draft = { title: m.title + (correction ? ' · 纠偏 ' + (m.corrections + 1) : ''),
      provider: m.provider, cwd: m.cwd, threadMode: m.binding ? 'existing' : 'new', threadId: m.binding?.threadId,
      trigger, times, prompt, missionId: m.id, sandbox: m.access === 'read' ? 'read-only' : 'workspace-write',
      model: input.model || '', effort: input.effort || '', timeoutMinutes: input.timeoutMinutes || 120, networkAccess: input.networkAccess === true };
    this.authorizedDrafts.add(draft);
    let task;
    try { task = await this.scheduler.saveTask(draft); } finally { this.authorizedDrafts.delete(draft); }
    if (correction) m.corrections++;
    const instruction = { id: randomUUID(), requestId, taskId: task.id, kind: correction ? 'correction' : 'initial',
      round: m.corrections, prompt, feedback, state: 'queued', queuedAt: this.clock(), runId: null, threadId: m.binding?.threadId || null };
    m.instructions.push(instruction); m.state = correction ? 'correction_pending' : 'scheduled'; m.updatedAt = this.clock();
    this.save(); return { instruction, mission: this.summary(m) };
  }
  correctionFeedback(m) {
    const review = m.reviews.at(-1);
    const failures = review?.packet.checks.filter(c => c.status !== 'passed').map(c => '[' + c.id + '] ' + c.description + '：' + (c.reason || c.status)) || [];
    return ['验收未通过。', review?.reason || '', ...failures, '只修复上述问题，完成后重新提供验收证据。'].filter(Boolean).join('\n');
  }
  async correct(id, input = {}) {
    return this.serial(id, () => this.queueInstruction(this.get(id), input, true));
  }
  assertTask(input, old) {
    const missionId = input.missionId || old?.missionId;
    if (!missionId) return;
    const m = this.get(missionId);
    if (old) throw new Error('督导生成的指令不可改写；请通过督导流程纠偏或取消。');
    if (!this.authorizedDrafts.has(input) || pathKey(validateFolder(input.cwd)) !== pathKey(m.cwd) || input.provider !== m.provider) {
      throw new Error('督导指令与保存的目标、Agent 或文件夹不一致。');
    }
  }
  nativeActivity(cwd, provider, threadId) {
    const activity = [];
    for (const row of this.sessionRows()) {
      if (row.provider === provider && row.nativeId === threadId) continue;
      if (!row.cwd || !['running', 'waiting', 'dispatching', 'working', 'planning', 'pending'].includes(row.status)) continue;
      if (this.store.data.fileLeases.some(l => l.state === 'held' && l.provider === row.provider && l.threadId === row.nativeId)) continue;
      let external;
      try { external = validateFolder(row.cwd); } catch { continue; }
      // A working directory is context, not proof of whole-project write ownership.
      if (overlaps(cwd, external)) activity.push({ provider: row.provider, threadId: row.nativeId, cwd: external,
        name: row.name, status: row.status, message: '其他活动会话共享工作空间；不据此推断文件冲突。' });
    }
    return activity;
  }
  checkConflicts(owner, cwd, paths, access, provider, threadId) {
    const resources = this.leases.resources(cwd, paths);
    const conflict = this.leases.conflict(owner, resources, access);
    if (conflict) throw new Error('文件占用冲突：' + conflict.owner);
    return this.nativeActivity(cwd, provider, threadId);
  }
  blocker(task) {
    try {
      const m = task.missionId ? this.get(task.missionId) : null;
      if (m && !['scheduled', 'correction_pending'].includes(m.state)) return '督导状态不允许发送：' + m.state;
      if (['workbuddyDesktop', 'antigravityDesktop'].includes(task.provider) && !this.scheduler.providers.get(task.provider)?.snapshot().available) {
        return '等待目标桌面连接就绪';
      }
      const owner = m?.id || task.id, scope = m?.writePaths || ['.'];
      const access = m?.access || (task.sandbox === 'read-only' ? 'read' : 'write');
      this.checkConflicts(owner, task.cwd, scope, access, task.provider, task.threadId);
      const bound = task.threadId && this.sessionRows().find(r => r.provider === task.provider && r.nativeId === task.threadId);
      if (bound && ['running', 'waiting', 'dispatching', 'working', 'planning', 'pending'].includes(bound.status)) return '目标会话仍在运行或等待处理';
      return null;
    } catch (error) { return error.message; }
  }
  async beforeLaunch(task, run) {
    const m = task.missionId ? this.get(task.missionId) : null;
    const owner = m?.id || run.id, scope = m?.writePaths || ['.'], access = m?.access || (task.sandbox === 'read-only' ? 'read' : 'write');
    if (m) {
      const instruction = m.instructions.find(i => i.taskId === task.id);
      if (!instruction || instruction.runId || !['scheduled', 'correction_pending'].includes(m.state)) throw new Error('督导指令已运行或任务状态不允许发送。');
      if (task.prompt !== instruction.prompt || pathKey(validateFolder(task.cwd)) !== pathKey(m.cwd) || task.provider !== m.provider) throw new Error('发送内容或文件夹与督导记录不一致。');
      if (m.binding && run.threadId !== m.binding.threadId) throw new Error('目标会话与督导绑定不一致。');
    }
    const sharedWorkspaceActivity = this.checkConflicts(owner, task.cwd, scope, access, run.provider, run.threadId);
    if (m && run.threadId) {
      const row = await this.inspect(m.provider, run.threadId, m.cwd);
      if (!['idle', 'completed'].includes(row.status)) throw new Error('目标会话不空闲，停止发送。');
    }
    this.leases.acquire({ owner, cwd: task.cwd, paths: scope, access, provider: run.provider, threadId: run.threadId, runId: run.id });
    run.fileLeaseOwner = owner;
    run.sharedWorkspaceActivity = sharedWorkspaceActivity;
    if (m) {
      m.baseline ||= manifest(m.cwd, evidencePaths(m));
      m.workspaceBaseline ||= evidencePaths(m).includes('.') ? m.baseline : manifest(m.cwd, ['.']);
      m.sharedWorkspaceActivity = sharedWorkspaceActivity;
      const instruction = m.instructions.find(i => i.taskId === task.id);
      Object.assign(instruction, { runId: run.id, state: 'dispatching', startedAt: this.clock() });
      m.state = 'running'; m.latestRunId = run.id; m.updatedAt = this.clock();
    }
    this.save();
  }
  bindRun(task, run) {
    this.leases.bind(run.fileLeaseOwner || run.id, run.threadId);
    if (task.missionId) {
      const m = this.get(task.missionId);
      m.binding = { threadId: run.threadId, cwd: m.cwd, provider: m.provider, checkedAt: this.clock(), status: 'running' };
      const instruction = m.instructions.find(i => i.taskId === task.id);
      if (instruction) instruction.threadId = run.threadId;
      this.save();
    }
  }
  finished(run) {
    const task = this.store.data.tasks.find(t => t.id === run.taskId);
    if (!task?.missionId) {
      if (run.status !== 'uncertain') this.leases.release(run.fileLeaseOwner || run.id, '运行结束：' + run.status);
      return;
    }
    const m = this.get(task.missionId), instruction = m.instructions.find(i => i.taskId === task.id);
    if (instruction) Object.assign(instruction, { state: run.status, endedAt: run.endedAt, runId: run.id, threadId: run.threadId });
    if (run.status !== 'completed') {
      m.state = run.status === 'uncertain' ? 'uncertain' : 'blocked'; m.error = run.error || '执行未成功，不能进行质量验收。'; this.save(); return;
    }
    m.state = 'collecting'; this.save();
    const job = this.serial(m.id, () => this.capture(m, run)).catch(error => {
      m.state = 'review_pending'; m.error = '收集证据失败：' + error.message; this.save();
    }).finally(() => this.jobs.delete(m.id));
    this.jobs.set(m.id, job);
  }
  async capture(m, run) {
    if (run.id !== m.latestRunId || run.status !== 'completed') throw new Error('只能审查本任务最新的成功运行。');
    const packet = await this.collect(m, run, m.baseline || manifest(m.cwd, evidencePaths(m)));
    if (m.binding) {
      const current = await this.inspect(m.provider, m.binding.threadId, m.cwd);
      if (!['idle', 'completed'].includes(current.status)) throw new Error('原会话又开始工作或等待处理，不能验收。');
      packet.bindingVersion = current.version || null;
    }
    const resources = this.leases.resources(m.cwd, m.writePaths);
    packet.outOfScopeChanges = packet.changes.filter(change => !resources.some(r => overlaps(r, scopedPath(m.cwd, change.path))));
    if (m.access === 'read') packet.outOfScopeChanges = packet.changes;
    const review = { id: packet.id, at: this.clock(), packet, decisions: [], state: 'pending', reason: '' };
    m.reviews.push(review); m.state = 'review_pending'; m.error = ''; this.save();
    this.evaluate(m, review);
    if (m.state === 'correction_needed' && m.autoCorrect && !this.closed) {
      await this.queueInstruction(m, { requestId: 'automatic-' + review.id, feedback: this.correctionFeedback(m) }, true);
    }
    return review;
  }
  evaluate(m, review) {
    const failed = review.packet.checks.some(c => c.status === 'failed') || review.packet.outOfScopeChanges.length > 0;
    const pending = review.packet.checks.some(c => c.status === 'pending') || (!review.packet.baselineComplete || !review.packet.scanComplete) && !review.scanAcknowledgment;
    if (failed) {
      review.state = 'rejected'; m.state = review.packet.outOfScopeChanges.length ? 'blocked' : m.corrections >= m.maxCorrections ? 'exhausted' : 'correction_needed';
      review.reason ||= review.packet.outOfScopeChanges.length ? '检测到约定范围之外的文件变化。' : '自动验收未通过。';
    } else if (pending) { review.state = 'pending'; m.state = 'review_pending'; }
    else { review.state = 'accepted'; m.state = 'accepted'; this.leases.release(m.id, '质量验收通过'); }
    m.updatedAt = this.clock(); this.save();
  }
  async evidence(id, { refresh = false } = {}) {
    if (this.jobs.has(id)) await this.jobs.get(id);
    const m = this.get(id);
    if (refresh) return this.serial(id, async () => {
      if (!['review_pending', 'correction_needed', 'exhausted'].includes(m.state)) throw new Error('当前任务状态不允许重新运行验收。');
      const run = this.store.data.runs.find(r => r.id === m.latestRunId);
      const review = await this.capture(m, run); return review.packet;
    });
    if (!m.reviews.length) throw new Error('尚无验收证据；请等待本任务完成。');
    return m.reviews.at(-1).packet;
  }
  async observe(id) {
    const m = this.get(id);
    const run = this.store.data.runs.find(r => r.id === m.latestRunId);
    const current = manifest(m.cwd, evidencePaths(m));
    const changes = m.baseline ? changesSince(scopedSnapshot(m.cwd, m.baseline, evidencePaths(m)), current) : [];
    const binding = m.binding ? await this.inspect(m.provider, m.binding.threadId, m.cwd) : null;
    return { missionId: id, observedAt: this.clock(), state: m.state,
      binding: binding ? { threadId: binding.id, cwd: binding.cwd, status: binding.status, version: binding.version } : null,
      execution: run ? { runId: run.id, status: run.status, error: run.error, output: (run.output || '').slice(-24000),
        logs: (run.logs || []).slice(-20).map(l => ({ ...l, text: l.text.slice(-2000) })) } : null,
      changes, changedFilePreviews: changes.filter(c => c.kind !== 'deleted').slice(0, 16).map(c => artifact(m.cwd, c.path)),
      scanComplete: current.complete, scanIssues: current.issues,
      scopePaths: evidencePaths(m), sharedWorkspaceActivity: this.nativeActivity(m.cwd, m.provider, m.binding?.threadId),
      artifacts: m.artifacts.map(p => artifact(m.cwd, p)), note: '阶段观察只读取文件和运行状态，不执行测试，不等同于最终验收。' };
  }
  async review(id, input) {
    return this.serial(id, async () => {
      const m = this.get(id), review = m.reviews.at(-1);
      if (m.state !== 'review_pending' || !review || input.evidenceId !== review.id) throw new Error('验收证据已变化或不可审查，请重新读取。');
      if (!Array.isArray(input.decisions) || !input.decisions.length && input.confirmIncompleteScan !== true) throw new Error('请提供待判断验收标准的结论和理由。');
      if (new Set(input.decisions.map(d => d.criterionId)).size !== input.decisions.length) throw new Error('验收结论编号不能重复。');
      const reason = input.reason ? text(input.reason, '审查结论', 4000) : '';
      const reviewer = input.reviewer ? text(input.reviewer, '审查者', 120) : 'conversation';
      if ((!review.packet.baselineComplete || !review.packet.scanComplete) && input.confirmIncompleteScan === true) text(input.reason, '扫描不完整的核验说明', 4000);
      for (const decision of input.decisions) {
        const check = review.packet.checks.find(c => c.id === decision.criterionId);
        if (!check || check.status !== 'pending' || !['passed', 'failed'].includes(decision.status)) throw new Error('只能判断待审查标准，不能覆盖失败测试。');
        text(decision.reason, '判断理由', 4000);
      }
      if (review.packet.fingerprint !== fingerprint(manifest(m.cwd, evidencePaths(m)))) throw new Error('产物在收集证据后发生变化，请重新收集验收证据。');
      if (m.binding) {
        const current = await this.inspect(m.provider, m.binding.threadId, m.cwd);
        if (!['idle', 'completed'].includes(current.status) || review.packet.bindingVersion && current.version !== review.packet.bindingVersion) throw new Error('原会话轮次已变化，请重新核实并收集证据。');
      }
      for (const decision of input.decisions) {
        const check = review.packet.checks.find(c => c.id === decision.criterionId);
        check.status = decision.status; check.reason = decision.reason;
        review.decisions.push({ ...decision, reviewer, at: this.clock() });
      }
      if ((!review.packet.baselineComplete || !review.packet.scanComplete) && input.confirmIncompleteScan === true) {
        text(input.reason, '扫描不完整的核验说明', 4000);
        review.scanAcknowledgment = { reason: input.reason, at: this.clock() };
      }
      review.reason = reason;
      this.evaluate(m, review);
      if (m.state === 'correction_needed' && m.autoCorrect) await this.queueInstruction(m, { requestId: 'automatic-' + review.id }, true);
      return this.detail(id);
    });
  }
  async pause(id, input) {
    return this.serial(id, async () => {
      const m = this.get(id);
      if (m.state === 'paused') return this.detail(id);
      if (m.state === 'accepted') throw new Error('已验收通过的任务不能改成暂停状态。');
      if (this.scheduler.active?.task.missionId === id || this.jobs.has(id)) throw new Error('任务仍在执行或验收，先停止运行并等待结束。');
      for (const i of m.instructions) if (i.state === 'queued') this.scheduler.pause(i.taskId, true);
      m.pausedFrom = m.state; m.state = 'paused'; m.error = text(input.reason, '暂停原因', 4000);
      this.save(); return this.detail(id);
    });
  }
  async resume(id) {
    return this.serial(id, async () => {
      const m = this.get(id);
      if (m.state !== 'paused' || !['draft', 'bound', 'scheduled', 'correction_pending', 'review_pending', 'correction_needed', 'exhausted'].includes(m.pausedFrom)) throw new Error('这个暂停状态不能自动恢复；需核实原会话或建立新的阶段任务。');
      m.state = m.pausedFrom; m.error = '';
      for (const i of m.instructions) if (i.state === 'queued') this.scheduler.pause(i.taskId, false);
      this.save(); return this.detail(id);
    });
  }
  async releaseLease(leaseId, input) {
    const lease = this.store.data.fileLeases.find(l => l.id === leaseId && l.state === 'held');
    if (!lease) throw new Error('占用记录不存在或已释放。');
    if (this.scheduler.active?.run.fileLeaseOwner === lease.owner || this.jobs.has(lease.owner)) throw new Error('仍在运行或收集证据，不能释放。');
    text(input.reason, '释放说明', 4000);
    if (input.confirmedIdle !== true) throw new Error('需核实原客户端已停止，并设置 confirmedIdle=true。');
    if (lease.threadId && SUPPORTED.has(lease.provider)) {
      const row = await this.inspect(lease.provider, lease.threadId, lease.cwd);
      if (!['idle', 'completed'].includes(row.status)) throw new Error('原客户端会话尚未空闲，不能释放。');
    }
    this.leases.release(lease.owner, input.reason);
    const m = this.store.data.missions.find(m => m.id === lease.owner);
    if (m && m.state !== 'accepted') {
      for (const i of m.instructions) if (i.state === 'queued') this.scheduler.pause(i.taskId, true);
      m.state = 'paused'; m.error = '人工核实后释放文件占用：' + input.reason;
    }
    this.save(); return { ok: true };
  }
  async close() { this.closed = true; await Promise.allSettled([...this.jobs.values()]); this.save(); }
}
