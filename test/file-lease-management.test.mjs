import test from 'node:test';
import assert from 'node:assert/strict';
import {EventEmitter} from 'node:events';
import {mkdirSync,mkdtempSync} from 'node:fs';
import path from 'node:path';
import {Store} from '../lib/store.mjs';
import {Supervision} from '../lib/supervision.mjs';

test('historical file protection names its source and only releases after real idle verification',async t=>{
  const root=path.resolve('work/lease-management-tests');mkdirSync(root,{recursive:true});
  const cwd=mkdtempSync(path.join(root,'case-'));mkdirSync(path.join(cwd,'research'));
  const store=new Store(path.join(cwd,'tasks.json'));
  let status='working';
  const scheduler=new EventEmitter();scheduler.providers=new Map([['workbuddyDesktop',{snapshot:()=>({available:true}),inspect:async()=>({id:'chat',cwd,status})}]]);
  scheduler.activeRuns=new Map();scheduler.usesLocalFiles=()=>true;
  const supervisor=new Supervision(store,scheduler);t.after(()=>supervisor.close());
  store.data.missions.push({id:'historical',title:'Old research',state:'correction_needed',instructions:[],writePaths:['research']});
  const lease=supervisor.leases.acquire({owner:'historical',cwd,paths:['research'],provider:'workbuddyDesktop',threadId:'chat',runId:'old-run'});
  assert.throws(()=>supervisor.checkConflicts('new',cwd,['.'],'write','workbuddyDesktop'),/Old research.*旧督导待纠偏.*research/);
  await assert.rejects(supervisor.releaseLease(lease.id,{confirmedIdle:true,reason:'User releases old protection'}),/尚未空闲/);
  assert.equal(lease.state,'held');
  status='idle';
  await assert.rejects(supervisor.releaseLease(lease.id,{reason:'Missing explicit check'}),/confirmedIdle/);
  await supervisor.releaseLease(lease.id,{confirmedIdle:true,reason:'User releases old protection'});
  assert.equal(lease.state,'released');assert.equal(store.data.missions[0].state,'paused');
  assert.equal(supervisor.checkConflicts('new',cwd,['.'],'write','workbuddyDesktop').length,0);
});
