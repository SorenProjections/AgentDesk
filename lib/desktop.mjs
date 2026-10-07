import { execFile, spawn } from 'node:child_process';
import { existsSync } from 'node:fs';
import { homedir } from 'node:os';
import path from 'node:path';
import { pathToFileURL, fileURLToPath } from 'node:url';
import { randomUUID } from 'node:crypto';

const sleep = ms => new Promise(resolve => setTimeout(resolve, ms));
export const desktopIds = ['antigravityDesktop', 'workbuddyDesktop'];
const sameFolder = (a,b) => path.normalize(a || '').toLowerCase() === path.normalize(b || '').toLowerCase();
function uriFolder(uri) { try { return fileURLToPath(uri); } catch { return ''; } }
function localUrl(value, port) {
  const u = new URL(value);
  if (!['http:', 'ws:'].includes(u.protocol) || u.hostname !== '127.0.0.1' || Number(u.port) !== Number(port) || u.username || u.password) throw new Error('桌面连接地址不是预期的本机端口。');
  return u.href;
}

// Read only the owned desktop services. Local CSRF values stay in memory.
export async function discoverDesktop() {
  if (process.platform !== 'win32') return { processes: [], ports: [] };
  const script = `[Console]::OutputEncoding=[System.Text.UTF8Encoding]::new($false); $ErrorActionPreference='Stop'; $taskApps=@(Get-CimInstance Win32_Process -Filter "Name='Antigravity.exe' OR Name='language_server.exe' OR Name='WorkBuddy.exe'"); $taskPorts=@(Get-NetTCPConnection -State Listen -LocalAddress '127.0.0.1' -ErrorAction SilentlyContinue | Where-Object { $_.OwningProcess -in $taskApps.ProcessId } | ForEach-Object { @{port=$_.LocalPort;pid=$_.OwningProcess} }); $taskResult=@{processes=@($taskApps | ForEach-Object { $taskToken=''; if($_.Name -eq 'language_server.exe' -and $_.ExecutablePath -match 'antigravity' -and $_.CommandLine -match '--csrf_token[= ]+([^ ]+)'){ $taskToken=$Matches[1].Trim('"') }; @{pid=$_.ProcessId;name=$_.Name;exe=$_.ExecutablePath;csrf=$taskToken} });ports=$taskPorts}; $taskResult | ConvertTo-Json -Depth 4 -Compress`;
  const out = await new Promise((resolve,reject) => execFile('powershell.exe',['-NoProfile','-EncodedCommand',Buffer.from(script,'utf16le').toString('base64')],{windowsHide:true,timeout:15000,maxBuffer:200000},(err,out)=>err?reject(new Error('无法读取桌面服务，请在正常 Windows 用户会话中运行后台。')):resolve(out)));
  return JSON.parse(out.replace(/^\uFEFF/,''));
}

export function antigravityStatus(summary) {
  if (!summary) return 'uncertain';
  if (summary.killed || summary.interrupted) return 'interrupted';
  if (summary.waitingSteps?.length) return 'waiting';
  if (summary.status === 'CASCADE_RUN_STATUS_IDLE' && !summary.notFullyIdle && !summary.hasActiveChildren) return 'idle';
  if (['CASCADE_RUN_STATUS_RUNNING','CASCADE_RUN_STATUS_BUSY','CASCADE_RUN_STATUS_CANCELING'].includes(summary.status) || summary.notFullyIdle || summary.hasActiveChildren) return 'running';
  return 'uncertain';
}

export class AntigravityDesktop {
  constructor({ discovery = discoverDesktop, fetcher = fetch } = {}) {
    this.id='antigravityDesktop'; this.name='Antigravity 桌面端'; this.discovery=discovery; this.fetcher=fetcher;
    this.available=false;this.detail='等待检测桌面端';this.verification=null;
    this.capabilities={desktop:true,threads:true,resume:true,captureThread:true,watch:true,model:true};
  }
  snapshot(){return{id:this.id,name:this.name,available:this.available,detail:this.detail,capabilities:this.capabilities,verification:this.verification};}
  async probe(){
    this.available=false;this.endpoint=null;
    try {
      const found=await this.discovery();
      const servers=found.processes.filter(p=>p.name==='language_server.exe' && /antigravity/i.test(p.exe) && p.csrf);
      for(const proc of servers) for(const item of found.ports.filter(p=>p.pid===proc.pid)) {
        try {
          const endpoint=`http://127.0.0.1:${item.port}`;
          const r=await this.fetcher(endpoint+'/',{signal:AbortSignal.timeout(1500)});
          const html=await r.text();const match=html.match(/window\.__APP_CONFIG__\s*=\s*(\{[^;]+\});/);
          if(!match)continue;
          const config=JSON.parse(match[1]);if(config.productName!=='antigravity' || config.csrfToken!==proc.csrf)continue;
          this.endpoint=endpoint;this.csrf=proc.csrf;this.version=config.appVersion;
          await this.summaries();this.available=true;this.detail=`桌面端 ${this.version} 已连接，使用当前登录账号和对话`;
          return this.snapshot();
        }catch{}
      }
      this.detail='未找到可连接的 Antigravity 桌面服务，请打开桌面端后点击检测。';
    }catch(e){this.detail=e.message;}
    return this.snapshot();
  }
  async rpc(method,body={}) {
    if(!this.endpoint)throw new Error('Antigravity 桌面端未连接。');
    const r=await this.fetcher(this.endpoint+'/exa.language_server_pb.LanguageServerService/'+method,{method:'POST',headers:{'Content-Type':'application/json','Connect-Protocol-Version':'1','x-codeium-csrf-token':this.csrf},body:JSON.stringify(body),signal:AbortSignal.timeout(15000)});
    if(!r.ok)throw new Error(`Antigravity 桌面接口 ${method} 返回 ${r.status}，请重新检测连接。`);
    return r.json();
  }
  async summaries(){return (await this.rpc('GetAllCascadeTrajectories',{excludeSubtrajectories:true})).trajectorySummaries || {};}
  async listThreads(cwd){const items=await this.summaries();return Object.entries(items).map(([id,s])=>({id,name:s.summary || id,cwd:uriFolder(s.workspaces?.[0]?.workspaceFolderAbsoluteUri),status:antigravityStatus(s),version:s.lastUserInputTime || s.createdTime || '',steps:s.stepCount || 0})).filter(x=>!cwd || sameFolder(x.cwd,cwd));}
  async inspect(id){const s=(await this.summaries())[id];if(!s)throw new Error('Antigravity 对话不存在或已经删除。');return{id,cwd:uriFolder(s.workspaces?.[0]?.workspaceFolderAbsoluteUri),status:antigravityStatus(s),version:s.lastUserInputTime || s.createdTime || '',steps:s.stepCount || 0,inputStep:s.lastUserInputStepIndex || 0,summary:s};}
  async listSessions(known=[]){
    if(!this.available)throw new Error(this.detail);
    const summaries=await this.summaries();const rows=[];
    const entries=Object.entries(summaries).sort((a,b)=>String(b[1].lastUserInputTime || '').localeCompare(String(a[1].lastUserInputTime || '')));
    for(const [id,s]of entries){
      const status=antigravityStatus(s);
      if(rows.length>=60 && !known.includes(id) && !['running','waiting'].includes(status))continue;
      const row={id,name:s.summary || id,cwd:uriFolder(s.workspaces?.[0]?.workspaceFolderAbsoluteUri),status,version:s.lastUserInputTime || s.createdTime || '',updatedAt:Date.parse(s.lastUserInputTime || s.createdTime) || 0,evidence:'Antigravity 桌面运行状态'};
      if(status==='idle' && s.stepCount){
        const offset=s.lastUserInputStepIndex || 0;
        const cacheKey=`${id}:${row.version}:${s.stepCount}`;this.sessionResults ||= new Map();
        let result=this.sessionResults.get(cacheKey);
        if(!result){result=await this.result(id,offset);this.sessionResults.set(cacheKey,result);}
        Object.assign(row,result,{output:(result.output || '').slice(-6000),evidence:'Antigravity 本轮步骤与最终回复'});
      }
      rows.push(row);
    }
    if(this.sessionResults?.size>600)this.sessionResults.clear();
    return rows;
  }
  async result(id,offset){
    const data=await this.rpc('GetCascadeTrajectorySteps',{cascadeId:id,stepOffset:offset,trajectoryVerbosity:1});
    const steps=data.steps || [];
    const error=steps.find(s=>s.errorMessage || s.error || /ERROR|FAILED/.test(s.status || ''));
    const output=steps.flatMap(s=>[s.plannerResponse?.response,s.plannerResponse?.responseText,s.notifyUser?.notificationContent,s.assistantMessage?.text].filter(x=>typeof x==='string')).join('\n\n');
    const unfinished=steps.some(s=>!['CORTEX_STEP_STATUS_DONE','CORTEX_STEP_STATUS_SKIPPED'].includes(s.status));
    return{status:error?'failed':output&&!unfinished?'completed':'uncertain',output,error:error?(error.errorMessage?.error?.shortError || 'Antigravity 返回执行错误，请在桌面端查看详情。'):output&&!unfinished?'':'任务已空闲，但没有可确认的最终回复，请在桌面端核实。'};
  }
  start(task,run,hooks){
    let id=run.threadId, sent=false,interrupted=false;
    const completion=(async()=>{
      try {
        if(!this.available)throw new Error(this.detail);
        if(task.effort)throw new Error('桌面模型已包含推理等级，请清空单独的推理强度设置。');
        const models=await this.rpc('GetCascadeModelConfigData');
        const chosen=task.model ? models.clientModelConfigs?.find(x=>x.label===task.model || x.modelId===task.model || x.modelOrAlias?.model===task.model)?.modelOrAlias : models.defaultOverrideModelConfig?.modelOrAlias;
        if(!chosen?.model)throw new Error('未找到桌面端默认模型，请在面板模型栏填写客户端中显示的完整模型名称。');
        if(!id){const created=await this.rpc('StartCascade',{cascadeId:randomUUID(),source:18,workspaceUris:[pathToFileURL(task.cwd).href]});id=created.cascadeId;if(!id)throw new Error('桌面端没有返回新对话编号。');hooks.thread(id);}
        const before=await this.inspect(id);
        if(!sameFolder(before.cwd,task.cwd))throw new Error('桌面对话的文件夹与任务不一致，已停止发送。');
        if(before.status!=='idle')throw new Error('桌面对话正在运行或等待处理，已停止发送。');
        if(interrupted)return{status:'interrupted',error:''};
        sent=true;await this.rpc('SendUserCascadeMessage',{cascadeId:id,items:[{text:run.prompt}],cascadeConfig:{plannerConfig:{planModel:chosen.model}},blocking:false});
        hooks.log('system','消息已发送到 Antigravity 桌面对话。权限确认请在桌面端处理。');
        const end=Date.now()+(task.timeoutMinutes || 120)*60000;
        while(Date.now()<end){
          await sleep(1200);const now=await this.inspect(id);
          hooks.status?.(now.status==='waiting'?'waiting':'running');
          if(interrupted || now.status==='interrupted')return{status:'interrupted',error:''};
          if(now.status==='idle' && now.steps>before.steps){const result=await this.result(id,before.steps);hooks.output(result.output);return result;}
        }
        return{status:'uncertain',error:'超过监控时间，未确认桌面任务结束。不会自动重发，也不会关闭客户端任务。'};
      }catch(e){return{status:sent?'uncertain':'failed',error:e.message};}
    })();
    return{completion,interrupt:async()=>{interrupted=true;if(sent&&id)await this.rpc('CancelCascadeInvocation',{cascadeId:id});}};
  }
  async verify(){let output='',id;const result=await this.start({cwd:process.cwd(),timeoutMinutes:1},{prompt:'Reply with exactly AGENT_CONNECTION_OK. Do not use tools, read files, or make changes.'},{thread:x=>id=x,log(){},output:x=>output=x}).completion;this.verification={at:Date.now(),status:result.status==='completed' && output.includes('AGENT_CONNECTION_OK')?'verified':'failed',error:result.error || (output.includes('AGENT_CONNECTION_OK')?'':'未收到预期的测试回复。'),threadId:id};return this.snapshot();}
}

// Transport to the desktop's SDK; it never types/clicks or changes permission settings.
export class DesktopRpc {
  constructor(socket){this.socket=socket;this.pending=new Map();this.next=1;socket.addEventListener('message',e=>{let m;try{m=JSON.parse(e.data);}catch{return;}const p=this.pending.get(m.id);if(p){this.pending.delete(m.id);clearTimeout(p.timer);m.error?p.reject(new Error(m.error.message)):p.resolve(m.result);}});socket.addEventListener('close',()=>this.close());}
  static async connect(url,port){const socket=new WebSocket(localUrl(url,port));await new Promise((resolve,reject)=>{const timer=setTimeout(()=>{socket.close();reject(new Error('桌面连接超时。'));},5000);socket.addEventListener('open',()=>{clearTimeout(timer);resolve();},{once:true});socket.addEventListener('error',()=>{clearTimeout(timer);reject(new Error('桌面桥连接失败。'));},{once:true});});return new DesktopRpc(socket);}
  request(method,params,timeout=15000){if(this.socket.readyState!==1)return Promise.reject(new Error('桌面桥连接中断。'));return new Promise((resolve,reject)=>{const id=this.next++;const timer=setTimeout(()=>{this.pending.delete(id);reject(new Error('桌面接口响应超时；发送后的状态需核实。'));},timeout);this.pending.set(id,{resolve,reject,timer});try{this.socket.send(JSON.stringify({id,method,params}));}catch(e){clearTimeout(timer);this.pending.delete(id);reject(e);}});}
  async evaluate(expression,timeout){const r=await this.request('Runtime.evaluate',{expression,awaitPromise:true,returnByValue:true},timeout);if(r.exceptionDetails)throw new Error(r.exceptionDetails.exception?.description || '桌面 SDK 调用失败。');return r.result?.value;}
  close(){if(this.closed)return;this.closed=true;for(const p of this.pending.values()){clearTimeout(p.timer);p.reject(new Error('桌面桥连接中断。'));}this.pending.clear();if(this.socket.readyState<2)this.socket.close();this.onclosed?.();}
}

export class WorkBuddyDesktop {
  constructor({port=9337,discovery=discoverDesktop,fetcher=fetch,pause=sleep}={}){this.id='workbuddyDesktop';this.name='WorkBuddy 桌面端';this.port=port;this.discovery=discovery;this.fetcher=fetcher;this.pause=pause;this.available=false;this.detail='等待检测桌面桥';this.capabilities={desktop:true,threads:true,resume:true,captureThread:true,watch:true};this.verification=null;}
  snapshot(){return{id:this.id,name:this.name,available:this.available,detail:this.detail,port:this.port,capabilities:this.capabilities,verification:this.verification};}
  async probe(){this.close();this.available=false;
    try{const found=await this.discovery();const owner=found.ports.find(p=>p.port===this.port && found.processes.some(x=>x.pid===p.pid && x.name==='WorkBuddy.exe'));
      if(!owner)throw new Error('桌面桥尚未启用。请等 WorkBuddy 当前任务结束，完全退出客户端，再点击「启动桌面连接」。');
      const r=await this.fetcher(`http://127.0.0.1:${this.port}/json/list`,{signal:AbortSignal.timeout(3000)});const tabs=await r.json();
      for(const tab of tabs.filter(x=>x.type==='page' && /app\.asar.*renderer\/index\.html|workbuddy:\/\//i.test(x.url || ''))){
        const rpc=await DesktopRpc.connect(tab.webSocketDebuggerUrl,this.port);
        if(await rpc.evaluate('typeof window.__wbInvoke === "function"')){this.rpc=rpc;rpc.onclosed=()=>{if(this.rpc===rpc){this.available=false;this.detail='桌面桥连接中断，请打开客户端后重新检测。';this.rpc=null;}};break;}rpc.close();
      }
      if(!this.rpc)throw new Error('桌面连接已启动，等待 WorkBuddy 主界面加载后再次检测。');
      await this.listThreads();this.available=true;this.detail='桌面 SDK 已连接，复用当前登录账号和本地对话';
    }catch(e){this.detail=e.message;this.close();}
    return this.snapshot();
  }
  async invoke(method,args=[],timeout){if(!this.rpc)throw new Error('WorkBuddy 桌面桥未连接。');const channel=method==='local:list'?'wb:conversations.local:list':'wb:conversations:'+method;const result=await this.rpc.evaluate(`window.__wbInvoke(${JSON.stringify(channel)}, undefined, ...${JSON.stringify(args)})`,timeout);if(result?.__wbError)throw new Error(result.message || 'WorkBuddy 桌面 SDK 调用失败。');return result;}
  async listThreads(cwd){
    const rows=new Map();let loaded=0;
    for(let page=1;page<=100;page++){
      const r=await this.invoke('local:list',[{page,size:100,...(cwd?{workspacePath:cwd}:{})}]);
      if(!Array.isArray(r) && !Array.isArray(r?.items))throw new Error('WorkBuddy 桌面对话列表格式不匹配，请重新检测客户端。');
      const items=Array.isArray(r)?r:r.items;const before=rows.size;
      for(const item of items)rows.set(item.id,item);loaded+=items.length;
      if(Array.isArray(r)||items.length<100||loaded>=r.total||rows.size===before)break;
    }
    return [...rows.values()].map(s=>({id:s.id,name:s.title || s.name || s.id,cwd:s.space?.cwd || s.cwd,status:s.hasActiveChildAgents || s.hasRunningBackgroundTasks?'running':s.state || s.status,version:String(s.lastRequestId || s.updatedAt || '')})).filter(x=>!cwd || sameFolder(x.cwd,cwd));
  }
  async inspect(id){const s=await this.invoke('get',[id]);if(!s?.info)throw new Error('WorkBuddy 对话不存在。');const info=s.info;const page=await this.invoke('requests',[id,{byteLength:100000}]);const requests=page.items || [];const last=requests.at(-1);return{id,cwd:info.space?.cwd || info.cwd,status:info.hasActiveChildAgents || info.hasRunningBackgroundTasks?'running':info.state,version:last?.id || '',last,requests,info};}
  async listSessions(known=[]){
    if(!this.available)throw new Error(this.detail);
    const threads=(await this.listThreads()).sort((a,b)=>String(b.version).localeCompare(String(a.version)));const rows=[];
    for(const thread of threads){
      // Inspect actual requests; list state alone cannot confirm successful work.
      if(rows.length>=60 && !known.includes(thread.id) && !['working','planning','running','waiting','pending'].includes(thread.status))continue;
      const current=await this.inspect(thread.id);const request=current.last;
      let status=current.status;
      if(['idle','completed'].includes(status))status=request?.state==='completed'?'completed':['error','failed'].includes(request?.state)?'failed':request?.state==='cancelled'?'interrupted':request?'uncertain':'idle';
      rows.push({...thread,status,version:current.version,updatedAt:Date.parse(current.info.updatedAt) || Number(current.info.updatedAt) || 0,output:status==='completed'?extractText(request.assistantMessage).slice(-6000):'',evidence:'WorkBuddy 本轮请求与子任务状态'});
    }
    return rows;
  }
  start(task,run,hooks){let id=run.threadId,sent=false,interrupted=false;const completion=(async()=>{
    try{if(!this.available)throw new Error(this.detail);if(task.model || task.effort)throw new Error('桌面连接沿用客户端模型，请清空面板模型和推理强度设置。');
      if(!id){const r=await this.invoke('create',[{transport:'local',cwd:task.cwd}]);if(r?.errorCode)throw new Error(r.message || r.errorCode);id=r?.info?.id;if(!id)throw new Error('WorkBuddy 没有返回新对话编号。');hooks.thread(id);}
      const before=await this.inspect(id);if(!sameFolder(before.cwd,task.cwd))throw new Error('桌面对话文件夹不一致，已停止发送。');if(!['idle','completed'].includes(before.status))throw new Error('桌面对话正在运行或等待处理，已停止发送。');if(interrupted)return{status:'interrupted'};
      const requestId=run.id || randomUUID();const end=Date.now()+(task.timeoutMinutes || 120)*60000;
      sent=true;const result=await this.invoke('sendPrompt',[id,[{type:'text',text:run.prompt}],{clientRequestId:requestId,clientTimestamp:Date.now(),emitUserMessage:true,_expectQueueReceipt:true,_meta:{'codebuddy.ai/conversationRequestId':requestId}}]);
      if(result?.errorCode)throw new Error(result.message || result.errorCode);if(result?.disposition==='queued')return{status:'uncertain',error:'消息被桌面端放入内部队列，需核实执行结果。'};
      hooks.log?.('system','消息已发送到 WorkBuddy 桌面对话。权限确认请在桌面端处理。');
      // sendPrompt acknowledges submission before the turn completes. Match our request,
      // then wait for children/background tasks too; old replies cannot finish this run.
      while(Date.now()<end){
        await this.pause(1200);const current=await this.inspect(id);
        if(interrupted)return{status:'interrupted'};
        hooks.status?.(['waiting','pending'].includes(current.status)?'waiting':'running');
        const request=current.requests.find(x=>x.id===requestId || x.clientRequestId===requestId);
        if(!request)continue;
        if(current.last?.id!==request.id)return{status:'uncertain',error:'桌面对话已插入另一轮消息，请在客户端核实。'};
        if(['error','failed','cancelled'].includes(request.state))return{status:request.state==='cancelled'?'interrupted':'failed',error:'WorkBuddy 当前消息未成功完成，请在客户端查看详情。'};
        if(request.state==='completed' && ['idle','completed'].includes(current.status)){
          const output=extractText(request.assistantMessage);hooks.output(output);
          return{status:output?'completed':'uncertain',error:output?'':'任务结束但没有最终回复，请在客户端核实。'};
        }
      }
      return{status:'uncertain',error:'超过监控时间，未确认桌面任务结束。不会自动重发，也不会关闭客户端任务。'};
    }catch(e){return{status:sent?'uncertain':'failed',error:e.message};}
  })();return{completion,interrupt:async()=>{interrupted=true;if(sent&&id)await this.invoke('cancel',[id]);}};}
  async verify(){let output='',id;const result=await this.start({cwd:process.cwd(),timeoutMinutes:1},{prompt:'Reply with exactly AGENT_CONNECTION_OK. Do not use tools, read files, or make changes.',id:randomUUID()},{thread:x=>id=x,output:t=>output=t,log(){}}).completion;const verified=result.status==='completed'&&output.includes('AGENT_CONNECTION_OK');this.verification={at:Date.now(),status:verified?'verified':'failed',error:verified?'':result.error || '未收到预期测试回复。',threadId:id};return this.snapshot();}
  async launch(){const found=await this.discovery();if(found.processes.some(x=>x.name==='WorkBuddy.exe'))throw new Error('WorkBuddy 仍在运行。请先在客户端退出，当前任务不会被面板强制关闭。');
    const roots=[process.env.WORKBUDDY_DESKTOP_BINARY,'E:\\workbuddy\\WorkBuddy.exe',path.join(process.env.LOCALAPPDATA || path.join(homedir(),'AppData/Local'),'Programs/WorkBuddy/WorkBuddy.exe')];const exe=roots.find(x=>x&&existsSync(x));if(!exe)throw new Error('未找到 WorkBuddy 桌面程序。');
    const child=spawn(exe,[`--remote-debugging-port=${this.port}`,'--remote-debugging-address=127.0.0.1'],{windowsHide:true,detached:true,stdio:'ignore'});await new Promise((resolve,reject)=>{child.once('spawn',resolve);child.once('error',reject);});child.unref();return{launched:true};}
  close(){const rpc=this.rpc;this.rpc=null;this.available=false;rpc?.close();}
}
export function extractText(value){const texts=[];function visit(x){if(!x || typeof x!=='object')return;if(x.role==='user')return;if(x.type==='text'&&typeof x.text==='string')texts.push(x.text);if(typeof x.content==='string' && x.role==='assistant')texts.push(x.content);for(const [k,v]of Object.entries(x))if(!['prompt','userMessage','input'].includes(k)&&typeof v==='object')Array.isArray(v)?v.forEach(visit):visit(v);}visit(value);return texts.join('\n\n').slice(-1000000);}
