import test from 'node:test';
import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import { desktopTargets } from '../lib/desktop-cdp.mjs';
import { connectOrLaunch } from '../lib/desktop-launch.mjs';
import { WorkBuddyDesktop } from '../lib/desktop.mjs';
import { DoubaoDesktop } from '../lib/doubao-desktop.mjs';

test('CDP discovery accepts a client opened first on another owned port and isolates failing services', async () => {
  const calls = [];
  const found = { processes: [{ pid: 1, name: 'WorkBuddy.exe' }, { pid: 2, name: 'Other.exe' }], ports: [{ pid: 1, port: 1234 }, { pid: 1, port: 5678 }, { pid: 2, port: 9337 }] };
  const tabs = await desktopTargets(found, 'WorkBuddy.exe', 9337, async (url, options) => {
    calls.push(url); assert.equal(options.redirect, 'error');
    if (url.includes(':1234')) throw new Error('not a CDP service');
    return { ok: true, json: async () => [{ type: 'page', webSocketDebuggerUrl: 'ws://127.0.0.1:5678/page' }, { type: 'worker' }] };
  });
  assert.equal(calls.length, 2); assert.ok(!calls.some(url => url.includes(':9337')));
  assert.deepEqual(tabs.map(t => t.port), [5678]);
});

test('both providers connect to an already running compatible renderer on a non-default owned port', async () => {
  for (const [Provider, name, url] of [[WorkBuddyDesktop, 'WorkBuddy.exe', 'file:///app.asar/renderer/index.html'], [DoubaoDesktop, 'Doubao.exe', 'https://www.doubao.com/chat/'], [DoubaoDesktop, 'Doubao.exe', 'doubao://doubao-chat/chat'], [DoubaoDesktop, 'Doubao.exe', 'chrome://doubao-chat/chat/123']]) {
    const provider = new Provider({ discovery: async () => ({ processes: [{ pid: 5, name }], ports: [{ pid: 5, port: 12345 }] }),
      fetcher: async () => ({ ok: true, json: async () => [{ type: 'page', url, webSocketDebuggerUrl: 'ws://127.0.0.1:12345/page' }] }),
      connect: async (_, port) => { assert.equal(port, 12345); return { close() {}, evaluate: async text => text.includes('typeof window.__wbInvoke') ? true : name === 'WorkBuddy.exe' ? { items: [] } : { ready: true } }; } });
    assert.equal((await provider.probe()).available, true); assert.equal(provider.port, 12345);
    provider.discovery = async () => { throw new Error('repeat probe must use the live interface'); };
    assert.equal((await provider.probe()).available, true);
    provider.close();
  }
});

test('WorkBuddy reads past the SDK asynchronous empty first history snapshot', async () => {
  let reads=0;
  const p=new WorkBuddyDesktop();
  p.rpc={evaluate:async expression=>{
    const invoke=async()=>++reads===1?{items:[],hasOlder:true}:{items:[{id:'canonical',state:'completed'}],hasOlder:false};
    // Run the actual transport expression against a simulated lazy SDK loader.
    return new Function('window', 'return '+expression)({__wbInvoke:invoke});
  }};
  const result=await p.invoke('requests',['test-chat',{byteLength:100000}]);
  assert.equal(reads,2); assert.equal(result.items[0].id,'canonical');
});

test('WorkBuddy keeps the canonical request identity after client correlation metadata disappears', async () => {
  const p=new WorkBuddyDesktop({pause:async()=>{polls++;}});p.available=true;
  let polls=0,sent=false,sends=0;const checkpoints=[];const cwd=process.cwd();
  p.invoke=async(method,args)=>{
    if(method==='get')return{info:{space:{cwd},state:sent&&polls<2?'working':'idle'}};
    if(method==='requests')return{items:sent?[{id:'canonical',state:polls<2?'working':'completed',...(polls<2?{clientRequestId:'client-id'}:{}),assistantMessage:{content:[{type:'text',text:'done'}]}}]:[]};
    if(method==='sendPrompt'){sent=true;sends++;return;}
    throw new Error('Unexpected '+method);
  };
  const task={cwd,timeoutMinutes:1},run={id:'client-id',threadId:'test',prompt:'hello'};
  assert.equal((await p.start(task,run,{checkpoint:c=>checkpoints.push(c),output(){}}).completion).status,'completed');
  const monitor=checkpoints.at(-1);assert.equal(monitor.conversationRequestId,'canonical');
  assert.equal(await p.recoveryState(task,{...run,desktopMonitor:monitor}),'completed');
  assert.equal((await p.resume(task,{...run,desktopMonitor:monitor},{output(){}}).completion).status,'completed');
  assert.equal(sends,1);
});

test('WorkBuddy reuses unchanged terminal session results but always checks changed or busy turns', async () => {
  const p=new WorkBuddyDesktop();p.available=true;let version='1',state='idle',reads=0;
  p.listThreads=async()=>[{id:'test',version,status:state}];
  p.inspect=async()=>{reads++;return{status:state,version,last:{state:'completed',assistantMessage:{content:[{type:'text',text:'done'}]}},info:{}};};
  await p.listSessions();await p.listSessions();assert.equal(reads,1);
  version='2';await p.listSessions();assert.equal(reads,2);
  state='working';await p.listSessions();await p.listSessions();assert.equal(reads,4);
});

test('launch reuses live clients, reports missing debug flags and never kills or respawns them', async () => {
  let spawns = 0, available = true;
  const provider = { discovery: async () => ({ processes: [{ name: 'Doubao.exe' }], ports: [] }), probe: async () => ({ available, detail: 'missing debug interface' }) };
  const options = { name: 'Doubao.exe', spawnProcess() { spawns++; throw new Error('must not spawn'); } };
  assert.equal((await connectOrLaunch(provider, options)).connected, true);
  available = false;
  assert.equal((await connectOrLaunch(provider, options)).requiresRestart, true);
  assert.equal(spawns, 0);
});

test('a successful spawn is not a successful connection; launch waits for a renderer and handles failure', async () => {
  let probes = 0, spawned = 0, unrefs = 0;
  const provider = { port: 9337, discovery: async () => ({ processes: [], ports: [] }), probe: async () => ({ available: ++probes >= 3 }), snapshot: () => ({ available: false }) };
  const spawnProcess = (binary, args, options) => {
    spawned++; assert.equal(binary, 'client.exe'); assert.deepEqual(args, ['--remote-debugging-port=9337', '--remote-debugging-address=127.0.0.1']); assert.equal(options.shell, false);
    const child = new EventEmitter(); child.unref = () => { unrefs++; }; queueMicrotask(() => child.emit('spawn')); return child;
  };
  assert.equal((await connectOrLaunch(provider, { name: 'WorkBuddy.exe', binary: 'client.exe', spawnProcess, pause: async () => {} })).connected, true);
  assert.equal(spawned, 1); assert.equal(unrefs, 1); assert.equal(probes, 3);
  probes = -100;
  const result = await connectOrLaunch(provider, { name: 'WorkBuddy.exe', binary: 'client.exe', spawnProcess, pause: async () => {}, attempts: 2 });
  assert.equal(result.connected, false); assert.equal(result.launched, true);
  await assert.rejects(connectOrLaunch(provider, { name: 'WorkBuddy.exe', binary: 'client.exe', spawnProcess() { const c = new EventEmitter(); queueMicrotask(() => c.emit('error', new Error('spawn failed'))); return c; } }), /spawn failed/);
});
