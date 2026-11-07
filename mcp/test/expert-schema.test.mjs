import test from 'node:test';
import assert from 'node:assert/strict';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';
import { createServer } from '../server.mjs';
async function fixture(t) {
  const calls=[],gateway={request:async(...args)=>{calls.push(args);return{tasks:[],providers:[]};}};
  const server=createServer({gateway}),client=new Client({name:'query-test',version:'1'});
  const [a,b]=InMemoryTransport.createLinkedPair();await server.connect(b);await client.connect(a);
  t.after(async()=>{await client.close();await server.close();});
  return {calls,client,call:(name,args={})=>client.callTool({name,arguments:args})};
}
test('MCP exposes only ordinary query and interrupt tools; retired supervision entry points are absent',async t=>{
  const f=await fixture(t),tools=(await f.client.listTools()).tools;
  assert.deepEqual(tools.map(x=>x.name).sort(),['status','list_sessions','list_projects','list_workbuddy_experts','get_run','interrupt_run'].sort());
  assert.equal(tools.find(x=>x.name==='list_projects').annotations.readOnlyHint,true);
  assert.equal((await f.call('create_mission',{})).isError,true);
  assert.equal(f.calls.length,0);
});
test('MCP project filters and pagination pass unchanged and strict schemas reject unknown arguments',async t=>{
  const f=await fixture(t);
  assert.notEqual((await f.call('list_sessions',{provider:'codex',cwd:'E:/demo',projectId:'native-project',cursor:'page-two'})).isError,true);
  const query=new URLSearchParams(f.calls[0][0].split('?')[1]);
  assert.equal(query.get('projectId'),'native-project');assert.equal(query.get('cursor'),'page-two');
  assert.notEqual((await f.call('list_projects',{provider:'codex'})).isError,true);
  assert.equal(f.calls.at(-1)[0],'projects?provider=codex');
  const before=f.calls.length;
  for(const [name,args] of [['get_run',{runId:'../escape'}],['status',{command:'send'}],['list_workbuddy_experts',{expertId:'change'}]])assert.equal((await f.call(name,args)).isError,true);
  assert.equal(f.calls.length,before);
});
test('MCP expert catalog delegates exactly one read-only GET and failures never retry mutations',async t=>{
  const f=await fixture(t);await f.call('list_workbuddy_experts');
  assert.deepEqual(f.calls,[['desktop/workbuddy/experts']]);
  let calls=0;
  const server=createServer({gateway:{request:async()=>{calls++;throw Error('transport lost')}}});
  const client=new Client({name:'failure-test',version:'1'}),[a,b]=InMemoryTransport.createLinkedPair();
  await server.connect(b);await client.connect(a);t.after(async()=>{await client.close();await server.close();});
  assert.equal((await client.callTool({name:'interrupt_run',arguments:{runId:'run-1'}})).isError,true);
  assert.equal(calls,1);
});
