import {$,element,icon,api,toast,containDialogFocus,localDateFormat} from './api.js';
const pages={sessions:['会话工作台','集中查看会话进展与任务提醒。'],queue:['定时任务','统一安排豆包、WorkBuddy 与 Codex 的定时任务。'],runs:['运行记录','查看执行结果，回溯每一次任务。'],agents:['Agent 接入','连接桌面客户端，开始协同工作。'],settings:['后台设置','设置运行方式，让工作有序继续。']};
export class Workspace {
  constructor({newTask,openRun,handleAttention}){
    this.openRun=openRun;this.newTask=newTask;
    document.querySelector('.skip-link').addEventListener('click',event=>{event.preventDefault();$('mainContent').focus();$('mainContent').scrollIntoView({block:'start'});});
    document.querySelectorAll('[data-nav]').forEach(button=>button.addEventListener('click',()=>this.navigate(button.dataset.nav)));
    $('closeRun').addEventListener('click',()=>this.showRun(false));
    $('attentionBanner').addEventListener('click',()=>{if(this.attentionRun)this.openRun(this.attentionRun);});
    $('dismissAttention').addEventListener('click',()=>{if(this.attentionRun)void handleAttention(this.attentionRun);});
    window.addEventListener('hashchange',()=>this.navigate(location.hash.slice(1),false));this.navigate(location.hash.slice(1) || 'sessions',false);
  }
  navigate(page,updateHash=true){if(!pages[page])page='sessions';this.page=page;document.querySelectorAll('[data-page]').forEach(section=>section.hidden=section.dataset.page!==page);document.querySelectorAll('.nav-item').forEach(button=>{const current=button.dataset.nav===page;button.classList.toggle('selected',current);current?button.setAttribute('aria-current','page'):button.removeAttribute('aria-current');});$('pageTitle').textContent=pages[page][0];$('pageDescription').textContent=pages[page][1];$('breadcrumbCurrent').textContent=pages[page][0];document.title=pages[page][0]+' · AgentDesk';if(updateHash && location.hash!=='#'+page)history.replaceState(null,'','#'+page);window.scrollTo({top:0,left:0,behavior:'instant'});}
  showEditor(open=true){const dialog=$('scheduleDialog');$('taskEditor').hidden=!open;if(open){this.navigate('queue');if(dialog&&!dialog.open)dialog.showModal();}else if(dialog?.open)dialog.close();}
  showRun(open=true){$('recordsWorkspace').classList.toggle('has-detail',open);if(open)this.navigate('runs');else window.scrollTo({top:0,left:0,behavior:'instant'});}
  update(state,hasPending){
    const pending=state.tasks.filter(hasPending).length;const live=state.runs.find(run=>['dispatching','running','waiting'].includes(run.status));
    const connected=(state.providers || []).filter(p=>['codex','antigravityDesktop','workbuddyDesktop','doubaoDesktop'].includes(p.id)&&p.available).length;$('navPending').textContent=pending;
    const attention=state.runs.filter(run=>!run.deletedAt&&(run.status==='waiting'||run.status==='uncertain'&&!run.attentionHandledAt));const actionable=attention.find(run=>run.id===state.activeRunId)||attention.at(-1);
    $('navAttention').hidden=!attention.length;$('navAttention').textContent=attention.length;this.attentionRun=actionable?.id;$('attentionBanner').hidden=!actionable;$('attentionText').textContent=actionable?(actionable.status==='waiting'?'运行正在等待你的处理：':'执行结果需要核实：')+actionable.taskTitle:'';
    $('attentionNotice').hidden=!actionable;$('dismissAttention').hidden=actionable?.status==='waiting';
    $('dismissAttention').disabled=!state.historyManagement;
    $('dismissAttention').title=state.historyManagement?'收起这条历史运行提醒，原始结果保留':'记录管理更新已准备，重新启动后台后生效';
    const total=(state.providers || []).filter(p=>['codex','antigravityDesktop','workbuddyDesktop','doubaoDesktop'].includes(p.id)).length;
    const paused=state.settings?.queuePaused;$('queueStateLabel').textContent=state.maintenance?'正在验证连接':paused?'队列已暂停':live?'正在执行任务':'队列自动运行';$('queueDot').classList.toggle('paused',!!paused);$('queueMetrics').textContent=`${pending} 条待发送 · ${connected}/${total} 个本机 Agent 已连接`;
  }
  emptyQueue({filtered=false}={}){
    const box=element('div','queue-empty');if(filtered){box.append(icon('queue'),element('h2','','没有符合条件的任务'),element('p','','试试其他筛选条件，或清空搜索内容。'));return box;}
    const diagram=element('div','handoff-diagram');for(const [i,label]of ['预设消息','等待条件','Agent 执行'].entries()){if(i)diagram.append(element('span','handoff-line'));const step=element('div','handoff-step');const mark=element('div','handoff-mark');mark.append(icon(['message','clock','agents'][i]));step.append(mark,element('span','',label));diagram.append(step);}
    box.append(diagram,element('h2','','还没有安排任务'),element('p','','写好下一条提示词，选择发送条件。\n后台会在条件满足时，按队列顺序执行。'));const create=element('button','primary','新建第一条任务');create.type='button';create.prepend(icon('plus'));create.addEventListener('click',this.newTask);box.append(create);const links=element('div','empty-links');for(const [page,text]of [['agents','连接 Agent'],['settings','配置夜间运行']]){const button=element('button','text-button',text);button.type='button';button.addEventListener('click',()=>this.navigate(page));links.append(button);}box.append(links);return box;
  }
}
const running = new Set(['dispatching', 'running', 'waiting']);
const labels = {completed:'已完成',failed:'失败',interrupted:'已停止',uncertain:'待核实',dispatching:'正在发送',running:'运行中',waiting:'等你处理'};
const date = localDateFormat({month:'long', day:'numeric', hour:'2-digit', minute:'2-digit', hour12:false});
const weekday = ['日','一','二','三','四','五','六'];
export function scheduleLabel(task) {
  const rule = task.trigger?.recurrence;
  if (rule) return `${rule.frequency === 'daily' ? '每天' : '每周' + rule.weekdays.map(day => weekday[day]).join('、')} ${rule.time}`;
  return task.trigger?.type === 'queue' ? '轮到时运行' : task.trigger?.type === 'afterTask' ? '前置任务结束后运行' : task.trigger?.type === 'afterConversation' ? '桌面任务结束后运行' : '指定日期';
}
function button(text, action, className='quiet') { const node=element('button',className,text);node.type='button';node.addEventListener('click',action);return node; }
function setting(text, control) { const row=element('label','schedule-setting');row.append(element('span','',text),control);return row; }
function checkbox(id, checked=false) {const node=element('input','switch');node.type='checkbox';node.id=id;node.defaultChecked=checked;node.checked=checked;return node;}

export class ScheduledView {
  constructor({select, openRun, create, edit, refresh, close}) {
    const nodes=new Map([...document.querySelectorAll('[id]')].map(node=>[node.id,node]));
    const $=id=>document.getElementById(id)||nodes.get(id);
    Object.assign(this,{select,openRun,create,edit,refresh,close});this.expanded=new Set();
    document.querySelector('[data-nav="queue"] span').textContent='定时任务';
    $('queuePage').classList.add('scheduled-page');
    this.dialog=element('dialog','schedule-dialog');this.dialog.id='scheduleDialog';this.dialog.setAttribute('aria-labelledby','editorTitle');
    document.body.append(this.dialog);this.dialog.append($('taskEditor'));
    this.dialog.addEventListener('cancel',event=>{event.preventDefault();void close();});containDialogFocus(this.dialog);
    $('closeEditor').textContent='×';$('closeEditor').setAttribute('aria-label','关闭设置');
    $('editorTitle').textContent='设置定时任务';
    const form=$('taskForm'), original=[...form.children];
    const promptSection=element('div','schedule-description');
    $('prompt').placeholder='说明…';$('prompt').rows=5;promptSection.append($('prompt'));
    const schedule=element('div','schedule-block');
    schedule.append(setting('重复',$('repeatFrequency')));
    const timeRow=setting('时间',$('repeatTime'));timeRow.id='scheduleTimeRow';schedule.append(timeRow);
    const repeatFields=$('repeatFields');
    const timeFields=$('timeFields');timeFields.replaceChildren(schedule,$('onceFields'),$('weekdayFields'));
    // Keep legacy IDs because the queue and dependency controls share this form.
    repeatFields.replaceChildren();repeatFields.hidden=true;
    timeFields.append(repeatFields);
    const advanced=element('details','schedule-advanced');advanced.id='scheduleAdvanced';advanced.append(element('summary','','高级'));
    const settings=element('div','schedule-settings');advanced.append(settings);
    const local=checkbox('scheduleLocal',true);local.disabled=true;local.title='当前版本仅支持在此电脑上运行';
    settings.append(setting('在此电脑上运行',local));
    const notification=element('select');notification.id='notificationPolicy';notification.append(new Option('所有运行','all'),new Option('仅异常运行','errors'),new Option('不通知','none'));settings.append(setting('通知',notification));
    this.newChat=checkbox('everyRunNew',true);settings.append(setting('每次运行时都开启新聊天',this.newChat));
    const archive=checkbox('archiveSuccessful');settings.append(setting('归档成功运行记录',archive));
    settings.append(setting('Agent',$('provider')));
    const projectRow=(id,select,refresh)=>{
      const row=setting('项目',element('span','schedule-project-control'));row.id=id;
      row.lastChild.append(select,refresh);settings.append(row);
    };
    projectRow('codexScheduleProject',$('codexProject'),$('refreshCodexProjects'));
    projectRow('doubaoScheduleProject',$('nativeProject'),$('refreshProjects'));
    this.doubaoHelp=element('p','schedule-note','选择豆包客户端项目，或保留普通聊天。项目未显示时，在豆包展开项目后刷新。');settings.append(this.doubaoHelp);
    const wbProject=element('select');wbProject.id='workbuddyProject';wbProject.append(new Option('选择项目目录',''));
    const wbRefresh=button('刷新',()=>wbProject.dispatchEvent(new Event('refresh')),'quiet');wbRefresh.id='refreshWorkbuddyProjects';
    projectRow('workbuddyScheduleProject',wbProject,wbRefresh);
    this.workbuddyHelp=element('p','schedule-project-path');this.workbuddyHelp.id='workbuddyProjectPath';settings.append(this.workbuddyHelp);
    settings.append($('projectFields'));
    const model=element('input');model.id='taskModel';model.placeholder='沿用客户端';model.setAttribute('list','scheduleModels');model.autocomplete='off';model.maxLength=120;
    const models=element('datalist');models.id='scheduleModels';settings.append(setting('模型',model),models);
    const effort=element('select');effort.id='taskEffort';
    for(const [value,text] of [['','沿用客户端'],['low','低'],['medium','中'],['high','高'],['xhigh','很高'],['max','最高'],['ultra','极高']])effort.append(new Option(text,value));
    settings.append(setting('强度',effort));
    this.clientSettingsNote=element('p','schedule-note');settings.append(this.clientSettingsNote);
    const more=element('details','schedule-more');more.append(element('summary','','更多设置'));advanced.append(more);
    const rest=element('div','schedule-extra');more.append(rest);
    const name=setting('任务名称',$('taskTitle'));$('taskTitle').required=false;$('taskTitle').placeholder='根据说明自动命名';rest.append(name);
    rest.append(setting('运行条件',$('triggerType')),$('dependencyFields'));
    if($('watchFields'))rest.append($('watchFields'));
    const target=element('div','schedule-target');target.id='scheduleTarget';
    const choice=document.querySelector('input[name="threadMode"]').closest('.choice-row');
    const reuse=element('label','radio-choice'),radio=element('input');radio.type='radio';radio.name='threadMode';radio.value='reuse';reuse.append(radio,element('span','','复用任务对话'));choice.append(reuse);
    target.append(choice,$('existingThreadField'));rest.append(target);
    // Retain helper/control nodes, without the old numbered editor sections.
    const helpers=element('div','schedule-notes');helpers.append($('newThreadHelp'),$('providerHelp'),$('triggerHelp'),$('codexProjectHelp'));
    rest.append(helpers,$('timeoutMinutes').closest('.timeout-field'),setting('错过预约时间',$('latePolicy')),$('defaultModel'));
    const actions=document.querySelector('.form-actions');
    this.cancel=button('取消',()=>void close(),'secondary');actions.prepend(this.cancel);
    const retained=element('div');retained.hidden=true;
    for(const child of original)retained.append(child);
    const scrollBody=element('div','schedule-form-body');scrollBody.append(promptSection,timeFields,advanced,retained);
    form.replaceChildren(scrollBody,actions);
    $('taskActions').hidden=true;
    $('taskForm').addEventListener('invalid',event=>{for(let node=event.target.parentElement;node;node=node.parentElement)if(node.tagName==='DETAILS')node.open=true;},true);
    this.newChat.addEventListener('change',()=>{
      document.querySelector(`input[name="threadMode"][value="${this.newChat.checked?'new':'reuse'}"]`).checked=true;
      document.querySelector('input[name="threadMode"]:checked').dispatchEvent(new Event('change',{bubbles:true}));
    });
    advanced.addEventListener('toggle',()=>{if(advanced.open)void this.loadModels();});
    const pane=document.querySelector('.queue-list-pane');pane.classList.add('schedule-tree');
    const toolbar=element('div','schedule-tree-toolbar');toolbar.append(element('h2','','定时任务'),button('＋ 新建任务',create,'schedule-create'));pane.prepend(toolbar);
    const oldToolbar=pane.querySelector('.list-toolbar');oldToolbar.hidden=true;
    const search=element('div','schedule-search');search.append($('taskSearch'));toolbar.after(search);$('taskSearch').placeholder='搜索定时任务';
    this.detail=element('section','schedule-detail');this.detail.id='scheduleDetail';$('queueWorkspace').append(this.detail);
    this.upgrade=element('p','schedule-upgrade');this.upgrade.hidden=true;$('queueWorkspace').before(this.upgrade);
    const archived=element('label','run-history-filter'),show=checkbox('showArchivedRuns');show.className='';archived.append(show,document.createTextNode('显示已归档记录'));$('runSearch').closest('.list-toolbar').after(archived);
  }
  syncForm(task) {
    this.newChat.checked = !task || task.threadMode === 'new';
    $('notificationPolicy').value=task?.notificationPolicy || 'all';$('archiveSuccessful').checked=!!task?.archiveSuccessful;
    $('taskModel').value=task?.model || '';$('taskEffort').value=task?.effort || '';
    $('scheduleAdvanced').open=false;this.syncControls();
  }
  syncControls() {
    const mode=document.querySelector('input[name="threadMode"]:checked')?.value;
    this.newChat.checked=mode==='new';$('scheduleTarget').hidden=mode==='new';
    const provider=$('provider').value, capabilities=this.state?.providers?.find(row=>row.id===provider)?.capabilities || {};
    $('codexScheduleProject').hidden=provider!=='codex';$('codexProject').required=false;
    $('doubaoScheduleProject').hidden=provider!=='doubaoDesktop';this.doubaoHelp.hidden=provider!=='doubaoDesktop';
    $('workbuddyScheduleProject').hidden=provider!=='workbuddyDesktop';this.workbuddyHelp.hidden=provider!=='workbuddyDesktop';
    const clientSettings=['workbuddyDesktop','doubaoDesktop'].includes(provider);
    for(const id of ['taskModel','taskEffort']){
      const supported=!clientSettings&&($(id).id==='taskModel'?capabilities.model:capabilities.effort)!==false;
      $(id).disabled=!supported;$(id).closest('.schedule-setting').hidden=!supported;
    }
    this.clientSettingsNote.hidden=!clientSettings;this.clientSettingsNote.textContent=provider==='workbuddyDesktop'?'模型和权限沿用 WorkBuddy 客户端设置。':'模型和权限沿用豆包客户端设置。';
    $('projectFields').hidden=provider==='codex'||provider==='doubaoDesktop'||provider==='workbuddyDesktop';
    $('workbuddyProject').required=provider==='workbuddyDesktop';if(provider==='workbuddyDesktop')$('cwd').required=false;
    $('codexProjectHelp').hidden=provider!=='codex';
    const newOnly=provider!=='codex'&&capabilities.resume===false;this.newChat.disabled=newOnly;
    $('scheduleLocal').checked=true;$('scheduleLocal').disabled=true;
    $('scheduleTimeRow').hidden=$('repeatFrequency').value==='once'||$('triggerType').value!=='time';
    $('editorTitle').textContent='设置定时任务';$('saveTask').textContent=this.editing?'保存':'创建';
  }
  async loadModels() {
    if(this.modelsLoaded||$('provider').value!=='codex')return;
    try {const data=await api('models');$('scheduleModels').replaceChildren(...data.models.map(model=>new Option(model.displayName || model.model,model.model)));this.modelsLoaded=true;}
    catch { /* Manual model IDs remain usable when the catalog is unavailable. */ }
  }
  render(state,selectedId,hasPending) {
    this.upgrade.hidden=state.scheduledTasksVersion===1;
    this.upgrade.textContent='后台更新待生效。'+(state.activeRunIds?.length?`当前有 ${state.activeRunIds.length} 项任务正在运行，结束后请重启后台。`:'请重启后台以启用新版定时任务。')+'运行中的任务会继续执行；新设置暂不提交。';
    this.state=state;const query=$('taskSearch').value.trim().toLowerCase();$('taskCount').textContent=state.tasks.length;
    const tasks=[...state.tasks].sort((a,b)=>a.order-b.order).filter(task=>!query||[task.title,task.prompt,task.nativeProjectName].join(' ').toLowerCase().includes(query));
    const list=$('taskList');
    // Reuse the tree during status polling so expansion and keyboard focus stay put.
    const signature=JSON.stringify([tasks.map(task=>[task.id,task.title,task.paused,task.times,task.trigger,task.queueStatus]),state.runs.map(run=>[run.id,run.status,run.archivedAt,run.deletedAt]),selectedId,query]);
    if(signature!==this.signature){
      this.signature=signature;list.replaceChildren();
      for(const [title,predicate,collapsed] of [['活跃',task=>!task.paused&&hasPending(task),false],['已暂停',task=>task.paused,true],['已结束',task=>!task.paused&&!hasPending(task),true]]){
        const group=tasks.filter(predicate);if(!group.length&&title!=='活跃')continue;
        const section=element('details','schedule-group');section.open=!collapsed||group.some(task=>task.id===selectedId);const summary=element('summary','',title);summary.append(element('span','',String(group.length)));section.append(summary);
        for(const task of group){
          const item=element('div','schedule-task');const row=element('div','schedule-task-row'+(selectedId===task.id?' selected':''));
          const select=button('',()=>void this.select(task),'schedule-task-select');select.append(element('strong','',task.title));
          const next=task.times.find(slot=>slot.state==='pending');select.append(element('span','',`${task.paused?'已暂停':next?date.format(next.at):task.queueStatus?.reason||''} · ${scheduleLabel(task)}`));row.append(select);
          const runs=state.runs.filter(run=>run.taskId===task.id&&!run.deletedAt&&!run.archivedAt).toReversed();
          if(runs.length){const expand=button(this.expanded.has(task.id)?'⌄':'›',()=>{this.expanded.has(task.id)?this.expanded.delete(task.id):this.expanded.add(task.id);this.signature=null;this.render(state,selectedId,hasPending);},'schedule-expand');expand.setAttribute('aria-label','展开运行记录：'+task.title);expand.setAttribute('aria-expanded',String(this.expanded.has(task.id)));row.append(expand);}
          item.append(row);
          if(this.expanded.has(task.id))for(const run of runs){const child=button('',()=>this.openRun(run.id),'schedule-run-child');child.append(element('span','',task.title),element('small','',`${date.format(run.startedAt)} · ${labels[run.status]||run.status}`));item.append(child);}
          section.append(item);
        }
        list.append(section);
      }
      if(!tasks.length)list.append(element('p','schedule-empty-tree',query?'没有匹配的任务':'点击“新建任务”安排第一次运行。'));
    }
    this.renderDetail(state.tasks.find(task=>task.id===selectedId),state,hasPending);
  }
  renderDetail(task,state,hasPending) {
    const focused=this.detail.contains(document.activeElement)?document.activeElement.dataset.action:null;
    this.detail.replaceChildren();
    if(!task){const empty=element('div','schedule-welcome');empty.append(icon('clock'),element('h2','','安排一次，按时完成'),element('p','','选择任务查看每次运行，或创建新的定时任务。'),button('＋ 新建任务',this.create,'primary'));this.detail.append(empty);return;}
    const top=element('div','schedule-detail-heading');top.append(element('h2','',task.title));
    const edit=button('编辑',()=>this.edit(task),'secondary');edit.disabled=state.scheduledTasksVersion!==1;edit.dataset.action='edit';top.append(edit);this.detail.append(top);
    const next=task.times.find(slot=>slot.state==='pending');this.detail.append(element('p','schedule-detail-meta',`${task.paused?'已暂停':scheduleLabel(task)}${next?' · 下次 '+date.format(next.at):''}`));
    const prompt=element('p','schedule-detail-prompt',task.prompt);this.detail.append(prompt);
    const actions=element('div','schedule-detail-actions'),busy=state.runs.some(run=>run.taskId===task.id&&running.has(run.status));
    for(const [text,action,path] of [['立即运行','run','run'],[task.paused?'恢复任务':'暂停任务','pause',task.paused?'resume':'pause']]){
      const control=button(text,async()=>{control.disabled=true;try{await api(`tasks/${task.id}/${path}`,'POST');await this.refresh();}catch(error){toast(error.message,true);control.disabled=false;}},'secondary');control.disabled=action==='run'&&(state.scheduledTasksVersion!==1||busy||task.paused||!hasPending(task)&&task.trigger.type!=='time');control.dataset.action=action;actions.append(control);
    }
    const remove=button('删除任务',async()=>{await this.select(task);$('deleteTask').click();},'text-button danger');remove.dataset.action='delete';remove.disabled=busy;actions.append(remove);this.detail.append(actions);
    const facts=element('div','schedule-facts');for(const value of [task.nativeProjectName||(task.cwd?task.cwd.split(/[\\/]/).filter(Boolean).at(-1):'无项目'),task.threadMode==='new'?'每次开启新聊天':'连续使用同一对话',task.model||'客户端默认模型'])facts.append(element('span','',value));this.detail.append(facts);
    const history=element('div','schedule-history-heading');history.append(element('h3','','运行记录'));const show=checkbox('taskShowArchived',this.showArchived);show.className='';show.addEventListener('change',()=>{this.showArchived=show.checked;this.renderDetail(task,state,hasPending);});const label=element('label','','显示已归档');label.prepend(show);history.append(label);this.detail.append(history);
    const runs=state.runs.filter(run=>run.taskId===task.id&&!run.deletedAt&&(this.showArchived||!run.archivedAt)).toReversed();
    for(const run of runs){const record=button('',()=>this.openRun(run.id),'schedule-history-run');const heading=element('span','');heading.append(element('strong','',date.format(run.startedAt)),element('span','badge '+run.status,(labels[run.status]||run.status)+(run.archivedAt?' · 已归档':'')));record.append(heading,element('p','',run.error||(run.outputPreview || run.output)?.slice(0,180)||'查看本次对话与结果'));this.detail.append(record);}
    if(!runs.length)this.detail.append(element('p','schedule-no-runs','运行后，结果和对应对话会显示在这里。'));
    if(focused)this.detail.querySelector(`[data-action="${focused}"]`)?.focus({preventScroll:true});
  }
}
