import test from 'node:test';
import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import { mkdirSync, mkdtempSync } from 'node:fs';
import path from 'node:path';
import { Scheduler } from '../lib/scheduler.mjs';
import { Store } from '../lib/store.mjs';
import { DoubaoDesktop } from '../lib/doubao-desktop.mjs';
import { WorkBuddyDesktop, AntigravityDesktop } from '../lib/desktop.mjs';
import { SessionHub } from '../lib/sessions.mjs';

const flush=()=>new Promise(resolve=>setImmediate(resolve));
function fixture(t,Provider) {
  const base=path.resolve('work/scheduled-integration');mkdirSync(base,{recursive:true});
  const cwd=mkdtempSync(path.join(base,'case-')),store=new Store(path.join(cwd,'tasks.json'));
  const client=new EventEmitter();client.defaults={};client.connected=false;
  const provider=new Provider();provider.available=true;const jobs=[];
  provider.inspect=async id=>({id,cwd,status:'idle',name:'Existing task conversation'});
  provider.start=(task,run,hooks)=>{
    const target=run.threadId;hooks.thread(target||`chat-${jobs.length+1}`);
    let finish;const completion=new Promise(resolve=>finish=resolve);jobs.push({target,run,finish});
    return{completion,interrupt:async()=>finish({status:'interrupted'})};
  };
  let now=Date.parse('2026-11-07T08:00:00+08:00');
  const providers=new Map([[provider.id,provider]]),clock=()=>now;
  const scheduler=new Scheduler(store,client,{providers,clock});
  t.after(async()=>{for(const job of jobs)job.finish({status:'completed'});await flush();scheduler.stop();});
  return {cwd,store,client,provider,providers,clock,scheduler,jobs,setNow:value=>now=value,draft:{title:'Daily report',provider:provider.id,cwd,threadMode:'new',prompt:'Check and report',trigger:{type:'time',recurrence:{frequency:'daily',time:'09:00'}}}};
}

for(const Provider of [DoubaoDesktop,WorkBuddyDesktop,AntigravityDesktop]) {
  for(const mode of ['new','reuse','existing'])test(`${Provider.name}: ${mode} applies to manual runs, recurring runs and restart`,async t=>{
    const f=fixture(t,Provider);
    const task=await f.scheduler.saveTask({...f.draft,threadMode:mode,...(mode==='existing'?{threadId:'selected-chat'}:{})});
    const pending=task.times[0].at;
    const manual=await f.scheduler.runNow(task.id);f.jobs[0].finish({status:'completed'});await flush();
    assert.equal(task.times[0].at,pending);assert.equal(task.times[0].state,'pending');
    f.setNow(pending);await f.scheduler.tick();f.jobs[1].finish({status:'completed'});await flush();
    f.scheduler.stop();
    const reloaded=new Store(f.store.file),restarted=new Scheduler(reloaded,f.client,{providers:f.providers,clock:f.clock});t.after(()=>restarted.stop());
    f.setNow(restarted.getTask(task.id).times.find(slot=>slot.state==='pending').at);await restarted.tick();f.jobs[2].finish({status:'completed'});await flush();
    const runs=reloaded.data.runs;
    assert.equal(runs.length,3);assert.ok(runs.every(run=>run.status==='completed'&&run.prompt===f.draft.prompt));
    if(mode==='new'){assert.equal(new Set(runs.map(run=>run.threadId)).size,3);assert.ok(f.jobs.every(job=>job.target===null));}
    else {assert.equal(new Set(runs.map(run=>run.threadId)).size,1);assert.equal(runs[2].threadId,manual.threadId);}
  });
  test(`${Provider.name}: pause, weekly schedule and successful record archival survive persistence`,async t=>{
    const f=fixture(t,Provider),task=await f.scheduler.saveTask({...f.draft,notificationPolicy:'errors',archiveSuccessful:true,trigger:{type:'time',recurrence:{frequency:'weekly',time:'09:00',weekdays:[1,5]}}});
    f.scheduler.pause(task.id,true);f.setNow(task.times[0].at);await f.scheduler.tick();assert.equal(f.jobs.length,0);
    f.scheduler.pause(task.id,false);await f.scheduler.tick();const run=f.jobs[0].run;
    assert.equal(run.notificationPolicy,'errors');
    f.jobs[0].finish({status:'completed'});await flush();
    const saved=new Store(f.store.file).data;assert.ok(saved.runs[0].archivedAt);assert.equal(saved.runs[0].status,'completed');assert.equal(saved.tasks[0].archiveSuccessful,true);
    assert.ok(task.times.find(slot=>slot.state==='pending').at>f.clock());
  });
}

test('new schedules ignore an old chat that is now running under a different task',async t=>{
  const f=fixture(t,WorkBuddyDesktop),task=await f.scheduler.saveTask(f.draft);task.threadId='old-chat';
  f.scheduler.activeRuns.set('other',{task:{id:'other'},run:{provider:task.provider,threadId:'old-chat'}});
  assert.equal(f.scheduler.concurrencyBlocker(task),null);f.scheduler.activeRuns.clear();
  await f.scheduler.runNow(task.id);assert.equal(f.jobs[0].target,null);
});

for(const policy of ['all','errors','none'])test(`per-run ${policy} notifications cover instant completion and keep policy after edits`,async t=>{
  const f=fixture(t,WorkBuddyDesktop),hub=new SessionHub(f.store);t.after(()=>hub.close());
  for(const [i,status] of ['completed','failed'].entries()) {
    f.store.data.runs.push({id:`notice-${i}`,taskId:'deleted-task',provider:f.provider.id,threadId:`notice-chat-${i}`,taskTitle:'Report',notificationPolicy:policy,status,startedAt:100,endedAt:200});
    hub.syncRuns();
  }
  assert.deepEqual(hub.snapshot().notifications.map(note=>note.kind).sort(),policy==='none'?[]:policy==='errors'?['failed']:['completed','failed']);
  hub.syncRuns();assert.equal(hub.snapshot().notifications.length,policy==='none'?0:policy==='errors'?1:2);
});
