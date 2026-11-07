import test from 'node:test';
import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import { mkdtempSync, mkdirSync } from 'node:fs';
import path from 'node:path';
import { Store } from 'file:///E:/CodexScheduler/lib/store.mjs';
import { Scheduler } from 'file:///E:/CodexScheduler/lib/scheduler.mjs';
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
  assert.equal((await p.result('test',0)).status,'running');
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

function expertFixture(options={}){
  const cwd=process.cwd();const calls=[],checkpoints=[];
  const expert={id:'FixtureTeam',name:{zh:'测试团队',en:'Fixture Team'},expertType:'team',source:'builtin',namespace:'fixture',marketExpertId:'fixture-market',members:[{id:'leader'},{id:'worker'}],prompt:'Never expose this expert prompt'};
  let selected=options.initialExpert || '',state=options.state || 'idle',version=options.version || '',request=null;
  const p=new WorkBuddyDesktop({pause:async()=>{state='idle';if(request)request.state='completed';}});p.available=true;
  p.invoke=async(method,args)=>{
    calls.push({method,args});
    if(method==='get')return{info:{space:{cwd:options.cwd || cwd},state,hasActiveChildAgents:!!options.children,hasRunningBackgroundTasks:!!options.background},configManager:{expertId:selected}};
    if(method==='requests')return{items:request?[request]:version?[{id:version,state:'completed'}]:[]};
    if(method==='configSetExpertId'){
      if(options.configError)return{errorCode:'fixture-config-rejected',message:'Config rejected'};
      selected=options.wrongReadback?'DifferentTeam':args[1];
      if(options.turnAfterConfig)version='human-turn-after-config';
      return{};
    }
    if(method==='sendPrompt'){
      state='working';version=args[2].clientRequestId;
      request={id:version,clientRequestId:version,state:'working',assistantMessage:{content:[{type:'text',text:'fixture complete'}]}};
      return undefined;
    }
    if(method==='create')return{info:{id:'new-fixture-chat'}};
    throw new Error('Unexpected conversation call '+method);
  };
  p.expertsInvoke=async(method,args)=>{
    calls.push({method:'experts:'+method,args});
    if(method==='list'){
      if(options.turnDuringCatalog)version='human-turn-during-catalog';
      return{items:[expert],total:1};
    }
    if(method==='get')return{...expert,expertType:options.detailType || 'team'};
    throw new Error('Unexpected expert call '+method);
  };
  const hooks={checkpoint:point=>checkpoints.push(point),output(){},log(){},thread(){}};
  const task={cwd,timeoutMinutes:1,desktopExpertId:'FixtureTeam'};
  const run={threadId:'fixture-chat',id:'fixture-request',prompt:'Do the owned fixture work',startedAt:Date.now()};
  return{p,cwd,calls,checkpoints,hooks,task,run};
}

test('WorkBuddy expert catalog uses only whitelisted SDK channels and redacts prompt fields',async()=>{
  const p=new WorkBuddyDesktop();const expressions=[];
  p.rpc={evaluate:async text=>{expressions.push(text);return{items:[{id:'FixtureTeam',name:{zh:'测试团队'},expertType:'team',source:'builtin',marketExpertId:'fixture-market',prompt:'secret instructions',credentials:{password:'secret'}}],total:1};}};
  const catalog=await p.getExpertCatalog();
  assert.equal(catalog.experts[0].name,'测试团队');assert.equal(catalog.complete,true);
  assert.ok(expressions[0].includes('wb:experts:list'));assert.ok(expressions[0].includes('pageSize'));
  assert.ok(!JSON.stringify(catalog).includes('secret'));
  await assert.rejects(p.expertsInvoke('configure'),/不支持/);
});

test('WorkBuddy project options come from native conversation directories and deduplicate paths',async()=>{
  const p=new WorkBuddyDesktop(),cwd=process.cwd(),other=path.join(cwd,'other');let reads=0;
  p.invoke=async(method)=>{assert.equal(method,'local:list');reads++;return{items:[
    {id:'first',space:{cwd}}, {id:'same',space:{cwd:cwd.toUpperCase()}},
    {id:'other',cwd:other}, {id:'missing'}, {id:'relative',cwd:'relative-project'}
  ]};};
  const projects=await p.listProjects();
  assert.equal(reads,1);assert.deepEqual(projects.map(project=>project.cwd),[cwd,other]);
  assert.deepEqual(projects[0],{id:cwd,name:path.basename(cwd),cwd,rootPaths:[cwd]});
});

test('WorkBuddy team selection verifies actual type and readback before one send and saves checkpoint',async()=>{
  const f=expertFixture();const result=await f.p.start(f.task,f.run,f.hooks).completion;
  assert.equal(result.status,'completed');
  const setters=f.calls.filter(c=>c.method==='configSetExpertId');assert.equal(setters.length,1);
  assert.deepEqual(setters[0].args,['fixture-chat','FixtureTeam',{locale:'zh',marketExpertId:'fixture-market'}]);
  assert.equal(f.calls.filter(c=>c.method==='sendPrompt').length,1);
  assert.ok(f.calls.findIndex(c=>c.method==='configSetExpertId')<f.calls.findIndex(c=>c.method==='sendPrompt'));
  const checkpoint=f.checkpoints.find(p=>p.phase==='sent');
  assert.equal(checkpoint.desktopExpert.expertType,'team');assert.equal(checkpoint.desktopExpert.configurationVerified,true);
  assert.equal(checkpoint.desktopExpert.backgroundExecutionVerified,false);
  assert.deepEqual(checkpoint.desktopExpert.configurationVerifiedFields,['expertId']);
  assert.equal(checkpoint.desktopExpert.optionsReadbackAvailable,false);
  assert.equal(checkpoint.desktopExpert.memberCount,2);
  assert.equal(checkpoint.deadline,f.run.startedAt+60000);
});

test('WorkBuddy target lookup stops on a full first page without claiming a complete catalog',async()=>{
  const f=expertFixture();const original=f.p.expertsInvoke;
  f.p.expertsInvoke=async(method,args)=>{
    if(method!=='list')return original(method,args);
    f.calls.push({method:'experts:list',args});
    if(args[0].page>1)return{items:[{id:'SecondPageTeam',name:'Second page',expertType:'team'}]};
    return{items:Array.from({length:100},(_,i)=>({id:i===48?'FixtureTeam':'OtherTeam'+i,name:'Team '+i,expertType:'team',marketExpertId:i===48?'fixture-market':'market-'+i}))};
  };
  const targeted=await f.p.getExpertCatalog({expertId:'FixtureTeam'});
  assert.equal(targeted.complete,false);assert.equal(targeted.experts.length,100);
  assert.equal(f.calls.filter(c=>c.method==='experts:list').length,1);
  f.calls.length=0;
  const result=await f.p.start(f.task,f.run,f.hooks).completion;
  assert.equal(result.status,'completed');
  assert.equal(f.calls.filter(c=>c.method==='experts:list').length,1);
  assert.equal(f.calls.filter(c=>c.method==='configSetExpertId').length,1);
  assert.equal(f.calls.filter(c=>c.method==='sendPrompt').length,1);
  f.calls.length=0;
  const full=await f.p.getExpertCatalog();
  assert.equal(full.complete,true);assert.equal(full.experts.length,101);
  assert.equal(f.calls.filter(c=>c.method==='experts:list').length,2);
  f.calls.length=0;
  const missing=await f.p.getExpertCatalog({expertId:'AbsentTeam'});
  assert.equal(missing.complete,true);assert.equal(missing.experts.some(item=>item.id==='AbsentTeam'),false);
  assert.equal(f.calls.filter(c=>c.method==='experts:list').length,2);
});

test('WorkBuddy expert configuration rejects busy children/background or wrong cwd without configuring or sending',async()=>{
  for(const options of [{state:'working'},{children:true},{background:true},{cwd:path.join(process.cwd(),'wrong')}]){
    const f=expertFixture(options);const result=await f.p.start(f.task,f.run,f.hooks).completion;
    assert.equal(result.status,'failed');
    assert.equal(f.calls.filter(c=>c.method==='configSetExpertId'||c.method==='sendPrompt').length,0);
  }
});

test('WorkBuddy unknown expert ID, non-team details, config errors and mismatched readback never send',async()=>{
  for(const options of [{missing:true},{detailType:'individual'},{configError:true},{wrongReadback:true}]){
    const f=expertFixture(options);if(options.missing)f.task.desktopExpertId='UnknownFixtureTeam';
    const result=await f.p.start(f.task,f.run,f.hooks).completion;
    assert.equal(result.status,'failed');assert.equal(f.calls.filter(c=>c.method==='sendPrompt').length,0);
  }
});

test('WorkBuddy refuses another human turn during expert lookup or configuration even when idle',async()=>{
  for(const options of [{turnDuringCatalog:true},{turnAfterConfig:true}]){
    const f=expertFixture(options);const result=await f.p.start(f.task,f.run,f.hooks).completion;
    assert.equal(result.status,'failed');assert.match(result.error,/另一轮/);
    assert.equal(f.calls.filter(c=>c.method==='sendPrompt').length,0);
    if(options.turnDuringCatalog)assert.equal(f.calls.filter(c=>c.method==='configSetExpertId').length,0);
  }
});

test('WorkBuddy no expert parameter preserves the default and performs no expert SDK operations',async()=>{
  const f=expertFixture();delete f.task.desktopExpertId;
  const result=await f.p.start(f.task,f.run,f.hooks).completion;
  assert.equal(result.status,'completed');assert.equal(f.calls.filter(c=>c.method.startsWith('experts:')||c.method==='configSetExpertId').length,0);
  assert.equal(f.calls.filter(c=>c.method==='sendPrompt').length,1);
  assert.ok(f.checkpoints.every(c=>!c.desktopExpert));
});

test('WorkBuddy new runs create native conversations while continuation reuses its exact target',async()=>{
  const f=expertFixture();delete f.task.desktopExpertId;f.run.threadId=null;
  let captured;f.hooks.thread=id=>{captured=id;};
  assert.equal((await f.p.start(f.task,f.run,f.hooks).completion).status,'completed');
  assert.equal(captured,'new-fixture-chat');assert.equal(f.calls.filter(call=>call.method==='create').length,1);
  f.calls.length=0;f.run.threadId=captured;
  assert.equal((await f.p.start(f.task,f.run,f.hooks).completion).status,'completed');
  assert.equal(f.calls.some(call=>call.method==='create'),false);
  assert.equal(f.calls.find(call=>call.method==='sendPrompt').args[0],captured);
});

test('WorkBuddy resumed team request only observes and never reconfigures or resends',async()=>{
  const f=expertFixture();await f.p.start(f.task,f.run,f.hooks).completion;
  const monitor=f.checkpoints.find(p=>p.phase==='sent');f.calls.length=0;
  const result=await f.p.resume(f.task,{...f.run,desktopMonitor:monitor},f.hooks).completion;
  assert.equal(result.status,'completed');
  assert.equal(f.calls.filter(c=>c.method.startsWith('experts:')||c.method==='configSetExpertId'||c.method==='sendPrompt').length,0);
});

function transientRequestFixture(otherHuman=false){
  const f=expertFixture();let sent=false,pauses=0;
  const original=f.p.invoke;
  f.p.pause=async()=>{pauses++;};
  f.p.invoke=async(method,args)=>{
    if(method==='get')return{info:{space:{cwd:f.cwd},state:sent&&pauses<2?'working':'idle'},configManager:{expertId:sent?'FixtureTeam':''}};
    if(method==='requests'){
      if(!sent)return{items:[]};
      const request={id:'sdk-canonical-request',conversationRequestId:'sdk-canonical-request',state:pauses<2?'working':'completed',assistantMessage:{content:[{type:'text',text:'canonical final reply'}]},...(pauses<2?{clientRequestId:f.run.id}:{})};
      return{items:otherHuman&&pauses>=2?[request,{id:'another-human-request',state:'completed',assistantMessage:{content:[{type:'text',text:'wrong replacement'}]}}]:[request]};
    }
    const result=await original(method,args);if(method==='sendPrompt')sent=true;return result;
  };
  // The setter readback before send must still reflect the actual fixture selection.
  const withReadback=f.p.invoke;let configured=false;
  f.p.invoke=async(method,args)=>{const result=await withReadback(method,args);if(method==='configSetExpertId')configured=true;if(method==='get'&&configured)result.configManager.expertId='FixtureTeam';return result;};
  return f;
}

test('WorkBuddy retains canonical SDK request ID after streaming clientRequestId disappears and resumes without sending',async()=>{
  const f=transientRequestFixture();const result=await f.p.start(f.task,f.run,f.hooks).completion;
  assert.equal(result.status,'completed');
  const monitor=f.checkpoints.findLast(p=>p.phase==='sent');
  assert.equal(monitor.conversationRequestId,'sdk-canonical-request');assert.equal(monitor.requestId,f.run.id);
  assert.equal(monitor.deadline,f.run.startedAt+60000);assert.equal(monitor.desktopExpert.configurationVerified,true);
  const run={...f.run,desktopMonitor:monitor};f.calls.length=0;
  assert.equal(await f.p.recoveryState(f.task,run),'completed');
  assert.equal((await f.p.resume(f.task,run,f.hooks).completion).status,'completed');
  assert.equal(f.calls.filter(c=>c.method==='sendPrompt'||c.method==='configSetExpertId'||c.method.startsWith('experts:')).length,0);
  await assert.rejects(f.p.recoveryState(f.task,{...run,desktopMonitor:{...monitor,conversationRequestId:undefined}}),/真实请求编号/);
});

test('WorkBuddy another human turn cannot replace a saved canonical request in start or recovery',async()=>{
  const f=transientRequestFixture(true);const result=await f.p.start(f.task,f.run,f.hooks).completion;
  assert.equal(result.status,'uncertain');assert.match(result.error,/另一轮/);
  const run={...f.run,desktopMonitor:f.checkpoints.findLast(p=>p.phase==='sent')};
  await assert.rejects(f.p.recoveryState(f.task,run),/另一轮/);
  f.calls.length=0;const resumed=await f.p.resume(f.task,run,f.hooks).completion;
  assert.equal(resumed.status,'uncertain');assert.match(resumed.error,/另一轮/);
  assert.equal(f.calls.filter(c=>c.method==='sendPrompt'||c.method==='configSetExpertId'||c.method.startsWith('experts:')).length,0);
});

test('WorkBuddy expired deadline does not reset timeout after expert setup or create/send anything',async()=>{
  const f=expertFixture();f.run.startedAt=Date.now()-120000;
  const result=await f.p.start(f.task,f.run,f.hooks).completion;
  assert.equal(result.status,'failed');assert.match(result.error,/时限/);assert.equal(f.calls.length,0);
});
