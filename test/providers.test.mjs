import test from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { CommandProvider, commandFor, parseAgentEvent } from '../lib/providers.mjs';

test('agent commands pass prompt via stdin and resume exact session without shell interpolation', () => {
  const prompt = '中文\n$(do-not-execute) `quoted` "text"';
  const wb = commandFor('workbuddy', { model: true, effort: true, dontAsk: true }, { model: '', effort: '' }, { prompt, threadId: 'existing-session' });
  assert.equal(JSON.parse(wb.input).message.content, prompt);
  assert.ok(wb.args.includes('existing-session'));
  assert.ok(!wb.args.includes('--dangerously-skip-permissions'));
  const ag = commandFor('antigravity', { streamInput: true, printTimeout: true }, { timeoutMinutes: 60 }, { prompt, threadId: 'ag-session' });
  assert.equal(JSON.parse(ag.input).message.content, prompt);
  assert.ok(ag.args.includes('ag-session'));
});

test('structured results distinguish success, errors, interruption and denied operations', () => {
  assert.equal(parseAgentEvent('antigravity', { event: 'result', result: { status: 'SUCCESS', conversation_id: 'ag', response: 'Done' } }).final.status, 'completed');
  assert.equal(parseAgentEvent('antigravity', { event: 'result', result: { status: 'INTERRUPTED' } }).final.status, 'interrupted');
  assert.equal(parseAgentEvent('workbuddy', { type: 'result', subtype: 'success', result: 'Done', permission_denials: [{}] }).final.status, 'failed');
  assert.equal(parseAgentEvent('workbuddy', { type: 'result', is_error: true, result: 'Failure' }).final.status, 'failed');
});

async function runFake(script, { structured = true, id = 'workbuddy' } = {}) {
  let output, thread;
  const provider = new CommandProvider(id, { spawnProcess: () => spawn(process.execPath, ['-e', script], { stdio: ['pipe', 'pipe', 'pipe'], windowsHide: true }) });
  provider.available = true; provider.binary = { command: process.execPath, args: [] };
  provider.capabilities = { structured };
  const handle = provider.start({ cwd: process.cwd(), timeoutMinutes: 1 }, { prompt: 'test' }, { log() {}, thread: value => { thread = value; }, output: value => { output = value; } });
  return { result: await handle.completion, output, thread };
}

test('real subprocess parsing handles split UTF-8 and waits for final process exit', async () => {
  const event = JSON.stringify({ type: 'result', subtype: 'success', session_id: 'test-session', result: '中文结果' }) + '\n';
  const script = `const b=Buffer.from(${JSON.stringify(event)});process.stdout.write(b.subarray(0,b.length-9));setTimeout(()=>{process.stdout.write(b.subarray(b.length-9));process.exit(0)},20)`;
  const run = await runFake(script);
  assert.equal(run.result.status, 'completed'); assert.equal(run.output, '中文结果'); assert.equal(run.thread, 'test-session');
});

test('missing final event is uncertain and non-zero exit cannot report success', async () => {
  assert.equal((await runFake('process.stdout.write("{}\\n")')).result.status, 'uncertain');
  assert.equal((await runFake('process.stdout.write(JSON.stringify({type:"result",subtype:"success",result:"Done"}));process.exit(2)')).result.status, 'failed');
});

test('text-only Antigravity capability uses text output and rejects unsupported model override', async () => {
  assert.throws(() => commandFor('antigravity', {}, { model: 'unsupported' }, { prompt: 'test' }), /模型/);
  const run = await runFake('process.stdout.write("中文文本回复")', { structured: false, id: 'antigravity' });
  assert.equal(run.result.status, 'completed'); assert.equal(run.output, '中文文本回复');
});

test('empty text output cannot claim a successful task', async () => {
  assert.equal((await runFake('process.exit(0)', { structured: false, id: 'antigravity' })).result.status, 'uncertain');
});

test('a helper inheriting stdout cannot keep a completed CLI running forever', async () => {
  const script = 'const {spawn}=require("node:child_process");const p=spawn(process.execPath,["-e","setTimeout(()=>{},3500)"],{stdio:["ignore",process.stdout,process.stderr],windowsHide:true});p.unref();process.stdout.write(JSON.stringify({type:"result",subtype:"success",result:"Done"})+"\\n");';
  const started = Date.now();
  const run = await runFake(script);
  assert.equal(run.result.status, 'completed');
  assert.ok(Date.now() - started < 3400, 'completion should not wait for the persistent helper');
});
