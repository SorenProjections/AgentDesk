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

test('session lookup encodes literal cwd and desktop provider', async t => {
  const f = await fixture(t);
  await f.call('list_sessions', { provider: 'antigravityDesktop', cwd: 'E:\\folder&other=value' });
  const query = new URLSearchParams(f.calls[0][0].split('?')[1]);
  assert.deepEqual([...query], [['provider', 'antigravityDesktop'], ['cwd', 'E:\\folder&other=value']]);
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
  await Promise.all([g.request('state'), g.request('state')]);
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
  await assert.rejects(sent.request('tasks/t-1/run', 'POST', {}), /lost/);
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
