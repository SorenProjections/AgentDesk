const active = new Set(['dispatching','running','waiting']);

export function updateRunHistory(store, scheduler, id, action, clock = Date.now) {
  const run = store.data.runs.find(row => row.id === id);
  if (!run) throw new Error('运行记录不存在。');
  if (!['dismiss','remind','delete','restore'].includes(action)) throw new Error('运行记录操作无效。');
  if (active.has(run.status) || scheduler.activeRuns.has(id)) throw new Error('运行中的记录不能处理或删除，请等待结束。');
  if (action === 'dismiss') run.attentionHandledAt = clock();
  if (action === 'remind') delete run.attentionHandledAt;
  if (action === 'delete') run.deletedAt ||= clock();
  if (action === 'restore') delete run.deletedAt;
  // Keep the execution outcome, dependency references, evidence and file leases.
  // Deleting a record is reversible and does not approve an uncertain result.
  store.save(); scheduler.emit('change');
  return {id:run.id,status:run.status,attentionHandledAt:run.attentionHandledAt,deletedAt:run.deletedAt};
}

export async function runHistoryRoutes(request,response,url,{store,scheduler,body,send}) {
  const match = url.pathname.match(/^\/api\/runs\/([a-zA-Z0-9-]+)\/history$/);
  if (!match || request.method !== 'POST') return false;
  const input = await body(request);
  send(response,200,updateRunHistory(store,scheduler,match[1],input.action));
  return true;
}
