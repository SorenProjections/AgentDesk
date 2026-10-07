import {$,element,icon} from './api.js';
const pages={sessions:['会话工作台','集中查看会话进展与任务提醒。'],queue:['工作队列','安排下一步，让任务按你的节奏接续。'],runs:['运行记录','查看执行结果，回溯每一次任务。'],agents:['Agent 接入','连接桌面客户端，开始协同工作。'],settings:['后台设置','设置运行方式，让工作有序继续。']};
export class Workspace {
  constructor({newTask,openRun}){
    this.openRun=openRun;this.newTask=newTask;
    document.querySelector('.skip-link').addEventListener('click',event=>{event.preventDefault();$('mainContent').focus();$('mainContent').scrollIntoView({block:'start'});});
    document.querySelectorAll('[data-nav]').forEach(button=>button.addEventListener('click',()=>this.navigate(button.dataset.nav)));
    $('closeEditor').addEventListener('click',()=>this.showEditor(false));$('closeRun').addEventListener('click',()=>this.showRun(false));
    $('attentionBanner').addEventListener('click',()=>{if(this.attentionRun)this.openRun(this.attentionRun);});
    window.addEventListener('hashchange',()=>this.navigate(location.hash.slice(1),false));this.navigate(location.hash.slice(1) || 'sessions',false);
  }
  navigate(page,updateHash=true){if(!pages[page])page='sessions';this.page=page;document.querySelectorAll('[data-page]').forEach(section=>section.hidden=section.dataset.page!==page);document.querySelectorAll('.nav-item').forEach(button=>{const current=button.dataset.nav===page;button.classList.toggle('selected',current);current?button.setAttribute('aria-current','page'):button.removeAttribute('aria-current');});$('pageTitle').textContent=pages[page][0];$('pageDescription').textContent=pages[page][1];$('breadcrumbCurrent').textContent=pages[page][0];document.title=pages[page][0]+' · Agent 工作台';if(updateHash && location.hash!=='#'+page)history.replaceState(null,'','#'+page);window.scrollTo({top:0,left:0,behavior:'instant'});}
  showEditor(open=true){$('taskEditor').hidden=!open;$('queueWorkspace').classList.toggle('has-editor',open);if(open)this.navigate('queue');else window.scrollTo({top:0,left:0,behavior:'instant'});}
  showRun(open=true){$('recordsWorkspace').classList.toggle('has-detail',open);if(open)this.navigate('runs');else window.scrollTo({top:0,left:0,behavior:'instant'});}
  update(state,hasPending){
    const pending=state.tasks.filter(hasPending).length;const live=state.runs.find(run=>['dispatching','running','waiting'].includes(run.status));
    const connected=(state.providers || []).filter(p=>['codex','antigravityDesktop','workbuddyDesktop'].includes(p.id)&&p.available).length;$('navPending').textContent=pending;
    const attention=state.runs.filter(run=>run.status==='waiting'||run.status==='uncertain');const actionable=attention.find(run=>run.id===state.activeRunId)||attention.at(-1);
    $('navAttention').hidden=!attention.length;$('navAttention').textContent=attention.length;this.attentionRun=actionable?.id;$('attentionBanner').hidden=!actionable;$('attentionText').textContent=actionable?(actionable.status==='waiting'?'运行正在等待你的处理：':'执行结果需要核实：')+actionable.taskTitle:'';
    const paused=state.settings?.queuePaused;$('queueStateLabel').textContent=state.maintenance?'正在验证连接':paused?'队列已暂停':live?'正在执行任务':'队列自动运行';$('queueDot').classList.toggle('paused',!!paused);$('queueMetrics').textContent=`${pending} 条待发送 · ${connected}/3 个本机 Agent 已连接`;
  }
  emptyQueue({filtered=false}={}){
    const box=element('div','queue-empty');if(filtered){box.append(icon('queue'),element('h2','','没有符合条件的任务'),element('p','','试试其他筛选条件，或清空搜索内容。'));return box;}
    const diagram=element('div','handoff-diagram');for(const [i,label]of ['预设消息','等待条件','Agent 执行'].entries()){if(i)diagram.append(element('span','handoff-line'));const step=element('div','handoff-step');const mark=element('div','handoff-mark');mark.append(icon(['message','clock','agents'][i]));step.append(mark,element('span','',label));diagram.append(step);}
    box.append(diagram,element('h2','','还没有安排任务'),element('p','','写好下一条提示词，选择发送条件。\n后台会在条件满足时，按队列顺序执行。'));const create=element('button','primary','新建第一条任务');create.type='button';create.prepend(icon('plus'));create.addEventListener('click',this.newTask);box.append(create);const links=element('div','empty-links');for(const [page,text]of [['agents','连接 Agent'],['settings','配置夜间运行']]){const button=element('button','text-button',text);button.type='button';button.addEventListener('click',()=>this.navigate(page));links.append(button);}box.append(links);return box;
  }
}
