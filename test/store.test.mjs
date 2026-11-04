import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdirSync,mkdtempSync,readFileSync,renameSync,existsSync} from 'node:fs';
import path from 'node:path';
import {Store} from '../lib/store.mjs';

function file(){const root=path.resolve('work/store-tests');mkdirSync(root,{recursive:true});return path.join(mkdtempSync(path.join(root,'case-')),'tasks.json');}
test('a temporary Windows replacement lock preserves the previous file until the new state can be committed',()=>{
  const target=file(),initial=new Store(target),old=readFileSync(target,'utf8');let attempts=0;
  const store=new Store(target,{platform:'win32',replaceFile:(source,destination)=>{
    attempts++;
    if(attempts<3){assert.equal(readFileSync(destination,'utf8'),old);throw Object.assign(new Error('locked'),{code:'EPERM'});}
    renameSync(source,destination);
  }});
  store.data.tasks.push({id:'saved'});store.save();
  assert.equal(attempts,3);assert.equal(new Store(target).data.tasks[0].id,'saved');assert.equal(existsSync(target+'.tmp'),false);
});
test('permanent replacement errors surface without destroying the last saved file',()=>{
  for(const code of ['EPERM','ENOSPC']){
    const target=file();new Store(target);const old=readFileSync(target,'utf8');let attempts=0;
    const store=new Store(target,{platform:'win32',replaceFile:()=>{attempts++;throw Object.assign(new Error('cannot replace'),{code});}});
    store.data.tasks.push({id:'unsaved'});assert.throws(()=>store.save(),/cannot replace/);
    assert.equal(readFileSync(target,'utf8'),old);assert.equal(attempts,code==='EPERM'?6:1);
  }
});
