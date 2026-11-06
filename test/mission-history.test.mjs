import test from 'node:test';
import assert from 'node:assert/strict';
import {EventEmitter} from 'node:events';
import {mkdirSync,mkdtempSync} from 'node:fs';
import path from 'node:path';
import {Store} from '../lib/store.mjs';
import {Supervision} from '../lib/supervision.mjs';
import {updateMissionHistory} from '../lib/mission-history.mjs';
import {supervisionRoutes} from '../lib/supervision-routes.mjs';

function fixture(){
  const root=path.resolve('work/mission-history-tests');mkdirSync(root,{recursive:true});
  const store=new Store(path.join(mkdtempSync(path.join(root,'case-')),'tasks.json'));
  const scheduler=new EventEmitter();scheduler.activeRuns=new Map();scheduler.providers=new Map();
  scheduler.pause=(id,paused)=>{store.data.tasks.find(task=>task.id===id).paused=paused;};
  const supervision=new Supervision(store,scheduler,{clock:()=>123});
  store.data.missions.push({id:'old',title:'Old mission',state:'scheduled',instructions:[{state:'queued',taskId:'queued'}],reviews:[{id:'evidence',state:'failed',packet:{output:'proof'}}]});
  store.data.tasks.push({id:'queued',missionId:'old',paused:false},{id:'other-task',paused:false});
  store.data.fileLeases.push({id:'lease',owner:'old',state:'held'});
  return {store,scheduler,supervision};
}
test('mission deletion pauses future sends, retains evidence and leases, and restore cannot silently dispatch',()=>{
  const f=fixture();const m=f.store.data.missions[0];
  updateMissionHistory(f.supervision,['old'],'delete');
  assert.equal(m.state,'paused');assert.equal(m.pausedFrom,'scheduled');assert.equal(m.deletedAt,123);
  assert.equal(f.store.data.tasks[0].paused,true);assert.equal(f.store.data.tasks[1].paused,false);
  assert.equal(f.store.data.fileLeases[0].state,'held');assert.equal(m.reviews[0].packet.output,'proof');
  assert.throws(()=>f.supervision.get('old'),/已删除/);
  assert.equal(f.supervision.detail('old').deletedAt,123);
  assert.equal(new Store(f.store.file).data.missions[0].deletedAt,123);
  updateMissionHistory(f.supervision,['old'],'delete');assert.equal(m.pausedFrom,'scheduled');
  updateMissionHistory(f.supervision,['old'],'restore');
  assert.equal(m.deletedAt,undefined);assert.equal(f.supervision.get('old').state,'paused');assert.equal(f.store.data.tasks[0].paused,true);
});
test('batch mission deletion is rejected atomically for active monitoring, evidence collection and invalid selections',()=>{
  const f=fixture();f.store.data.missions.push({id:'other',state:'accepted',instructions:[],reviews:[]});
  for(const source of ['active','job','busy','state','run']){
    if(source==='active')f.scheduler.activeRuns.set('live',{task:{missionId:'other'},run:{}});
    if(source==='job')f.supervision.jobs.set('other',Promise.resolve());
    if(source==='busy')f.supervision.busy.add('other');
    if(source==='state')f.store.data.missions[1].state='running';
    if(source==='run')f.store.data.runs.push({id:'live',missionId:'other',status:'waiting'});
    assert.throws(()=>updateMissionHistory(f.supervision,['old','other'],'delete'),/仍在执行/);
    assert.equal(f.store.data.missions[0].deletedAt,undefined);assert.equal(f.store.data.tasks[0].paused,false);
    f.scheduler.activeRuns.clear();f.supervision.jobs.clear();f.supervision.busy.clear();f.store.data.missions[1].state='accepted';f.store.data.runs=[];
  }
  assert.throws(()=>updateMissionHistory(f.supervision,['old','missing'],'delete'),/不存在/);
  updateMissionHistory(f.supervision,['other'],'delete');updateMissionHistory(f.supervision,['other'],'restore');
  assert.equal(f.store.data.missions[1].state,'accepted');
});
test('supervision history route serves explicit deletion and restore requests',async()=>{
  const f=fixture();let result;
  const args={supervision:f.supervision,body:async()=>({ids:['old'],action:'delete'}),send:(_response,status,data)=>{result={status,data};}};
  assert.equal(await supervisionRoutes({method:'POST'},{},new URL('http://127.0.0.1/api/supervision/history'),args),true);
  assert.equal(result.status,200);assert.equal(result.data.missions[0].deletedAt,123);
});

test('deleting finished supervision retires its reservation without reconnecting its client',()=>{
  for(const status of ['completed','failed']) {
    const f=fixture(),mission=f.store.data.missions[0],lease=f.store.data.fileLeases[0];
    lease.runId='past';
    f.store.data.runs.push({id:'past',missionId:mission.id,status,endedAt:100,output:'original result'});
    f.supervision.inspect=()=>{throw new Error('Disconnected client must not be required');};
    updateMissionHistory(f.supervision,[mission.id],'delete');
    assert.equal(lease.state,'released');
    assert.equal(f.store.data.runs[0].output,'original result');
    assert.equal(mission.reviews[0].packet.output,'proof');
    updateMissionHistory(f.supervision,[mission.id],'restore');
    assert.equal(mission.state,'paused');
    assert.equal(lease.state,'released');
    assert.equal(f.store.data.tasks[0].paused,true);
  }
});

test('startup retires legacy deleted reservations only when execution has a confirmed end',()=>{
  for(const status of ['completed','failed','uncertain','interrupted','running','waiting','dispatching',null]) {
    const f=fixture(),mission=f.store.data.missions[0],lease=f.store.data.fileLeases[0];
    mission.deletedAt=100;mission.state='paused';lease.runId='past';
    if(status)f.store.data.runs.push({id:'past',missionId:mission.id,status,endedAt:100});
    f.store.save();
    const reloaded=new Store(f.store.file);
    new Supervision(reloaded,f.scheduler,{clock:()=>123});
    assert.equal(reloaded.data.fileLeases[0].state,['completed','failed'].includes(status)?'released':'held',status);
  }
});

test('retirement preserves undeleted missions and active execution or collection',()=>{
  for(const source of ['undeleted','active','job','busy','run','unfinished']) {
    const f=fixture(),mission=f.store.data.missions[0],lease=f.store.data.fileLeases[0];
    mission.deletedAt=100;lease.runId='past';
    f.store.data.runs.push({id:'past',missionId:mission.id,status:'failed',endedAt:100});
    if(source==='undeleted')delete mission.deletedAt;
    if(source==='active')f.scheduler.activeRuns.set('live',{task:{missionId:mission.id},run:{}});
    if(source==='job')f.supervision.jobs.set(mission.id,Promise.resolve());
    if(source==='busy')f.supervision.busy.add(mission.id);
    if(source==='run')f.store.data.runs.push({id:'live',missionId:mission.id,status:'running'});
    if(source==='unfinished')delete f.store.data.runs[0].endedAt;
    assert.equal(f.supervision.retireDeletedLeases(),0,source);
    assert.equal(lease.state,'held',source);
  }
});
