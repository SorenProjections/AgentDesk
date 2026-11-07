import test from 'node:test';
import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import { mkdtempSync, mkdirSync, readFileSync } from 'node:fs';
import path from 'node:path';
import { Store } from '../lib/store.mjs';
import { Scheduler } from '../lib/scheduler.mjs';
import { validateDesktopExpertId } from '../lib/desktop-expert.mjs';
import { desktopExpertRoutes } from '../lib/desktop-expert-routes.mjs';
import { main } from '../scripts/agentdesk.mjs';

const scratch=path.resolve('test-scratch/expert-control');mkdirSync(scratch,{recursive:true});
function fixture(t){
  const cwd=mkdtempSync(path.join(scratch,'case-')),store=new Store(path.join(cwd,'tasks.json'));
  const client=new EventEmitter();client.connected=true;client.defaults={};
  const starts=[];
  const p={id:'workbuddyDesktop',snapshot:()=>({id:'workbuddyDesktop',available:true,capabilities:{resume:true,desktop:true}}),
    inspect:async id=>({id,cwd,status:'idle'}),start(task,run){starts.push({task:{...task},run:{...run}});return{completion:Promise.resolve({status:'failed',error:'mock completion only; no SDK send'}),interrupt:async()=>{}};}};
  const ag={...p,id:'antigravityDesktop'};
  const scheduler=new Scheduler(store,client,{providers:new Map([['workbuddyDesktop',p],['antigravityDesktop',ag]])});
  t.after(async()=>{scheduler.stop();});
  const task={title:'Direct fixture',prompt:'mock prompt',cwd,provider:'workbuddyDesktop',threadMode:'new',trigger:{type:'queue'}};
  return{cwd,store,scheduler,task,starts};
}
test('expert ID optional omission, strict validation, trim and workbuddy-only restriction',()=>{
  assert.equal(validateDesktopExpertId(undefined,'codex'),undefined);
  assert.equal(validateDesktopExpertId('  fixture-team-id  ','workbuddyDesktop'),'fixture-team-id');
  for(const value of [null,'','  ',42,true,{},'x'.repeat(121),'id\nbad','id\0bad'])assert.throws(()=>validateDesktopExpertId(value,'workbuddyDesktop'));
  for(const provider of ['codex','workbuddy','antigravityDesktop'])assert.throws(()=>validateDesktopExpertId('fixture-team-id',provider),/workbuddyDesktop/);
});
test('direct task edits preserve omitted expert and reject null and provider changes',async t=>{
  const f=fixture(t),task=await f.scheduler.saveTask({...f.task,desktopExpertId:'fixture-team-id'});
  const changed=await f.scheduler.saveTask({...f.task,revision:task.revision,prompt:'edited'},task.id);
  assert.equal(changed.desktopExpertId,'fixture-team-id');
  await assert.rejects(f.scheduler.saveTask({...f.task,desktopExpertId:null},task.id),/desktopExpertId/);
  await assert.rejects(f.scheduler.saveTask({...f.task,provider:'codex'},task.id),/desktopExpertId/);
});
test('expert catalog route is read-only GET and delegates existing provider method once',async()=>{
  let calls=0,sent;
  const p={getExpertCatalog:async()=>{calls++;return{provider:'workbuddyDesktop',experts:[{id:'fixture-team-id',name:'Fixture team'}]};}};
  const options={providers:new Map([['workbuddyDesktop',p]]),send:(_,status,value)=>sent={status,value}};
  const url=new URL('http://127.0.0.1/api/desktop/workbuddy/experts');
  assert.equal(await desktopExpertRoutes({method:'GET'},{},url,options),true);
  assert.equal(sent.status,200);assert.equal(calls,1);
  assert.equal(await desktopExpertRoutes({method:'POST'},{},url,options),false);assert.equal(calls,1);
});
test('CLI experts performs catalog GET; create JSON preserves optional selection',async t=>{
  const calls=[],previous=globalThis.fetch;t.after(()=>globalThis.fetch=previous);
  globalThis.fetch=async(url,options={})=>{
    calls.push({url,options});
    if(url.endsWith('/health'))return new Response(JSON.stringify({type:'codex-local-scheduler'}));
    if(url.endsWith('/'))return new Response('',{headers:{'set-cookie':'scheduler_session=fixture'}});
    return new Response(JSON.stringify({ok:true}));
  };
  await main(['experts']);
  const get=calls.at(-1);assert.ok(get.url.endsWith('/api/desktop/workbuddy/experts'));assert.equal(get.options.method,'GET');
  await main(['create','--json',JSON.stringify({desktopExpertId:'fixture-team-id',provider:'workbuddyDesktop'})]);
  const post=calls.at(-1);assert.equal(post.options.method,'POST');assert.equal(JSON.parse(post.options.body).desktopExpertId,'fixture-team-id');
  const before=calls.length;await assert.rejects(main(['experts','--provider','codex']),/workbuddyDesktop/);assert.equal(calls.length,before);
});
