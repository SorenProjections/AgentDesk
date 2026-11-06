import test from 'node:test';
import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import { mkdirSync, mkdtempSync } from 'node:fs';
import path from 'node:path';
import { Store } from '../lib/store.mjs';
import { Scheduler } from '../lib/scheduler.mjs';
import { Supervision } from '../lib/supervision.mjs';

function fixture(t, supervised = true, providers = new Map()) {
  const root = path.resolve('work/ordinary-protection-tests');
  mkdirSync(root, { recursive: true });
  const cwd = mkdtempSync(path.join(root, 'case-'));
  const store = new Store(path.join(cwd, 'tasks.json'));
  const client = new EventEmitter();
  Object.assign(client, { connected: true, defaults: {}, nextThread: 0, nextTurn: 0, connect: async () => {} });
  client.request = async (method, input) => {
    if (method === 'thread/start') return { thread: { id: 'chat-' + ++client.nextThread, cwd } };
    if (method.startsWith('thread/')) return { thread: { id: input.threadId, cwd, status: { type: 'idle' } } };
    if (method === 'turn/start') return { turn: { id: 'turn-' + ++client.nextTurn } };
    return {};
  };
  const scheduler = new Scheduler(store, client, { providers });
  const supervision = supervised ? new Supervision(store, scheduler) : null;
  t.after(() => scheduler.stop());
  const draft = { title: 'Ordinary task', cwd, prompt: 'Do the scheduled work', threadMode: 'new', trigger: { type: 'queue' }, times: [] };
  return { cwd, store, client, scheduler, supervision, draft };
}

test('ordinary new conversations share a workspace without automatic file locks', async t => {
  for (const supervised of [false, true]) {
    const f = fixture(t, supervised);
    if (supervised) {
      f.store.data.missions.push({ id: 'review', state: 'paused', writePaths: ['research'], instructions: [], reviews: [] });
      f.supervision.leases.acquire({ owner: 'review', cwd: f.cwd, paths: ['research'] });
    }
    const a = await f.scheduler.saveTask({ ...f.draft, title: 'A' });
    const b = await f.scheduler.saveTask({ ...f.draft, title: 'B' });
    await f.scheduler.tick();
    assert.equal(f.scheduler.activeRuns.size, 2);
    assert.notEqual(a.threadId, b.threadId);
    assert.equal(f.client.nextTurn, 2);
    assert.equal(f.store.data.fileLeases?.length || 0, supervised ? 1 : 0);
    assert.throws(() => f.scheduler.remove(a.id), /正在运行/);
    await f.scheduler.tick();
    assert.equal(f.client.nextTurn, 2, 'active tasks are never dispatched twice');
  }
});

test('ordinary concurrency still respects the same conversation and configured capacity', async t => {
  const f = fixture(t);
  const a = await f.scheduler.saveTask({ ...f.draft, threadMode: 'existing', threadId: 'existing' });
  const b = await f.scheduler.saveTask({ ...f.draft, threadMode: 'existing', threadId: 'existing' });
  await f.scheduler.tick();
  assert.equal(f.scheduler.activeRuns.size, 1);
  assert.match(f.scheduler.readiness(b).reason, /目标会话仍在运行/);
  f.scheduler.configure({ maxConcurrentRuns: 1 });
  const c = await f.scheduler.saveTask({ ...f.draft });
  assert.match(f.scheduler.readiness(c).reason, /并发上限/);
  assert.equal(f.scheduler.active.task.id, a.id);
});

test('legacy ordinary reservations are removed in every run state while history and explicit supervision stay intact', async t => {
  for (const status of ['running', 'waiting', 'uncertain', 'failed', 'completed', 'interrupted']) {
    const f = fixture(t, false);
    const task = await f.scheduler.saveTask(f.draft);
    const run = { id: 'ordinary-run', taskId: task.id, provider: 'codex', status, output: 'original output' };
    f.store.data.runs.push(run);
    f.store.data.missions = [{ id: 'explicit', state: 'paused', instructions: [], reviews: [] }];
    f.store.data.fileLeases = [
      { id: 'ordinary', owner: run.id, runId: run.id, state: 'held', paths: ['.'] },
      { id: 'explicit', owner: 'explicit', state: 'held', paths: ['research'] },
    ];
    if (status === 'running') f.scheduler.activeRuns.set(run.id, { task, run });
    new Supervision(f.store, f.scheduler);
    assert.equal(f.store.data.fileLeases[0].state, 'released', status);
    assert.equal(f.store.data.fileLeases[1].state, 'held', status);
    assert.equal(run.status, status);
    assert.equal(run.output, 'original output');
    assert.equal(f.scheduler.activeRuns.size, status === 'running' ? 1 : 0);
    assert.equal(new Store(f.store.file).data.fileLeases[0].state, 'released');
  }
});

test('desktop monitoring resumes the exact ordinary request after restart without recreating its old lock', async t => {
  let starts = 0, resumes = 0;
  const provider = {
    snapshot: () => ({ available: true, capabilities: { desktop: true, resume: true, captureThread: true } }),
    start(task, run, hooks) {
      starts++;
      hooks.thread('original-chat');
      hooks.checkpoint({ phase: 'sent', requestId: run.id, conversationRequestId: 'original-request', deadline: Date.now() + 60000 });
      return { completion: new Promise(() => {}) };
    },
    canResume: run => run.desktopMonitor?.phase === 'sent',
    resume(task, run) {
      resumes++;
      assert.equal(run.threadId, 'original-chat');
      assert.equal(run.desktopMonitor.conversationRequestId, 'original-request');
      return { completion: new Promise(() => {}) };
    },
    recoveryState: async () => 'running',
  };
  const providers = new Map([['workbuddyDesktop', provider]]);
  const f = fixture(t, true, providers);
  const task = await f.scheduler.saveTask({ ...f.draft, provider: 'workbuddyDesktop' });
  await f.scheduler.tick();
  const original = f.scheduler.active.run;
  f.store.data.fileLeases.push({ id: 'legacy', owner: original.id, runId: original.id, paths: ['.'], state: 'held' });
  f.scheduler.stop();
  const store = new Store(f.store.file);
  const restarted = new Scheduler(store, f.client, { providers });
  const supervision = new Supervision(store, restarted);
  t.after(() => restarted.stop());
  await restarted.tick();
  assert.equal(starts, 1);
  assert.equal(resumes, 1);
  assert.equal(restarted.active.run.id, original.id);
  assert.equal(restarted.active.run.taskId, task.id);
  assert.equal(supervision.snapshot().leases.length, 0);
  restarted.activeRuns.clear();
  const recoveredRun = store.data.runs.find(run => run.id === original.id);
  recoveredRun.status = 'uncertain';
  await restarted.resumeDesktopMonitor(original.id);
  assert.equal(resumes, 2);
  assert.equal(starts, 1);
  assert.equal(supervision.snapshot().leases.length, 0);
});
