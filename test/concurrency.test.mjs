import test from 'node:test';
import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import { mkdirSync, mkdtempSync } from 'node:fs';
import path from 'node:path';
import { Store } from '../lib/store.mjs';
import { Scheduler } from '../lib/scheduler.mjs';
import { Supervision } from '../lib/supervision.mjs';
import { WorkBuddyDesktop, AntigravityDesktop } from '../lib/desktop.mjs';

class Client extends EventEmitter {
  constructor() { super(); this.connected = true; this.defaults = {}; this.calls = []; this.folders = new Map(); this.next = 0; }
  async connect() {}
  async request(method, p) {
    this.calls.push({ method, p });
    if (method === 'thread/start') { const id = 'thread-' + ++this.next; this.folders.set(id, p.cwd); return { thread: { id, cwd: p.cwd, status: { type: 'idle' } } }; }
    if (method === 'thread/read' || method === 'thread/resume') return { thread: { id: p.threadId, cwd: this.folders.get(p.threadId), status: { type: 'idle' } } };
    if (method === 'turn/start') return { turn: { id: 'turn-' + p.threadId } };
    return {};
  }
  respond(id, response) { this.calls.push({ method: 'respond', id, response }); }
  rejectRequest(id) { this.calls.push({ method: 'reject', id }); }
  complete(run, status = 'completed') { this.emit('notification', { method: 'turn/completed', params: { threadId: run.threadId, turn: { id: run.turnId, status } } }); }
}
function fixture(t) {
  const base = path.resolve('work/concurrency-tests'); mkdirSync(base, { recursive: true });
  const cwd = mkdtempSync(path.join(base, 'case-')), store = new Store(path.join(cwd, 'tasks.json'));
  const client = new Client(), scheduler = new Scheduler(store, client);
  t.after(() => scheduler.stop());
  return { cwd, store, client, scheduler, draft: { title: 'Parallel', cwd, threadMode: 'new', prompt: 'Work', trigger: { type: 'queue' }, times: [] } };
}
function desktop(id) {
  const jobs = [];
  return { id, jobs, snapshot: () => ({ id, available: true, capabilities: { resume: true, captureThread: true } }),
    start(task, run, hooks) {
      hooks.thread(id + '-' + run.id);
      let finish; const completion = new Promise(resolve => finish = resolve);
      const job = { task, run, hooks, finish, interrupted: false }; jobs.push(job);
      return { completion, async interrupt() { job.interrupted = true; finish({ status: 'interrupted' }); } };
    } };
}

test('isolated WorkBuddy and Antigravity missions run together; overlapping writes wait', async t => {
  const f = fixture(t), wb = desktop('workbuddyDesktop'), ag = desktop('antigravityDesktop');
  f.scheduler.providers.set(wb.id, wb); f.scheduler.providers.set(ag.id, ag);
  const supervisor = new Supervision(f.store, f.scheduler); t.after(() => supervisor.close());
  for (const [provider, scope] of [[wb.id, 'research/a'], [ag.id, 'research/b'], [ag.id, 'research/a/nested']]) {
    const m = await supervisor.create({ title: scope, objective: 'Isolated research', cwd: f.cwd, provider,
      constraints: ['Only own scope'], criteria: [{ id: 'manual', type: 'manual', description: 'Review' }], writePaths: [scope] });
    await supervisor.dispatch(m.id, { requestId: 'start-' + m.id });
  }
  await Promise.all([f.scheduler.tick(), f.scheduler.tick()]);
  assert.equal(f.scheduler.activeRuns.size, 2);
  assert.equal(wb.jobs.length, 1); assert.equal(ag.jobs.length, 1);
  assert.equal(f.store.data.runs.length, 2);
  assert.match(f.scheduler.readiness(f.store.data.tasks[2]).reason, /占用冲突/);
  ag.jobs[0].hooks.output('B output');
  assert.equal(wb.jobs[0].run.output, '');
  await f.scheduler.interrupt(ag.jobs[0].run.id); await new Promise(r => setImmediate(r));
  assert.equal(ag.jobs[0].interrupted, true); assert.equal(wb.jobs[0].interrupted, false);
  assert.equal(f.scheduler.activeRuns.size, 1); assert.equal(wb.jobs[0].run.status, 'running');
  assert.deepEqual(f.scheduler.snapshot().activeRunIds, [wb.jobs[0].run.id]);
  await assert.rejects(supervisor.releaseLease(f.store.data.fileLeases.find(l => l.owner === f.store.data.tasks[0].missionId).id,
    { confirmedIdle: true, reason: 'Cannot release an active parallel owner' }), /运行/);
});

test('parallel Codex requests, output, completion and interruption route to their own turns', async t => {
  const f = fixture(t);
  const first = path.join(f.cwd, 'first'), other = path.join(f.cwd, 'other'); mkdirSync(first); mkdirSync(other);
  const a = await f.scheduler.saveTask({ ...f.draft, cwd: first }), b = await f.scheduler.saveTask({ ...f.draft, cwd: other });
  await f.scheduler.tick(); assert.equal(f.scheduler.activeRuns.size, 2);
  const [ra, rb] = f.store.data.runs;
  for (const [id, run] of [['approval-a', ra], ['approval-b', rb]]) f.client.emit('request', {
    id, method: 'item/commandExecution/requestApproval', params: { threadId: run.threadId, turnId: run.turnId } });
  const [qa, qb] = f.scheduler.snapshot().requests;
  f.scheduler.respond(qb.id, { decision: 'decline' });
  assert.equal(ra.status, 'waiting'); assert.equal(rb.status, 'running');
  assert.equal(f.client.calls.at(-1).id, 'approval-b');
  f.client.emit('notification', { method: 'item/completed', params: { threadId: rb.threadId, turnId: rb.turnId, item: { type: 'agentMessage', text: 'B only' } } });
  assert.equal(ra.output, ''); assert.equal(rb.output, 'B only');
  await f.scheduler.interrupt(ra.id);
  assert.deepEqual(f.client.calls.at(-1), { method: 'turn/interrupt', p: { threadId: ra.threadId, turnId: ra.turnId } });
  f.client.complete(rb);
  assert.equal(f.scheduler.activeRuns.has(ra.id), true); assert.equal(f.scheduler.activeRuns.has(rb.id), false);
  assert.equal(f.scheduler.snapshot().requests[0].id, qa.id);
  f.scheduler.respond(qa.id, { decision: 'decline' }); f.client.complete(ra);
  assert.equal(f.scheduler.activeRuns.size, 0); assert.equal(a.trigger.state, 'completed'); assert.equal(b.trigger.state, 'completed');
});

test('same session is serialized even with read-only paths; concurrency cap is enforced', async t => {
  const f = fixture(t), p = desktop('testDesktop'); f.scheduler.providers.set(p.id, p);
  p.inspect = async id => ({ id, cwd: f.cwd });
  await f.scheduler.saveTask({ ...f.draft, provider: p.id, sandbox: 'read-only', threadMode: 'existing', threadId: 'same-chat' });
  await f.scheduler.saveTask({ ...f.draft, provider: p.id, sandbox: 'read-only', threadMode: 'existing', threadId: 'same-chat' });
  // This fake keeps the specified existing thread instead of manufacturing one.
  const start = p.start; p.start = (task, run, hooks) => start(task, run, { ...hooks, thread: () => {} });
  await f.scheduler.tick(); assert.equal(p.jobs.length, 1);
  assert.match(f.scheduler.readiness(f.store.data.tasks[1]).reason, /会话/);
  f.scheduler.configure({ maxConcurrentRuns: 1 });
  const other = path.join(f.cwd, 'independent'); mkdirSync(other);
  const independent = await f.scheduler.saveTask({ ...f.draft, provider: p.id, cwd: other, sandbox: 'read-only' });
  await f.scheduler.tick(); assert.equal(p.jobs.length, 1);
  assert.match(f.scheduler.readiness(independent).reason, /并发上限/);
  assert.throws(() => f.scheduler.configure({ maxConcurrentRuns: 0 }), /1–32/);
});

test('Codex disconnect stops only Codex runs while a desktop task continues', async t => {
  const f = fixture(t), p = desktop('testDesktop'); f.scheduler.providers.set(p.id, p);
  const first = path.join(f.cwd, 'codex'), other = path.join(f.cwd, 'desktop'); mkdirSync(first); mkdirSync(other);
  await f.scheduler.saveTask({ ...f.draft, cwd: first }); await f.scheduler.saveTask({ ...f.draft, provider: p.id, cwd: other });
  await f.scheduler.tick(); assert.equal(f.scheduler.activeRuns.size, 2);
  f.client.emit('disconnected', 'transport lost');
  assert.equal(f.scheduler.activeRuns.size, 1); assert.equal(p.jobs[0].run.status, 'running');
  assert.equal(f.store.data.runs[0].status, 'uncertain');
});

test('backend reload recovers an acknowledged WorkBuddy request without sending or changing its lease', async t => {
  const f = fixture(t), p = new WorkBuddyDesktop({ pause: async () => {} }); p.available = true;
  const runId = 'original-request'; let resumeReads = 0;
  p.inspect = async () => { resumeReads++; return { cwd: f.cwd, status: 'working', requests: [{ id: runId, state: 'working' }], last: { id: runId } }; };
  p.invoke = async () => { throw new Error('No send/create/cancel expected'); };
  const task = { ...f.draft, id: 'task-original', provider: p.id, threadId: 'wb-existing', timeoutMinutes: 5, trigger: { type: 'queue', id: 'slot-original', state: 'running' }, missionId: 'mission-original' };
  const run = { id: runId, taskId: task.id, slotId: task.trigger.id, provider: p.id, threadId: task.threadId, startedAt: Date.now(), status: 'running', logs: [{ text: '消息已发送到 WorkBuddy 桌面对话。' }], fileLeaseOwner: task.missionId };
  f.store.data.tasks.push(task); f.store.data.runs.push(run);
  f.store.data.missions = [{ id: task.missionId, state: 'running', latestRunId: runId, instructions: [], writePaths: ['research/original'], cwd: f.cwd }]; f.store.save();
  // Leave the recovered request waiting rather than spin a fake polling loop.
  p.pause = () => new Promise(() => {});
  const recovered = new Scheduler(new Store(f.store.file), new Client(), { providers: new Map([[p.id, p]]) }); t.after(() => recovered.stop());
  const supervisor = new Supervision(recovered.store, recovered); t.after(() => supervisor.close());
  assert.equal(supervisor.get(task.missionId).state, 'running');
  assert.equal(recovered.activeRuns.get(runId).recoveryPending, true);
  await recovered.tick();
  assert.equal(resumeReads, 1); assert.equal(recovered.store.data.runs.length, 1);
  assert.equal(recovered.activeRuns.get(runId).run.status, 'running');
  assert.equal(recovered.store.data.settings.queuePaused, false);
  assert.equal(supervisor.get(task.missionId).latestRunId, runId);
});

test('desktop recovery refuses missing acknowledgements or a different turn', async () => {
  const wb = new WorkBuddyDesktop(); assert.equal(wb.canResume({ id: 'r', threadId: 'chat', logs: [] }), false);
  const ag = new AntigravityDesktop(); ag.inspect = async () => ({ cwd: process.cwd(), version: 'new-turn', status: 'running' });
  ag.rpc = async () => { throw new Error('No sending/cancelling during recovery'); };
  const run = { threadId: 'chat', desktopMonitor: { phase: 'sent', offset: 3, turnVersion: 'old-turn', deadline: Date.now() + 10000 } };
  assert.equal(ag.canResume(run), true);
  const result = await ag.resume({ cwd: process.cwd() }, run, {}).completion;
  assert.equal(result.status, 'uncertain'); assert.match(result.error, /另一轮/);
  wb.inspect = async () => ({ cwd: process.cwd(), status: 'idle', requests: [{ id: 'other', state: 'completed' }], last: { id: 'other' } });
  const result2 = await wb.resume({ cwd: process.cwd(), timeoutMinutes: 1 }, { id: 'original', threadId: 'chat', startedAt: Date.now(), logs: [{ text: '消息已发送到 WorkBuddy 桌面对话。' }] }, {}).completion;
  assert.equal(result2.status, 'uncertain'); assert.match(result2.error, /请求编号/);
});
