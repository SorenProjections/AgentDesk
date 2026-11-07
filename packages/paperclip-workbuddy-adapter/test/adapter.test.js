import test from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { mkdir, mkdtemp, readFile, writeFile, rm } from 'node:fs/promises';
import path from 'node:path';
import { tmpdir } from 'node:os';
import { fileURLToPath } from 'node:url';
import { createServerAdapter } from '../src/index.js';
import { createParser } from '../src/parse.js';

const fake = fileURLToPath(new URL('./fake-cli.js', import.meta.url));
const adapter = createServerAdapter();
const cwd = path.dirname(fake);
function context(mode = 'identity', overrides = {}) {
  const logs = [], metas = [];
  const ctx = {
    runId: randomUUID(), agent: { id: 'agent-1', companyId: 'company-1', name: 'Worker', adapterType: 'workbuddy_local', adapterConfig: {} },
    runtime: { sessionId: null, sessionParams: null, sessionDisplayId: null, taskKey: 'task-1' },
    config: { cwd, cliPath: fake, configDir: cwd, timeoutSec: 5, env: { FAKE_MODE: mode } },
    context: { issueId: 'issue-1', paperclipTaskMarkdown: 'Task: 中文\n$(do-not-run) `literal`' },
    authToken: 'test-paperclip-token',
    onLog: async (stream, value) => { logs.push(value); }, onMeta: async value => { metas.push(value); },
    ...overrides,
  };
  return { ctx, logs, metas };
}

test('external factory exports a Paperclip-compatible adapter', () => {
  assert.equal(adapter.type, 'workbuddy_local'); assert.equal(adapter.supportsLocalAgentJwt, true);
  assert.equal(adapter.runtimeToolDelivery, 'environment'); assert.ok(adapter.getConfigSchema().fields.some(f => f.key === 'cliPath'));
});
test('executes a real subprocess with exact prompt, protected run identity and explicit config directory', async () => {
  const { ctx, metas } = context(); const result = await adapter.execute(ctx);
  assert.equal(result.exitCode, 0, JSON.stringify(result)); const received = JSON.parse(result.summary);
  assert.equal(received.agent, ctx.agent.id); assert.equal(received.company, ctx.agent.companyId);
  assert.equal(received.run, ctx.runId); assert.equal(received.task, 'issue-1'); assert.equal(received.tokenPresent, true);
  assert.ok(received.prompt.includes('$(do-not-run) `literal`')); assert.equal(received.configDir, cwd);
  assert.ok(received.args.includes('dontAsk')); assert.ok(!received.args.includes('--dangerously-skip-permissions'));
  assert.equal(metas[0].prompt, undefined); assert.equal(JSON.stringify(metas).includes(ctx.authToken), false);
});
test('resumes only a session from the same directory, config and CLI', async () => {
  const first = context(); const created = await adapter.execute(first.ctx);
  const next = context(); next.ctx.runtime.sessionParams = adapter.sessionCodec.deserialize(created.sessionParams);
  const resumed = await adapter.execute(next.ctx); assert.equal(resumed.exitCode, 0);
  assert.ok(JSON.parse(resumed.summary).args.includes('--resume'));
  for (const changed of ['cwd', 'configDir', 'command']) {
    const other = context(); other.ctx.runtime.sessionParams = { ...created.sessionParams, [changed]: 'another-directory' };
    const result = await adapter.execute(other.ctx); assert.equal(JSON.parse(result.summary).args.includes('--resume'), false);
  }
});
test('session codec preserves identity and does not serialize arbitrary metadata', () => {
  const value = { sessionId: 'test-session', cwd, configDir: cwd, command: fake, token: 'secret' };
  assert.equal(adapter.sessionCodec.serialize(value).token, undefined); assert.equal(adapter.sessionCodec.getDisplayId(value), 'test-session');
  assert.equal(adapter.sessionCodec.deserialize({ sessionId: 'test' }), null);
});
for (const mode of ['missing', 'nonzero', 'failure', 'denied', 'empty']) {
  test(`cannot report success for ${mode}`, async () => {
    const { ctx } = context(mode); const result = await adapter.execute(ctx);
    assert.notEqual(result.exitCode, 0); assert.ok(result.errorCode);
    assert.equal(result.executionRecovery, undefined, 'no automatic replay evidence');
  });
}
test('assistant text cannot create a false authentication failure', async () => {
  const { ctx } = context('normal'); const result = await adapter.execute(ctx); assert.equal(result.exitCode, 0);
});
test('handles UTF-8 split between transport chunks', async () => {
  const { ctx } = context('split'); const result = await adapter.execute(ctx); assert.equal(result.exitCode, 0); assert.ok(result.summary.startsWith('中文结果'));
});
test('records per-run usage, reports supplied cost, leaves unknown cost unpriced', async () => {
  const known = await adapter.execute(context('cost').ctx); assert.equal(known.costStatus, 'reported'); assert.equal(known.costUsd, 0.002);
  assert.deepEqual(known.usage, { inputTokens: 13, outputTokens: 5, cachedInputTokens: 2, cacheWriteTokens: 3 }); assert.equal(known.usageBasis, 'per_run');
  const unknown = await adapter.execute(context('normal').ctx); assert.equal(unknown.costUsd, null); assert.equal(unknown.costStatus, 'unpriced');
});
test('redacts credentials split across chunks from logs and persisted summary', async () => {
  const secret = 'some-unusual-api-secret'; const { ctx, logs } = context('secret'); ctx.config.env.TEST_API_KEY = secret;
  const result = await adapter.execute(ctx); assert.equal(result.exitCode, 0);
  assert.equal(logs.join('').includes(secret), false); assert.equal(result.summary.includes(secret), false);
});
test('rejects remote targets and unresolved environment refs before dispatch', async () => {
  const remote = context('identity', { executionTarget: { kind: 'remote', transport: 'ssh' } });
  assert.notEqual((await adapter.execute(remote.ctx)).exitCode, 0); assert.equal(remote.metas.length, 0);
  const bad = context(); bad.ctx.config.env.BAD = { secretRef: 'id' };
  assert.notEqual((await adapter.execute(bad.ctx)).exitCode, 0); assert.equal(bad.metas.length, 0);
  const identity = context(); identity.ctx.config.env.PAPERCLIP_API_KEY = 'other-token';
  assert.notEqual((await adapter.execute(identity.ctx)).exitCode, 0);
});
test('cancellation before dispatch never starts a process', async () => {
  const controller = new AbortController(); controller.abort(); const { ctx, metas } = context('hang', { signal: controller.signal });
  assert.equal((await adapter.execute(ctx)).errorCode, 'workbuddy_cancelled'); assert.equal(metas.length, 0);
});
test('operator cancellation stops the owned subprocess and acknowledges provider stop', async () => {
  const controller = new AbortController(); let stopped = false;
  const { ctx } = context('hang', { signal: controller.signal, onSpawn: async () => { setTimeout(() => controller.abort(), 100); }, onProviderStopped: async () => { stopped = true; } });
  const result = await adapter.execute(ctx); assert.equal(result.errorCode, 'workbuddy_cancelled'); assert.equal(stopped, true);
});
test('timeout stops owned child processes and does not label work complete', async () => {
  const testRoot = path.resolve(tmpdir());
  await mkdir(testRoot, { recursive: true });
  const folder = await mkdtemp(path.join(testRoot, 'workbuddy-tree-test-'));
  try {
    const pidFile = path.join(folder, 'child.txt'); const { ctx } = context('tree'); ctx.config.env.FAKE_PID_FILE = pidFile; ctx.config.timeoutSec = 0.7;
    const result = await adapter.execute(ctx); assert.equal(result.timedOut, true); assert.equal(result.errorCode, 'workbuddy_timeout');
    const pid = Number(await readFile(pidFile, 'utf8')); assert.throws(() => process.kill(pid, 0));
  } finally {
    assert.equal(path.dirname(path.resolve(folder)), testRoot);
    assert.ok(path.basename(folder).startsWith('workbuddy-tree-test-'));
    await rm(folder, { recursive: true, force: true });
  }
});
test('help-only diagnostics explicitly leave authentication unverified', async () => {
  const { ctx } = context(); const result = await adapter.testEnvironment({ companyId: ctx.agent.companyId, adapterType: adapter.type, config: ctx.config });
  assert.equal(result.status, 'warn'); assert.ok(result.checks.some(c => c.code === 'workbuddy_auth_unverified'));
});
test('conflicting stream sessions and oversized events cannot claim completion', () => {
  const parser = createParser(); parser.push('{"type":"system","session_id":"first"}\n');
  parser.push('{"type":"result","session_id":"second","subtype":"success","result":"Done"}\n'); assert.equal(parser.finish().success, false);
  const large = createParser(); large.push('x'.repeat(4 * 1024 * 1024 + 1)); large.push('\n{"type":"result","subtype":"success","result":"Done"}\n'); assert.equal(large.finish().success, false);
});
test('fresh handoff is fetched only when starting a new session', async () => {
  let calls = 0; const { ctx } = context('identity', { getFreshSessionHandoff: async () => { calls++; return 'Prior result: HELLO'; } });
  const result = await adapter.execute(ctx); assert.equal(JSON.parse(result.summary).prompt.split('Prior result: HELLO').length, 2);
  ctx.runtime.sessionParams = result.sessionParams;
  const resumed = await adapter.execute(ctx); assert.equal(calls, 1);
  assert.equal(JSON.parse(resumed.summary).prompt.includes('Prior result: HELLO'), false);
});
test('assigned runtime skills reach both fresh and resumed turns without global installation', async () => {
  const testRoot = path.resolve(tmpdir()); await mkdir(testRoot, { recursive: true });
  const folder = await mkdtemp(path.join(testRoot, 'workbuddy-skill-test-'));
  try {
    await writeFile(path.join(folder, 'SKILL.md'), 'Use the Paperclip API to update the task.');
    const { ctx } = context(); ctx.config.paperclipRuntimeSkills = [{ key: 'paperclip', runtimeName: 'paperclip', source: folder }];
    const first = await adapter.execute(ctx); assert.equal(first.exitCode, 0); assert.ok(JSON.parse(first.summary).prompt.includes('Use the Paperclip API'));
    ctx.runtime.sessionParams = first.sessionParams;
    const resumed = await adapter.execute(ctx); assert.equal(resumed.exitCode, 0); assert.ok(JSON.parse(resumed.summary).prompt.includes('Use the Paperclip API'));
    ctx.config.paperclipRuntimeSkills[0].sourceStatus = 'missing'; assert.notEqual((await adapter.execute(ctx)).exitCode, 0);
  } finally {
    assert.equal(path.dirname(path.resolve(folder)), testRoot); assert.ok(path.basename(folder).startsWith('workbuddy-skill-test-'));
    await rm(folder, { recursive: true, force: true });
  }
});
