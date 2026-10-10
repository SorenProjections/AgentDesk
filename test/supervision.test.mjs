import test from 'node:test';
import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import { mkdtempSync, mkdirSync, writeFileSync, symlinkSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import http from 'node:http';
import { Store } from '../lib/store.mjs';
import { Scheduler } from '../lib/scheduler.mjs';
import { Supervision } from '../lib/supervision.mjs';
import { FileLeases, scopedPath } from '../lib/file-leases.mjs';
import { artifact, runCommand, manifest } from '../lib/evidence.mjs';
import { ControlClient } from '../lib/control-client.mjs';
import { supervisionRoutes } from '../lib/supervision-routes.mjs';
const scratch = path.resolve(process.env.CODEX_SCHEDULER_TEST_DATA || path.join(path.dirname(fileURLToPath(import.meta.url)), '../work/supervision-tests'));
mkdirSync(scratch, { recursive: true });

class Client extends EventEmitter {
  constructor(folder) { super(); this.folder = folder; this.connected = true; this.defaults = {}; this.calls = []; this.turn = 0; }
  async connect() {}
  async request(method, p) {
    this.calls.push({ method, p });
    if (method.startsWith('thread/')) return { thread: { id: p.threadId || 'mock-session', cwd: this.folder, status: { type: 'idle' } } };
    if (method === 'turn/start') return { turn: { id: 'turn-' + ++this.turn } };
    return {};
  }
  complete(status = 'completed') {
    this.emit('notification', { method: 'item/completed', params: { threadId: 'mock-session', turnId: 'turn-' + this.turn, item: { type: 'agentMessage', text: 'Actual result' } } });
    this.emit('notification', { method: 'turn/completed', params: { threadId: 'mock-session', turn: { id: 'turn-' + this.turn, status } } });
  }
}
function fixture(t, options = {}) {
  const folder = mkdtempSync(path.join(scratch, 'case-'));
  const store = new Store(path.join(folder, 'data', 'tasks.json'));
  const client = new Client(folder), scheduler = new Scheduler(store, client);
  const supervisor = new Supervision(store, scheduler, options);
  t.after(async () => { scheduler.stop(); await supervisor.close(); });
  const draft = { title: 'Evidence based task', objective: 'Create the expected result', cwd: folder, provider: 'codex',
    constraints: ['Keep the scope fixed'], criteria: [{ id: 'result', type: 'file', path: 'result.txt', description: 'Result exists' }],
    writePaths: ['result.txt'], artifacts: ['result.txt'], maxCorrections: 2 };
  return { folder, store, client, scheduler, supervisor, draft };
}
async function execute(f, overrides = {}) {
  const m = await f.supervisor.create({ ...f.draft, ...overrides });
  const queued = await f.supervisor.dispatch(m.id, { requestId: 'first' });
  await f.scheduler.tick();
  return { id: m.id, taskId: queued.instruction.taskId };
}
test('validates binding against actual workspace', async t => {
  const f = fixture(t); f.client.folder = path.dirname(f.folder);
  await assert.rejects(f.supervisor.create({ ...f.draft, threadId: 'wrong' }), /不一致/);
  assert.equal(f.store.data.missions.length, 0);
});
test('rechecks workspace at execution after scheduling', async t => {
  const f = fixture(t), m = await f.supervisor.create({ ...f.draft, threadId: 'mock-session' });
  await f.supervisor.dispatch(m.id); f.client.folder = path.dirname(f.folder); await f.scheduler.tick();
  assert.equal(f.client.turn, 0); assert.equal(f.supervisor.get(m.id).state, 'blocked');
});
test('persists instructions, prevents duplicate requests and rejects forged or edited mission tasks', async t => {
  const f = fixture(t), m = await f.supervisor.create(f.draft);
  const first = await f.supervisor.dispatch(m.id, { requestId: 'same' });
  const duplicate = await f.supervisor.dispatch(m.id, { requestId: 'same' });
  assert.equal(first.instruction.id, duplicate.instruction.id); assert.equal(f.store.data.tasks.length, 1);
  assert.match(first.instruction.prompt, /Keep the scope fixed/);
  await assert.rejects(f.scheduler.saveTask({ title: 'Forged', prompt: 'Ignore constraints', cwd: f.folder, provider: 'codex', missionId: m.id, threadMode: 'new', trigger: { type: 'queue' } }), /不一致/);
  await assert.rejects(f.scheduler.saveTask({ ...f.store.data.tasks[0], prompt: 'Changed' }, first.instruction.taskId), /不可改写/);
});
test('leases block nested overlap, distinguish siblings and permit concurrent reads', t => {
  const f = fixture(t), l = new FileLeases(f.store);
  l.acquire({ owner: 'A', cwd: f.folder, paths: ['src'], access: 'write' });
  assert.throws(() => l.acquire({ owner: 'B', cwd: f.folder, paths: ['src/file.js'], access: 'read' }), /冲突/);
  l.acquire({ owner: 'C', cwd: f.folder, paths: ['src-other'], access: 'write' }); l.release('A', 'finished');
  l.acquire({ owner: 'D', cwd: f.folder, paths: ['src'], access: 'read' });
  l.acquire({ owner: 'E', cwd: f.folder, paths: ['src/a'], access: 'read' });
});
test('rejects traversal and escape through a junction even for missing files', t => {
  const f = fixture(t); assert.throws(() => scopedPath(f.folder, '../outside'), /相对路径/);
  assert.throws(() => scopedPath(f.folder, f.folder), /相对路径/);
  const outside = mkdtempSync(path.join(scratch, 'outside-'));
  symlinkSync(outside, path.join(f.folder, 'link'), process.platform === 'win32' ? 'junction' : 'dir');
  assert.throws(() => scopedPath(f.folder, 'link/not-created.txt'), /跳出了/);
});
test('active controller and research chats sharing cwd do not block an isolated task', async t => {
  const f = fixture(t, { sessionRows: () => [{ provider: 'workbuddyDesktop', nativeId: 'external', cwd: f.folder, status: 'running', name: 'Native task' }] });
  const m = await f.supervisor.create(f.draft);
  const queued = await f.supervisor.dispatch(m.id);
  assert.equal(f.supervisor.blocker(f.scheduler.getTask(queued.instruction.taskId)), null);
  await f.scheduler.tick(); assert.equal(f.client.turn, 1); assert.equal(f.store.data.runs.length, 1);
  assert.equal(f.supervisor.get(m.id).sharedWorkspaceActivity[0].threadId, 'external');
});
test('explicit overlapping leases still block while sibling task directories share cwd', async t => {
  const f = fixture(t, { sessionRows: () => [{ provider: 'workbuddyDesktop', nativeId: 'external', cwd: f.folder, status: 'running' }] });
  f.supervisor.leases.acquire({ owner: 'other-mission', provider: 'workbuddyDesktop', threadId: 'external', cwd: f.folder,
    paths: ['research_runs/other'], access: 'write' });
  assert.deepEqual(f.supervisor.checkConflicts('mine', f.folder, ['research_runs/mine'], 'write', 'codex', null), []);
  assert.throws(() => f.supervisor.checkConflicts('mine', f.folder, ['research_runs/other/file.csv'], 'write', 'codex', null), /文件占用冲突/);
});
test('busy target session still waits even though other active chats are advisory', async t => {
  const f = fixture(t, { sessionRows: () => [{ provider: 'codex', nativeId: 'mock-session', cwd: f.folder, status: 'running' }] });
  const m = await f.supervisor.create({ ...f.draft, threadId: 'mock-session' });
  const queued = await f.supervisor.dispatch(m.id);
  assert.match(f.supervisor.blocker(f.scheduler.getTask(queued.instruction.taskId)), /目标会话仍在运行/);
  await f.scheduler.tick(); assert.equal(f.client.turn, 0);
});
test('desktop probing at startup waits without claiming or failing an instruction', async t => {
  const f = fixture(t); let available = false;
  f.scheduler.providers.set('workbuddyDesktop', { snapshot: () => ({ available }) });
  const m = await f.supervisor.create({ ...f.draft, provider: 'workbuddyDesktop' });
  const queued = await f.supervisor.dispatch(m.id);
  assert.match(f.supervisor.blocker(f.scheduler.getTask(queued.instruction.taskId)), /等待目标桌面连接就绪/);
  await f.scheduler.tick(); assert.equal(f.store.data.runs.length, 0); assert.equal(f.supervisor.get(m.id).state, 'scheduled');
  available = true; assert.equal(f.supervisor.blocker(f.scheduler.getTask(queued.instruction.taskId)), null);
  assert.equal(f.supervisor.get(m.id).instructions.length, 1);
});
test('independent research output changes do not contaminate evidence or stale its review', async t => {
  const f = fixture(t);
  mkdirSync(path.join(f.folder, 'research_runs', 'mine'), { recursive: true });
  mkdirSync(path.join(f.folder, 'research_runs', 'other'), { recursive: true });
  writeFileSync(path.join(f.folder, 'research_runs', 'other', 'results.csv'), 'old');
  const own = 'research_runs/mine/report.md';
  const { id } = await execute(f, { writePaths: ['research_runs/mine'], artifacts: [own], criteria: [
    { id: 'report', type: 'file', path: own, description: 'Report exists' },
    { id: 'quality', type: 'manual', description: 'Review own results' }
  ] });
  writeFileSync(path.join(f.folder, own), 'Own actual result');
  writeFileSync(path.join(f.folder, 'research_runs', 'other', 'results.csv'), 'other research update');
  f.client.complete(); const packet = await f.supervisor.evidence(id);
  assert.deepEqual(packet.changes.map(c => c.path), [own]); assert.deepEqual(packet.outOfScopeChanges, []);
  assert.equal(packet.unattributedChanges[0].path, 'research_runs/other/results.csv');
  assert.equal(f.supervisor.get(id).state, 'review_pending');
  writeFileSync(path.join(f.folder, 'research_runs', 'other', 'results.csv'), 'later other update');
  await f.supervisor.review(id, { evidenceId: packet.id, reason: 'Reviewed own report',
    decisions: [{ criterionId: 'quality', status: 'passed', reason: 'Report evidence meets criteria' }] });
  assert.equal(f.supervisor.get(id).state, 'accepted');
});
test('an incomplete scan in another research directory does not invalidate scoped acceptance', async t => {
  const f = fixture(t), outside = mkdtempSync(path.join(scratch, 'elsewhere-'));
  symlinkSync(outside, path.join(f.folder, 'other-research-link'), process.platform === 'win32' ? 'junction' : 'dir');
  const { id } = await execute(f);
  writeFileSync(path.join(f.folder, 'result.txt'), 'Expected'); f.client.complete();
  const packet = await f.supervisor.evidence(id);
  assert.equal(packet.workspaceScanComplete, false); assert.equal(packet.scanComplete, true);
  assert.equal(packet.baselineComplete, true); assert.equal(f.supervisor.get(id).state, 'accepted');
});
test('historical full-workspace baseline is projected without inventing outside deletions', async t => {
  const f = fixture(t);
  writeFileSync(path.join(f.folder, 'unrelated.txt'), 'Existing');
  const { id } = await execute(f);
  f.supervisor.get(id).baseline = manifest(f.folder, ['.']);
  writeFileSync(path.join(f.folder, 'result.txt'), 'Expected');
  const observed = await f.supervisor.observe(id);
  assert.deepEqual(observed.changes.map(c => c.path), ['result.txt']);
  f.client.complete(); const packet = await f.supervisor.evidence(id);
  assert.deepEqual(packet.changes.map(c => c.path), ['result.txt']);
});
test('collects actual changes, binds created session and releases after acceptance', async t => {
  const f = fixture(t), { id } = await execute(f);
  writeFileSync(path.join(f.folder, 'result.txt'), 'Evidence'); f.client.complete();
  const packet = await f.supervisor.evidence(id);
  assert.equal(f.supervisor.get(id).state, 'accepted'); assert.equal(packet.changes[0].kind, 'added');
  assert.equal(packet.artifacts[0].text, 'Evidence'); assert.equal(packet.execution.threadId, 'mock-session');
  assert.equal(f.supervisor.snapshot().leases.length, 0);
  await assert.rejects(f.scheduler.runNow(f.store.data.tasks[0].id), /待发送/);
});
test('manual acceptance holds the lease and requires a fresh evidence identifier', async t => {
  const f = fixture(t), { id } = await execute(f, { criteria: [{ id: 'quality', type: 'manual', description: 'Economic rationale is sound' }] });
  writeFileSync(path.join(f.folder, 'result.txt'), 'Evidence'); f.client.complete();
  const packet = await f.supervisor.evidence(id);
  assert.equal(f.supervisor.get(id).state, 'review_pending'); assert.equal(f.supervisor.snapshot().leases.length, 1);
  await assert.rejects(f.supervisor.review(id, { evidenceId: 'old', decisions: [{ criterionId: 'quality', status: 'passed', reason: 'Verified' }] }), /证据已变化/);
  await f.supervisor.review(id, { evidenceId: packet.id, decisions: [{ criterionId: 'quality', status: 'passed', reason: 'Reviewed actual file and logic' }] });
  assert.equal(f.supervisor.get(id).state, 'accepted');
});
test('dependencies require quality acceptance in addition to execution completion', async t => {
  const f = fixture(t), { id, taskId } = await execute(f, { criteria: [{ id: 'quality', type: 'manual', description: 'Review quality' }] });
  const next = await f.scheduler.saveTask({ title: 'Next stage', cwd: f.folder, threadMode: 'new', prompt: 'Next', trigger: { type: 'afterTask', taskId } });
  f.client.complete(); const packet = await f.supervisor.evidence(id);
  assert.equal(f.scheduler.readiness(next).status, 'blocked');
  await f.supervisor.review(id, { evidenceId: packet.id, decisions: [{ criterionId: 'quality', status: 'passed', reason: 'Confirmed' }] });
  assert.equal(f.scheduler.readiness(next).status, 'ready');
});
test('automatic correction preserves scope, reuses session and stops at limit', async t => {
  const f = fixture(t), { id } = await execute(f, { autoCorrect: true, maxCorrections: 1 });
  f.client.complete(); await f.supervisor.evidence(id); const m = f.supervisor.get(id);
  assert.equal(m.state, 'correction_pending'); assert.equal(m.corrections, 1); assert.equal(m.instructions.length, 2);
  assert.match(m.instructions[1].prompt, /Keep the scope fixed/);
  await f.scheduler.tick(); assert.equal(f.store.data.runs[1].threadId, 'mock-session');
  f.client.complete(); await f.supervisor.evidence(id);
  assert.equal(m.state, 'exhausted'); assert.equal(m.instructions.length, 2); assert.equal(f.supervisor.snapshot().leases.length, 1);
});
test('uncertain execution keeps its lease and is not automatically resent', async t => {
  const f = fixture(t), { id } = await execute(f, { autoCorrect: true });
  f.client.emit('disconnected', 'Lost transport');
  assert.equal(f.supervisor.get(id).state, 'uncertain'); assert.equal(f.supervisor.snapshot().leases.length, 1);
  await f.scheduler.tick(); assert.equal(f.client.turn, 1); await assert.rejects(f.supervisor.evidence(id), /尚无/);
});
test('restart preserves uncertain ownership and sent history without replay', async t => {
  const f = fixture(t), { id } = await execute(f); f.scheduler.stop();
  const store = new Store(f.store.file), client = new Client(f.folder), scheduler = new Scheduler(store, client);
  const restored = new Supervision(store, scheduler);
  t.after(async () => { scheduler.stop(); await restored.close(); });
  assert.equal(restored.get(id).state, 'uncertain'); assert.equal(restored.get(id).instructions.length, 1);
  assert.equal(restored.snapshot().leases.length, 1); await scheduler.tick(); assert.equal(client.turn, 0);
});
test('detects selected artifact writes outside declared write scope despite a passing criterion', async t => {
  const f = fixture(t), { id } = await execute(f, { artifacts: ['result.txt', 'outside.txt'] });
  writeFileSync(path.join(f.folder, 'result.txt'), 'OK'); writeFileSync(path.join(f.folder, 'outside.txt'), 'Unauthorized');
  f.client.complete(); const packet = await f.supervisor.evidence(id);
  assert.equal(packet.outOfScopeChanges[0].path, 'outside.txt'); assert.equal(f.supervisor.get(id).state, 'blocked');
});
test('reservation and pause/resume preserve an unsent instruction', async t => {
  const f = fixture(t), m = await f.supervisor.create(f.draft);
  await f.supervisor.dispatch(m.id, { at: Date.now() + 3600000 });
  await f.scheduler.tick(); assert.equal(f.client.turn, 0);
  await f.supervisor.pause(m.id, { reason: 'Reschedule later' }); await f.scheduler.tick(); assert.equal(f.client.turn, 0);
  await f.supervisor.resume(m.id); assert.equal(f.supervisor.get(m.id).state, 'scheduled'); assert.equal(f.supervisor.get(m.id).instructions.length, 1);
});
test('reads explicit data artifacts while excluding secret files', t => {
  const f = fixture(t);
  mkdirSync(path.join(f.folder, 'data'), { recursive: true }); writeFileSync(path.join(f.folder, 'data', 'report.txt'), 'Report');
  writeFileSync(path.join(f.folder, '.env'), 'SECRET');
  assert.equal(artifact(f.folder, 'data/report.txt').text, 'Report'); assert.equal(artifact(f.folder, '.env').status, 'excluded');
});
test('test execution uses literal arguments and enforces timeouts', async t => {
  const f = fixture(t);
  const passed = await runCommand(process.execPath, ['-e', 'console.log(process.argv[1])', '$()&'], { cwd: f.folder });
  assert.equal(passed.exitCode, 0); assert.match(passed.output, /\$\(\)&/);
  const timedOut = await runCommand(process.execPath, ['-e', 'setInterval(()=>{},1000)'], { cwd: f.folder, timeoutMs: 150 });
  assert.equal(timedOut.timedOut, true);
});
test('HTTP routes share authentication; control client never retries lost mutations', async t => {
  const f = fixture(t);
  const server = http.createServer(async (req, res) => {
    const url = new URL(req.url, 'http://127.0.0.1');
    const send = (res, status, value) => { res.writeHead(status, { 'Content-Type': 'application/json' }); res.end(JSON.stringify(value)); };
    if (url.pathname === '/health') return send(res, 200, { type: 'codex-local-scheduler' });
    if (url.pathname === '/') { res.setHeader('Set-Cookie', 'scheduler_session=test-cookie; HttpOnly'); return send(res, 200, {}); }
    if (req.headers.cookie !== 'scheduler_session=test-cookie' || req.method === 'POST' && req.headers['x-scheduler-request'] !== '1') return send(res, 401, { error: 'Authentication required' });
    try {
      await supervisionRoutes(req, res, url, { supervision: f.supervisor, send, body: async req => { let raw = ''; for await (const chunk of req) raw += chunk; return JSON.parse(raw); } });
    } catch (error) { send(res, 400, { error: error.message }); }
  });
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve)); t.after(() => new Promise(resolve => server.close(resolve)));
  const client = new ControlClient({ base: 'http://127.0.0.1:' + server.address().port });
  const m = await client.request('supervision/missions', 'POST', f.draft);
  assert.equal(m.objective, f.draft.objective); assert.equal((await client.request('supervision')).missions.length, 1);
  assert.throws(() => new ControlClient({ base: 'http://example.com' }), /本机/);
  let calls = 0;
  const broken = new ControlClient({ fetcher: async () => { calls++; throw new Error('Lost response'); } }); broken.cookie = 'scheduler_session=known';
  await assert.rejects(broken.request('supervision/missions/' + m.id + '/dispatch', 'POST', {}), /Lost response/); assert.equal(calls, 1);
});
test('stage observations read real artifacts without running tests or completing a task', async t => {
  const f = fixture(t), { id } = await execute(f);
  writeFileSync(path.join(f.folder, 'result.txt'), 'In progress');
  const observed = await f.supervisor.observe(id);
  assert.equal(observed.state, 'running'); assert.equal(observed.artifacts[0].text, 'In progress');
  assert.equal(observed.changes[0].kind, 'added'); assert.equal(f.supervisor.get(id).reviews.length, 0);
  assert.equal(f.supervisor.snapshot().leases.length, 1);
});
test('changed artifacts cannot be accepted using a previously collected packet', async t => {
  const f = fixture(t), { id } = await execute(f, { criteria: [{ id: 'quality', type: 'manual', description: 'Review quality' }] });
  writeFileSync(path.join(f.folder, 'result.txt'), 'First'); f.client.complete();
  const packet = await f.supervisor.evidence(id);
  writeFileSync(path.join(f.folder, 'result.txt'), 'Changed afterwards');
  await assert.rejects(f.supervisor.review(id, { evidenceId: packet.id, decisions: [{ criterionId: 'quality', status: 'passed', reason: 'Earlier review' }] }), /发生变化/);
  assert.equal(f.supervisor.get(id).reviews[0].packet.checks[0].status, 'pending');
});
test('duplicate manual decisions are rejected before mutating stored checks', async t => {
  const f = fixture(t), { id } = await execute(f, { criteria: [{ id: 'quality', type: 'manual', description: 'Review quality' }] });
  f.client.complete(); const packet = await f.supervisor.evidence(id);
  await assert.rejects(f.supervisor.review(id, { evidenceId: packet.id, decisions: [
    { criterionId: 'quality', status: 'passed', reason: 'Yes' }, { criterionId: 'quality', status: 'failed', reason: 'No' }
  ] }), /重复/);
  assert.equal(f.supervisor.get(id).reviews[0].packet.checks[0].status, 'pending');
});
test('read-only violations block automatic correction instead of authorizing out-of-scope repairs', async t => {
  const f = fixture(t), { id } = await execute(f, { access: 'read', autoCorrect: true });
  writeFileSync(path.join(f.folder, 'result.txt'), 'Unexpected mutation'); f.client.complete();
  await f.supervisor.evidence(id);
  assert.equal(f.supervisor.get(id).state, 'blocked'); assert.equal(f.supervisor.get(id).instructions.length, 1);
});
test('actual failing command results cannot be overridden by a manual acceptance', async t => {
  const f = fixture(t), { id } = await execute(f, { criteria: [
    { id: 'test', type: 'command', command: process.execPath, args: ['-e', 'process.exit(2)'], description: 'Test succeeds' },
    { id: 'quality', type: 'manual', description: 'Review design' }
  ] });
  f.client.complete(); const packet = await f.supervisor.evidence(id);
  assert.equal(packet.checks[0].status, 'failed');
  await assert.rejects(f.supervisor.review(id, { evidenceId: packet.id, decisions: [{ criterionId: 'test', status: 'passed', reason: 'Ignore test' }] }), /不可审查/);
  assert.equal(f.supervisor.get(id).state, 'correction_needed');
});
test('incomplete scans keep their original limitations after an explicit acknowledgment', async t => {
  const f = fixture(t), { id } = await execute(f, { writePaths: ['.'], criteria: [{ id: 'quality', type: 'manual', description: 'Review quality' }] });
  mkdirSync(path.join(f.folder, 'sub'));
  symlinkSync(path.join(f.folder, 'sub'), path.join(f.folder, 'linked-sub'), process.platform === 'win32' ? 'junction' : 'dir');
  f.client.complete(); const packet = await f.supervisor.evidence(id);
  assert.equal(packet.scanComplete, false);
  await f.supervisor.review(id, { evidenceId: packet.id, confirmIncompleteScan: true, reason: 'Checked linked directory separately',
    decisions: [{ criterionId: 'quality', status: 'passed', reason: 'Reviewed' }] });
  assert.equal(f.supervisor.get(id).state, 'accepted'); assert.equal(packet.scanComplete, false);
});
test('file ownership survives JSON reload and cannot be released during execution', async t => {
  const f = fixture(t), { id } = await execute(f);
  const lease = f.supervisor.snapshot().leases[0];
  const restored = new FileLeases(new Store(f.store.file));
  assert.ok(restored.conflict('other', [path.join(f.folder, 'result.txt')], 'write'));
  await assert.rejects(f.supervisor.releaseLease(lease.id, { reason: 'Premature', confirmedIdle: true }), /仍在运行/);
  assert.equal(f.supervisor.get(id).state, 'running');
});
test('overlapping queued missions wait without failing or blocking the owner correction', async t => {
  const f = fixture(t);
  const a = await f.supervisor.create({ ...f.draft, autoCorrect: true, maxCorrections: 1 });
  await f.supervisor.dispatch(a.id);
  const b = await f.supervisor.create({ ...f.draft, title: 'Next overlapping mission' });
  const queuedB = await f.supervisor.dispatch(b.id);
  await f.scheduler.tick(); f.client.complete(); await f.supervisor.evidence(a.id);
  assert.equal(f.scheduler.readiness(f.scheduler.getTask(queuedB.instruction.taskId)).status, 'blocked');
  await f.scheduler.tick();
  assert.equal(f.store.data.runs.length, 2);
  assert.equal(f.store.data.runs[1].taskId, f.supervisor.get(a.id).instructions[1].taskId);
  assert.equal(f.store.data.settings.queuePaused, false);
  writeFileSync(path.join(f.folder, 'result.txt'), 'Fixed');
  f.client.complete(); await f.supervisor.evidence(a.id);
  assert.equal(f.scheduler.readiness(f.scheduler.getTask(queuedB.instruction.taskId)).status, 'ready');
});
test('duplicate pause requests preserve resume state and cannot rewrite accepted history', async t => {
  const f = fixture(t), m = await f.supervisor.create(f.draft);
  const queued = await f.supervisor.dispatch(m.id);
  await f.supervisor.pause(m.id, { reason: 'Pause' }); await f.supervisor.pause(m.id, { reason: 'Duplicate pause' });
  await f.supervisor.resume(m.id); assert.equal(f.supervisor.get(m.id).state, 'scheduled');
  await f.scheduler.runNow(queued.instruction.taskId);
  writeFileSync(path.join(f.folder, 'result.txt'), 'Done'); f.client.complete(); await f.supervisor.evidence(m.id);
  await assert.rejects(f.supervisor.pause(m.id, { reason: 'Wrong' }), /已验收/);
  assert.equal(f.supervisor.get(m.id).state, 'accepted');
});
