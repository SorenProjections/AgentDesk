import test from 'node:test';
import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import { mkdtempSync, readFileSync, writeFileSync, mkdirSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { Store } from '../lib/store.mjs';
import { Scheduler } from '../lib/scheduler.mjs';

const scratch = path.resolve(process.env.CODEX_SCHEDULER_TEST_DATA || path.join(path.dirname(fileURLToPath(import.meta.url)), '../work/scheduler-tests'));
mkdirSync(scratch, { recursive: true });

class FakeCodex extends EventEmitter {
  constructor() { super(); this.connected = true; this.defaults = {}; this.calls = []; this.nextTurn = 0; this.reply = []; }
  async connect() { return this; }
  async request(method, params) {
    this.calls.push({ method, params });
    if (method === 'thread/start') return { thread: { id: 'local-test-thread', cwd: params.cwd, status: { type: 'idle' } } };
    if (method === 'thread/read' || method === 'thread/resume') return { thread: { id: params.threadId, name: 'Existing test', cwd: this.folder, status: { type: 'idle' } } };
    if (method === 'turn/start') {
      if (this.failSend) {
        const error = new Error('Transport interrupted after write');
        error.uncertainDelivery = true;
        throw error;
      }
      const turn = { id: 'turn-' + (++this.nextTurn), status: 'inProgress' };
      this.emit('notification', { method: 'turn/started', params: { threadId: params.threadId, turn } });
      return { turn };
    }
    return {};
  }
  respond(id, result) { this.reply.push({ id, result }); }
  rejectRequest(id, message) { this.reply.push({ id, error: message }); }
  complete(threadId = 'local-test-thread', status = 'completed') {
    this.emit('notification', { method: 'item/completed', params: { threadId, turnId: 'turn-' + this.nextTurn, item: { type: 'agentMessage', text: 'Done' } } });
    this.emit('notification', { method: 'turn/completed', params: { threadId, turn: { id: 'turn-' + this.nextTurn, status } } });
  }
}

function fixture(t) {
  const folder = mkdtempSync(path.join(scratch, 'case-'));
  const store = new Store(path.join(folder, 'tasks.json'));
  const client = new FakeCodex();
  client.folder = folder;
  let now = 1700000000000;
  const scheduler = new Scheduler(store, client, { clock: () => now });
  t.after(() => scheduler.stop());
  return { folder, store, client, scheduler, setNow(value) { now = value; }, now: () => now,
    draft: { title: 'One shot', cwd: folder, threadMode: 'new', prompt: 'Run this once', times: [now + 10000] } };
}

test('one-shot time creates one turn and never fires again after completion or restart', async t => {
  const f = fixture(t);
  const task = await f.scheduler.saveTask(f.draft);
  await f.scheduler.tick();
  assert.equal(f.client.calls.filter(call => call.method === 'turn/start').length, 0);
  f.setNow(f.now() + 10000);
  await Promise.all([f.scheduler.tick(), f.scheduler.tick(), f.scheduler.tick()]);
  assert.equal(f.client.calls.filter(call => call.method === 'turn/start').length, 1);
  f.client.complete();
  await f.scheduler.tick();
  assert.equal(task.times[0].state, 'completed');
  assert.equal(f.client.calls.filter(call => call.method === 'turn/start').length, 1);
  f.scheduler.stop();
  const restarted = new Scheduler(new Store(f.store.file), f.client, { clock: f.now });
  await restarted.tick();
  restarted.stop();
  assert.equal(f.client.calls.filter(call => call.method === 'turn/start').length, 1);
});

test('separate dates keep the same newly created conversation and serialize runs', async t => {
  const f = fixture(t);
  const task = await f.scheduler.saveTask({ ...f.draft, times: [f.now() + 10000, f.now() + 20000] });
  f.setNow(f.now() + 30000);
  await f.scheduler.tick();
  await f.scheduler.tick();
  assert.equal(f.client.nextTurn, 1);
  f.client.complete();
  await f.scheduler.tick();
  assert.equal(f.client.nextTurn, 2);
  assert.equal(f.client.calls.filter(call => call.method === 'thread/start').length, 1);
  assert.equal(task.threadId, 'local-test-thread');
  f.client.complete();
});

test('existing conversation is resumed with its original project and receives the exact prompt', async t => {
  const f = fixture(t);
  await f.scheduler.saveTask({ ...f.draft, threadMode: 'existing', threadId: 'existing-test' });
  f.setNow(f.now() + 10000);
  await f.scheduler.tick();
  const sent = f.client.calls.find(call => call.method === 'turn/start');
  assert.equal(sent.params.threadId, 'existing-test');
  assert.equal(sent.params.cwd, f.folder);
  assert.equal(sent.params.input[0].text, f.draft.prompt);
  assert.ok(f.client.calls.some(call => call.method === 'thread/resume'));
  f.client.complete('existing-test');
});

test('rejects a conversation in a different folder and rejects past or duplicate times', async t => {
  const f = fixture(t);
  f.client.folder = path.dirname(f.folder);
  await assert.rejects(f.scheduler.saveTask({ ...f.draft, threadMode: 'existing', threadId: 'wrong-folder' }), /不一致/);
  await assert.rejects(f.scheduler.saveTask({ ...f.draft, times: [f.now() - 1] }), /晚于/);
  await assert.rejects(f.scheduler.saveTask({ ...f.draft, times: [f.now() + 1, f.now() + 1] }), /重复/);
});

test('pause persists, resume runs an overdue task only once, and catch-up skip is honored', async t => {
  const f = fixture(t);
  const task = await f.scheduler.saveTask(f.draft);
  f.scheduler.pause(task.id, true);
  assert.equal(JSON.parse(readFileSync(f.store.file, 'utf8')).tasks[0].paused, true);
  f.setNow(f.now() + 100000);
  await f.scheduler.tick();
  assert.equal(f.client.nextTurn, 0);
  f.scheduler.pause(task.id, false);
  await f.scheduler.tick();
  assert.equal(f.client.nextTurn, 1);
  f.client.complete();
  const skipped = await f.scheduler.saveTask({ ...f.draft, latePolicy: 'skip', times: [f.now() + 1000] });
  f.setNow(f.now() + 70000);
  await f.scheduler.tick();
  assert.equal(skipped.times[0].state, 'missed');
  assert.equal(f.client.nextTurn, 1);
});

test('crash recovery does not resend a message claimed before dispatch', async t => {
  const f = fixture(t);
  const task = await f.scheduler.saveTask(f.draft);
  f.setNow(f.now() + 10000);
  await f.scheduler.tick();
  f.scheduler.stop();
  const recoveredStore = new Store(f.store.file);
  const recovered = new Scheduler(recoveredStore, f.client, { clock: f.now });
  await recovered.tick();
  assert.equal(recoveredStore.data.runs[0].status, 'uncertain');
  assert.equal(recovered.getTask(task.id).paused, true);
  assert.equal(f.client.nextTurn, 1);
  recovered.stop();
});

test('a delivery timeout leaves an uncertain record and pauses further automatic sends', async t => {
  const f = fixture(t);
  f.client.failSend = true;
  const task = await f.scheduler.saveTask(f.draft);
  f.setNow(f.now() + 10000);
  await f.scheduler.tick();
  assert.equal(f.store.data.runs[0].status, 'uncertain');
  assert.equal(task.paused, true);
  await f.scheduler.tick();
  assert.equal(f.client.calls.filter(call => call.method === 'turn/start').length, 1);
});

test('project write scope and confirmation mode stay explicit; full access is unavailable', async t => {
  const f = fixture(t);
  await assert.rejects(f.scheduler.saveTask({ ...f.draft, sandbox: 'danger-full-access' }), /权限/);
  const task = await f.scheduler.saveTask({ ...f.draft, approval: 'deny', networkAccess: false });
  await f.scheduler.runNow(task.id);
  const turn = f.client.calls.find(call => call.method === 'turn/start');
  assert.equal(turn.params.approvalPolicy, 'never');
  assert.deepEqual(turn.params.sandboxPolicy.writableRoots, [f.folder]);
  assert.equal(turn.params.sandboxPolicy.networkAccess, false);
  assert.equal(task.times[0].state, 'pending');
  f.client.complete();
});

test('approval is displayed and only a human response resolves it', async t => {
  const f = fixture(t);
  const task = await f.scheduler.saveTask(f.draft);
  const run = await f.scheduler.runNow(task.id);
  f.client.emit('request', { id: 'approval-1', method: 'item/commandExecution/requestApproval', params: { threadId: run.threadId, turnId: run.turnId, command: 'test command' } });
  assert.equal(run.status, 'waiting');
  assert.equal(f.client.reply.length, 0);
  const request = f.scheduler.snapshot().requests[0];
  f.scheduler.respond(request.id, { decision: 'decline' });
  assert.deepEqual(f.client.reply[0], { id: 'approval-1', result: { decision: 'decline' } });
  assert.equal(run.status, 'running');
  f.client.complete();
});

test('editing and deleting cannot change an active run; history survives schedule removal', async t => {
  const f = fixture(t);
  const task = await f.scheduler.saveTask(f.draft);
  await f.scheduler.runNow(task.id);
  await assert.rejects(f.scheduler.saveTask(f.draft, task.id), /正在运行/);
  assert.throws(() => f.scheduler.remove(task.id), /正在运行/);
  f.client.complete();
  f.scheduler.remove(task.id);
  assert.equal(f.store.data.tasks.length, 0);
  assert.equal(f.store.data.runs.length, 1);
  assert.equal(f.store.data.runs[0].output, 'Done');
});

test('corrupt data is preserved and fails loudly rather than silently deleting schedules', () => {
  const folder = mkdtempSync(path.join(scratch, 'corrupt-'));
  const file = path.join(folder, 'tasks.json');
  writeFileSync(file, 'not valid json');
  assert.throws(() => new Store(file), /原文件已保留/);
  assert.equal(readFileSync(file, 'utf8'), 'not valid json');
});

test('queued messages send once, in editable order, without overlapping turns', async t => {
  const f = fixture(t);
  const a = await f.scheduler.saveTask({ ...f.draft, title: 'A', trigger: { type: 'queue' }, times: [] });
  const b = await f.scheduler.saveTask({ ...f.draft, title: 'B', prompt: 'Original', trigger: { type: 'queue' }, times: [] });
  f.scheduler.reorder([b.id, a.id]);
  await f.scheduler.saveTask({ ...b, prompt: 'Edited before sending' }, b.id);
  await Promise.all([f.scheduler.tick(), f.scheduler.tick()]);
  assert.equal(f.store.data.runs[0].taskId, b.id);
  assert.equal(f.store.data.runs[0].prompt, 'Edited before sending');
  f.client.complete();
  await f.scheduler.tick();
  assert.equal(f.store.data.runs[1].taskId, a.id);
  f.client.complete();
  await f.scheduler.tick();
  assert.equal(f.store.data.runs.length, 2);
});

test('a completion dependency preserves a running predecessor and resumes its conversation', async t => {
  const f = fixture(t);
  const parent = await f.scheduler.saveTask(f.draft);
  const first = await f.scheduler.runNow(parent.id);
  const child = await f.scheduler.saveTask({ ...f.draft, prompt: 'Continue this context', trigger: { type: 'afterTask', taskId: parent.id }, threadMode: 'previous', times: [] });
  assert.equal(child.trigger.sourceRunId, first.id);
  assert.equal(f.scheduler.readiness(child).status, 'pending');
  f.client.complete();
  await f.scheduler.tick();
  assert.equal(f.store.data.runs[1].sourceRunId, first.id);
  assert.equal(f.store.data.runs[1].threadId, first.threadId);
  assert.equal(f.client.calls.filter(call => call.method === 'thread/start').length, 1);
  f.client.complete();
  await f.scheduler.tick();
  assert.equal(f.store.data.runs.length, 2);
});

test('a chain created before its predecessor waits for the next run, not stale history', async t => {
  const f = fixture(t);
  const parent = await f.scheduler.saveTask(f.draft);
  await f.scheduler.runNow(parent.id); f.client.complete();
  const child = await f.scheduler.saveTask({ ...f.draft, trigger: { type: 'afterTask', taskId: parent.id }, times: [] });
  await f.scheduler.tick();
  assert.equal(f.store.data.runs.length, 1);
  const next = await f.scheduler.runNow(parent.id); f.client.complete();
  await f.scheduler.tick();
  assert.equal(f.store.data.runs[2].sourceRunId, next.id);
  f.client.complete();
  assert.equal(child.trigger.state, 'completed');
});

test('failed predecessor blocks continuation even after restoring the global queue', async t => {
  const f = fixture(t);
  const parent = await f.scheduler.saveTask(f.draft);
  await f.scheduler.runNow(parent.id);
  const child = await f.scheduler.saveTask({ ...f.draft, trigger: { type: 'afterTask', taskId: parent.id }, times: [] });
  f.client.complete(undefined, 'failed');
  assert.equal(f.store.data.settings.queuePaused, true);
  f.scheduler.configure({ queuePaused: false });
  await f.scheduler.tick();
  assert.equal(f.scheduler.readiness(child).status, 'blocked');
  assert.equal(f.client.nextTurn, 1);
  await f.scheduler.saveTask({ ...child, trigger: { ...child.trigger, onFailure: 'continue' } }, child.id);
  await f.scheduler.tick();
  assert.equal(f.client.nextTurn, 2);
  f.client.complete();
});

test('editing lease prevents stale dispatch, expires, and revision detects stale edits', async t => {
  const f = fixture(t);
  const task = await f.scheduler.saveTask({ ...f.draft, trigger: { type: 'queue' }, times: [] });
  const token = 'editing-token-123456789012345';
  f.scheduler.hold(task.id, token);
  await f.scheduler.tick();
  assert.equal(f.client.nextTurn, 0);
  await assert.rejects(f.scheduler.saveTask({ ...task, prompt: 'Other window' }, task.id), /另一个面板/);
  const changed = await f.scheduler.saveTask({ ...task, editToken: token, prompt: 'Latest text' }, task.id);
  await assert.rejects(f.scheduler.saveTask({ ...task, prompt: 'Stale edit' }, task.id), /已在其他面板更新/);
  f.scheduler.hold(changed.id, token);
  f.setNow(f.now() + 90001);
  await f.scheduler.tick();
  assert.equal(f.store.data.runs[0].prompt, 'Latest text');
  f.client.complete();
});

test('dependency cycles and deletion of a required predecessor are rejected', async t => {
  const f = fixture(t);
  const a = await f.scheduler.saveTask(f.draft);
  const b = await f.scheduler.saveTask({ ...f.draft, trigger: { type: 'afterTask', taskId: a.id }, times: [] });
  await assert.rejects(f.scheduler.saveTask({ ...a, trigger: { type: 'afterTask', taskId: b.id }, times: [] }, a.id), /循环/);
  assert.throws(() => f.scheduler.remove(a.id), /后续消息/);
});

test('paused queue and restored queue survive a backend restart', async t => {
  const f = fixture(t);
  await f.scheduler.saveTask({ ...f.draft, trigger: { type: 'queue' }, times: [] });
  f.scheduler.configure({ queuePaused: true });
  f.scheduler.stop();
  const recovered = new Scheduler(new Store(f.store.file), f.client, { clock: f.now });
  t.after(() => recovered.stop());
  await recovered.tick(); assert.equal(f.client.nextTurn, 0);
  recovered.configure({ queuePaused: false });
  await recovered.tick(); assert.equal(f.client.nextTurn, 1);
  f.client.complete();
});

test('cross-agent continuation waits for actual process completion and keeps exact prompt', async t => {
  const f = fixture(t);
  let finish, received;
  f.scheduler.providers.set('workbuddy', { snapshot: () => ({ capabilities: { captureThread: true } }), start: (task, run, hooks) => {
    received = run.prompt; hooks.thread('wb-session'); hooks.output('WorkBuddy done');
    return { completion: new Promise(resolve => { finish = resolve; }), interrupt() {} };
  } });
  const parent = await f.scheduler.saveTask({ ...f.draft, trigger: { type: 'queue' }, times: [] });
  const child = await f.scheduler.saveTask({ ...f.draft, provider: 'workbuddy', prompt: 'Cross agent prompt', trigger: { type: 'afterTask', taskId: parent.id }, times: [] });
  await f.scheduler.tick();
  f.client.complete(); await f.scheduler.tick();
  assert.equal(received, 'Cross agent prompt');
  assert.equal(child.trigger.state, 'running');
  f.client.emit('disconnected', 'Codex offline');
  assert.equal(f.scheduler.active.run.provider, 'workbuddy');
  finish({ status: 'completed' }); await new Promise(resolve => setImmediate(resolve));
  assert.equal(child.trigger.state, 'completed');
  await f.scheduler.tick(); assert.equal(f.store.data.runs.length, 2);
});
