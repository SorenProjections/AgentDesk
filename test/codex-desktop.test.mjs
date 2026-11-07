import test from 'node:test';
import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import { mkdtempSync, mkdirSync } from 'node:fs';
import path from 'node:path';
import { CodexDesktop } from '../lib/codex-desktop.mjs';
import { Store } from '../lib/store.mjs';
import { Scheduler } from '../lib/scheduler.mjs';

function fixture({existing=false,failSend=false,reads}={}) {
  const calls=[],run={execution:'desktop',prompt:'Hello',...(existing?{threadId:'native-thread'}:{})};
  let readIndex=0;
  const desktop=new CodexDesktop({pause:async()=>{},invoke:async(tool,args)=>{
    calls.push({tool,args});
    if(tool==='list_projects')return{projects:[{projectId:'native-project',projectKind:'local',hostId:'local',label:'Project',path:process.cwd()}]};
    if(tool==='list_threads')return{threads:[{id:'native-thread',projectId:'native-project'}]};
    if(tool==='create_thread'||tool==='send_message_to_thread'){
      if(failSend)throw Error('connection lost');
      return{threadId:'native-thread'};
    }
    if(tool==='read_thread')return reads?.[readIndex++]||{thread:{status:{type:'idle'}},turns:[{id:'new-turn',status:'completed',items:[{type:'agentMessage',text:'Done'}]}]};
    throw Error('Unexpected tool '+tool);
  }});
  const task={cwd:process.cwd(),nativeProjectId:'native-project',title:'Native task',timeoutMinutes:2};
  const hooks={thread:id=>{run.threadId=id;},checkpoint:value=>{run.desktopMonitor=value;},project:(id)=>{run.project=id;},output:value=>{run.output=value;}};
  return{desktop,task,run,hooks,calls};
}

test('new Codex tasks execute in the native project without permission or model overrides',async()=>{
  const f=fixture();
  const result=await f.desktop.start(f.task,f.run,f.hooks).completion;
  assert.equal(result.status,'completed');assert.equal(f.run.project,'native-project');assert.equal(f.run.output,'Done');
  assert.deepEqual(f.calls.find(c=>c.tool==='create_thread').args,{title:'Native task',prompt:'Hello',target:{type:'project',projectId:'native-project',environment:{type:'local'}}});
  assert.equal(f.calls.filter(c=>c.tool==='create_thread').length,1);
});

test('projectless native tasks and explicitly selected model settings reach the client',async()=>{
  const f=fixture();delete f.task.nativeProjectId;f.task.model='chosen-model';f.task.effort='high';
  assert.equal((await f.desktop.start(f.task,f.run,f.hooks).completion).status,'completed');
  const args=f.calls.find(call=>call.tool==='create_thread').args;
  assert.deepEqual(args.target,{type:'projectless'});assert.equal(args.model,'chosen-model');assert.equal(args.thinking,'high');
});

test('continuation ignores every prior turn and observes only the newly submitted turn',async()=>{
  const old={id:'old',status:'completed',items:[{type:'agentMessage',text:'Wrong result'}]};
  const f=fixture({existing:true,reads:[
    {thread:{status:{type:'idle'}},turns:[old,{...old,id:'older'}]},
    {thread:{status:{type:'active'}},turns:[old]},
    {thread:{status:{type:'idle'}},turns:[{id:'new',status:'completed',items:[{type:'agentMessage',text:'Correct result'}]},old]},
  ]});
  assert.equal((await f.desktop.start(f.task,f.run,f.hooks).completion).status,'completed');
  assert.equal(f.run.output,'Correct result');assert.equal(f.run.desktopMonitor.turnId,'new');
  assert.equal(f.calls.filter(c=>c.tool==='send_message_to_thread').length,1);
});

test('ambiguous delivery is never automatically retried',async()=>{
  const f=fixture({failSend:true});
  assert.equal((await f.desktop.start(f.task,f.run,f.hooks).completion).status,'uncertain');
  assert.equal(f.run.desktopMonitor.phase,'dispatching');assert.equal(f.calls.filter(c=>c.tool==='create_thread').length,1);
  assert.equal(f.desktop.canResume(f.run),false);
});

test('a conversation moved to another project cannot receive a scheduled continuation',async()=>{
  const f=fixture({existing:true});const invoke=f.desktop.invoke;
  f.desktop.invoke=(tool,args)=>tool==='list_threads'?Promise.resolve({threads:[{id:'native-thread',projectId:'another-project'}]}):invoke(tool,args);
  const result=await f.desktop.start(f.task,f.run,f.hooks).completion;
  assert.equal(result.status,'uncertain');assert.match(result.error,/项目/);
  assert.equal(f.calls.filter(c=>c.tool==='send_message_to_thread').length,0);
});

test('restoring observation never submits another message',async()=>{
  const f=fixture();f.run.threadId='native-thread';f.run.desktopMonitor={phase:'sent',threadId:'native-thread',turnId:'new-turn',deadline:Date.now()+60000};
  assert.equal((await f.desktop.resume(f.task,f.run,f.hooks).completion).status,'completed');
  assert.deepEqual(f.calls.map(c=>c.tool),['read_thread']);
});

test('stopping monitoring leaves the native client task running',async()=>{
  const f=fixture();let onPoll;
  const polled=new Promise(resolve=>{onPoll=resolve;});
  f.desktop.pause=()=>{onPoll();return new Promise(()=>{});};
  f.run.threadId='native-thread';f.run.desktopMonitor={phase:'sent',threadId:'native-thread',deadline:Date.now()+60000};
  f.desktop.invoke=async(tool)=>{f.calls.push({tool});return{thread:{status:{type:'active'}},turns:[{id:'running-turn',status:'inProgress',items:[]}]};};
  const handle=f.desktop.resume(f.task,f.run,f.hooks);await polled;await handle.interrupt();
  assert.equal((await handle.completion).status,'uncertain');assert.deepEqual(f.calls.map(c=>c.tool),['read_thread']);
});

test('the scheduler dispatches Codex through the native client without starting a separate executor',async t=>{
  const scratch=path.resolve('work/scheduler-tests');mkdirSync(scratch,{recursive:true});
  const store=new Store(path.join(mkdtempSync(path.join(scratch,'native-')),'tasks.json'));
  const client=new EventEmitter();client.connected=false;client.defaults={};client.request=()=>{throw Error('Independent executor must not be used');};
  const f=fixture();await f.desktop.probe();
  const scheduler=new Scheduler(store,client,{codexDesktop:f.desktop});t.after(()=>scheduler.stop());
  const draft={title:'Native scheduler task',nativeProjectId:'native-project',provider:'codex',threadMode:'new',prompt:'Hello',trigger:{type:'queue'},times:[]};
  const task=await scheduler.saveTask(draft);
  assert.equal(task.cwd,process.cwd(),'Project selection alone determines the directory');
  const stale=await scheduler.saveTask({...draft,cwd:'Z:\\obsolete-folder'});
  assert.equal(stale.cwd,process.cwd(),'A stale hidden directory cannot override the selected project');
  const projectless=await scheduler.saveTask({...draft,nativeProjectId:''});
  assert.equal(projectless.cwd,'');
  const run=await scheduler.runNow(task.id);
  await new Promise(resolve=>setImmediate(resolve));
  assert.equal(run.execution,'desktop');assert.equal(run.status,'completed');assert.equal(run.threadId,'native-thread');assert.equal(run.projectSyncStatus,'native');
  assert.equal(run.codexThreadState,undefined);assert.equal(run.effectivePermissions,undefined);
});
