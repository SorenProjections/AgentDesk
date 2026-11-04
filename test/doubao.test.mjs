import test from 'node:test';
import assert from 'node:assert/strict';
import vm from 'node:vm';
import { Scheduler } from '../lib/scheduler.mjs';
import { DoubaoDesktop, doubaoPage } from '../lib/doubao-desktop.mjs';

function fixture(options = {}) {
  let now = 1000, stage = 'old', polls = 0, sends = 0, output;
  const provider = new DoubaoDesktop({ clock: () => now, pause: async ms => { now += ms; } });
  provider.available = true;
  provider.page = async (action = 'read', prompt) => {
    if (action === 'new') { stage = 'new'; return true; }
    if (action === 'fill') { assert.equal(prompt, 'hello'); return true; }
    if (action === 'send') { sends++; stage = 'sent'; if (options.lostSend) throw new Error('connection lost'); return true; }
    if (stage !== 'sent') return { ready: true, draft: '', busy: false, messages: [] };
    polls++;
    const messages = [{ role: 'user', text: 'hello' }, { role: 'assistant', text: polls < 3 ? 'partial' : 'answer', streaming: polls < 3, finished: polls >= 3 }];
    if (options.interference) messages.push({ role: 'user', text: 'human message' });
    if (options.noFinish) messages[1].finished = false;
    if (options.disconnected) throw new Error('connection lost');
    return { ready: true, draft: '', busy: polls < 3, canSend: false, href: options.switchChat && polls > 1 ? 'other' : 'chat', messages };
  };
  const start = (task = {}, run = {}) => provider.start({ threadMode: 'new', timeoutMinutes: 0.25, ...task }, { prompt: 'hello', ...run }, { output: text => { output = text; } });
  return { provider, start, get sends() { return sends; }, get polls() { return polls; }, get output() { return output; } };
}

test('Doubao waits for the new turn, finished controls and stable text even when send is disabled', async () => {
  const f = fixture();
  assert.equal((await f.start().completion).status, 'completed');
  assert.equal(f.output, 'answer'); assert.equal(f.sends, 1); assert.ok(f.polls >= 6);
});

test('Doubao never treats partial text, transport ambiguity or changed conversations as success', async () => {
  for (const options of [{ lostSend: true }, { disconnected: true }, { interference: true }, { switchChat: true }, { noFinish: true }]) {
    const f = fixture(options);
    assert.equal((await f.start().completion).status, 'uncertain');
    assert.equal(f.sends, 1); assert.equal(f.output, undefined);
  }
});

test('Doubao rejects unsupported continuation/model, expired runs and concurrent UI access', async () => {
  for (const [task, run] of [[{ threadMode: 'existing' }, {}], [{ model: 'x' }, {}], [{}, { startedAt: -1000000 }]]) {
    const f = fixture(); assert.equal((await f.start(task, run).completion).status, 'failed'); assert.equal(f.sends, 0);
  }
  const f = fixture(); const first = f.start(); assert.throws(() => f.start(), /另一项任务/);
  await first.interrupt(); assert.equal((await first.completion).status, 'interrupted'); assert.equal(f.sends, 0);
  assert.equal(f.provider.running, false);
});

test('Doubao probe requires an owned loopback port and a compatible chat page', async () => {
  let connections = 0, closed = 0;
  const p = new DoubaoDesktop({ discovery: async () => ({ processes: [{ pid: 7, name: 'Doubao.exe' }], ports: [{ port: 9338, pid: 7 }] }),
    fetcher: async () => ({ ok: true, json: async () => [{ type: 'page', url: 'https://evil.example/chat', webSocketDebuggerUrl: 'ws://127.0.0.1:9338/x' }, { type: 'page', url: 'https://www.doubao.com/chat/', webSocketDebuggerUrl: 'ws://127.0.0.1:9338/y' }] }),
    connect: async () => { connections++; return { evaluate: async () => ({ ready: true }), close: () => { closed++; } }; } });
  assert.equal((await p.probe()).available, true); assert.equal(connections, 1);
  p.close(); assert.equal(closed, 1);
  p.discovery = async () => ({ processes: [{ pid: 8, name: 'Other.exe' }], ports: [{ port: 9338, pid: 8 }] });
  assert.equal((await p.probe()).available, false); assert.equal(connections, 1);
});

test('Doubao launch refuses to close a running client', async () => {
  const p = new DoubaoDesktop({ discovery: async () => ({ processes: [{ pid: 1 }], ports: [] }) });
  await assert.rejects(p.launch(), /仍在运行/);
});

test('scheduler serializes Doubao across independent folders while other providers remain parallel', () => {
  const p = new DoubaoDesktop();
  const context = { isTaskActive: () => false, providers: new Map([[p.id, p]]), activeRuns: new Map([['r', { task: { cwd: 'E:\\one' }, run: { provider: p.id } }]]), concurrencyLimit: 4 };
  const task = { provider: p.id, cwd: 'E:\\two' };
  assert.match(Scheduler.prototype.concurrencyBlocker.call(context, task), /一次只能/);
  assert.equal(Scheduler.prototype.concurrencyBlocker.call(context, { ...task, provider: 'codex' }), null);
});

test('DOM adapter preserves drafts and injects prompt as data without executing it', () => {
  let clicked = 0;
  class TextArea { value = ''; dispatchEvent() {} }
  let value = '';
  Object.defineProperty(TextArea.prototype, 'value', { get() { return value; }, set(v) { value = v; } });
  const input = new TextArea(); delete input.value;
  const send = { disabled: false, getAttribute() { return null; }, click() { clicked++; } };
  const context = vm.createContext({ HTMLTextAreaElement: TextArea, Event: class {}, location: { href: 'chat' }, document: {
    querySelector: selector => selector === '[data-testid="chat_input_input"]' ? input : selector === '[data-testid="chat_input_send_button"]' ? send : null,
    querySelectorAll: () => [],
  } });
  const call = (action, text) => vm.runInContext(`(${doubaoPage.toString()})(${JSON.stringify(action)}, ${JSON.stringify(text)})`, context);
  value = 'keep draft'; assert.throws(() => call('new', ''), /草稿/); assert.equal(value, 'keep draft');
  value = ''; const prompt = '中文\n${doNotExecute()} `quoted`'; call('fill', prompt); assert.equal(value, prompt);
  assert.throws(() => call('send', 'different'), /已变化/); assert.equal(clicked, 0);
  call('send', prompt); assert.equal(clicked, 1);
});
