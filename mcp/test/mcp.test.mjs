import test from 'node:test';
import assert from 'node:assert/strict';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';
import { createServer, instructions } from '../server.mjs';
import { BackendGateway, launchBackend } from '../backend.mjs';
import { EventEmitter } from 'node:events';

async function fixture(t, operation = async () => ({ ok: true }), options = {}) {
  const calls = [], gateway = { async request(...args) { calls.push(args); return operation(...args); } };
  const server = createServer({ gateway, ...options }), client = new Client({ name: 'test', version: '1' });
  const [a, b] = InMemoryTransport.createLinkedPair();
  await server.connect(b); await client.connect(a);
  t.after(async () => { await client.close(); await server.close(); });
  return { client, calls, call: (name, args = {}) => client.callTool({ name, arguments: args }) };
}
const result = r => JSON.parse(r.content[0].text);

test('MCP initialize, tools, workflow resource and prompt expose supervision rules', async t => {
  const f = await fixture(t), tools = (await f.client.listTools()).tools;
  assert.equal(tools.length, 17);
  assert.equal(f.client.getInstructions(), instructions);
  assert.match(instructions.slice(0, 512), /不能扩大授权/);
  assert.equal(tools.find(t => t.name === 'get_evidence').annotations.readOnlyHint, true);
  assert.equal(tools.find(t => t.name === 'refresh_evidence').annotations.readOnlyHint, false);
  assert.equal(tools.find(t => t.name === 'dispatch_mission').annotations.idempotentHint, true);
  assert.equal((await f.client.readResource({ uri: 'agentdesk://workflow' })).contents[0].text, instructions);
  const prompt = await f.client.getPrompt({ name: 'supervise_task', arguments: { objective: '修复配置', cwd: 'E:\\example' } });
  assert.match(prompt.messages[0].content.text, /修复配置/);
  assert.equal(f.calls.length, 0);
});

test('strict MCP schemas reject invalid id, missing dedupe id and unknown arguments before HTTP', async t => {
  const f = await fixture(t);
  for (const [name, args] of [
    ['get_mission', { missionId: '../elsewhere' }],
    ['dispatch_mission', { missionId: 'mission-1' }],
    ['dispatch_mission', { missionId: 'mission-1', requestId: 'a', at: '2026-12-01T20:00:00' }],
    ['status', { command: 'arbitrary' }],
    ['release_lease', { leaseId: 'lease-1', reason: 'checked', confirmedIdle: false }],
  ]) assert.equal((await f.call(name, args)).isError, true, name);
  assert.equal(f.calls.length, 0);
});

test('mission creation preserves fixed criteria and does not dispatch', async t => {
  const f = await fixture(t);
  const input = { title: '配置任务', provider: 'workbuddyDesktop', cwd: 'E:\\example', objective: '修复配置读取',
    constraints: ['保持兼容'], writePaths: ['src/config'], artifacts: ['src/config/index.mjs'],
    criteria: [{ id: 'quality', type: 'manual', description: '保持接口兼容' },
      { id: 'tests', type: 'command', description: '测试通过', command: 'node', args: ['--test', 'test/config.mjs'] }],
    threadId: 'native-session', maxCorrections: 2, autoCorrect: false };
  await f.call('create_mission', input);
  assert.deepEqual(f.calls, [['supervision/missions', 'POST', input]]);
  const bad = await f.call('create_mission', { ...input, criteria: [{ ...input.criteria[0], random: true }] });
  assert.equal(bad.isError, true); assert.equal(f.calls.length, 1);
});

test('session lookup encodes literal cwd and desktop provider', async t => {
  const f = await fixture(t);
  await f.call('list_sessions', { provider: 'antigravityDesktop', cwd: 'E:\\folder&other=value' });
  const query = new URLSearchParams(f.calls[0][0].split('?')[1]);
  assert.deepEqual([...query], [['provider', 'antigravityDesktop'], ['cwd', 'E:\\folder&other=value']]);
});

test('every lifecycle mutation maps once to its authenticated HTTP operation', async t => {
  const f = await fixture(t);
  const cases = [
    ['bind_session', { missionId: 'm-1', threadId: 't-1' }, 'supervision/missions/m-1/bind', { threadId: 't-1' }],
    ['dispatch_mission', { missionId: 'm-1', requestId: 'initial-1', at: '2026-12-01T20:00:00+08:00' }, 'supervision/missions/m-1/dispatch', { requestId: 'initial-1', at: '2026-12-01T20:00:00+08:00' }],
    ['refresh_evidence', { missionId: 'm-1' }, 'supervision/missions/m-1/evidence', {}],
    ['review_mission', { missionId: 'm-1', evidenceId: 'e-1', decisions: [{ criterionId: 'quality', status: 'failed', reason: '缺少错误处理' }], reason: '需要纠偏' }, 'supervision/missions/m-1/review', { evidenceId: 'e-1', decisions: [{ criterionId: 'quality', status: 'failed', reason: '缺少错误处理' }], reason: '需要纠偏' }],
    ['correct_mission', { missionId: 'm-1', requestId: 'correction-1', feedback: '修复错误处理' }, 'supervision/missions/m-1/correct', { requestId: 'correction-1', feedback: '修复错误处理' }],
    ['pause_mission', { missionId: 'm-1', reason: '等待核实' }, 'supervision/missions/m-1/pause', { reason: '等待核实' }],
    ['resume_mission', { missionId: 'm-1' }, 'supervision/missions/m-1/resume', {}],
    ['interrupt_run', { runId: 'r-1' }, 'runs/r-1/interrupt', {}],
    ['release_lease', { leaseId: 'l-1', reason: '原会话已核实空闲', confirmedIdle: true }, 'supervision/leases/l-1/release', { reason: '原会话已核实空闲', confirmedIdle: true }],
  ];
  for (const [name, args, route, payload] of cases) {
    assert.notEqual((await f.call(name, args)).isError, true);
    assert.deepEqual(f.calls.at(-1), [route, 'POST', payload]);
  }
  assert.equal(f.calls.length, cases.length);
});

test('MCP reports uncertain mutation without automatic retry', async t => {
  const f = await fixture(t, async () => { throw new Error('connection lost after send'); });
  const r = await f.call('dispatch_mission', { missionId: 'm-1', requestId: 'initial-1' });
  assert.equal(r.isError, true); assert.match(result(r).recovery, /未自动重试/); assert.equal(f.calls.length, 1);
});

test('wait returns promptly for actual manual review and blocked scope states', async t => {
  for (const state of ['review_pending', 'blocked']) {
    const f = await fixture(t, async () => ({ id: 'm-1', title: 'Task', state, updatedAt: 12, instructions: [], reviews: [] }));
    const r = result(await f.call('wait_for_mission', { missionId: 'm-1' }));
    assert.equal(r.timedOut, false); assert.equal(r.mission.state, state); assert.equal(f.calls.length, 1);
  }
});

test('wait is bounded and observes a transition without running checks', async t => {
  let time = 0;
  const f = await fixture(t, async () => ({ id: 'm-1', state: 'running', updatedAt: 12, instructions: [], reviews: [] }),
    { now: () => time, sleep: async n => { time += n; } });
  const r = result(await f.call('wait_for_mission', { missionId: 'm-1', waitSeconds: 2, pollSeconds: 1 }));
  assert.equal(r.timedOut, true); assert.equal(time, 2000); assert.equal(f.calls.length, 3);
  assert.ok(f.calls.every(c => c[0] === 'supervision/missions/m-1' && c.length === 1));
  const changed = result(await f.call('wait_for_mission', { missionId: 'm-1', afterState: 'scheduled' }));
  assert.equal(changed.timedOut, false);
});

test('gateway rejects non-local endpoints and wrong project roots', async () => {
  assert.throws(() => new BackendGateway({ base: 'http://example.com' }), /本机后台/);
  let sent = false;
  const g = new BackendGateway({ root: '/expected', autoStart: true,
    clientFactory: () => ({ async connect() { return { root: '/other' }; }, async request() { sent = true; } }) });
  await assert.rejects(g.request('state'), /另一份/); assert.equal(sent, false);
});

test('gateway starts missing backend once for simultaneous tools and reauthenticates', async () => {
  let online = false, launches = 0, connects = 0;
  const g = new BackendGateway({ root: '/expected', autoStart: true,
    launcher: async () => { launches++; await new Promise(r => setTimeout(r, 5)); online = true; },
    clientFactory: () => ({ async connect() { connects++; if (!online) throw Object.assign(new Error('refused'), { cause: { code: 'ECONNREFUSED' } }); return { root: '/expected' }; }, async request() { return { ok: true }; } }) });
  await Promise.all([g.request('state'), g.request('supervision')]);
  assert.equal(launches, 1); assert.equal(connects, 4);
  await g.request('state'); assert.equal(connects, 5);
});

test('gateway does not launch on auth failure or retry already sent mutations', async () => {
  let launches = 0, mutations = 0;
  const g = new BackendGateway({ root: '/expected', autoStart: true, launcher: async () => { launches++; },
    clientFactory: () => ({ async connect() { throw new Error('auth failed'); } }) });
  await assert.rejects(g.request('state'), /auth failed/); assert.equal(launches, 0);
  const sent = new BackendGateway({ root: '/expected', autoStart: true, launcher: async () => { launches++; },
    clientFactory: () => ({ async connect() { return { root: '/expected' }; }, async request() { mutations++; throw Object.assign(new Error('lost'), { code: 'ECONNREFUSED' }); } }) });
  await assert.rejects(sent.request('supervision/missions/m-1/dispatch', 'POST', {}), /lost/);
  assert.equal(mutations, 1); assert.equal(launches, 0);
});

test('launcher uses hidden literal Node invocation and does not open browser', async () => {
  let invocation;
  await launchBackend('http://127.0.0.1:43129', { root: '/project', spawnProcess: (...args) => {
    invocation = args; const child = new EventEmitter(); queueMicrotask(() => child.emit('close', 0)); return child;
  } });
  assert.equal(invocation[0], process.execPath);
  assert.equal(invocation[1].at(-1), '--no-browser');
  assert.equal(invocation[2].windowsHide, true); assert.equal(invocation[2].shell, false);
  assert.equal(invocation[2].env.CODEX_SCHEDULER_PORT, '43129');
});
