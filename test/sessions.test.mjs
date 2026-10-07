import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, writeFileSync, appendFileSync } from 'node:fs';
import path from 'node:path';
import { Store } from '../lib/store.mjs';
import { SessionHub } from '../lib/sessions.mjs';
import { NativeCodexObserver, reduceCodexEvent } from '../lib/native-codex.mjs';
import { workBuddyNativeState } from '../lib/native-workbuddy.mjs';
import { WorkBuddyDesktop, AntigravityDesktop } from '../lib/desktop.mjs';

function fixture(t) {
  mkdirSync(path.resolve('work'), { recursive: true });
  const dir=mkdtempSync(path.resolve('work/session-tests-'));let now=1700000000000;
  const store=new Store(path.join(dir,'tasks.json'));const sent=[];
  const hub=new SessionHub(store,{clock:()=>now,notifier:async(...args)=>sent.push(args)});t.after(()=>hub.close());
  const ingest=(status,version='turn-1')=>hub.ingest('codex',{id:'one',name:'Native task',cwd:dir,status,version,updatedAt:now});
  return{hub,store,dir,sent,ingest,advance:()=>now+=10000};
}
test('native baseline, same-turn deduplication, unseen short turns and distinct providers',t=>{
  const f=fixture(t);f.ingest('completed');assert.equal(f.hub.snapshot().notifications.length,0);
  f.ingest('running','turn-2');f.ingest('waiting','turn-2');f.ingest('running','turn-2');f.ingest('waiting','turn-2');f.ingest('completed','turn-2');f.ingest('completed','turn-2');
  assert.deepEqual(f.store.data.notifications.map(n=>n.kind),['waiting','completed']);
  f.ingest('completed','turn-3');assert.equal(f.store.data.notifications.length,3);
  f.hub.ingest('workbuddyDesktop',{id:'one',name:'Different native task',status:'running',version:'wb'});assert.equal(f.store.data.sessions.length,2);
});
test('idle is not completion; watching, hiding and aliases belong to the mapping',t=>{
  const f=fixture(t);const s=f.ingest('running');f.ingest('idle');assert.equal(f.store.data.notifications.length,0);
  f.hub.update(s.key,{watched:false,alias:'My name',note:'Check tests',pinned:true});f.ingest('running','turn-2');f.ingest('completed','turn-2');assert.equal(f.store.data.notifications.length,0);
  f.hub.update(s.key,{watched:true,hidden:true});f.ingest('running','turn-3');f.ingest('failed','turn-3');assert.equal(f.store.data.notifications.length,1);assert.equal(s.name,'Native task');assert.equal(s.alias,'My name');
});
test('restart keeps baseline and unread reminders; explicit completion after downtime alerts once',t=>{
  const f=fixture(t);f.ingest('running');f.hub.save();const reloaded=new SessionHub(new Store(f.store.file));t.after(()=>reloaded.close());
  reloaded.ingest('codex',{id:'one',name:'Native task',status:'completed',version:'turn-1'});reloaded.save();assert.equal(reloaded.snapshot().counts.unread,1);
  const again=new SessionHub(new Store(f.store.file));t.after(()=>again.close());again.ingest('codex',{id:'one',name:'Native task',status:'completed',version:'turn-1'});assert.equal(again.snapshot().counts.unread,1);again.read('all');assert.equal(again.snapshot().counts.unread,0);
});
test('quiet periods retain reminders and release one OS digest; delivery failures stay visible',async t=>{
  const f=fixture(t);f.ingest('running');f.hub.configure({quietMinutes:25});f.ingest('completed');await f.hub.deliver();assert.equal(f.sent.length,0);assert.equal(f.hub.snapshot().counts.unread,1);
  f.hub.configure({quietMinutes:0});await new Promise(r=>setImmediate(r));await f.hub.deliver();assert.equal(f.sent.length,1);assert.equal(f.store.data.notifications[0].delivery,'sent');
  f.ingest('running','turn-2');f.ingest('failed','turn-2');f.hub.notifier=async()=>{throw new Error('OS blocked');};await f.hub.deliver();assert.equal(f.store.data.notifications.at(-1).delivery,'failed');assert.equal(f.hub.snapshot().counts.unread,2);
});
test('source loss preserves last state and cannot create a completion; source failure is isolated',async t=>{
  const f=fixture(t);let online=true;
  f.hub.sources=[{id:'codex',name:'Codex',list:async()=>{if(!online)throw new Error('offline');return[{id:'one',name:'Native task',status:'running',version:'turn-1'}];}},{id:'other',name:'Other',list:async()=>[{id:'two',status:'idle',name:'Other'}]}];
  await f.hub.refresh();online=false;await f.hub.refresh();await f.hub.refresh();assert.equal(f.hub.snapshot().sources[1].available,true);assert.equal(f.store.data.sessions[0].status,'running');assert.equal(f.store.data.sessions[0].disconnected,true);assert.deepEqual(f.store.data.notifications.map(n=>n.kind),['disconnected']);
});
test('queue/native mappings merge and completion does not double notify on the next native poll',async t=>{
  const f=fixture(t);f.ingest('idle');f.store.data.runs.push({id:'run-1',provider:'codex',threadId:'one',taskTitle:'Queued',taskId:'task',status:'running',startedAt:1700000000000});f.hub.syncRuns();
  f.advance();f.store.data.runs[0].status='completed';f.store.data.runs[0].endedAt=1700000010000;f.hub.syncRuns();assert.equal(f.store.data.notifications.length,1);assert.equal(f.store.data.sessions.length,1);
  f.hub.sources=[{id:'codex',name:'Codex',list:async()=>[{id:'one',name:'Native task',status:'completed',version:'native-turn'}]}];await f.hub.refresh();assert.equal(f.store.data.notifications.length,1);
});
test('Codex lifecycle requires a matching terminal event and stale activity is not success',()=>{
  const event=(type,id)=>({type:'event_msg',timestamp:'2026-10-04T00:00:00Z',payload:{type,turn_id:id}});
  let s=reduceCodexEvent({},event('task_started','one'));s=reduceCodexEvent(s,event('task_complete','old'));assert.equal(s.status,'running');s=reduceCodexEvent(s,event('item_completed','one'));assert.equal(s.status,'running');s=reduceCodexEvent(s,event('turn_aborted','one'));assert.equal(s.status,'interrupted');
});
test('Codex rollout reader finds lifecycle outside tail and preserves incomplete appended JSON',async t=>{
  const f=fixture(t);const observer=new NativeCodexObserver();t.after(()=>observer.close());const file=path.join(f.dir,'rollout.jsonl');
  const start=JSON.stringify({type:'event_msg',timestamp:'2026-10-04T00:00:00Z',payload:{type:'task_started',turn_id:'one'}})+'\n';
  writeFileSync(file,start+Array(7000).fill(JSON.stringify({type:'event_msg',timestamp:'2026-10-04T00:01:00Z',payload:{type:'token_count',padding:'x'.repeat(50)}})+'\n').join(''));
  assert.equal((await observer.readRollout(file)).status,'running');const finish=JSON.stringify({type:'event_msg',timestamp:'2026-10-04T00:02:00Z',payload:{type:'task_complete',turn_id:'one',last_agent_message:'完成'}})+'\n';appendFileSync(file,finish.slice(0,30));assert.equal((await observer.readRollout(file)).status,'running');appendFileSync(file,finish.slice(30));assert.equal((await observer.readRollout(file)).status,'completed');
});
test('WorkBuddy completion waits for children; idle requests with failed state fail',async()=>{
  const wb=new WorkBuddyDesktop();wb.available=true;wb.listThreads=async()=>[{id:'one',name:'Task'}];wb.inspect=async()=>({status:'running',version:'req',info:{},last:{state:'completed'}});assert.equal((await wb.listSessions())[0].status,'running');wb.inspect=async()=>({status:'idle',version:'req',info:{},last:{state:'failed'}});assert.equal((await wb.listSessions())[0].status,'failed');
});
test('Antigravity native idle requires a verified final reply',async()=>{
  const ag=new AntigravityDesktop();ag.available=true;ag.summaries=async()=>({one:{summary:'Task',status:'CASCADE_RUN_STATUS_IDLE',stepCount:2,lastUserInputTime:'2026-10-04T00:00:00Z'}});ag.result=async()=>({status:'uncertain',output:''});assert.equal((await ag.listSessions())[0].status,'uncertain');
});

test('WorkBuddy native records distinguish completed, cancelled and missing runtime evidence',()=>{
  const records=[{type:'message',role:'user',timestamp:1000,id:'user',providerData:{conversationRequestId:'req'}},{type:'message',role:'assistant',timestamp:2000,status:'completed',providerData:{conversationRequestId:'req'},content:[{type:'text',text:'Done'}]}];
  assert.equal(workBuddyNativeState('completed',records).status,'uncertain');
  assert.equal(workBuddyNativeState('completed',records,[{at:3000,finalState:'cancelled'}]).status,'interrupted');
  assert.equal(workBuddyNativeState('completed',records,[{at:3000,finalState:'completed'}]).status,'completed');
  assert.equal(workBuddyNativeState('working',records,[{at:3000,finalState:'completed'}]).status,'running');
  records.push({type:'message',role:'user',timestamp:4000,id:'new',providerData:{conversationRequestId:'next'}});
  assert.equal(workBuddyNativeState('completed',records,[{at:3000,finalState:'completed'}]).status,'uncertain');
});
test('historical unknown states and internal review threads do not demand attention',t=>{
  const f=fixture(t);f.ingest('uncertain');assert.equal(f.hub.snapshot().counts.attention,0);
  f.hub.ingest('codex',{id:'guardian',name:'Review',status:'running',version:'one',internal:true});f.hub.ingest('codex',{id:'guardian',name:'Review',status:'completed',version:'one',internal:true});assert.equal(f.hub.snapshot().sessions.length,1);assert.equal(f.hub.snapshot().counts.unread,0);
});
