import test from 'node:test';
import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import { mkdirSync, mkdtempSync } from 'node:fs';
import path from 'node:path';
import { Store } from '../lib/store.mjs';
import { Scheduler } from '../lib/scheduler.mjs';
import { DoubaoDesktop } from '../lib/doubao-desktop.mjs';

function fixture(t) {
  const root = path.resolve('work/chat-workspace-tests'); mkdirSync(root, {recursive:true});
  const cwd = mkdtempSync(path.join(root,'case-'));
  const store = new Store(path.join(cwd,'tasks.json'));
  const client = new EventEmitter(); client.connected = true; client.defaults = {};
  client.request = async () => { throw Error('chat must not call Codex'); };
  const provider = new DoubaoDesktop(); provider.available = true;
  const jobs = [];
  provider.start = (task, run) => {
    let finish;
    const completion = new Promise(resolve => { finish = resolve; });
    jobs.push({task,run,finish});
    return {completion, interrupt:async () => finish({status:'interrupted'})};
  };
  let now = Date.parse('2026-11-05T08:00:00+08:00');
  const scheduler = new Scheduler(store,client,{providers:new Map([[provider.id,provider]]),clock:()=>now});
  t.after(async () => {
    jobs.forEach(job => job.finish({status:'completed'}));
    await new Promise(resolve => setImmediate(resolve));
    scheduler.stop();
  });
  return {cwd,store,scheduler,provider,jobs,setNow(value){now=value;},draft:{title:'Chat task',provider:provider.id,threadMode:'new',prompt:'hello',trigger:{type:'queue'},times:[]}};
}

test('Doubao requires no project and ignores legacy archive paths',async t => {
  const f = fixture(t);
  const first = await f.scheduler.saveTask({...f.draft,cwd:f.cwd});
  assert.equal(first.cwd,'');
  first.cwd = f.cwd; // A task saved before chat/workspace capabilities were separated.
  assert.equal(f.scheduler.readiness(first).status,'ready');
  await f.scheduler.tick();
  assert.equal(f.jobs.length,1);
  assert.equal(f.jobs[0].run.fileLeaseOwner,undefined);
  const second = await f.scheduler.saveTask({...f.draft,title:'Another chat'});
  assert.match(f.scheduler.readiness(second).reason,/一次只能/);
  f.jobs[0].finish({status:'completed'}); await new Promise(resolve => setImmediate(resolve));
  second.cwd = path.join(f.cwd,'deleted-archive');
  await f.scheduler.tick();
  assert.equal(f.jobs.length,2,'a nonexistent archive path cannot stop chat dispatch');
});

test('Doubao daily recurrence waits for connection without consuming its pending slot',async t => {
  const f = fixture(t);
  const task = await f.scheduler.saveTask({...f.draft,trigger:{type:'time',recurrence:{frequency:'daily',time:'09:00'}}});
  f.setNow(task.times[0].at);
  f.provider.available = false;
  assert.match(f.scheduler.readiness(task).reason,/等待目标桌面连接/);
  await f.scheduler.tick(); assert.equal(f.jobs.length,0);
  f.provider.available = true;
  await f.scheduler.tick(); assert.equal(f.jobs.length,1);
  f.jobs[0].finish({status:'completed'}); await new Promise(resolve => setImmediate(resolve));
  f.setNow(task.times.find(slot=>slot.state==='pending').at);
  await f.scheduler.tick(); assert.equal(f.jobs.length,2);
});

test('native project selection is validated and existing conversations must belong to it',async t => {
  const f=fixture(t);
  f.provider.listProjects=async()=>[{id:'project-1',name:'Research'}];
  f.provider.inspect=async id=>({id,name:'Existing research',cwd:'',projectId:'project-1',status:'idle'});
  const task=await f.scheduler.saveTask({...f.draft,nativeProjectId:'project-1',threadMode:'existing',threadId:'456'});
  assert.equal(task.nativeProjectName,'Research');assert.equal(task.cwd,'');assert.equal(task.threadTitle,'Existing research');
  const run=await f.scheduler.runNow(task.id);assert.equal(run.nativeProjectId,'project-1');
  f.jobs[0].finish({status:'completed'});await new Promise(resolve=>setImmediate(resolve));
  await assert.rejects(f.scheduler.saveTask({...f.draft,nativeProjectId:'deleted'}),/项目未加载/);
  f.provider.inspect=async()=>({cwd:'',projectId:'other',status:'idle'});
  await assert.rejects(f.scheduler.saveTask({...f.draft,nativeProjectId:'project-1',threadMode:'existing',threadId:'456'}),/不属于所选项目/);
});

test('a chat is parallel to coding work in its former archive directory',async t => {
  const f = fixture(t);
  const chat = await f.scheduler.saveTask(f.draft);
  chat.cwd = f.cwd;
  f.scheduler.activeRuns.set('coding',{task:{id:'coding',provider:'codex',cwd:f.cwd,sandbox:'workspace-write'},run:{id:'coding',provider:'codex'}});
  assert.equal(f.scheduler.concurrencyBlocker(chat),null);
  f.scheduler.activeRuns.clear();
  f.scheduler.activeRuns.set('chat',{task:chat,run:{provider:f.provider.id}});
  assert.equal(f.scheduler.concurrencyBlocker({id:'coding',provider:'codex',cwd:f.cwd,sandbox:'workspace-write'}),null);
  f.scheduler.activeRuns.clear();
});

test('editing a recurring chat preserves its captured conversation only within the same native project',async t => {
  const f=fixture(t);
  f.provider.listProjects=async()=>[{id:'project-1',name:'Research'},{id:'project-2',name:'Other'}];
  const draft={...f.draft,nativeProjectId:'project-1',trigger:{type:'time',recurrence:{frequency:'daily',time:'09:00'}}};
  const task=await f.scheduler.saveTask(draft);
  task.threadId='captured-chat';task.cwd='F:\\legacy-archive';
  const updated=await f.scheduler.saveTask({...draft,title:'Edited'},task.id);
  assert.equal(updated.threadId,'captured-chat');assert.equal(updated.cwd,'');
  const moved=await f.scheduler.saveTask({...draft,nativeProjectId:'project-2'},task.id);
  assert.equal(moved.threadId,null,'changing project must not reuse the old project conversation');
});
