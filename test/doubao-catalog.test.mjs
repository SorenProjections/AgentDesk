import test from 'node:test';
import assert from 'node:assert/strict';
import vm from 'node:vm';
import { doubaoPage } from '../lib/doubao-desktop.mjs';

function fixture() {
  let draft='',active='456',content=[],clicks=[];
  class TextArea { matches(){return true;} dispatchEvent(){} }
  Object.defineProperty(TextArea.prototype,'value',{get(){return draft;},set(v){draft=v;}});
  const input=new TextArea();
  const node=(attrs={},innerText='')=>({innerText,classList:{contains:()=>false},getAttribute:key=>attrs[key] ?? null,querySelector:()=>null,querySelectorAll:()=>[],closest:()=>null,click(){clicks.push(attrs.id);}});
  const project=node({'data-project-id':'project-1'},'Research');
  const header=node({},'Research'); const title=node({title:'Research'});
  const create=node({id:'project-new','aria-label':'新对话'});
  project.querySelector=selector=>selector.includes('[title]')?title:header;
  project.querySelectorAll=()=>[create];
  const chat=node({'data-conversation-id':'456','data-conversation-active':'true',id:'existing'},'Existing research');
  chat.closest=()=>project; chat.querySelector=()=>null;
  const send=node({id:'send'}); send.disabled=false;
  const globalNew=node({id:'global-new'});
  const ids={chat_input_input:input,chat_input_send_button:send,new_chat_button:globalNew};
  const context=vm.createContext({URL,HTMLTextAreaElement:TextArea,Event:class{},location:{get href(){return 'chrome://doubao-chat/chat/'+active;}},document:{title:'Doubao',querySelector:selector=>ids[selector.match(/data-testid="([^"]+)"/)?.[1]] || null,querySelectorAll:selector=>selector==='[data-conversation-id]'?[chat]:selector==='section[data-project-id]'?[project]:selector==='[data-testid="message_content"]'?content:[]}});
  const call=(action,payload)=>JSON.parse(JSON.stringify(vm.runInContext(`(${doubaoPage.toString()})(${JSON.stringify(action)},${JSON.stringify(payload)})`,context)));
  return {call,clicks,setDraft(value){draft=value;},get draft(){return draft;},setActive(value){active=value;},setContent(value){content=value;},message(role,text,id){const message=node({'data-message-id':id,'data-message-role':role},text);message.closest=()=>message;message.querySelector=selector=>selector.includes('message_text_content')?{innerText:text}:role==='assistant'&&selector.includes('message_action_copy')?{}:null;return message;}};
}

test('DOM catalog uses native project/conversation identifiers and the current saved URL',()=>{
  const f=fixture(),catalog=f.call('catalog');
  assert.deepEqual(catalog.projects,[{id:'project-1',name:'Research'}]);
  assert.deepEqual(catalog.threads,[{id:'456',name:'Existing research',projectId:'project-1'}]);
  assert.equal(f.call('read').threadId,'456');
  f.setActive('local_123');assert.equal(f.call('read').threadId,null,'temporary URL must not reuse an old sidebar selection');
});

test('native project creation uses its own button and rejects missing projects and drafts',()=>{
  const f=fixture();f.call('new',{projectId:'project-1'});assert.deepEqual(f.clicks,['project-new']);
  assert.throws(()=>f.call('new',{projectId:'missing'}),/项目未加载/);
  f.setDraft('keep');assert.throws(()=>f.call('new',{projectId:'project-1'}),/草稿/);
  assert.equal(f.draft,'keep');
});

test('existing message send rechecks history, target conversation and the exact draft',()=>{
  const f=fixture();f.setContent([f.message('user','old question','1'),f.message('assistant','old reply','2')]);
  const baseline=JSON.stringify(f.call('read').messages);
  const payload={prompt:'new message',baseline,threadId:'456'};
  f.call('fill',payload);assert.equal(f.draft,'new message');f.call('send',payload);assert.deepEqual(f.clicks,['send']);
  f.setActive('789');assert.throws(()=>f.call('send',payload),/已变化/);
  f.setActive('456');f.setContent([]);assert.throws(()=>f.call('send',payload),/已变化/);
});

test('open selects an actual loaded conversation, preserves drafts, and checks its project',()=>{
  const f=fixture();f.setActive('789');f.call('open',{id:'456',projectId:'project-1'});assert.deepEqual(f.clicks,['existing']);
  assert.throws(()=>f.call('open',{id:'456',projectId:'wrong'}),/不在所选项目/);
  assert.throws(()=>f.call('open',{id:'missing'}),/未加载/);
  f.setDraft('keep');assert.throws(()=>f.call('open',{id:'456'}),/草稿/);
});
