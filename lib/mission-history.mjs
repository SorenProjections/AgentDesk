// Reversible removal from the workbench; evidence and unresolved execution stay intact.
export function updateMissionHistory(supervision, ids, action) {
  if (!Array.isArray(ids) || !ids.length || ids.length>500 || ids.some(id=>typeof id!=='string')) throw new Error('请选择 1 至 500 个督导任务。');
  if (!['delete','restore'].includes(action)) throw new Error('督导记录操作无效。');
  const {scheduler,store}=supervision;
  const missions=[...new Set(ids)].map(id=>{
    const mission=supervision.get(id,{includeDeleted:true});
    if(supervision.busy.has(id)||supervision.jobs.has(id)||['running','dispatching','collecting'].includes(mission.state)||
      [...scheduler.activeRuns.values()].some(({task,run})=>task.missionId===id||run.fileLeaseOwner===id)||
      store.data.runs.some(run=>run.missionId===id&&['dispatching','running','waiting'].includes(run.status)))throw new Error('督导任务仍在执行或验收，不能删除或恢复。');
    return mission;
  });
  const at=supervision.clock();
  for(const mission of missions){
    if(action==='delete'&&!mission.deletedAt){
      // Pause future instructions before hiding their source. Restore never sends them.
      for(const task of store.data.tasks)if(task.missionId===mission.id&&!task.paused)scheduler.pause(task.id,true);
      if(!['paused','accepted'].includes(mission.state)){
        mission.pausedFrom=mission.state;mission.state='paused';
      }
      mission.deletedAt=at;mission.updatedAt=at;
    }
    if(action==='restore'&&mission.deletedAt){delete mission.deletedAt;mission.updatedAt=at;}
  }
  supervision.retireDeletedLeases();
  supervision.save();
  return missions.map(mission=>supervision.summary(mission));
}
