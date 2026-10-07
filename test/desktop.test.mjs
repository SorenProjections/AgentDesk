import test from 'node:test';
import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import { mkdtempSync, mkdirSync } from 'node:fs';
import path from 'node:path';
import { Store } from '../lib/store.mjs';
import { Scheduler } from '../lib/scheduler.mjs';
import { AntigravityDesktop, WorkBuddyDesktop, antigravityStatus } from '../lib/desktop.mjs';

test('desktop idle requires all children, background work and permissions to finish',()=>{
  const idle={status:'CASCADE_RUN_STATUS_IDLE'};
  assert.equal(antigravityStatus(idle),'idle');
  assert.equal(antigravityStatus({...idle,notFullyIdle:true}),'running');
  assert.equal(antigravityStatus({...idle,hasActiveChildren:true}),'running');
  assert.equal(antigravityStatus({...idle,waitingSteps:[{}]}),'waiting');
  assert.equal(antigravityStatus({...idle,interrupted:true}),'interrupted');
  assert.equal(antigravityStatus({}),'uncertain');
});

test('a desktop execution error can be a DONE step and must fail the queue',async()=>{
  const p=new AntigravityDesktop();p.rpc=async()=>({steps:[{status:'CORTEX_STEP_STATUS_DONE',errorMessage:{error:{shortError:'model unavailable'}}}]});
  assert.equal((await p.result('test',0)).status,'failed');
  p.rpc=async()=>({steps:[{status:'CORTEX_STEP_STATUS_DONE',plannerResponse:{response:'done'}}]});
  assert.equal((await p.result('test',0)).status,'completed');
  p.rpc=async()=>({steps:[{status:'CORTEX_STEP_STATUS_RUNNING',plannerResponse:{response:'partial'}}]});
  assert.equal((await p.result('test',0)).status,'uncertain');
});

function fixture(t){
  const base=path.resolve('work/desktop-tests');mkdirSync(base,{recursive:true});const cwd=mkdtempSync(path.join(base,'case-'));
  const store=new Store(path.join(cwd,'tasks.json'));const client=new EventEmitter();client.connected=true;client.defaults={};
  let state={id:'desktop-chat',cwd,status:'running',version:'turn-1',steps:4,inputStep:2};let now=1700000000000;let sent=[];
  const provider={id:'desktop',snapshot:()=>({id:'desktop',available:true,capabilities:{watch:true,resume:true,captureThread:true,desktop:true}}),inspect:async()=>({...state}),result:async()=>({status:'completed',error:''}),start:(task,run)=>{sent.push(run.prompt);return{completion:Promise.resolve({status:'completed'}),interrupt:async()=>{}};}};
  const scheduler=new Scheduler(store,client,{providers:new Map([['desktop',provider]]),clock:()=>now});t.after(()=>scheduler.stop());
  return{cwd,store,scheduler,provider,sent,state,setState:x=>state={...state,...x},advance:()=>now+=4000,draft:{title:'After desktop',cwd,provider:'desktop',threadMode:'existing',threadId:'desktop-chat',prompt:'original',trigger:{type:'afterConversation',provider:'desktop',threadId:'desktop-chat'}}};
}
test('external desktop predecessor waits, allows prompt editing, and submits once',async t=>{
  const f=fixture(t);const task=await f.scheduler.saveTask(f.draft);
  await f.scheduler.tick();assert.equal(f.sent.length,0);
  const edited=await f.scheduler.saveTask({...f.draft,prompt:'edited',revision:task.revision},task.id);
  assert.equal(edited.trigger.observation.version,'turn-1');
  f.setState({status:'waiting'});f.advance();await f.scheduler.tick();assert.equal(f.sent.length,0);
  f.setState({status:'idle'});f.advance();await f.scheduler.tick();await new Promise(r=>setImmediate(r));
  await f.scheduler.tick();assert.deepEqual(f.sent,['edited']);
});
test('a different human turn or lost desktop connection cannot satisfy a predecessor',async t=>{
  const f=fixture(t);const task=await f.scheduler.saveTask(f.draft);
  f.setState({version:'turn-2',status:'idle'});await f.scheduler.tick();
  assert.equal(task.trigger.observation.status,'uncertain');assert.equal(f.sent.length,0);
});
test('watch recovery requires review instead of treating a stopped monitor as completion',async t=>{
  const f=fixture(t);await f.scheduler.saveTask(f.draft);f.scheduler.stop();
  const client=new EventEmitter();client.defaults={};const reloaded=new Scheduler(new Store(f.store.file),client,{providers:new Map([['desktop',f.provider]])});t.after(()=>reloaded.stop());
  assert.equal(reloaded.store.data.tasks[0].trigger.observation.status,'uncertain');
});

test('an interrupted desktop watch can be explicitly rebound without resending its old turn',async t=>{
  const f=fixture(t);const task=await f.scheduler.saveTask(f.draft);
  f.setState({version:'turn-2',status:'running'});await f.scheduler.tick();
  assert.equal(task.trigger.observation.status,'uncertain');
  const rebound=await f.scheduler.saveTask({...f.draft,revision:task.revision,trigger:{...f.draft.trigger,rearm:true}},task.id);
  assert.equal(rebound.trigger.observation.version,'turn-2');
  f.setState({status:'idle'});f.advance();await f.scheduler.tick();await new Promise(r=>setImmediate(r));
  assert.deepEqual(f.sent,['original']);
});

test('WorkBuddy submission acknowledgement and old replies cannot finish a new turn; children must finish',async()=>{
  let stage=0;const cwd=process.cwd(), requestId='queue-request';let finalOutput='';
  const p=new WorkBuddyDesktop({pause:async()=>{stage++;}});p.available=true;
  p.invoke=async(method,args)=>{
    if(method==='get')return{info:{space:{type:'local',cwd},state:stage===1?'planning':stage===2?'working':'idle',hasActiveChildAgents:stage===3}};
    if(method==='requests')return{items:[{id:'old',state:'completed',assistantMessage:{content:[{type:'text',text:'old answer'}]}},...(stage>=2?[{id:requestId,state:stage>=3?'completed':'working',assistantMessage:{content:[{type:'text',text:'new answer'}]}}]:[])]};
    if(method==='sendPrompt'){assert.equal(args[2]._meta['codebuddy.ai/conversationRequestId'],requestId);return undefined;}
    throw new Error('Unexpected method '+method);
  };
  const result=await p.start({cwd,timeoutMinutes:1},{threadId:'chat',id:requestId,prompt:'new prompt'},{output:t=>finalOutput=t}).completion;
  assert.equal(result.status,'completed');assert.equal(stage,4);assert.equal(finalOutput,'new answer');
});

test('WorkBuddy local lists use the nested SDK channel and return project-scoped conversations',async()=>{
  const p=new WorkBuddyDesktop();const cwd=process.cwd();let expression;
  p.rpc={evaluate:async value=>{expression=value;return{items:[{id:'chat',title:'Project chat',space:{cwd},state:'idle'},{id:'other',space:{cwd:path.join(cwd,'other')}}]};}};
  const rows=await p.listThreads(cwd);
  assert.ok(expression.includes('wb:conversations.local:list'));
  assert.ok(expression.includes('workspacePath'));
  assert.deepEqual(rows.map(row=>({id:row.id,cwd:row.cwd})),[{id:'chat',cwd}]);
  p.rpc.evaluate=async()=>({__wbError:true,message:'SDK unavailable'});
  await assert.rejects(p.listThreads(),/SDK unavailable/);
  p.rpc.evaluate=async()=>({unexpected:[]});
  await assert.rejects(p.listThreads(),/格式不匹配/);
  let pages=0;
  p.rpc.evaluate=async()=>++pages===1?{items:Array.from({length:100},(_,i)=>({id:String(i),space:{cwd}})),total:101}:{items:[{id:'older',space:{cwd}}],total:101};
  assert.equal((await p.listThreads(cwd)).length,101);
  assert.equal(pages,2);
});
