import test from 'node:test';
import assert from 'node:assert/strict';
import vm from 'node:vm';
import { Scheduler } from '../lib/scheduler.mjs';
import { DoubaoDesktop, doubaoPage } from '../lib/doubao-desktop.mjs';

function fixture(options = {}) {
  let now = 1000, stage = 'old', polls = 0, sends = 0, output, captured, opened, created;
  const baseline = options.existing ? [{id:'old-user',role:'user',text:'hello'}, {id:'old-assistant',role:'assistant',text:'old answer',finished:true}] : [];
  const provider = new DoubaoDesktop({ clock: () => now, pause: async ms => { now += ms; } });
  provider.available = true;
  provider.page = async (action = 'read', prompt) => {
    if (action === 'new') { stage = 'new'; created = prompt; return true; }
    if (action === 'open') { stage = 'existing'; opened = prompt; return true; }
    if (action === 'fill') { assert.equal(prompt.prompt, 'hello'); assert.equal(prompt.baseline,JSON.stringify(baseline)); return true; }
    if (action === 'send') { sends++; stage = 'sent'; if (options.lostSend) throw new Error('connection lost'); return true; }
    if (stage !== 'sent') return { ready: true, draft: '', busy: false, messages: baseline,threadId:options.existing ? '456' : null,projectId:options.projectId || null,href:'chrome://doubao-chat/chat/456' };
    polls++;
    const messages = [{ role: 'user', text: 'hello' }, { role: 'assistant', text: polls < 3 ? 'partial' : 'answer', streaming: polls < 3, finished: polls >= 3 }];
    if (options.placeholder && polls === 1) messages[0].text = '';
    if (options.interference) messages.push({ role: 'user', text: 'human message' });
    if (options.noFinish) messages[1].finished = false;
    if (options.disconnected) throw new Error('connection lost');
    if (options.rewriteHistory && polls > 1) baseline[0].text='changed';
    return { ready: true, draft: '', busy: polls < 3, canSend: false, threadId:options.nativeRedirect && polls<3 ? null : '456',projectId:options.projectId || null,href:options.existing ? 'chrome://doubao-chat/chat/456' : options.nativeRedirect ? 'chrome://doubao-chat/chat/' + (polls < 3 ? 'local_123' : '456') : options.switchChat && polls > 1 ? 'other' : 'chat', messages:baseline.concat(messages) };
  };
  const start = (task = {}, run = {}) => provider.start({ threadMode: 'new', timeoutMinutes: 0.25, ...task }, { prompt: 'hello', ...run }, { output: text => { output = text; },thread:id=>{captured=id;} });
  return { provider, start, get sends() { return sends; }, get polls() { return polls; }, get output() { return output; },get captured(){return captured;},get opened(){return opened;},get created(){return created;} };
}

test('Doubao resumes the exact existing project conversation and ignores its old matching prompt/reply', async () => {
  const f=fixture({existing:true,projectId:'project-1'});
  assert.equal((await f.start({threadMode:'existing',nativeProjectId:'project-1'},{threadId:'456'}).completion).status,'completed');
  assert.deepEqual(f.opened,{id:'456',projectId:'project-1'});
  assert.equal(f.created,undefined); assert.equal(f.sends,1); assert.equal(f.output,'answer');
});

test('Doubao creates in the selected native project and captures the saved conversation ID', async () => {
  const f=fixture({nativeRedirect:true,projectId:'project-1'});
  assert.equal((await f.start({nativeProjectId:'project-1'}).completion).status,'completed');
  assert.deepEqual(f.created,{projectId:'project-1'}); assert.equal(f.captured,'456');
  const mismatch=fixture({existing:true,projectId:'other'});
  assert.equal((await mismatch.start({threadMode:'existing',nativeProjectId:'project-1'},{threadId:'456'}).completion).status,'failed');
  assert.equal(mismatch.sends,0);
});

test('Doubao new mode ignores the previous run conversation saved on the task', async () => {
  const f=fixture();
  assert.equal((await f.start({threadId:'old-chat'}).completion).status,'completed');
  assert.deepEqual(f.created,{projectId:null});assert.equal(f.opened,undefined);
});

test('Doubao waits for the new turn, finished controls and stable text even when send is disabled', async () => {
  const f = fixture();
  assert.equal((await f.start().completion).status, 'completed');
  assert.equal(f.output, 'answer'); assert.equal(f.sends, 1); assert.ok(f.polls >= 6);
});

test('Doubao tolerates empty hydration placeholders and saving its temporary native chat URL', async () => {
  const f = fixture({placeholder:true,nativeRedirect:true});
  assert.equal((await f.start().completion).status, 'completed');
  assert.equal(f.output, 'answer'); assert.equal(f.sends, 1);
});

test('Doubao never treats partial text, transport ambiguity or changed conversations as success', async () => {
  for (const options of [{ lostSend: true }, { disconnected: true }, { interference: true }, { switchChat: true }, { noFinish: true }]) {
    const f = fixture(options);
    assert.equal((await f.start().completion).status, 'uncertain');
    assert.equal(f.sends, 1); assert.equal(f.output, undefined);
  }
});

test('Doubao rejects missing continuation targets, model overrides, expired runs and concurrent UI access', async () => {
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
  const p = new DoubaoDesktop({ discovery: async () => ({ processes: [{ pid: 1, name: 'Doubao.exe' }], ports: [] }) });
  const result = await p.launch();
  assert.equal(result.requiresRestart, true);
  assert.equal(result.launched, false);
  assert.equal(result.connected, false);
});

test('scheduler serializes Doubao across independent folders while other providers remain parallel', () => {
  const p = new DoubaoDesktop();
  const context = { isTaskActive: () => false, usesLocalFiles: Scheduler.prototype.usesLocalFiles, providers: new Map([[p.id, p]]), activeRuns: new Map([['r', { task: { provider:p.id, cwd: 'E:\\one' }, run: { provider: p.id } }]]), concurrencyLimit: 4 };
  const task = { provider: p.id, cwd: 'E:\\two' };
  assert.match(Scheduler.prototype.concurrencyBlocker.call(context, task), /一次只能/);
  assert.equal(Scheduler.prototype.concurrencyBlocker.call(context, { ...task, provider: 'codex' }), null);
});

test('DOM adapter preserves drafts and injects prompt as data without executing it', () => {
  let clicked = 0;
  class TextArea { value = ''; dispatchEvent() {} }
  let value = '';
  Object.defineProperty(TextArea.prototype, 'value', { get() { return value; }, set(v) { value = v; } });
  const input = new TextArea(); delete input.value; input.matches = () => true;
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
