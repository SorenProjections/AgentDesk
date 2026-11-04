import test from 'node:test';
import assert from 'node:assert/strict';
import {SystemIntegration,powershellError} from '../lib/system.mjs';

test('autostart updates only its value under an existing Run key and verifies enable/disable idempotently',async()=>{
  const calls=[];let value='';
  const system=new SystemIntegration('E:/A project 中文',{platform:'win32',runPowerShell:async(script,env)=>{
    calls.push(script);
    if(script.includes('.SetValue('))value=env.AGENT_SCHEDULER_START_COMMAND;
    if(script.includes('.DeleteValue('))value='';
    return script.includes('.GetValue(')?value:'';
  }});
  await system.setAutostart(true);await system.setAutostart(true);assert.equal(system.autostart,true);
  assert.match(value,/background\.vbs/);assert.match(value,/中文/);
  await system.setAutostart(false);await system.setAutostart(false);assert.equal(system.autostart,false);
  assert.ok(calls.some(script=>script.includes('CreateSubKey(')));
  assert.ok(calls.every(script=>!script.includes('New-Item')&&!script.includes('DeleteSubKey')));
});
test('autostart exposes readable failures and refuses an unverified write',async()=>{
  const denied=new SystemIntegration('E:/app',{platform:'win32',runPowerShell:async()=>{throw Error('Access denied');}});
  await assert.rejects(denied.setAutostart(true),/无法开启.*Access denied/);
  const unverified=new SystemIntegration('E:/app',{platform:'win32',runPowerShell:async()=>''});
  await assert.rejects(unverified.setAutostart(true),/未能验证/);
  const xml='#< CLIXML\n<Objs><S S="Error">权限不足_x000D__x000A_路径 &lt;Run&gt;</S><S S="progress">noise</S></Objs>';
  assert.equal(powershellError(xml),'权限不足\r\n路径 <Run>');
  assert.equal(powershellError('#< CLIXML\n<Objs/>'),'Windows 设置执行失败。');
});
