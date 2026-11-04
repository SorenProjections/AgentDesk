const active = new Set(['dispatching','running','waiting']);

export function updateRunHistory(store, scheduler, id, action, clock = Date.now) {
  return updateRunHistories(store,scheduler,[id],action,clock)[0];
}

export function updateRunHistories(store, scheduler, ids, action, clock = Date.now) {
  if (!Array.isArray(ids) || !ids.length || ids.length > 500 || ids.some(id=>typeof id!=='string')) throw new Error('请选择 1 至 500 条运行记录。');
  if (!['dismiss','remind','delete','restore'].includes(action)) throw new Error('运行记录操作无效。');
  const runs=[...new Set(ids)].map(id=>{
    const run=store.data.runs.find(row=>row.id===id);
    if(!run)throw new Error('运行记录不存在。');
    if(active.has(run.status)||scheduler.activeRuns.has(id))throw new Error('运行中的记录不能处理或删除，请等待结束。');
    return run;
  });
  const at=clock();
  for(const run of runs){
  if (action === 'dismiss') run.attentionHandledAt = at;
  if (action === 'remind') delete run.attentionHandledAt;
  if (action === 'delete') run.deletedAt ||= at;
  if (action === 'restore') delete run.deletedAt;
  }
  // Keep the execution outcome, dependency references, evidence and file leases.
  // Deleting a record is reversible and does not approve an uncertain result.
  store.save(); scheduler.emit('change');
  return runs.map(run=>({id:run.id,status:run.status,attentionHandledAt:run.attentionHandledAt,deletedAt:run.deletedAt}));
}

export async function runHistoryRoutes(request,response,url,{store,scheduler,body,send}) {
  if(url.pathname==='/api/runs/history'&&request.method==='POST'){
    const input=await body(request);
    send(response,200,{runs:updateRunHistories(store,scheduler,input.ids,input.action)});
    return true;
  }
  const match = url.pathname.match(/^\/api\/runs\/([a-zA-Z0-9-]+)\/history$/);
  if (!match || request.method !== 'POST') return false;
  const input = await body(request);
  send(response,200,updateRunHistory(store,scheduler,match[1],input.action));
  return true;
}
