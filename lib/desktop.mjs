import { existsSync } from 'node:fs';
import { homedir } from 'node:os';
import path from 'node:path';
import { pathToFileURL, fileURLToPath } from 'node:url';
import { randomUUID } from 'node:crypto';
import { discoverWindowsDesktop } from './desktop-discovery.mjs';
import { desktopTargets } from './desktop-cdp.mjs';
import { connectOrLaunch } from './desktop-launch.mjs';

const sleep = ms => new Promise(resolve => setTimeout(resolve, ms));
export const desktopIds = ['antigravityDesktop', 'workbuddyDesktop', 'doubaoDesktop'];
const sameFolder = (a,b) => path.normalize(a || '').toLowerCase() === path.normalize(b || '').toLowerCase();
function uriFolder(uri) { try { return fileURLToPath(uri); } catch { return ''; } }
function localUrl(value, port) {
  const u = new URL(value);
  if (!['http:', 'ws:'].includes(u.protocol) || u.hostname !== '127.0.0.1' || Number(u.port) !== Number(port) || u.username || u.password) throw new Error('桌面连接地址不是预期的本机端口。');
  return u.href;
}

// Read only the owned desktop services. Local CSRF values stay in memory.
export async function discoverDesktop() {
  return discoverWindowsDesktop();
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
      const servers=found.processes.filter(p=>p.name==='language_server.exe' && /antigravity/i.test(p.exe));
      for(const proc of servers) for(const item of found.ports.filter(p=>p.pid===proc.pid)) {
        try {
          const endpoint=`http://127.0.0.1:${item.port}`;
          const r=await this.fetcher(endpoint+'/',{signal:AbortSignal.timeout(1500)});
          const html=await r.text();const match=html.match(/window\.__APP_CONFIG__\s*=\s*(\{[^;]+\});/);
          if(!match)continue;
          const config=JSON.parse(match[1]);if(config.productName!=='antigravity' || typeof config.csrfToken!=='string' || !config.csrfToken || (proc.csrf && config.csrfToken!==proc.csrf))continue;
          // The endpoint must belong to the installed Antigravity language server.
          // Its own bootstrap config supplies the token without reading process memory.
          this.endpoint=endpoint;this.csrf=config.csrfToken;this.version=config.appVersion;
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
        if(!result){result=await this.result(id,offset);if(['completed','failed','interrupted'].includes(result.status))this.sessionResults.set(cacheKey,result);}
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
    const running=steps.some(s=>['CORTEX_STEP_STATUS_RUNNING','CORTEX_STEP_STATUS_WAITING','CORTEX_STEP_STATUS_PENDING'].includes(s.status));
    return{status:error?'failed':running?'running':output&&!unfinished?'completed':'uncertain',output,error:error?(error.errorMessage?.error?.shortError || 'Antigravity 返回执行错误，请在桌面端查看详情。'):running||output&&!unfinished?'':'任务已空闲，但没有可确认的最终回复，请在桌面端核实。'};
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
        hooks.checkpoint?.({phase:'sending',offset:before.steps,deadline:Date.now()+(task.timeoutMinutes || 120)*60000});
        sent=true;await this.rpc('SendUserCascadeMessage',{cascadeId:id,items:[{text:run.prompt}],cascadeConfig:{plannerConfig:{planModel:chosen.model}},blocking:false});
        hooks.checkpoint?.({phase:'sent',offset:before.steps,turnVersion:(await this.inspect(id)).version,deadline:Date.now()+(task.timeoutMinutes || 120)*60000});
        hooks.log('system','消息已发送到 Antigravity 桌面对话。权限确认请在桌面端处理。');
        const end=Date.now()+(task.timeoutMinutes || 120)*60000;
        while(Date.now()<end){
          await sleep(1200);const now=await this.inspect(id);
          hooks.status?.(now.status==='waiting'?'waiting':'running');
          if(interrupted || now.status==='interrupted')return{status:'interrupted',error:''};
          if(now.status==='idle' && now.steps>before.steps){const result=await this.result(id,before.steps);if(result.status==='running')continue;hooks.output(result.output);return result;}
        }
        return{status:'uncertain',error:'超过监控时间，未确认桌面任务结束。不会自动重发，也不会关闭客户端任务。'};
      }catch(e){return{status:sent?'uncertain':'failed',error:e.message};}
    })();
    return{completion,interrupt:async()=>{interrupted=true;if(sent&&id)await this.rpc('CancelCascadeInvocation',{cascadeId:id});}};
  }
  async recoveryState(task,run){
    const current=await this.inspect(run.threadId),m=run.desktopMonitor;
    if(!sameFolder(current.cwd,task.cwd))throw new Error('原桌面对话文件夹不匹配。');
    const inputIndex=current.summary?.lastUserInputStepIndex;
    if(Number.isInteger(inputIndex)?inputIndex!==m.offset:current.version!==m.turnVersion)throw new Error('原会话已开始另一轮消息。');
    if(['running','waiting'].includes(current.status))return current.status;
    if(current.status==='idle'){
      const result=await this.result(run.threadId,m.offset);
      if(['running','completed'].includes(result.status))return result.status;
    }
    throw new Error('没有原请求仍在执行或成功结束的证据，不能恢复监控。');
  }
  canResume(run){return !!run.threadId && run.desktopMonitor?.phase==='sent' &&
    Number.isInteger(run.desktopMonitor.offset) && !!run.desktopMonitor.turnVersion && Number.isFinite(run.desktopMonitor.deadline);}
  resume(task,run,hooks){
    if(!this.canResume(run))throw new Error('没有可确认的 Antigravity 原请求监控记录。');
    let interrupted=false;const id=run.threadId,m=run.desktopMonitor;
    const completion=(async()=>{try{
      do{
        const current=await this.inspect(id);
        if(!sameFolder(current.cwd,task.cwd))throw new Error('原桌面对话文件夹已改变。');
        // The summary timestamp can settle after SendUserCascadeMessage returns.
        // Its input step index identifies the actual submitted message stably.
        const inputIndex=current.summary?.lastUserInputStepIndex;
        if(Number.isInteger(inputIndex)?inputIndex!==m.offset:current.version!==m.turnVersion)return{status:'uncertain',error:'原 Antigravity 会话已开始另一轮消息，停止旧请求监控。'};
        if(interrupted||current.status==='interrupted')return{status:'interrupted'};
        hooks.status?.(current.status==='waiting'?'waiting':'running');
        if(current.status==='idle'&&current.steps>m.offset){const result=await this.result(id,m.offset);if(result.status!=='running'){hooks.output(result.output);return result;}}
        if(Date.now()>=m.deadline)break;
        await sleep(1200);
      }while(true);
      return{status:'uncertain',error:'原桌面请求超过监控时间，未重新发送或取消任务。'};
    }catch(e){return{status:'uncertain',error:e.message};}})();
    return{completion,interrupt:async()=>{interrupted=true;await this.rpc('CancelCascadeInvocation',{cascadeId:id});}};
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
  constructor({port=9337,discovery=discoverDesktop,fetcher=fetch,connect=DesktopRpc.connect,pause=sleep}={}){this.id='workbuddyDesktop';this.name='WorkBuddy 桌面端';this.port=port;this.discovery=discovery;this.fetcher=fetcher;this.connect=connect;this.pause=pause;this.available=false;this.detail='等待检测桌面桥';this.capabilities={desktop:true,threads:true,resume:true,captureThread:true,watch:true};this.verification=null;}
  snapshot(){return{id:this.id,name:this.name,available:this.available,detail:this.detail,port:this.port,capabilities:this.capabilities,verification:this.verification};}
  async probe(found){
    // A live, previously owned socket already identifies the client. Re-check
    // its SDK directly instead of spawning OS discovery and loading all chats.
    if(this.rpc&&!found){try{const list=await this.invoke('local:list',[{page:1,size:1}],3000);if(!Array.isArray(list)&&!Array.isArray(list?.items))throw new Error();this.available=true;this.detail='桌面 SDK 已连接，复用当前登录账号和本地对话';return this.snapshot();}catch{}}
    this.close();this.available=false;
    try{found ||= await this.discovery();
      const tabs=await desktopTargets(found,'WorkBuddy.exe',this.port,this.fetcher);
      if(!tabs.length)throw new Error(found.processes.some(p=>p.name.toLowerCase()==='workbuddy.exe')?'WorkBuddy 已运行，但未开放调试接口。保存任务并完全退出一次，再使用带连接参数的快捷方式或「打开并连接」。':'WorkBuddy 尚未运行，点击「打开并连接」。');
      for(const tab of tabs.filter(x=>/app\.asar.*renderer\/index\.html|workbuddy:\/\//i.test(x.url || ''))){
        let rpc;
        try{rpc=await this.connect(tab.webSocketDebuggerUrl,tab.port);
        if(await rpc.evaluate('typeof window.__wbInvoke === "function"')){this.port=tab.port;this.rpc=rpc;rpc.onclosed=()=>{if(this.rpc===rpc){this.available=false;this.detail='桌面桥连接中断，请打开客户端后重新检测。';this.rpc=null;}};break;}rpc.close();
        }catch{rpc?.close();}
      }
      if(!this.rpc)throw new Error('桌面连接已启动，等待 WorkBuddy 主界面加载后再次检测。');
      const list=await this.invoke('local:list',[{page:1,size:1}],3000);if(!Array.isArray(list)&&!Array.isArray(list?.items))throw new Error('WorkBuddy 对话接口尚未就绪。');this.available=true;this.detail='桌面 SDK 已连接，复用当前登录账号和本地对话';
    }catch(e){this.detail=e.message;this.close();}
    return this.snapshot();
  }
  async invoke(method,args=[],timeout){
    if(!this.rpc)throw new Error('WorkBuddy 桌面桥未连接。');
    const channel=method==='local:list'?'wb:conversations.local:list':'wb:conversations:'+method;
    const call=`window.__wbInvoke(${JSON.stringify(channel)}, undefined, ...${JSON.stringify(args)})`;
    // The SDK's first history call starts an asynchronous load and returns an
    // empty snapshot. Read again in the same short window before the desktop
    // evicts an idle conversation from its pool; an empty first read is not EOF.
    const expression=method==='requests'?`(async()=>{let r=await ${call};for(let i=0;i<10&&r?.items?.length===0&&r.hasOlder;i++){await new Promise(resolve=>setTimeout(resolve,75));r=await ${call};}return r;})()`:call;
    const result=await this.rpc.evaluate(expression,timeout);
    if(result?.__wbError)throw new Error(result.message || 'WorkBuddy 桌面 SDK 调用失败。');return result;
  }
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
    this.sessionCache ||= new Map();
    for(const thread of threads){
      // Inspect actual requests; list state alone cannot confirm successful work.
      if(rows.length>=60 && !known.includes(thread.id) && !['working','planning','running','waiting','pending'].includes(thread.status))continue;
      const cached=this.sessionCache.get(thread.id);
      if(thread.version&&cached?.version===thread.version&&['idle','completed'].includes(thread.status)&&['completed','failed','interrupted'].includes(cached.row.status)){rows.push(cached.row);continue;}
      const current=await this.inspect(thread.id);const request=current.last;
      let status=current.status;
      if(['idle','completed'].includes(status))status=request?.state==='completed'?'completed':['error','failed'].includes(request?.state)?'failed':request?.state==='cancelled'?'interrupted':request?'uncertain':'idle';
      const row={...thread,status,version:current.version,updatedAt:Date.parse(current.info.updatedAt) || Number(current.info.updatedAt) || 0,output:status==='completed'?extractText(request.assistantMessage).slice(-6000):'',evidence:'WorkBuddy 本轮请求与子任务状态'};
      rows.push(row);this.sessionCache.set(thread.id,{version:thread.version,row});
    }
    if(this.sessionCache.size>600)this.sessionCache.clear();
    return rows;
  }
  start(task,run,hooks){let id=run.threadId,sent=false,interrupted=false;const completion=(async()=>{
    try{if(!this.available)throw new Error(this.detail);if(task.model || task.effort)throw new Error('桌面连接沿用客户端模型，请清空面板模型和推理强度设置。');
      const end=(Number.isFinite(run.startedAt)?run.startedAt:Date.now())+(task.timeoutMinutes || 120)*60000;
      if(Date.now()>=end)throw new Error('任务监控时限已到，未新建会话或发送消息。');
      if(!id){const r=await this.invoke('create',[{transport:'local',cwd:task.cwd}]);if(r?.errorCode)throw new Error(r.message || r.errorCode);id=r?.info?.id;if(!id)throw new Error('WorkBuddy 没有返回新对话编号。');hooks.thread(id);}
      const before=await this.inspect(id);if(!sameFolder(before.cwd,task.cwd))throw new Error('桌面对话文件夹不一致，已停止发送。');if(!['idle','completed'].includes(before.status))throw new Error('桌面对话正在运行或等待处理，已停止发送。');if(interrupted)return{status:'interrupted'};
      if(interrupted)return{status:'interrupted'};
      if(Date.now()>=end)throw new Error('配置与检查后任务时限已到，已停止发送。');
      const requestId=run.id || randomUUID();
      hooks.checkpoint?.({phase:'sending',requestId,deadline:end});
      sent=true;const result=await this.invoke('sendPrompt',[id,[{type:'text',text:run.prompt}],{clientRequestId:requestId,clientTimestamp:Date.now(),emitUserMessage:true,_expectQueueReceipt:true,_meta:{'codebuddy.ai/conversationRequestId':requestId}}]);
      if(result?.errorCode)throw new Error(result.message || result.errorCode);if(result?.disposition==='queued')return{status:'uncertain',error:'消息被桌面端放入内部队列，需核实执行结果。'};
      hooks.checkpoint?.({phase:'sent',requestId,deadline:end});
      hooks.log?.('system','消息已发送到 WorkBuddy 桌面对话。权限确认请在桌面端处理。');
      // sendPrompt acknowledges submission before the turn completes. Match our request,
      // then wait for children/background tasks too; old replies cannot finish this run.
      let conversationRequestId;
      while(Date.now()<end){
        await this.pause(1200);const current=await this.inspect(id);
        if(interrupted)return{status:'interrupted'};
        hooks.status?.(['waiting','pending'].includes(current.status)?'waiting':'running');
        const request=this.matchRequest(current,requestId,conversationRequestId);
        if(!request)continue;
        if(!conversationRequestId){
          if(typeof request.id!=='string'||!request.id)throw new Error('原 WorkBuddy 请求缺少可持久追踪的真实编号。');
          conversationRequestId=request.id;
          hooks.checkpoint?.({phase:'sent',requestId,conversationRequestId,deadline:end});
        }
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
  matchRequest(current,requestId,conversationRequestId){
    const matches=current.requests.filter(x=>conversationRequestId?
      x.id===conversationRequestId || x.conversationRequestId===conversationRequestId:
      x.id===requestId || x.clientRequestId===requestId);
    if(matches.length>1)throw new Error('原 WorkBuddy 请求编号匹配多个记录，无法安全核实。');
    return matches[0];
  }
  canResume(run){return !!run.threadId && !!run.id && (
    (run.desktopMonitor?.phase==='sent' && run.desktopMonitor.requestId===run.id && Number.isFinite(run.desktopMonitor.deadline)) ||
    // Older runs already persisted this acknowledgement after sendPrompt returned.
    (!run.desktopMonitor && run.logs?.some(l=>l.text?.includes('消息已发送到 WorkBuddy 桌面对话。'))));}
  resume(task,run,hooks){
    if(!this.canResume(run))throw new Error('没有可确认的 WorkBuddy 原请求发送记录。');
    let interrupted=false;const id=run.threadId,requestId=run.desktopMonitor?.requestId || run.id;
    let conversationRequestId=run.desktopMonitor?.conversationRequestId;
    const deadline=run.desktopMonitor?.deadline || run.startedAt+(task.timeoutMinutes || 120)*60000;
    const completion=(async()=>{try{
      do{
        const current=await this.inspect(id);
        if(!sameFolder(current.cwd,task.cwd))throw new Error('原桌面对话文件夹已改变。');
        if(interrupted)return{status:'interrupted'};
        const request=this.matchRequest(current,requestId,conversationRequestId);
        if(!request)return{status:'uncertain',error:'未找到原 WorkBuddy 请求编号，未重新发送。'};
        if(!conversationRequestId&&typeof request.id==='string'&&request.id){
          conversationRequestId=request.id;
          hooks.checkpoint?.({...run.desktopMonitor,phase:'sent',requestId,conversationRequestId,deadline});
        }
        if(current.last?.id!==request.id)return{status:'uncertain',error:'原 WorkBuddy 会话已插入另一轮消息。'};
        hooks.status?.(['waiting','pending'].includes(current.status)?'waiting':'running');
        if(['error','failed','cancelled'].includes(request.state))return{status:request.state==='cancelled'?'interrupted':'failed',error:'WorkBuddy 原请求未成功完成。'};
        if(request.state==='completed'&&['idle','completed'].includes(current.status)){
          const output=extractText(request.assistantMessage);hooks.output(output);
          return{status:output?'completed':'uncertain',error:output?'':'原请求没有最终回复。'};
        }
        if(Date.now()>=deadline)break;
        await this.pause(1200);
      }while(true);
      return{status:'uncertain',error:'原桌面请求超过监控时间，未重新发送或取消任务。'};
    }catch(e){return{status:'uncertain',error:e.message};}})();
    return{completion,interrupt:async()=>{interrupted=true;await this.invoke('cancel',[id]);}};
  }
  async recoveryState(task,run){
    if(!this.canResume(run)||typeof run.desktopMonitor?.conversationRequestId!=='string'||!run.desktopMonitor.conversationRequestId)throw new Error('没有已保存的 WorkBuddy 真实请求编号，不能安全恢复监控。');
    const current=await this.inspect(run.threadId);
    if(!sameFolder(current.cwd,task.cwd))throw new Error('原桌面对话文件夹已改变。');
    const request=this.matchRequest(current,run.desktopMonitor.requestId,run.desktopMonitor.conversationRequestId);
    if(!request||current.last?.id!==request.id)throw new Error('原 WorkBuddy 请求不存在或会话已插入另一轮消息。');
    if(['error','failed','cancelled'].includes(request.state))throw new Error('原 WorkBuddy 请求没有成功执行证据。');
    if(request.state==='completed'&&['idle','completed'].includes(current.status)&&extractText(request.assistantMessage))return'completed';
    if(['waiting','pending'].includes(current.status))return'waiting';
    if(['working','running'].includes(current.status))return'running';
    throw new Error('原 WorkBuddy 请求状态无法核实，未重新发送。');
  }
  async verify(){let output='',id;const result=await this.start({cwd:process.cwd(),timeoutMinutes:2},{prompt:'Reply with exactly AGENT_CONNECTION_OK. Do not use tools, read files, or make changes.',id:randomUUID()},{thread:x=>id=x,output:t=>output=t,log(){}}).completion;const verified=result.status==='completed'&&output.trim()==='AGENT_CONNECTION_OK';this.verification={at:Date.now(),status:verified?'verified':'failed',error:verified?'':result.error || '未收到预期测试回复。',threadId:id};return this.snapshot();}
  async launch(onProgress){
    const roots=[process.env.WORKBUDDY_DESKTOP_BINARY,'E:\\workbuddy\\WorkBuddy.exe',path.join(process.env.LOCALAPPDATA || path.join(homedir(),'AppData/Local'),'Programs/WorkBuddy/WorkBuddy.exe')];const exe=roots.find(x=>x&&path.isAbsolute(x)&&existsSync(x));
    return connectOrLaunch(this,{name:'WorkBuddy.exe',binary:exe,onProgress});}
  close(){const rpc=this.rpc;this.rpc=null;this.available=false;rpc?.close();}
}
export function extractText(value){const texts=[];function visit(x){if(!x || typeof x!=='object')return;if(x.role==='user')return;if(x.type==='text'&&typeof x.text==='string')texts.push(x.text);if(typeof x.content==='string' && x.role==='assistant')texts.push(x.content);for(const [k,v]of Object.entries(x))if(!['prompt','userMessage','input'].includes(k)&&typeof v==='object')Array.isArray(v)?v.forEach(visit):visit(v);}visit(value);return texts.join('\n\n').slice(-1000000);}
