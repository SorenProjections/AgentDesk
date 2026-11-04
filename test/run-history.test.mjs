import test from 'node:test';
import assert from 'node:assert/strict';
import {EventEmitter} from 'node:events';
import {mkdirSync,mkdtempSync} from 'node:fs';
import path from 'node:path';
import {Store} from '../lib/store.mjs';
import {updateRunHistory,updateRunHistories,runHistoryRoutes} from '../lib/run-history.mjs';

function fixture(){
  const root=path.resolve('work/history-tests');mkdirSync(root,{recursive:true});
  const store=new Store(path.join(mkdtempSync(path.join(root,'case-')),'tasks.json'));
  store.data.runs=[{id:'run-1',taskId:'old-task',status:'uncertain',threadId:'thread',error:'Transport lost',output:'Partial evidence'}];
  store.data.fileLeases=[{owner:'mission',runId:'run-1',state:'held'}];
  store.data.tasks=[{id:'successor',trigger:{type:'afterTask',runId:'run-1'}}];
  const scheduler=new EventEmitter();scheduler.activeRuns=new Map();
  return {store,scheduler};
}
test('handling and deleting old history persists without approving execution, releasing leases or erasing dependency evidence',()=>{
  const f=fixture();const apply=action=>updateRunHistory(f.store,f.scheduler,'run-1',action,()=>123);
  apply('dismiss');assert.equal(f.store.data.runs[0].attentionHandledAt,123);
  apply('delete');apply('delete');
  const restored=new Store(f.store.file);
  assert.equal(restored.data.runs[0].deletedAt,123);
  assert.equal(restored.data.runs[0].status,'uncertain');
  assert.equal(restored.data.runs[0].output,'Partial evidence');
  assert.equal(restored.data.fileLeases[0].state,'held');
  assert.equal(restored.data.tasks[0].trigger.runId,'run-1');
  apply('restore');assert.equal(f.store.data.runs[0].deletedAt,undefined);
  apply('remind');assert.equal(f.store.data.runs[0].attentionHandledAt,undefined);
});
test('live runs and invalid history mutations are rejected before saving',()=>{
  const f=fixture();
  for(const status of ['dispatching','running','waiting']){
    f.store.data.runs[0].status=status;
    for(const action of ['delete','dismiss','restore','remind'])assert.throws(()=>updateRunHistory(f.store,f.scheduler,'run-1',action),/运行中/);
  }
  f.store.data.runs[0].status='uncertain';f.scheduler.activeRuns.set('run-1',{});
  assert.throws(()=>updateRunHistory(f.store,f.scheduler,'run-1','delete'),/运行中/);
  f.scheduler.activeRuns.clear();
  assert.throws(()=>updateRunHistory(f.store,f.scheduler,'run-1','complete'),/操作无效/);
  assert.throws(()=>updateRunHistory(f.store,f.scheduler,'missing','delete'),/不存在/);
  assert.equal(f.store.data.runs[0].deletedAt,undefined);
});
test('history route accepts only the explicit mutation endpoint',async()=>{
  const f=fixture();let result;
  const args={...f,body:async()=>({action:'delete'}),send:(_response,status,data)=>{result={status,data};}};
  const url=new URL('http://127.0.0.1/api/runs/run-1/history');
  assert.equal(await runHistoryRoutes({method:'GET'},{},url,args),false);
  assert.equal(await runHistoryRoutes({method:'POST'},{},url,args),true);
  assert.equal(result.status,200);assert.ok(result.data.deletedAt);
});

test('bulk history mutation validates every record before changing any, and can restore the whole selection',()=>{
  const f=fixture();f.store.data.runs.push({id:'live',status:'running'},{id:'old-2',status:'completed',output:'result'});
  assert.throws(()=>updateRunHistories(f.store,f.scheduler,['run-1','live'],'delete'),/运行中/);
  assert.equal(f.store.data.runs[0].deletedAt,undefined);
  assert.throws(()=>updateRunHistories(f.store,f.scheduler,['run-1','missing'],'delete'),/不存在/);
  assert.equal(f.store.data.runs[0].deletedAt,undefined);
  const rows=updateRunHistories(f.store,f.scheduler,['run-1','old-2','run-1'],'delete',()=>456);
  assert.equal(rows.length,2);assert.ok(rows.every(row=>row.deletedAt===456));
  updateRunHistories(f.store,f.scheduler,['run-1','old-2'],'restore');
  assert.equal(f.store.data.runs[2].output,'result');assert.equal(f.store.data.runs[2].deletedAt,undefined);
});
