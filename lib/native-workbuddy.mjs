import { open, readdir, readFile, stat } from 'node:fs/promises';
import path from 'node:path';
import { homedir } from 'node:os';

export function workBuddyNativeState(status, records, runtime = []) {
  const user = records.findLast(r => r.type === 'message' && r.role === 'user');
  const requestId = r => r?.providerData?.conversationRequestId || r?.requestId || r?.id || '';
  const version = requestId(user);
  const assistant = records.findLast(r => r.type === 'message' && r.role === 'assistant' && requestId(r) === version);
  const lastRuntime = runtime.findLast(r => r.at >= (Number(user?.timestamp) || Infinity) && r.finalState);
  let state = ['working','planning','active'].includes(status) ? 'running' : ['waiting','pending'].includes(status) ? 'waiting' : status === 'error' ? 'failed' : status === 'terminated' ? 'uncertain' : 'idle';
  if (status === 'completed') {
    // WorkBuddy also persists cancelled turns as completed. Require this request's
    // history and, when present, its explicit runtime terminal state.
    state = lastRuntime?.finalState === 'cancelled' || assistant?.status === 'cancelled' ? 'interrupted'
      : lastRuntime?.finalState === 'error' || assistant?.status === 'error' ? 'failed'
      : version && assistant?.status === 'completed' && lastRuntime?.finalState === 'completed' ? 'completed' : 'uncertain';
  }
  return { status: state, version, startedAt: Number(user?.timestamp) || undefined,
    output: state === 'completed' ? (assistant.content || []).filter(c => c.type === 'text').map(c => c.text || '').join('\n\n').slice(-6000) : '',
    evidence: 'WorkBuddy 本机会话库与本轮记录（只读）' };
}

async function tail(file, limit) {
  const fd = await open(file,'r');
  try { const size=(await fd.stat()).size;const start=Math.max(0,size-limit);const bytes=Buffer.alloc(size-start);await fd.read(bytes,0,bytes.length,start);const text=bytes.toString('utf8');return (start?text.slice(text.indexOf('\n')+1):text).split('\n'); }
  finally {await fd.close();}
}
export class NativeWorkBuddyObserver {
  constructor({home=process.env.WORKBUDDY_CONFIG_DIR || process.env.CODEBUDDY_CONFIG_DIR || path.join(homedir(),'.workbuddy')}={}) {this.home=home;this.paths=new Map();this.cache=new Map();}
  async database() {
    if(this.db)return this.db;
    const {DatabaseSync}=await import('node:sqlite');this.db=new DatabaseSync(path.join(this.home,'workbuddy.db'),{readOnly:true});return this.db;
  }
  async index() {
    if(this.indexAt && Date.now()-this.indexAt<30000)return;
    const root=path.join(this.home,'projects');const dirs=await readdir(root,{withFileTypes:true});
    this.paths.clear();
    for(const dir of dirs.filter(d=>d.isDirectory() && !d.isSymbolicLink())) {
      const folder=path.join(root,dir.name);
      for(const file of await readdir(folder,{withFileTypes:true})) if(file.isFile() && /^[a-zA-Z0-9-]+\.jsonl$/.test(file.name))this.paths.set(file.name.slice(0,-6),path.join(folder,file.name));
    }
    this.indexAt=Date.now();
  }
  async history(file) {
    const size=await stat(file);const key=`${size.size}:${size.mtimeMs}`;
    if(this.cache.get(file)?.key===key)return this.cache.get(file).rows;
    let rows=[];
    for(let bytes=512*1024;bytes<=8*1024*1024;bytes*=2) {
      rows=(await tail(file,bytes)).flatMap(line=>{try{return[JSON.parse(line)];}catch{return[];}});
      if(rows.some(r=>r.type==='message'&&r.role==='user') || size.size<=bytes)break;
    }
    const user=rows.findLast(r=>r.type==='message'&&r.role==='user');const version=user?.providerData?.conversationRequestId || user?.requestId || user?.id;const assistant=rows.findLast(r=>r.type==='message'&&r.role==='assistant'&&(r.providerData?.conversationRequestId || r.requestId || r.id)===version);const compact=[...(user?[{type:user.type,role:user.role,id:user.id,timestamp:user.timestamp,providerData:{conversationRequestId:version}}]:[]),...(assistant?[{type:assistant.type,role:assistant.role,status:assistant.status,timestamp:assistant.timestamp,providerData:{conversationRequestId:version},content:(assistant.content||[]).filter(c=>c.type==='text').map(c=>({type:'text',text:String(c.text||'').slice(-6000)}))}]:[]),{timestamp:rows.at(-1)?.timestamp}];this.cache.set(file,{key,rows:compact});return compact;
  }
  async listSessions(known=[]) {
    const db=await this.database();await this.index();
    const select='SELECT id,cwd,COALESCE(custom_title,title) AS title,status,updated_at,last_activity_at FROM sessions WHERE deleted_at IS NULL AND (transport IS NULL OR transport=\'local\')';
    const rows=db.prepare(select+' ORDER BY updated_at DESC LIMIT 100').all();const seen=new Set(rows.map(r=>r.id));
    const extra=db.prepare(select+' AND id=?');for(const id of known)if(!seen.has(id)){const r=extra.get(id);if(r)rows.push(r);}
    const running=db.prepare(select+" AND status IN ('working','planning','active','waiting','pending')").all();for(const r of running)if(!rows.some(x=>x.id===r.id))rows.push(r);
    const sessions=[];
    for(const row of rows) {
      const file=this.paths.get(row.id);let records=[],runtime=[];
      try{if(file)records=await this.history(file);}catch{}
      const dates=[new Date(row.updated_at).toISOString().slice(0,10),new Date().toISOString().slice(0,10)];
      for(const date of new Set(dates))try{
        const lines=await tail(path.join(this.home,'logs',date,'sdk','conversations',row.id+'.log'),128*1024);
        for(const line of lines)if(line.includes('state-machine:transition')){const index=line.indexOf('{');const event=JSON.parse(line.slice(index));if(event.finalState)runtime.push({at:Date.parse(line.slice(0,line.indexOf(' '))),finalState:event.finalState});}
      }catch{}
      const state=workBuddyNativeState(row.status,records,runtime);const lastActivity=Math.max(Number(row.last_activity_at)||0,Number(records.at(-1)?.timestamp)||0,Number(row.updated_at)||0);
      if(state.status==='running' && Date.now()-lastActivity>15*60000){state.status='uncertain';state.evidence='WorkBuddy 本轮超过 15 分钟无记录更新，请在客户端核实';}
      sessions.push({id:row.id,name:row.title || '未命名会话',cwd:row.cwd,updatedAt:lastActivity,...state,readOnly:true});
    }
    const files=new Set(rows.map(r=>this.paths.get(r.id)));for(const key of this.cache.keys())if(!files.has(key))this.cache.delete(key);
    return sessions;
  }
  close(){this.db?.close();this.db=null;}
}
