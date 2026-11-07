import test from 'node:test';
import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import { mkdirSync, mkdtempSync, readFileSync } from 'node:fs';
import path from 'node:path';
import { CodexClient } from '../lib/codex.mjs';
import { Scheduler } from '../lib/scheduler.mjs';
import { Store } from '../lib/store.mjs';
import { samePath, containsPath } from '../lib/paths.mjs';

test('Windows project paths normalize extended prefixes, case, separators and directory boundaries', () => {
  assert.ok(samePath('\\\\?\\E:\\Repo', 'e:/repo/'));
  assert.ok(samePath('\\\\?\\UNC\\server\\share\\repo', '\\\\server\\share\\repo'));
  assert.ok(containsPath('E:\\Repo', 'e:/repo/child'));
  assert.ok(containsPath('C:\\', 'c:/repo'));
  assert.equal(containsPath('E:\\Repo', 'E:\\Repository'), false);
});

test('project pagination and most specific root select native IDs; ambiguous or stale choices fail', async () => {
  const client = new CodexClient(); const calls = [];
  client.request = async (method, params) => { calls.push({method,params}); return params.cursor
    ? {data:[{id:'nested',name:'Nested',roots:[{path:'E:\\Repo\\Child'}]}]}
    : {data:[{id:'parent',name:'Parent',roots:[{path:'E:\\Repo'}]}],nextCursor:'next'}; };
  assert.equal((await client.resolveProject('e:/repo/child/src')).id, 'nested');
  assert.equal(calls[1].params.cursor, 'next');
  await assert.rejects(client.resolveProject('E:\\Other', 'parent'), /不属于/);
  const projects = [{id:'a',rootPaths:['E:\\Repo']},{id:'b',rootPaths:['e:/repo']}];
  await assert.rejects(client.resolveProject('E:\\Repo', '', projects), /多个/);
  assert.equal(await client.resolveProject('F:\\Other', '', projects), null);
  await client.listThreads({cwd:'E:\\Repo',projectId:'parent',cursor:'page'});
  assert.equal(calls.at(-1).params.projectId, 'parent');
});

function fixture(t) {
  const base = path.resolve('test-scratch/codex-project-tests'); mkdirSync(base,{recursive:true});
  const cwd = mkdtempSync(path.join(base,'case-')), store = new Store(path.join(cwd,'tasks.json'));
  const client = new EventEmitter(); Object.assign(client,{connected:true,defaults:{},calls:[],threads:new Map()});
  client.listProjects = async () => [{id:'project-a',name:'A',rootPaths:[cwd]},{id:'project-b',name:'B',rootPaths:[cwd]}];
  client.resolveProject = CodexClient.prototype.resolveProject;
  client.connect = async () => {};
  client.releaseThread = async () => {};
  client.request = async (method, params) => {
    client.calls.push({method,params});
    if (method === 'thread/start') { const thread = {id:'thread-'+client.threads.size,cwd:params.cwd,projectId:params.projectId}; client.threads.set(thread.id,thread); return {thread}; }
    if (method === 'thread/read' || method === 'thread/resume') return {thread:client.threads.get(params.threadId)};
    if (method === 'thread/metadata/update') { const thread = client.threads.get(params.threadId); thread.projectId = params.projectId; return {thread}; }
    if (method === 'turn/start') return {turn:{id:'turn-'+client.calls.length}};
    return {};
  };
  const scheduler = new Scheduler(store,client); t.after(()=>scheduler.stop());
  const draft = {title:'Project task',cwd,provider:'codex',nativeProjectId:'project-a',threadMode:'new',prompt:'mock only',trigger:{type:'queue'}};
  return {cwd,store,client,scheduler,draft};
}

test('new task persists native project and passes it to thread creation; changing projects starts a fresh chat', async t => {
  const f=fixture(t),task=await f.scheduler.saveTask({...f.draft,trigger:{type:'time'},times:[Date.now()+60000]});
  const run=await f.scheduler.runNow(task.id);
  assert.equal(run.nativeProjectId,'project-a');
  assert.equal(f.client.calls.find(x=>x.method==='thread/start').params.projectId,'project-a');
  assert.equal(new Store(f.store.file).data.tasks[0].nativeProjectId,'project-a');
  f.client.emit('notification',{method:'turn/completed',params:{threadId:run.threadId,turn:{id:run.turnId,status:'completed'}}});
  const other=await f.scheduler.saveTask({...f.draft,nativeProjectId:'project-b',trigger:{type:'time'},times:[Date.now()+60000]},task.id);
  assert.equal(other.threadId,null);
});

test('unassigned legacy chats are assigned before resume, while another project blocks delivery', async t => {
  const f=fixture(t); f.client.threads.set('legacy',{id:'legacy',cwd:f.cwd});
  const task=await f.scheduler.saveTask({...f.draft,threadMode:'existing',threadId:'legacy'});
  await f.scheduler.runNow(task.id);
  assert.equal(f.client.threads.get('legacy').projectId,'project-a');
  assert.ok(f.client.calls.findIndex(x=>x.method==='thread/metadata/update')<f.client.calls.findIndex(x=>x.method==='turn/start'));
  const second=fixture(t); second.client.threads.set('moved',{id:'moved',cwd:second.cwd,projectId:'project-a'});
  const next=await second.scheduler.saveTask({...second.draft,threadMode:'existing',threadId:'moved'});
  second.client.threads.get('moved').projectId='project-b';
  const run=await second.scheduler.runNow(next.id);
  assert.equal(run.status,'failed'); assert.match(run.error,/其他 Codex 项目/);
  assert.equal(second.client.calls.some(x=>x.method==='turn/start'),false);
});

test('startup repairs an idle unassigned managed conversation and leaves explicit assignments intact',async t=>{
  const f=fixture(t),task=await f.scheduler.saveTask(f.draft);
  task.threadId='old'; f.client.threads.set('old',{id:'old',cwd:f.cwd,name:'Old title'});
  f.store.data.runs.push({id:'past',provider:'codex',threadId:'old',status:'completed'});
  await f.scheduler.syncCodexNames();
  assert.equal(f.client.threads.get('old').projectId,'project-a');
  assert.equal(f.store.data.runs[0].nativeProjectId,'project-a');
  f.client.threads.get('old').projectId='project-b'; f.client.calls=[];
  await f.scheduler.syncCodexNames();
  assert.equal(f.client.calls.some(x=>x.method==='thread/metadata/update'),false);
});

test('failed desktop project synchronization prevents submitting any model turn',async t=>{
  const f=fixture(t); let synchronized=false;
  f.client.syncDesktopProject=async()=>{synchronized=true;throw Error('desktop project unavailable');};
  const task=await f.scheduler.saveTask(f.draft),run=await f.scheduler.runNow(task.id);
  assert.equal(synchronized,true);assert.equal(run.status,'failed');
  assert.match(run.error,/desktop project unavailable/);
  assert.equal(f.client.calls.some(call=>call.method==='turn/start'),false);
});

test('retired instructions never dispatch and legacy archives stay byte-equivalent in persisted data', async t => {
  const f=fixture(t),task=await f.scheduler.saveTask(f.draft); task.missionId='legacy';
  f.store.data.missions=[{id:'legacy',state:'scheduled',reviews:[{evidence:'retained'}]}];
  f.store.data.fileLeases=[{id:'old',state:'held'}]; f.store.save();
  const old=JSON.parse(readFileSync(f.store.file));
  await f.scheduler.tick(); assert.equal(f.client.calls.length,0);
  assert.equal(f.scheduler.snapshot().tasks.length,0);
  await assert.rejects(f.scheduler.runNow(task.id),/停用/);
  await assert.rejects(f.scheduler.saveTask(f.draft,task.id),/停用/);
  await assert.rejects(f.scheduler.saveTask({...f.draft,trigger:{type:'afterTask',taskId:task.id}}),/停用/);
  f.scheduler.stop(); const saved=JSON.parse(readFileSync(f.store.file));
  assert.deepEqual(saved.missions,old.missions); assert.deepEqual(saved.fileLeases,old.fileLeases); assert.deepEqual(saved.tasks,old.tasks);
});
