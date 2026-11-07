import { connect } from 'node:net';
import { randomUUID } from 'node:crypto';
import { readdirSync, readFileSync } from 'node:fs';
import { homedir } from 'node:os';
import path from 'node:path';
import { containsPath, pathKey } from './paths.mjs';

function projectPipe() {
  if (process.env.CODEX_APP_TOOLS_PIPE_PATH) return process.env.CODEX_APP_TOOLS_PIPE_PATH;
  if (process.platform !== 'win32') return null;
  const names = readdirSync('\\\\.\\pipe\\').filter(name => /^codex-app-tools-[a-f0-9-]{36}$/i.test(name));
  if (names.length !== 1) throw new Error('无法确定 Codex 客户端连接，请从 Codex 启动面板。');
  return '\\\\.\\pipe\\' + names[0];
}

// Call the same local project tools as the desktop connector.
function requestDesktopTool(params, { pipe = projectPipe(), timeout = 10000 } = {}) {
  if (!pipe) return Promise.reject(new Error('Codex 客户端项目接口未连接。'));
  const id = randomUUID();
  return new Promise((resolve, reject) => {
    const socket = connect(pipe); let buffer = Buffer.alloc(0), settled = false;
    const finish = (error, result) => { if (settled) return; settled = true; clearTimeout(timer); socket.destroy(); error ? reject(error) : resolve(result); };
    const timer = setTimeout(() => finish(new Error('Codex 客户端项目同步超时。')), timeout);
    socket.on('error', error => finish(new Error('Codex 客户端项目接口不可用：' + error.message)));
    socket.on('close', () => { if (!settled) finish(new Error('Codex 客户端项目连接已中断。')); });
    socket.on('connect', () => {
      const body = Buffer.from(JSON.stringify({ id, jsonrpc:'2.0', method:'tools/call', params })), frame = Buffer.alloc(4 + body.length);
      frame.writeUInt32LE(body.length); body.copy(frame, 4); socket.write(frame);
    });
    socket.on('data', data => {
      try {
        buffer = Buffer.concat([buffer, data]);
        if (buffer.length < 4) return;
        const length = buffer.readUInt32LE();
        if (length > 8 * 1024 * 1024) throw new Error('Codex 项目响应过大。');
        if (buffer.length < length + 4) return;
        const response = JSON.parse(buffer.subarray(4, length + 4).toString());
        if (response.id !== id || response.error) throw new Error(response.error?.message || 'Codex 项目响应不匹配。');
        if (response.result?.isError) throw new Error('Codex 项目同步失败。');
        finish(null, response.result);
      } catch (error) { finish(error); }
    });
  });
}

export async function desktopProjectTool(tool, args, options) {
  if (!['list_projects', 'list_threads', 'read_thread', 'create_thread', 'send_message_to_thread', 'set_thread_archived', 'move_thread_to_project', 'move_thread_to_sidebar_section'].includes(tool)) throw new Error('不支持的 Codex 客户端操作。');
  const result = await requestDesktopTool({
    callerSource:'codex', hostId:'local', namespace:'codex_app', tool, arguments:args,
    threadId:process.env.CODEX_THREAD_ID || args.threadId || 'agentdesk', turnId:'agentdesk-project-sync', callId:randomUUID(),
  }, options);
  const text = (result?.contentItems || result?.content || []).filter(x=>typeof x.text === 'string').map(x=>x.text).join('\n');
  try { return JSON.parse(text); } catch { throw new Error(text || 'Codex 项目同步未返回确认。'); }
}

export class CodexDesktop {
  constructor({ invoke = desktopProjectTool, pause = ms => new Promise(resolve => setTimeout(resolve, ms)), clock = Date.now } = {}) {
    this.invoke=invoke; this.pause=pause; this.clock=clock; this.available=false; this.detail='正在连接 Codex 客户端';
  }
  snapshot() { return {id:'codex',name:'Codex',available:this.available,detail:this.detail,capabilities:{desktop:true,localFiles:true,projects:true,threads:true,resume:true,captureThread:true,model:true,effort:true}}; }
  async probe() {
    try { await this.listProjects(); this.available=true; this.detail='直接发送到 Codex 客户端，沿用客户端权限与模型配置'; }
    catch(error) {this.available=false;this.detail=error.message;}
    return this.snapshot();
  }
  projectId(id) {
    try {
      const state=JSON.parse(readFileSync(path.join(process.env.CODEX_HOME || path.join(homedir(),'.codex'),'.codex-global-state.json'),'utf8'));
      for(const map of Object.values(state['app-server-project-id-by-legacy-project-id-by-host'] || {})) for(const [legacy,current] of Object.entries(map)) if(current===id)return legacy;
    } catch {}
    return id;
  }
  async listProjects() {
    const result=await this.invoke('list_projects',{});
    let aliases={};
    try { aliases=JSON.parse(readFileSync(path.join(process.env.CODEX_HOME || path.join(homedir(),'.codex'),'.codex-global-state.json'),'utf8'))['app-server-project-id-by-legacy-project-id-by-host']?.local || {}; } catch {}
    return result.projects.filter(p=>p.projectKind==='local'&&p.hostId==='local').map(p=>({id:p.projectId,name:p.label,rootPaths:[p.path],aliases:aliases[p.projectId]?[aliases[p.projectId]]:[]}));
  }
  async resolveProject(cwd,id='') {
    id=this.projectId(id);
    const projects=(await this.listProjects()).filter(p=>(!id||p.id===id)&&(cwd?p.rootPaths.some(root=>containsPath(root,cwd)):!!id));
    if(id&&!projects.length)throw Error('所选 Codex 客户端项目不存在或工作目录不匹配。');
    projects.sort((a,b)=>Math.max(...b.rootPaths.map(pathKey).map(x=>x.length))-Math.max(...a.rootPaths.map(pathKey).map(x=>x.length)));
    if(!id&&projects.length>1&&pathKey(projects[0].rootPaths[0]).length===pathKey(projects[1].rootPaths[0]).length)throw Error('此目录对应多个 Codex 项目，请明确选择。');
    return projects[0]||null;
  }
  async listThreads({cwd,projectId,cursor,searchTerm}={}) {
    const result=await this.invoke('list_threads',{mode:'history',source:'codex',hostId:'local',limit:50,...(cursor?{cursor}:{})});
    const project=projectId&&this.projectId(projectId);
    return {data:result.threads.filter(t=>(!project||t.projectId===project)&&(!cwd||pathKey(t.cwd)===pathKey(cwd))&&(!searchTerm||t.title?.includes(searchTerm))).map(t=>({...t,name:t.title,status:{type:t.status}})),nextCursor:result.nextCursor||null};
  }
  inspect(threadId) { return this.invoke('read_thread',{threadId,hostId:'local',turnLimit:2,includeOutputs:false,maxOutputCharsPerItem:20000}); }
  async assertThreadProject(threadId,projectId) {
    let cursor;
    do {
      const page=await this.invoke('list_threads',{mode:'history',source:'codex',hostId:'local',limit:50,...(cursor?{cursor}:{})});
      const thread=page.threads.find(t=>t.id===threadId);
      if(thread){if(thread.projectId!==projectId)throw Error('Codex 对话已不在所选项目中，请重新选择。');return;}
      if(cursor===page.nextCursor)break;
      cursor=page.nextCursor;
    } while(cursor);
    throw Error('所选 Codex 对话在客户端中不可用，请重新选择。');
  }
  canResume(run) {return !!(run.execution==='desktop'&&run.threadId&&run.desktopMonitor?.phase==='sent');}
  async recoveryState(task,run) {
    const read=await this.inspect(run.threadId);
    const turn=read.turns.find(t=>t.id===run.desktopMonitor?.turnId);
    return turn?.status==='completed'?'completed':turn?.status==='inProgress'?'running':'uncertain';
  }
  start(task,run,hooks) {return this.#observe(task,run,hooks,false);}
  resume(task,run,hooks) {return this.#observe(task,run,hooks,true);}
  #observe(task,run,hooks,recovery) {
    let stopped=false,wake;
    const stopSignal=new Promise(resolve=>{wake=resolve;});
    const completion=(async()=>{
      let checkpoint=run.desktopMonitor;
      if(!recovery) {
        const project=task.nativeProjectId?await this.resolveProject(task.cwd,task.nativeProjectId):null;
        if(project)hooks.project?.(project.id,project.name);
        const before=run.threadId?await this.inspect(run.threadId):null;
        if(before?.thread.status?.type==='active')throw Error('Codex 客户端中的目标对话正在运行，请等待结束。');
        if(run.threadId&&project)await this.assertThreadProject(run.threadId,project.id);
        checkpoint={phase:'dispatching',baselineTurnIds:(before?.turns||[]).map(t=>t.id),deadline:this.clock()+(Number(task.timeoutMinutes)||120)*60000};
        hooks.checkpoint?.(checkpoint);
        let result;
        const overrides={...(task.model?{model:task.model}:{}),...(task.effort?{thinking:task.effort}:{})};
        try {
          result=run.threadId
            ? await this.invoke('send_message_to_thread',{threadId:run.threadId,hostId:'local',prompt:run.prompt,...overrides},{timeout:45000})
            : await this.invoke('create_thread',{title:task.title,prompt:run.prompt,...overrides,target:project?{type:'project',projectId:project.id,environment:{type:'local'}}:{type:'projectless'}},{timeout:45000});
        } catch(error) { return {status:'uncertain',error:'客户端发送结果未确认，未自动重发。'+error.message}; }
        const threadId=result.threadId||run.threadId;
        if(!threadId)return{status:'uncertain',error:'客户端仍在创建对话，保留设置编号 '+(result.clientThreadId||'')+'；未自动重发。'};
        hooks.thread?.(threadId);
        checkpoint={...checkpoint,phase:'sent',threadId,...(result.turnId?{turnId:result.turnId}:{})};
        hooks.checkpoint?.(checkpoint);hooks.log?.('system','消息已直接发送到 Codex 客户端；模型与权限由客户端处理。');
      }
      while(!stopped&&this.clock()<checkpoint.deadline) {
        const read=await this.inspect(run.threadId||checkpoint.threadId);
        let turn=checkpoint.turnId?read.turns.find(t=>t.id===checkpoint.turnId):read.turns.find(t=>!(checkpoint.baselineTurnIds||[]).includes(t.id));
        if(turn&&!checkpoint.turnId){checkpoint={...checkpoint,turnId:turn.id};hooks.checkpoint?.(checkpoint);}
        if(checkpoint.turnId&&!turn&&read.turns.length)return{status:'uncertain',error:'客户端会话已插入其他轮次，原轮次状态未确认；没有重发。'};
        if(turn){
          const output=(turn.items||[]).filter(i=>i.type==='agentMessage').map(i=>i.text||'').filter(Boolean).join('\n\n');
          if(output)hooks.output?.(output);
          if(['completed','failed','interrupted'].includes(turn.status))return{status:turn.status,error:turn.error?.message||''};
        }
        const flags=read.thread.status?.activeFlags||[];
        hooks.status?.(flags.some(x=>/approval|input|waiting/i.test(x))?'waiting':'running');
        await Promise.race([this.pause(2500),stopSignal]);
      }
      return {status:'uncertain',error:stopped?'已停止工作台监控，任务仍在 Codex 客户端中执行。':'监控时间已到，任务仍由 Codex 客户端处理；未自动重发。'};
    })().catch(error=>({status:'uncertain',error:error.message}));
    return {completion,interrupt:async()=>{stopped=true;wake();}};
  }
  close() {}
}
