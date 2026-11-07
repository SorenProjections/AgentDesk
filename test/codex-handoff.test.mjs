import test from 'node:test';
import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import { mkdirSync, mkdtempSync } from 'node:fs';
import path from 'node:path';
import { Scheduler } from '../lib/scheduler.mjs';
import { CodexClient } from '../lib/codex.mjs';
import { Store } from '../lib/store.mjs';
import { codexRoutes } from '../lib/codex-routes.mjs';
import { elicitationResponse } from '../lib/codex-elicitation.mjs';

const flush = () => new Promise(resolve => setImmediate(resolve));
class Client extends EventEmitter {
  constructor() { super(); this.connected = true; this.defaults = {}; this.calls = []; this.loaded = new Map(); this.next = 0; this.responses = []; }
  async connect() {}
  releaseThread = CodexClient.prototype.releaseThread;
  async request(method, params = {}) {
    this.calls.push({ method, params });
    if (method === 'thread/start') {
      const thread = { id: 'chat-' + ++this.next, cwd: params.cwd, status: { type: 'idle' } };
      this.loaded.set(thread.id, thread); return { thread };
    }
    if (method === 'thread/read' || method === 'thread/resume') return { thread: this.loaded.get(params.threadId) || this.persisted };
    if (method === 'thread/name/set') { this.loaded.get(params.threadId).name = params.name; return {}; }
    if (method === 'turn/start') return { turn: { id: 'turn-' + params.threadId } };
    if (method === 'turn/interrupt') { if (!this.noStopEvent) setImmediate(() => this.complete(params.threadId, 'interrupted')); return {}; }
    if (method === 'thread/unsubscribe') {
      if (this.releaseError) throw new Error('fixture release failed');
      if (this.releaseGate) await this.releaseGate;
      this.persisted = this.loaded.get(params.threadId);
      this.loaded.delete(params.threadId); return { status: 'unsubscribed' };
    }
    if (method === 'thread/loaded/list') return { data: [...this.loaded.keys()] };
    return {};
  }
  complete(threadId, status = 'completed') { this.emit('notification', { method: 'turn/completed', params: { threadId, turn: { id: 'turn-' + threadId, status } } }); }
  respond(id, result) { this.responses.push({ id, result }); }
  rejectRequest(id, message) { this.responses.push({ id, error: message }); }
}
async function fixture(t) {
  const base = path.resolve('work/codex-handoff-tests'); mkdirSync(base, { recursive: true });
  const cwd = mkdtempSync(path.join(base, 'case-')), store = new Store(path.join(cwd, 'tasks.json')), client = new Client();
  const scheduler = new Scheduler(store, client); t.after(() => scheduler.stop());
  const task = await scheduler.saveTask({ provider: 'codex', title: 'Named scheduled task', cwd, threadMode: 'new', prompt: 'Fixture only', trigger: { type: 'queue' }, times: [] });
  return { scheduler, client, task, store };
}

for (const status of ['completed', 'failed', 'interrupted']) test(`Codex ${status} releases the native conversation without changing its recorded outcome`, async t => {
  const { scheduler, client, task } = await fixture(t);
  const run = await scheduler.runNow(task.id);
  assert.equal(client.loaded.get(run.threadId).name, task.title);
  client.complete(run.threadId, status); await flush();
  assert.equal(run.status, status); assert.equal(run.codexThreadState, 'released');
  assert.equal(client.loaded.has(run.threadId), false);
  assert.equal(client.calls.filter(call => call.method === 'turn/start').length, 1);
});

test('handoff waits for the exact stopped turn and releases only that chat, pauses repetitions, and never resends', async t => {
  const { scheduler, client, task } = await fixture(t);
  const run = await scheduler.runNow(task.id);
  client.loaded.set('unrelated-chat', { id: 'unrelated-chat' });
  client.noStopEvent = true;
  await assert.rejects(scheduler.handoffCodex(run.id), /确认停止/);
  assert.equal(task.paused, false);
  const handingOff = scheduler.handoffCodex(run.id, { interrupt: true });
  await flush();
  assert.equal(task.paused, true); assert.equal(run.status, 'running');
  assert.equal(client.calls.some(call => call.method === 'thread/unsubscribe'), false);
  client.emit('notification', { method: 'turn/completed', params: { threadId: run.threadId, turn: { id: 'older-turn', status: 'interrupted' } } });
  await flush(); assert.equal(run.status, 'running');
  client.complete(run.threadId, 'interrupted');
  const result = await handingOff;
  assert.equal(run.codexThreadState, 'released'); assert.equal(run.status, 'interrupted');
  assert.equal(result.url, 'codex://threads/' + run.threadId);
  assert.equal(client.loaded.has('unrelated-chat'), true);
  assert.equal(client.calls.filter(call => call.method === 'turn/start').length, 1);
  assert.equal(scheduler.requests.size, 0);
});

test('a missing stop confirmation keeps ownership and reports failure instead of handing off', async t => {
  const { scheduler, client, task } = await fixture(t);
  const run = await scheduler.runNow(task.id); client.noStopEvent = true;
  await assert.rejects(scheduler.handoffCodex(run.id, { interrupt: true, timeout: 15 }), /尚未收到/);
  assert.equal(run.status, 'running'); assert.equal(run.codexHandedOffAt, undefined);
  assert.equal(client.calls.some(call => call.method === 'thread/unsubscribe'), false);
  client.complete(run.threadId); await flush();
});

test('release failure remains visible and an explicit retry can finish handoff', async t => {
  const { scheduler, client, task } = await fixture(t);
  const run = await scheduler.runNow(task.id); client.releaseError = true;
  client.complete(run.threadId); await flush();
  assert.equal(run.status, 'completed'); assert.equal(run.codexThreadState, 'releaseFailed');
  await assert.rejects(scheduler.handoffCodex(run.id), /fixture release failed/);
  assert.equal(run.codexHandedOffAt, undefined);
  client.releaseError = false;
  await scheduler.handoffCodex(run.id);
  assert.equal(run.codexThreadState, 'released'); assert.ok(run.codexHandedOffAt);
});

test('the next turn waits until the previous connection has been released', async t => {
  const { scheduler, client, task } = await fixture(t);
  task.threadMode = 'reuse';
  task.threadMode = 'reuse';
  const run = await scheduler.runNow(task.id);
  let release; client.releaseGate = new Promise(resolve => release = resolve);
  client.complete(run.threadId);
  task.trigger.state = 'pending';
  const next = scheduler.runNow(task.id); await flush();
  assert.equal(client.calls.filter(call => call.method === 'turn/start').length, 1);
  release(); const nextRun = await next;
  assert.equal(client.calls.filter(call => call.method === 'turn/start').length, 2);
  assert.equal(nextRun.threadId, run.threadId);
  client.complete(run.threadId); await flush();
});

test('connection loss remains uncertain and never claims successful handoff', async t => {
  const { scheduler, client, task } = await fixture(t);
  const run = await scheduler.runNow(task.id);
  client.connected = false; client.emit('disconnected', 'fixture offline');
  assert.equal(run.status, 'uncertain');
  await assert.rejects(scheduler.handoffCodex(run.id), /尚未确认/);
  assert.equal(client.calls.some(call => call.method === 'thread/unsubscribe'), false);
});

test('Codex release verifies actual unload and does not reconnect a disconnected server', async () => {
  const client = new Client(); client.connected = false;
  await assert.rejects(client.releaseThread('chat'), /已断开/);
  assert.equal(client.calls.length, 0);
  client.connected = true;
  client.request = async method => method === 'thread/unsubscribe' ? { status: 'unsubscribed' } : { data: ['chat'] };
  await assert.rejects(client.releaseThread('chat', { timeout: 1 }), /仍在释放/);
});

test('MCP confirmation is displayed until a human submits validated form data or declines', async t => {
  const { scheduler, client, task } = await fixture(t);
  const run = await scheduler.runNow(task.id);
  const params = { threadId: run.threadId, turnId: run.turnId, mode: 'form', serverName: 'fixture-mcp', message: 'Confirm fixture access', requestedSchema: { type: 'object', properties: { allow: { type: 'boolean' }, count: { type: 'integer', minimum: 1 } }, required: ['allow', 'count'] } };
  client.emit('request', { id: 'mcp-1', method: 'mcpServer/elicitation/request', params });
  assert.equal(run.status, 'waiting'); assert.equal(client.responses.length, 0);
  const request = scheduler.snapshot().requests[0];
  assert.throws(() => scheduler.respond(request.id, { decision: 'accept', content: { allow: false, count: 0 } }), /count/);
  assert.equal(scheduler.requests.size, 1); assert.equal(client.responses.length, 0);
  scheduler.respond(request.id, { decision: 'accept', content: { allow: false, count: 2, extra: 'ignored' } });
  assert.deepEqual(client.responses[0].result, { action: 'accept', content: { allow: false, count: 2 }, _meta: null });
  client.emit('request', { id: 'mcp-2', method: 'mcpServer/elicitation/request', params });
  scheduler.respond(scheduler.snapshot().requests[0].id, { decision: 'decline' });
  assert.deepEqual(client.responses[1].result, { action: 'decline', content: null, _meta: null });
  client.complete(run.threadId); await flush();
});

test('elicitation validation preserves required fields, finite numbers, enum constraints and cancellation', () => {
  const params = { mode: 'form', requestedSchema: { type: 'object', properties: { choice: { type: 'string', oneOf: [{ const: 'a' }] }, names: { type: 'array', items: { enum: ['one'] }, minItems: 1 } }, required: ['choice'] } };
  assert.throws(() => elicitationResponse(params, { decision: 'accept', content: {} }), /choice/);
  assert.throws(() => elicitationResponse(params, { decision: 'accept', content: { choice: 'other' } }), /choice/);
  assert.throws(() => elicitationResponse(params, { decision: 'accept', content: { choice: 'a', names: ['wrong'] } }), /names/);
  assert.deepEqual(elicitationResponse(params, { decision: 'cancel' }), { action: 'cancel', content: null, _meta: null });
  assert.deepEqual(elicitationResponse({ mode: 'url' }, { decision: 'accept' }), { action: 'accept', content: null, _meta: null });
});

test('an approval that offers cancel instead of decline receives a valid cancellation', async t => {
  const { scheduler, client, task } = await fixture(t);
  const run = await scheduler.runNow(task.id);
  client.emit('request', { id: 'command', method: 'item/commandExecution/requestApproval', params: { threadId: run.threadId, turnId: run.turnId, availableDecisions: ['accept', 'cancel'] } });
  scheduler.respond(scheduler.snapshot().requests[0].id, { decision: 'decline' });
  assert.deepEqual(client.responses[0].result, { decision: 'cancel' });
  client.complete(run.threadId); await flush();
});

test('handoff route requires an explicit interrupt flag and returns only the original conversation', async () => {
  let called; const context = { body: async () => ({ interrupt: 'true' }), scheduler: { handoffCodex: async (...args) => { called = args; return { url: 'codex://threads/original' }; } }, send: (_res, status, body) => { assert.equal(status, 200); assert.equal(body.url, 'codex://threads/original'); } };
  assert.equal(await codexRoutes({ method: 'GET' }, {}, new URL('http://localhost/api/runs/run-id/handoff-codex'), context), false);
  assert.equal(await codexRoutes({ method: 'POST' }, {}, new URL('http://localhost/api/runs/run-id/handoff-codex'), context), true);
  assert.deepEqual(called, ['run-id', { interrupt: false }]);
});
