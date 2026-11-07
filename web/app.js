import { $, element, icon, api, toast, confirmAction, localDateFormat, localDateTimeInput, parseLocalDateTime } from './api.js';
import { Workspace, ScheduledView } from './workspace.js';
import { renderProviders } from './providers-view.js';
import { SessionsView } from './sessions-view.js';
const names = { idle: '空闲', working: '运行中', planning: '运行中', pending: '待执行', dispatching: '正在发送', running: '运行中', waiting: '等你处理', completed: '已完成', failed: '失败', interrupted: '已停止', uncertain: '待核实', missed: '已跳过', paused: '已暂停' };
Object.assign(names, { ready: '可发送', blocked: '接续受阻', editing: '编辑中', finished: '已发送' });
const providerNames = { codex: 'Codex', antigravity: 'Antigravity CLI', workbuddy: 'WorkBuddy CLI', antigravityDesktop: 'Antigravity 桌面端', workbuddyDesktop: 'WorkBuddy 桌面端', doubaoDesktop: '豆包桌面端' };
const editToken = crypto.randomUUID();
let editingId = null;
let editingRevision = null;
let editTimer = null;
const hasPending = task => task.trigger?.type && task.trigger.type !== 'time' ? task.trigger.state === 'pending' : !!task.trigger?.recurrence || task.times.some(slot => slot.state === 'pending');
const activeStates = new Set(['dispatching', 'running', 'waiting']);
let state = { tasks: [], runs: [], requests: [], connection: { connected: false, defaults: {} } };
let selectedTaskId = null;
let selectedRunId = null;
let threadCursor = null;
let loadedThreads = [];
let codexProjects = [];
let projectRequest = 0;
let workbuddyProjectRequest = 0;
let nativeProjectRequest = 0;
let savedThread = null;
let requestSignature = '';
let currentRun = null;
let filter = 'all';
let formDirty = false;
let refreshing = false;
let refreshAgain = false;
let serverOffset = 0;
const workspace = new Workspace({newTask:()=>resetForm(),openRun:id=>openRun(id),handleAttention:id=>manageRunHistory(id,'dismiss')});
const historyActions=element('div','run-history-actions');historyActions.hidden=true;
const handleRun=element('button','secondary','标记已处理'),deleteRun=element('button','text-button danger','删除记录'),restoreRun=element('button','secondary','恢复记录');
for(const button of [handleRun,deleteRun,restoreRun])button.type='button';
const historyNote=element('span','muted');historyActions.append(handleRun,deleteRun,restoreRun,historyNote);$('runError').after(historyActions);
const runPath = element('p', 'run-workspace-path'); runPath.hidden = true; $('runTime').after(runPath);
const runPermissions = element('p', 'field-help'); runPermissions.hidden = true; runPath.after(runPermissions);
handleRun.addEventListener('click',()=>void manageRunHistory(selectedRunId,currentRun?.attentionHandledAt?'remind':'dismiss'));
deleteRun.addEventListener('click',()=>void manageRunHistory(selectedRunId,'delete'));
restoreRun.addEventListener('click',()=>void manageRunHistory(selectedRunId,'restore'));
const deletedFilter=element('label','run-history-filter','已删除记录'),showDeletedRuns=element('input');showDeletedRuns.type='checkbox';deletedFilter.prepend(showDeletedRuns);$('runSearch').closest('.list-toolbar').after(deletedFilter);
showDeletedRuns.addEventListener('change',()=>{selectedRunId=null;renderRunOptions();void refreshRun().catch(error=>toast(error.message,true));});
const visibleRuns=()=>state.runs.filter(run=>!!run.deletedAt===showDeletedRuns.checked && (!run.archivedAt || $('showArchivedRuns')?.checked));
const pickedRuns=new Set(),runBatch=element('div','history-batch');
const pickRuns=element('button','text-button','全选已结束记录'),clearPickedRuns=element('button','text-button','取消选择'),removePickedRuns=element('button','text-button danger','删除所选');
for(const button of [pickRuns,clearPickedRuns,removePickedRuns])button.type='button';
runBatch.append(pickRuns,clearPickedRuns,removePickedRuns);deletedFilter.after(runBatch);
const searchedRuns=()=>[...visibleRuns()].reverse().filter(run=>!$('runSearch').value.trim()||[run.taskTitle,providerNames[run.provider],names[run.status]].join(' ').toLowerCase().includes($('runSearch').value.trim().toLowerCase()));
function updateRunSelection(){
  const allowed=new Set(searchedRuns().filter(run=>!activeStates.has(run.status)).map(run=>run.id));
  for(const id of pickedRuns)if(!allowed.has(id))pickedRuns.delete(id);
  clearPickedRuns.hidden=!pickedRuns.size;
  removePickedRuns.textContent=(showDeletedRuns.checked?'恢复所选':'删除所选')+(pickedRuns.size?'（'+pickedRuns.size+'）':'');
  removePickedRuns.disabled=!state.historyManagement||!pickedRuns.size;
  pickRuns.disabled=!state.historyManagement||!allowed.size;
}
pickRuns.addEventListener('click',()=>{for(const run of searchedRuns())if(!activeStates.has(run.status))pickedRuns.add(run.id);renderRunList();});
clearPickedRuns.addEventListener('click',()=>{pickedRuns.clear();renderRunList();});
removePickedRuns.addEventListener('click',async()=>{
  updateRunSelection();const ids=[...pickedRuns],action=showDeletedRuns.checked?'restore':'delete';if(!ids.length)return;
  if(!await confirmAction((action==='delete'?'删除':'恢复')+'所选 '+ids.length+' 条运行记录？删除后可从“已删除记录”恢复；项目文件、客户端对话和文件保护保留。',{title:'批量管理运行记录',accept:action==='delete'?'删除所选':'恢复所选',danger:action==='delete'}))return;
  removePickedRuns.disabled=true;
  try{await api('runs/history','POST',{ids,action});pickedRuns.clear();await refreshState();await refreshRun();toast(action==='delete'?'所选记录已删除。':'所选记录已恢复。');}
  catch(error){toast(error.message,true);}finally{updateRunSelection();}
});
async function manageRunHistory(id,action){
  const run=state.runs.find(row=>row.id===id);if(!run)return;
  if(!state.historyManagement){toast('记录管理更新已准备；当前任务结束后重新启动后台即可使用。',true);return;}
  if(action==='delete'&&!await confirmAction('删除“'+run.taskTitle+'”的工作台运行记录与顶部提示。项目文件和客户端对话保留；可在“已删除记录”恢复。',{title:'删除运行记录',accept:'删除记录',danger:true}))return;
  try{await api('runs/'+id+'/history','POST',{action});await refreshState();await refreshRun();toast(action==='delete'?'记录已删除，可在“已删除记录”恢复。':action==='restore'?'记录已恢复。':action==='dismiss'?'已处理提醒，原始执行结果保留。':'已恢复提醒。');}
  catch(error){toast(error.message,true);}
}
const sessionsView = new SessionsView({ refresh: () => refreshState(), openRun: id => openRun(id), navigate: page => workspace.navigate(page), continueSession: session => continueSession(session) });
async function continueSession(session) {
  if (!await resetForm()) return;
  $('provider').value = session.provider; restoreCodexProject({...session, nativeProjectId: session.nativeProjectId || session.projectId}); $('cwd').value = session.cwd || '';
  if (session.nativeProjectId) { $('nativeProject').append(new Option(session.nativeProjectName || session.nativeProjectId,session.nativeProjectId)); $('nativeProject').value = session.nativeProjectId; }
  if (session.provider === 'doubaoDesktop') void loadNativeProjects().catch(error => toast(error.message,true));
  $('taskTitle').value = '接续：' + (session.alias || session.name);
  document.querySelector('input[name="threadMode"][value="existing"]').checked = true;
  $('triggerType').value = 'queue'; savedThread = {id:session.nativeId,name:session.name};
  $('threadSelect').replaceChildren(new Option(session.name,session.nativeId));
  $('manualThread').value = session.nativeId;renderProviderHelp();toggleTrigger();toggleThreadMode();
  formDirty = true; updateSummary();
}

// A desktop task can be a predecessor even when it was started outside this panel.
$('triggerType').append(new Option('桌面端当前任务结束后发送', 'afterConversation'));
const watchFields = element('div','condition-fields'); watchFields.id = 'watchFields'; watchFields.hidden = true;
const watchProvider = element('select'); watchProvider.id = 'watchProvider';
for (const id of ['antigravityDesktop','workbuddyDesktop']) watchProvider.append(new Option(providerNames[id], id));
const watchThread = element('select'); watchThread.id = 'watchThread';
watchThread.append(new Option('点击刷新读取桌面会话', ''));
for (const [text,node] of [['等待哪个桌面端',watchProvider],['等待哪个正在运行的对话',watchThread]]) {
  const label = element('label','',text); label.htmlFor = node.id; watchFields.append(label,node);
}
const refreshWatch = element('button','text-button','刷新桌面会话'); refreshWatch.type = 'button';
refreshWatch.addEventListener('click',()=>loadWatchThreads().catch(e=>toast(e.message,true)));
watchProvider.addEventListener('change',()=>{watchThread.replaceChildren(new Option('点击刷新读取桌面会话',''));void loadWatchThreads().catch(e=>toast(e.message,true));});
const rearmWatch = element('input'); rearmWatch.id = 'rearmWatch'; rearmWatch.type = 'checkbox';
const rearmLabel = element('label', 'checkbox-choice'); rearmLabel.append(rearmWatch, document.createTextNode('重新绑定此刻正在运行的任务（用于恢复中断的监控）'));
watchFields.append(refreshWatch, rearmLabel); $('dependencyFields').after(watchFields);
async function loadWatchThreads(selected = watchThread.value) {
  const provider = watchProvider.value;
  const data = await api('threads?provider='+encodeURIComponent(provider));
  if (watchProvider.value !== provider) return;
  watchThread.replaceChildren(new Option('选择正在运行的桌面对话',''));
  for (const item of data.threads) watchThread.append(new Option(`${item.name} · ${names[item.status] || item.status}`,item.id));
  if (selected && !data.threads.some(x=>x.id===selected)) watchThread.append(new Option('已保存的等待目标 · '+selected,selected));
  watchThread.value = selected || '';
}

const scheduled = new ScheduledView({
  select: task => loadTask(task), openRun: id => openRun(id), create: () => resetForm(),
  edit: async task => { await loadTask(task); $('editTask').click(); },
  refresh: () => refreshState(), close: () => closeScheduleEditor(),
});
$('showArchivedRuns').addEventListener('change', () => {renderRunOptions();void refreshRun().catch(error=>toast(error.message,true));});
async function closeScheduleEditor() {
  if(formDirty && !await confirmAction('当前修改尚未保存，放弃修改？',{title:'放弃修改',accept:'放弃修改'}))return;
  formDirty=false;releaseEditing();workspace.showEditor(false);
  const task=state.tasks.find(task=>task.id===selectedTaskId);
  if(task)await loadTask(task,{force:true});
}
$('closeEditor').addEventListener('click',()=>void closeScheduleEditor());

const dateFormat = localDateFormat({ year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit', hour12: false });
const shortFormat = localDateFormat({ month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit', hour12: false });
const weekdayFormat = localDateFormat({ weekday: 'long' });
const clockFormat = localDateFormat({ month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit', second: '2-digit', hour12: false });
const formatDate = value => dateFormat.format(new Date(value));
const parseTime = parseLocalDateTime;
const folderName = value => value?.split(/[\\/]/).filter(Boolean).at(-1) || value || '';
const usesLocalFiles = provider => provider !== 'doubaoDesktop' && state.providers?.find(row => row.id === provider)?.capabilities.localFiles !== false;

function taskStatus(task) {
  const live = state.runs.find(run => run.taskId === task.id && activeStates.has(run.status));
  if (live) return live.status;
  if (task.paused) return 'paused';
  if (hasPending(task)) return task.queueStatus?.status || 'pending';
  return [...state.runs].reverse().find(run => run.taskId === task.id)?.status || 'missed';
}

function renderTaskList() { scheduled.render(state, selectedTaskId, hasPending); }

function addTime(at = Math.ceil((Date.now() + serverOffset + 3600000) / 60000) * 60000, status = 'pending') {
  const row = element('div', 'time-row');
  row.dataset.state = status;
  const line = element('div', 'time-row-line');
  const input = element('input');
  input.type = 'datetime-local';
  input.step = '1';
  input.required = true;
  input.value = localDateTimeInput(at);
  input.disabled = status !== 'pending';
  input.setAttribute('aria-label', '执行日期和时间 ' + ($('timeList').children.length + 1));
  const hint = element('p', 'time-date-hint');
  function updateHint() {
    const timestamp = parseTime(input.value);
    hint.textContent = Number.isFinite(timestamp) ? `${weekdayFormat.format(new Date(timestamp))} · ${status === 'pending' ? '仅执行一次' : names[status] || status}` : '请选择有效的日期和时间';
    updateSummary();
  }
  input.addEventListener('input', updateHint);
  line.append(input);
  if (status === 'pending') {
    const remove = element('button', 'remove-time', '×');
    remove.type = 'button';
    remove.setAttribute('aria-label', '移除这个执行时间');
    remove.addEventListener('click', () => { row.remove(); formDirty=true; updateSummary(); });
    line.append(remove);
  } else line.append(element('span', 'badge ' + status, names[status] || status));
  row.append(line, hint);
  $('timeList').append(row);
  updateHint();
}

function updateSummary() {
  if ($('triggerType').value !== 'time') { $('scheduleSummary').textContent = $('triggerType').value === 'queue' ? '保存后加入队列，轮到时发送一次' : $('triggerType').value === 'afterConversation' ? '桌面端当前任务成功结束后发送一次' : '前置任务结束后发送一次'; return; }
  if ($('repeatFrequency').value !== 'once') {
    const days = [...document.querySelectorAll('input[name="weekday"]:checked')].map(input => input.parentElement.textContent);
    const prefix = $('repeatFrequency').value === 'daily' ? '每天' : days.length ? `每周${days.map(day => day.slice(1)).join('、')}` : '请选择每周执行的星期';
    const task = state.tasks.find(task => task.id === selectedTaskId);
    const next = !editingId && task?.times.find(slot => slot.state === 'pending');
    $('scheduleSummary').textContent = `${prefix} ${$('repeatTime').value || '请选择时间'}${next ? `；下次 ${formatDate(next.at)}` : ''}`;
    return;
  }
  const times = [...$('timeList').querySelectorAll('input')].filter(input => !input.disabled).map(input => parseTime(input.value)).filter(Number.isFinite).sort((a, b) => a - b);
  $('scheduleSummary').textContent = times.length ? `${formatDate(times[0])}${times.length > 1 ? `，共 ${times.length} 个时间` : '，仅执行一次'}` : '选择一个未来的执行时间';
}

function toggleThreadMode() {
  const chat = $('provider').value === 'doubaoDesktop';
  const newOnly = $('provider').value !== 'codex' && state.providers?.find(row => row.id === $('provider').value)?.capabilities.resume === false;
  for (const value of ['existing','previous','reuse']) {
    const radio = document.querySelector('input[name="threadMode"][value="'+value+'"]');
    radio.disabled = newOnly || (value === 'previous' && $('triggerType').value !== 'afterTask');
    if (newOnly && radio.checked) document.querySelector('input[name="threadMode"][value="new"]').checked = true;
  }
  $('newThreadHelp').textContent = chat ? '每次触发都在所选豆包项目中创建独立对话；不指定项目时创建普通聊天。每次对话和结果保存在运行记录中。停止运行仅停止监控，生成请在豆包中停止。' : '每次触发都创建独立对话，使用保存的提示词；指定日期、每天、每周和立即运行均适用。每次运行的对话和结果保存在运行记录中。';
  const existing = document.querySelector('input[name="threadMode"]:checked').value === 'existing';
  $('existingThreadField').hidden = !existing;
  $('newThreadHelp').hidden = document.querySelector('input[name="threadMode"]:checked').value !== 'new';
  const desktop = ['antigravityDesktop', 'workbuddyDesktop', 'doubaoDesktop'].includes($('provider').value);
  $('threadSelect').required = existing && ($('provider').value === 'codex' || desktop);
  $('manualThreadField').hidden = $('provider').value === 'codex' || desktop;
  scheduled.syncControls();
  if (existing && (!usesLocalFiles($('provider').value) || $('cwd').value.trim())) void loadThreads().catch(error => toast(error.message, true));
}

async function loadNativeProjects() {
  if ($('provider').value !== 'doubaoDesktop') return;
  const revision = ++nativeProjectRequest;
  const selected = $('nativeProject').value;
  const data = await api('projects?provider=doubaoDesktop');
  if (revision !== nativeProjectRequest || $('provider').value !== 'doubaoDesktop' || $('nativeProject').value !== selected) return;
  $('nativeProject').replaceChildren(new Option('不指定项目（普通聊天）',''));
  for (const project of data.projects) $('nativeProject').append(new Option(project.name,project.id));
  if (selected && !data.projects.some(row => row.id === selected)) $('nativeProject').append(new Option('已保存项目（请在豆包展开后刷新）',selected));
  $('nativeProject').value = selected;
}

function restoreWorkbuddyProject() {
  if ($('provider').value !== 'workbuddyDesktop') return;
  const cwd = $('cwd').value.trim(), select = $('workbuddyProject');
  if (![...select.options].some(option=>option.value==='__browse__')) select.append(new Option('选择其他文件夹…','__browse__'));
  if (cwd && ![...select.options].some(option => option.value === cwd)) select.add(new Option(folderName(cwd), cwd),select.querySelector('option[value="__browse__"]'));
  select.value = cwd;
  select.title=cwd;
  $('workbuddyProjectPath').textContent=cwd;$('workbuddyProjectPath').title=cwd;
}

async function loadWorkbuddyProjects() {
  if ($('provider').value !== 'workbuddyDesktop') return;
  const revision = ++workbuddyProjectRequest, requestedCwd = $('cwd').value.trim();
  restoreWorkbuddyProject();$('refreshWorkbuddyProjects').disabled = true;
  try {
    const data = await api('projects?provider=workbuddyDesktop');
    if (revision !== workbuddyProjectRequest || $('provider').value !== 'workbuddyDesktop' || $('cwd').value.trim() !== requestedCwd) return;
    const select = $('workbuddyProject');select.replaceChildren(new Option('选择项目', ''));
    for (const project of data.projects) {
      const cwd = project.cwd || project.rootPaths?.[0];if (!cwd) continue;
      const duplicates=data.projects.filter(other=>other.name===project.name).length>1;
      const option = new Option(duplicates?`${project.name}（${folderName(cwd.replace(/[\\/][^\\/]+[\\/]?$/,''))}）`:project.name, cwd);option.title = cwd;select.append(option);
    }
    select.append(new Option('选择其他文件夹…','__browse__'));
    restoreWorkbuddyProject();
  } catch (error) { toast('WorkBuddy 项目列表读取失败，仍可选择本地文件夹：' + error.message, true); }
  finally { if (revision === workbuddyProjectRequest) $('refreshWorkbuddyProjects').disabled = false; }
}

async function loadCodexProjects(selected = $('codexProject').value) {
  if ($('provider').value !== 'codex') return;
  const revision = ++projectRequest;
  $('refreshCodexProjects').disabled = true;
  try {
    const data = await api('projects?provider=codex');
    if (revision !== projectRequest || $('provider').value !== 'codex') return;
    codexProjects = data.projects;
    selected = codexProjects.find(project => project.aliases?.includes(selected))?.id || selected;
    $('codexProject').replaceChildren(new Option('无', ''));
    for (const project of codexProjects) {
      const option = new Option(project.name, project.id);
      option.title = (project.rootPaths || []).join('；');
      $('codexProject').append(option);
    }
    if (selected && !codexProjects.some(project => project.id === selected)) $('codexProject').append(new Option('已保存项目（当前不可用，请重新选择）', selected));
    $('codexProject').value = selected;
    const project = codexProjects.find(project => project.id === selected);
    if (project) $('cwd').value = project.rootPaths[0];
    $('codexProjectHelp').textContent = '可选择客户端项目；选择“无”时创建独立聊天。';
  } catch (error) {
    if (revision === projectRequest) $('codexProjectHelp').textContent = '项目列表读取失败：' + error.message;
  } finally { if (revision === projectRequest) $('refreshCodexProjects').disabled = !!selectedTaskId && editingId !== selectedTaskId; }
}

function restoreCodexProject(task = {}) {
  ++projectRequest;
  const id = task.provider === 'codex' ? task.nativeProjectId || '' : '';
  $('codexProject').replaceChildren(new Option('无', ''));
  if (id) $('codexProject').append(new Option(task.nativeProjectName || id, id));
  $('codexProject').value = id;
  void loadCodexProjects(id);
}

async function loadThreads(more = false) {
  if (!usesLocalFiles($('provider').value)) {
    const projectId = $('nativeProject').value;
    const selected = $('threadSelect').value || savedThread?.id || '';
    const data = await api('threads?provider=' + encodeURIComponent($('provider').value) + '&projectId=' + encodeURIComponent(projectId));
    if (usesLocalFiles($('provider').value) || projectId !== $('nativeProject').value) return;
    loadedThreads = data.threads; threadCursor = null;
    $('threadSelect').replaceChildren(new Option(data.threads.length ? '选择豆包已有对话' : '请在豆包打开对话或展开项目后刷新',''));
    for (const thread of data.threads) $('threadSelect').append(new Option(thread.name,thread.id));
    if (selected && !data.threads.some(row => row.id === selected) && savedThread?.id === selected) $('threadSelect').append(new Option(savedThread.name,selected));
    $('threadSelect').value = selected; $('moreThreads').hidden = true;
    return;
  }
  const requestedCwd = $('cwd').value.trim();
  if (!requestedCwd) return;
  $('refreshThreads').disabled = true;
  try {
    const folder = await api('folders/validate', 'POST', { cwd: requestedCwd });
    if ($('cwd').value.trim() !== requestedCwd) return;
    $('cwd').value = folder.cwd;
    $('folderHelp').textContent = '项目文件夹已确认，可以在其中运行。';
    const selected = $('threadSelect').value || savedThread?.id || '';
    const requestedProvider = $('provider').value;
    const requestedProject = requestedProvider === 'codex' ? $('codexProject').value : '';
    const data = await api('threads?provider=' + encodeURIComponent(requestedProvider) + '&cwd=' + encodeURIComponent(folder.cwd) + '&projectId=' + encodeURIComponent(requestedProject) + (more && threadCursor ? '&cursor=' + encodeURIComponent(threadCursor) : ''));
    if ($('cwd').value.trim() !== folder.cwd || $('provider').value !== requestedProvider) return;
    if (requestedProvider === 'codex' && $('codexProject').value !== requestedProject) return;
    loadedThreads = more ? [...loadedThreads, ...data.threads] : data.threads;
    threadCursor = data.nextCursor;
    $('threadSelect').replaceChildren(new Option(loadedThreads.length ? '选择一个对话' : '这个项目还没有已保存的对话', ''));
    for (const thread of loadedThreads) $('threadSelect').append(new Option(thread.name, thread.id));
    if (selected && !loadedThreads.some(thread => thread.id === selected) && savedThread?.id === selected) $('threadSelect').append(new Option(savedThread.name, savedThread.id));
    $('threadSelect').value = selected;
    $('moreThreads').hidden = !threadCursor;
  } finally { $('refreshThreads').disabled = false; }
}

async function resetForm(openEditor=true) {
  if(openEditor && state.serverTime && state.scheduledTasksVersion!==1){toast('后台更新待生效，请等待当前任务结束后重启后台。',true);return false;}
  if(formDirty && !await confirmAction('当前修改尚未保存，放弃修改并新建任务？',{title:'放弃当前修改',accept:'放弃并新建'}))return false;
  releaseEditing();
  setFormEditable(true);
  editingRevision = null;
  selectedTaskId = null;
  savedThread = null;
  $('taskForm').reset();
  $('repeatFrequency').value='daily';
  scheduled.editing=false;scheduled.syncForm();
  restoreCodexProject();
  $('timeList').replaceChildren();
  addTime();
  $('editorTitle').textContent = '新建任务';
  $('editorSubtitle').textContent = '选择 Agent、项目和发送条件，逐条安排工作。';
  $('saveTask').textContent = '保存任务';
  $('saveTask').disabled = false;
  $('deleteTask').hidden = true;
  $('taskActions').hidden = true;
  $('promptCount').textContent = '0 字';
  $('threadSelect').replaceChildren(new Option('先选择项目文件夹', ''));
  $('folderHelp').textContent = '直接在这个文件夹中运行，使用项目自己的说明和配置。';
  $('newThreadHelp').textContent = '每次触发都创建独立对话，运行结果分别保存。';
  $('saveHint').textContent = '任务保存在本机';
  renderDependencies();
  toggleTrigger();
  renderProviderHelp();
  toggleThreadMode();
  renderTaskList();
  $('taskReadiness').hidden=true;
  formDirty=false;
  workspace.showEditor(openEditor);
  return true;
}

async function loadTask(task,{force=false}={}) {
  if(!force && task.id===selectedTaskId && formDirty)return;
  if(!force && formDirty && !await confirmAction('当前修改尚未保存，放弃修改并打开其他任务？',{title:'放弃当前修改',accept:'放弃并打开'}))return;
  workspace.showEditor(false);
  releaseEditing();
  editingRevision = task.revision;
  setFormEditable(false);
  selectedTaskId = task.id;
  savedThread = task.threadId ? { id: task.threadId, name: task.threadTitle || task.title } : null;
  $('provider').value = task.provider || 'codex'; restoreCodexProject(task);
  $('nativeProject').replaceChildren(new Option('不指定项目（普通聊天）',''));
  if (task.nativeProjectId) $('nativeProject').append(new Option(task.nativeProjectName || task.nativeProjectId,task.nativeProjectId));
  $('nativeProject').value = task.nativeProjectId || '';
  if (task.provider === 'doubaoDesktop') void loadNativeProjects().catch(error => toast(error.message,true));
  $('triggerType').value = task.trigger?.type || 'time';
  $('repeatFrequency').value = task.trigger?.recurrence?.frequency || 'once';
  $('repeatTime').value = task.trigger?.recurrence?.time || '09:00';
  document.querySelectorAll('input[name="weekday"]').forEach(input => { input.checked = !!task.trigger?.recurrence?.weekdays.includes(Number(input.value)); });
  rearmWatch.checked = false;
  if (task.trigger?.type === 'afterConversation') {
    watchProvider.value = task.trigger.provider;
    watchThread.replaceChildren(new Option('已保存的桌面等待目标',task.trigger.threadId));
    watchThread.value = task.trigger.threadId;
    void loadWatchThreads(task.trigger.threadId).catch(e=>toast(e.message,true));
  }
  renderDependencies(task.trigger?.taskId, task.trigger?.runId);
  $('onFailure').value = task.trigger?.onFailure || 'stop';
  $('timeoutMinutes').value = task.timeoutMinutes || 120;
  $('manualThread').value = task.threadId || '';
  toggleTrigger();
  renderProviderHelp();
  $('taskTitle').value = task.title;
  $('cwd').value = task.cwd;
  $('prompt').value = task.prompt;
  $('promptCount').textContent = task.prompt.length + ' 字';
  document.querySelector(`input[name="threadMode"][value="${task.threadMode}"]`).checked = true;
  $('latePolicy').value = task.latePolicy;
  scheduled.editing=true;scheduled.syncForm(task);
  if (task.provider === 'workbuddyDesktop') void loadWorkbuddyProjects();
  renderProviderHelp();
  $('timeList').replaceChildren();
  if (task.trigger?.recurrence) addTime();
  else task.times.forEach(slot => addTime(slot.at, slot.state));
  $('editorTitle').textContent = '任务详情';
  $('editorSubtitle').textContent = task.title;
  $('saveTask').textContent = '保存修改';
  $('deleteTask').hidden = false;
  $('taskActions').hidden = false;
  $('threadSelect').replaceChildren(new Option(savedThread?.name || '选择一个对话', savedThread?.id || ''));
  selectedRunId = [...state.runs].reverse().find(run => run.taskId === task.id)?.id || null;
  toggleThreadMode();
  setFormEditable(false);
  renderTaskList();
  renderTaskActions();
  renderRunOptions();
  void refreshRun().catch(error => toast(error.message, true));
  formDirty=false;
}

function renderTaskActions() {
  const task = state.tasks.find(task => task.id === selectedTaskId);
  if (!task) return;
  $('pauseTask').textContent = task.paused ? '恢复任务' : '暂停任务';
  const busy = state.runs.some(run => run.taskId === task.id && activeStates.has(run.status));
  $('saveTask').disabled = busy || editingId !== task.id;
  $('editTask').disabled = busy || !hasPending(task) || editingId === task.id;
  $('cancelEdit').hidden = editingId !== task.id;
  $('followTask').disabled = editingId === task.id;
  $('deleteTask').disabled = busy;
  $('runTask').disabled = task.paused || state.runs.some(r => r.taskId === task.id && ['dispatching','running','waiting'].includes(r.status)) || task.queueStatus?.status === 'blocked' || editingId === task.id || (task.trigger?.type !== 'time' && task.queueStatus?.status !== 'ready');
  $('saveHint').textContent = editingId === task.id ? '正在编辑，这条消息暂不发送；保存后释放' : task.paused ? '任务已暂停' : '点击“编辑消息”修改尚未发送的内容';
  $('editorTitle').textContent=editingId===task.id?'编辑任务':'任务详情';
  $('taskReadiness').hidden=!task.queueStatus?.reason;
  scheduled.syncControls();
  $('taskReadiness').textContent=busy ? '当前任务正在执行或等待处理。' : task.queueStatus?.reason || '';
}

function renderRunOptions() {
  const runs = [...visibleRuns()].reverse();
  if (!selectedRunId || !runs.some(run => run.id === selectedRunId)) selectedRunId = runs.find(run => run.taskId === selectedTaskId)?.id || runs[0]?.id || null;
  $('runSelect').replaceChildren();
  if (!runs.length) $('runSelect').append(new Option('还没有运行记录', ''));
  for (const run of runs) $('runSelect').append(new Option(`${shortFormat.format(new Date(run.startedAt))} ${run.taskTitle} · ${names[run.status]}`, run.id));
  $('runSelect').value = selectedRunId || '';
  renderRunList();
}

function renderRunList(){
  const runs=searchedRuns();updateRunSelection();
  $('runList').replaceChildren();
  if(!runs.length)$('runList').append(element('p','run-list-empty',state.runs.length?'没有符合条件的运行记录。':'还没有运行记录。\n发送任务后，执行结果会保存在这里。'));
  for(const run of runs){
    const row=element('div','history-select-row'),check=element('input');check.type='checkbox';check.setAttribute('aria-label','选择运行记录：'+run.taskTitle);check.checked=pickedRuns.has(run.id);check.disabled=activeStates.has(run.status)||!state.historyManagement;
    check.addEventListener('change',()=>{check.checked?pickedRuns.add(run.id):pickedRuns.delete(run.id);updateRunSelection();});
    const button=element('button','run-item'+(run.id===selectedRunId?' selected':''));button.type='button';button.append(element('strong','',run.taskTitle));const meta=element('span','run-meta');meta.append(element('span','',shortFormat.format(new Date(run.startedAt))),element('span','badge '+run.status,names[run.status] || run.status));button.append(meta);button.addEventListener('click',()=>openRun(run.id));row.append(check,button);$('runList').append(row);
  }
}
function openRun(id){$('showArchivedRuns').checked=!!state.runs.find(run=>run.id===id)?.archivedAt;showDeletedRuns.checked=!!state.runs.find(run=>run.id===id)?.deletedAt;selectedRunId=id;requestSignature='';workspace.showRun();renderRunOptions();void refreshRun().catch(error=>toast(error.message,true));}

function renderRequests() {
  const requests = state.requests.filter(request => request.runId === selectedRunId);
  const signature = requests.map(request => request.id).join(',');
  if (signature === requestSignature) return;
  requestSignature = signature;
  $('requests').replaceChildren();
  for (const request of requests) {
    const box = element('div', 'request-box');
    const isQuestion = request.method === 'item/tool/requestUserInput';
    const isMcp = request.method === 'mcpServer/elicitation/request';
    box.append(element('h3', '', isQuestion ? 'Codex 需要你的回答' : isMcp ? `${request.params.serverName} 需要你的确认` : '这一步需要你的确认'));
    const answerInputs = new Map();
    let readContent = () => null;
    if (isMcp) {
      box.append(element('p', '', request.params.message || '请检查并确认这一步操作。'));
      if (request.params.mode === 'url') {
        try {
          const url = new URL(request.params.url);
          if (!['https:', 'http:'].includes(url.protocol)) throw new Error();
          const link = element('a', 'text-link', '打开确认页面'); link.href = url.href; link.target = '_blank'; link.rel = 'noopener noreferrer'; box.append(link);
        } catch { box.append(element('p', '', '确认链接无效，请交回 Codex 处理。')); }
      } else {
        const readers = [];
        const schema = request.params.requestedSchema;
        for (const [key, field] of Object.entries(schema?.properties || {})) {
          const label = element('label', '', field.title || key);
          const options = field.enum?.map((value, i) => ({ const: value, title: field.enumNames?.[i] || value })) || field.oneOf || field.items?.enum?.map(value => ({ const: value, title: value })) || field.items?.anyOf;
          const input = element(options || field.type === 'boolean' ? 'select' : 'input');
          input.required = !!schema.required?.includes(key);
          if (options) {
            if (field.type === 'array') input.multiple = true;
            else input.append(new Option('请选择', ''));
            for (const option of options) input.append(new Option(option.title || option.const, option.const));
            if (Array.isArray(field.default)) for (const option of input.options) option.selected = field.default.includes(option.value);
            else if (field.default !== undefined) input.value = field.default;
          } else if (field.type === 'boolean') input.append(new Option('请选择', ''), new Option('是', 'true'), new Option('否', 'false'));
          else {
            input.type = ['number', 'integer'].includes(field.type) ? 'number' : 'text';
            if (input.type === 'number') { input.step = field.type === 'integer' ? '1' : 'any'; if (field.minimum !== undefined) input.min = field.minimum; if (field.maximum !== undefined) input.max = field.maximum; }
            if (field.default !== undefined) input.value = field.default;
          }
          readers.push(() => {
            if (!input.reportValidity()) throw new Error('请完成确认表单。');
            if (field.type === 'array') return [key, [...input.selectedOptions].map(option => option.value)];
            if (!input.value && !input.required) return null;
            return [key, field.type === 'boolean' ? input.value === 'true' : ['number', 'integer'].includes(field.type) ? Number(input.value) : input.value];
          });
          label.append(input); if (field.description) label.append(element('span', 'muted', field.description)); box.append(label);
        }
        readContent = () => Object.fromEntries(readers.map(read => read()).filter(Boolean));
      }
    } else if (isQuestion) {
      for (const question of request.params.questions || []) {
        const label = element('label', '', question.question);
        const input = element('input');
        input.type = question.isSecret ? 'password' : 'text';
        if (question.options?.length) {
          const choices = element('select');
          choices.append(new Option('选择一个答案，或在下方填写', ''));
          question.options.forEach(option => choices.append(new Option(option.label, option.label)));
          choices.addEventListener('change', () => { input.value = choices.value; });
          label.append(choices);
        }
        label.append(input);
        answerInputs.set(question.id, input);
        box.append(label);
      }
    } else {
      if (request.params.reason) box.append(element('p', '', request.params.reason));
      const description = request.params.command || (request.method === 'item/permissions/requestApproval' ? JSON.stringify(request.params.permissions, null, 2) : JSON.stringify(request.params, null, 2));
      box.append(element('pre', '', description));
    }
    const buttons = element('div', 'request-buttons');
    const accept = element('button', 'primary', isQuestion ? '提交回答' : '允许这一次');
    accept.type = 'button';
    accept.addEventListener('click', async () => {
      accept.disabled = true;
      try {
        const answer = isQuestion ? { answers: Object.fromEntries([...answerInputs].map(([id, input]) => [id, input.value])) } : isMcp ? { decision: 'accept', content: readContent() } : { decision: 'accept' };
        await api(`requests/${request.id}/respond`, 'POST', answer);
        await refreshState();
      } catch (error) { toast(error.message, true); accept.disabled = false; }
    });
    buttons.append(accept);
    if (!isQuestion) {
      const decline = element('button', 'secondary', '拒绝');
      decline.type = 'button';
      decline.addEventListener('click', () => api(`requests/${request.id}/respond`, 'POST', { decision: 'decline' }).then(refreshState).catch(error => toast(error.message, true)));
      buttons.append(decline);
    }
    box.append(buttons);
    $('requests').append(box);
  }
}

async function refreshRun() {
  const runId = selectedRunId;
  $('runEmpty').hidden = !!runId;
  $('runDetails').hidden = !runId;
  historyActions.hidden=true;
  if (!runId) { currentRun = null; $('copyOutput').disabled=true; return; }
  if(currentRun?.id!==runId){
    const summary=state.runs.find(run=>run.id===runId);currentRun=null;
    $('runTitle').textContent=summary?.taskTitle || '正在加载运行记录';
    $('runProvider').textContent=providerNames[summary?.provider || 'codex'];
    $('runStatus').className='badge '+(summary?.status || 'pending');$('runStatus').textContent=names[summary?.status] || '正在加载';
    $('runTime').textContent='';$('runOutput').textContent='正在加载运行结果…';$('runLog').textContent='';$('runPrompt').textContent='';$('runError').hidden=true;$('openThread').hidden=true;$('handoffCodex').hidden=true;$('codexConnectionNote').hidden=true;$('interruptRun').hidden=true;$('copyOutput').disabled=true;renderRequests();
  }
  const run = await api('runs/' + runId);
  if (runId !== selectedRunId) return;
  currentRun = run;
  $('copyOutput').disabled=false;
  $('runTitle').textContent=run.taskTitle;
  $('runProvider').textContent=providerNames[run.provider || 'codex']+' · '+(run.nativeProjectName || (usesLocalFiles(run.provider) ? folderName(run.cwd) : '普通聊天'));
  runPath.hidden = !run.cwd; runPath.textContent = run.cwd || '';
  runPermissions.hidden = !run.effectivePermissions;
  if (run.effectivePermissions) { const p = run.effectivePermissions; runPermissions.textContent = `生效权限：${p.approvalsReviewer === 'auto_review' ? 'Codex 自动审批' : '人工审批'} · ${p.sandboxPolicy?.type === 'readOnly' ? '只读' : '允许修改项目'} · ${p.sandboxPolicy?.networkAccess ? '允许联网' : '禁止联网'}`; }
  $('runPrompt').textContent=run.prompt;
  $('runStatus').className = 'badge ' + run.status;
  $('runStatus').textContent = names[run.status] || run.status;
  $('runTime').textContent = shortFormat.format(new Date(run.startedAt)) + (run.endedAt ? `\n用时 ${Math.max(1, Math.round((run.endedAt - run.startedAt) / 1000))} 秒` : '');
  $('runError').hidden = !run.error;
  $('runError').textContent = run.error;
  historyActions.hidden=activeStates.has(run.status);
  for(const button of [handleRun,deleteRun,restoreRun])button.disabled=!state.historyManagement;
  handleRun.hidden=!!run.deletedAt;deleteRun.hidden=!!run.deletedAt;restoreRun.hidden=!run.deletedAt;
  handleRun.textContent=run.attentionHandledAt?'恢复提醒':'标记已处理';
  historyNote.textContent=!state.historyManagement?'记录管理更新已准备；当前任务结束后重新启动后台即可使用。':run.deletedAt?'已删除，可恢复。':run.attentionHandledAt?'提醒已处理；原始执行结果保留。':'处理提醒不会将待核实结果改为成功，也不会释放文件保护。';
  const codex = !!run.threadId && (run.provider || 'codex') === 'codex';
  const nativeCodex = codex && run.execution === 'desktop';
  const active = activeStates.has(run.status);
  $('openThread').hidden = !codex || !nativeCodex && (active || run.status !== 'uncertain' && ['releasing', 'releaseFailed', 'owned'].includes(run.codexThreadState));
  $('openThread').href = run.threadId ? 'codex://threads/' + encodeURIComponent(run.threadId) : '#';
  $('openThread').textContent = run.status === 'uncertain' ? '在 Codex 中查看并核实' : '在 Codex 中打开对话';
  $('handoffCodex').hidden = !codex || nativeCodex || run.status === 'uncertain' || run.codexThreadState === 'released';
  $('handoffCodex').disabled = run.codexThreadState === 'releasing' || active && !run.turnId;
  $('handoffCodex').textContent = active ? '停止并交回 Codex' : run.codexThreadState === 'releasing' ? '正在释放对话…' : '释放对话并交回 Codex';
  $('codexConnectionNote').hidden = !codex;
  $('codexConnectionNote').textContent = !codex ? '' : nativeCodex ? '任务直接在 Codex 客户端的项目中执行，可随时打开原对话；模型、权限确认和提问均由客户端处理。' : active
    ? '此对话由调度器执行，回复和确认在本页处理。交回 Codex 会停止本轮并暂停后续预约，保留原对话。'
    : run.status === 'uncertain' ? '后台连接曾中断，执行结果尚未确认。请在 Codex 查看原对话后决定下一步，不会自动重发。'
    : run.codexThreadState === 'releaseFailed' ? '对话释放失败：' + run.codexReleaseError
    : run.codexThreadState === 'releasing' ? '正在释放 Codex 对话连接，完成后可在桌面打开。'
    : '原对话保存在 Codex；可按任务名称查找。';
  $('interruptRun').hidden = !activeStates.has(run.status) || !run.turnId;
  $('interruptRun').textContent = nativeCodex ? '停止监控' : '停止运行';
  const output = run.output || run.logs.filter(log => log.type === 'delta').map(log => log.text).join('\n');
  $('runOutput').textContent = output || (activeStates.has(run.status) ? providerNames[run.provider || 'codex'] + ' 正在处理，回复会显示在这里。' : '这次运行没有文本回复。');
  $('runLog').textContent = run.logs.filter(log => !['delta', 'answer'].includes(log.type)).map(log => `[${clockFormat.format(new Date(log.at))}] ${log.text}`).join('\n\n');
  renderRequests();
}

async function refreshState() {
  if (refreshing) { refreshAgain = true; return; }
  refreshing = true;
  try {
    state = await api('state');
    state.tasks = state.tasks.filter(task => !task.missionId);
    if (selectedTaskId && !state.tasks.some(task => task.id === selectedTaskId)) {
      formDirty = false;
      await resetForm(false);
    }
    serverOffset = state.serverTime - Date.now();
    const connection = state.connection;
    $('engineStatus').textContent = '后台在线';
    $('engineStatus').className = 'engine-status connected';
    $('engineStatus').title = '本机调度后台已连接';
    renderProviderHelp();
    renderSettings();
    renderProviderHelp();
    renderTaskList();
    renderTaskActions();
    renderRunOptions();
    if (!editingId && !formDirty && state.tasks.find(task => task.id === selectedTaskId)?.trigger?.recurrence) updateSummary();
    workspace.update(state,hasPending);
    sessionsView.render(state.sessionHub);
    await refreshRun();
  } finally {
    refreshing = false;
    if (refreshAgain) { refreshAgain = false; void refreshState().catch(error => toast(error.message, true)); }
  }
}

$('taskForm').addEventListener('submit', async event => {
  event.preventDefault();
  if(state.scheduledTasksVersion!==1)return toast('请重启后台以启用新版定时任务；运行中的任务请先等待结束。',true);
  const repeating = $('triggerType').value === 'time' && $('repeatFrequency').value !== 'once';
  const times = $('triggerType').value === 'time' && !repeating ? [...$('timeList').querySelectorAll('input')].map(input => parseTime(input.value)) : [];
  const threadId = $('provider').value === 'codex' || ['antigravityDesktop','workbuddyDesktop','doubaoDesktop'].includes($('provider').value) ? $('threadSelect').value : $('manualThread').value.trim() || $('threadSelect').value;
  const input = {
    provider: $('provider').value, revision: editingRevision, editToken, timeoutMinutes: Number($('timeoutMinutes').value),
    trigger: { type: $('triggerType').value, taskId: $('afterTask').value, runId: $('afterRun').value || null, onFailure: $('onFailure').value },
    title: $('taskTitle').value.trim() || $('prompt').value.trim().split('\n')[0].slice(0,100), cwd: $('provider').value !== 'codex' && usesLocalFiles($('provider').value) ? $('cwd').value : '', prompt: $('prompt').value, times,
    nativeProjectId: $('provider').value === 'codex' ? $('codexProject').value : $('provider').value === 'doubaoDesktop' ? $('nativeProject').value : '',
    threadMode: document.querySelector('input[name="threadMode"]:checked').value,
    threadId, threadTitle: loadedThreads.find(thread => thread.id === threadId)?.name || savedThread?.name || '',
    latePolicy: $('latePolicy').value,
    notificationPolicy: $('notificationPolicy').value, archiveSuccessful: $('archiveSuccessful').checked,
    model: $('taskModel').disabled ? '' : $('taskModel').value.trim(), effort: $('taskEffort').disabled ? '' : $('taskEffort').value,

  };
  if (repeating) input.trigger.recurrence = { frequency: $('repeatFrequency').value, time: $('repeatTime').value, weekdays: [...document.querySelectorAll('input[name="weekday"]:checked')].map(input => Number(input.value)), timezone: 'local' };
  if (input.trigger.type === 'afterConversation') Object.assign(input.trigger, { provider: $('watchProvider').value, threadId: $('watchThread').value, rearm: rearmWatch.checked });
  if ($('triggerType').value === 'time' && !repeating && (!times.length || times.some(value => !Number.isFinite(value)))) return toast('请至少选择一个有效的执行时间。', true);
  if (repeating && input.trigger.recurrence.frequency === 'weekly' && !input.trigger.recurrence.weekdays.length) return toast('请至少选择一个星期。', true);
  $('saveTask').disabled = true;
  try {
    const task = await api(selectedTaskId ? 'tasks/' + selectedTaskId : 'tasks', selectedTaskId ? 'PUT' : 'POST', input);
    await refreshState();
    await loadTask(task,{force:true});
    workspace.showEditor(false);
    toast(task.paused ? '修改已保存；恢复任务后才会执行。' : '任务已保存，将按发送条件执行。');
  } catch (error) { toast(error.message, true); }
  finally { if (selectedTaskId) renderTaskActions(); else $('saveTask').disabled = false; }
});

$('newTask').addEventListener('click',()=>resetForm());
for(const event of ['input','change'])$('taskForm').addEventListener(event,()=>formDirty=true);
$('taskSearch').addEventListener('input',renderTaskList);
$('runSearch').addEventListener('input',renderRunList);
$('taskRuns').addEventListener('click',()=>{if(selectedRunId)openRun(selectedRunId);else{workspace.navigate('runs');workspace.showRun(false);}});
$('addTime').addEventListener('click', () => {
  const previous = [...$('timeList').querySelectorAll('input')].map(input => parseTime(input.value)).filter(Number.isFinite).at(-1);
  addTime(previous ? Math.max(previous + 86400000, Date.now() + serverOffset + 3600000) : undefined);
  formDirty=true;
});
$('prompt').addEventListener('input', () => { $('promptCount').textContent = $('prompt').value.length + ' 字'; });
document.querySelectorAll('input[name="threadMode"]').forEach(input => input.addEventListener('change', toggleThreadMode));
$('cwd').addEventListener('change', () => { savedThread = null; $('threadSelect').value = ''; void loadThreads().catch(error => toast(error.message, true)); });
$('refreshThreads').addEventListener('click', () => loadThreads().catch(error => toast(error.message, true)));
$('moreThreads').addEventListener('click', () => loadThreads(true).catch(error => toast(error.message, true)));
$('pickFolder').addEventListener('click', async () => {
  $('pickFolder').disabled = true;
  $('pickFolder').textContent = '选择窗口已打开';
  try {
    const result = await api('folders/pick', 'POST', { cwd: $('cwd').value }, 310000);
    if (!result.cancelled) { $('cwd').value = result.cwd; restoreWorkbuddyProject(); formDirty=true; savedThread = null; await loadThreads(); }
  } catch (error) { toast(error.message, true); }
  finally { $('pickFolder').disabled = false; $('pickFolder').replaceChildren(icon('folder'),document.createTextNode('选择')); }
});
document.querySelectorAll('[data-filter]').forEach(button => button.addEventListener('click', () => {
  filter = button.dataset.filter;
    document.querySelectorAll('[data-filter]').forEach(button => {const selected=button.dataset.filter===filter;button.classList.toggle('selected',selected);button.setAttribute('aria-pressed',String(selected));});
  renderTaskList();
}));
$('reconnect').addEventListener('click', async () => {
  $('reconnect').disabled = true;
  try { await api('connect', 'POST'); await refreshState(); toast('Codex 已连接。'); }
  catch (error) { toast(error.message, true); }
  finally { $('reconnect').disabled = false; }
});
$('pauseTask').addEventListener('click', async () => {
  try {
    const task = state.tasks.find(task => task.id === selectedTaskId);
    await api(`tasks/${task.id}/${task.paused ? 'resume' : 'pause'}`, 'POST');
    await refreshState();
  } catch (error) { toast(error.message, true); }
});
$('runTask').addEventListener('click', async () => {
  const task=state.tasks.find(task=>task.id===selectedTaskId);
  if (!await confirmAction(task?.trigger?.type === 'time' ? '现在额外发送一次已保存的消息。原定的预约时间会保留。' : '现在发送这条已保存的消息，完成后本条任务将结束。',{title:'立即运行一次',accept:'开始运行'})) return;
  $('runTask').disabled = true;
  try {
    const run = await api(`tasks/${selectedTaskId}/run`, 'POST');
    selectedRunId = run.id;
    workspace.showRun();
    await refreshState();
    if (run.error) toast(run.error, true);
  } catch (error) { toast(error.message, true); }
  finally { renderTaskActions(); }
});
async function deleteQueueTask(id) {
  const task = state.tasks.find(task => task.id === id);
  if (!task) return;
  const message = '删除“' + task.title + '”及其未来发送时间。已有运行记录会保留。';
  if (!await confirmAction(message,{title:'删除任务',accept:'删除任务',danger:true})) return;
  try {
    await api('tasks/' + id, 'DELETE');
    if (selectedTaskId === id) {
      formDirty = false;
      await resetForm(false);
    }
    await refreshState();
    toast('任务已删除，运行记录已保留。');
  }
  catch (error) { toast(error.message, true); }
}
$('deleteTask').addEventListener('click', () => deleteQueueTask(selectedTaskId));
$('duplicateTask').addEventListener('click', async () => {
  const task = state.tasks.find(task => task.id === selectedTaskId);
  if(!await resetForm())return;
  $('taskTitle').value = task.title + '（副本）';
  $('provider').value = task.provider || 'codex'; restoreCodexProject(task);
  renderProviderHelp();
  $('cwd').value = task.cwd;
  $('nativeProject').replaceChildren(new Option('不指定项目（普通聊天）',''));
  if (task.nativeProjectId) $('nativeProject').append(new Option(task.nativeProjectName || task.nativeProjectId,task.nativeProjectId));
  $('nativeProject').value = task.nativeProjectId || '';
  void loadNativeProjects().catch(error => toast(error.message,true));
  $('prompt').value = task.prompt;
  $('promptCount').textContent = task.prompt.length + ' 字';
  $('latePolicy').value = task.latePolicy;
  renderProviderHelp();
  formDirty=true;
});
$('runSelect').addEventListener('change', () => { selectedRunId = $('runSelect').value || null; requestSignature = ''; renderRunList(); void refreshRun().catch(error => toast(error.message, true)); });
$('refreshRuns').addEventListener('click', () => refreshState().catch(error => toast(error.message, true)));
$('handoffCodex').addEventListener('click', async () => {
  const run = currentRun;
  if (!run) return;
  const active = activeStates.has(run.status);
  if (active && !await confirmAction('停止本轮运行，暂停这个任务的后续预约，并把原对话交回 Codex。已完成的修改与对话记录保留，不会重发消息。', { title: '交回 Codex', accept: '停止并交回', danger: true })) return;
  $('handoffCodex').disabled = true;
  try {
    await api(`runs/${run.id}/handoff-codex`, 'POST', { interrupt: active });
    await refreshState();
    toast('对话已释放，点击“在 Codex 中打开对话”继续。');
  } catch (error) { toast(error.message, true); }
  finally { if (currentRun?.id === run.id) $('handoffCodex').disabled = false; }
});
$('interruptRun').addEventListener('click', async () => {
  const nativeCodex = currentRun?.provider === 'codex' && currentRun.execution === 'desktop';
  if (!await confirmAction(nativeCodex ? '停止工作台监控并暂停后续接续。当前任务继续在 Codex 客户端运行。' : '停止当前运行。已完成的文件修改会保留。',{title:nativeCodex?'停止监控':'停止运行',accept:nativeCodex?'停止监控':'停止运行',danger:true})) return;
  try { await api(`runs/${selectedRunId}/interrupt`, 'POST'); await refreshState(); }
  catch (error) { toast(error.message, true); }
});
$('copyOutput').addEventListener('click', () => navigator.clipboard.writeText(currentRun?.output || $('runOutput').textContent).then(() => toast('回复已复制。')).catch(() => toast('浏览器未允许复制，请选择文字手动复制。', true)));
$('stopBackend').addEventListener('click', async () => {
  if (!await confirmAction('停止后台后，预约将暂停调度。再次运行 start.cmd 可以恢复。',{title:'停止后台',accept:'停止后台',danger:true})) return;
  try { await api('shutdown', 'POST'); events.close(); $('engineStatus').textContent = '后台已停止'; $('engineStatus').className = 'engine-status offline'; toast('后台已停止。再次运行 start.cmd 可以恢复。'); }
  catch (error) { toast(error.message, true); }
});

function setFormEditable(editable) {
  for (const node of $('taskForm').querySelectorAll('input, select, textarea, button')) node.disabled = !editable || (node.matches('input[type="datetime-local"]') && node.closest('.time-row').dataset.state!=='pending');
  $('saveTask').disabled = !editable;
  scheduled.syncControls();scheduled.cancel.disabled=false;
}

function releaseEditing() {
  if (!editingId) return;
  const id = editingId;
  editingId = null;
  clearInterval(editTimer);
  editTimer = null;
  void api(`tasks/${id}/release`, 'POST', { token: editToken }).catch(() => {});
}

function renderDependencies(taskId = $('afterTask').value, runId = $('afterRun').value) {
  $('afterTask').replaceChildren(new Option('选择前置任务', ''));
  for (const task of state.tasks.filter(task => task.id !== selectedTaskId)) $('afterTask').append(new Option(task.title, task.id));
  $('afterTask').value = taskId || '';
  renderDependencyRuns(runId);
}

function renderDependencyRuns(runId = '') {
  $('afterRun').replaceChildren(new Option('当前正在运行的一次；否则等待下一次运行', ''));
  for (const run of state.runs.filter(run => run.taskId === $('afterTask').value).reverse()) $('afterRun').append(new Option(`${formatDate(run.startedAt)} · ${names[run.status]}`, run.id));
  $('afterRun').value = runId || '';
}

function toggleTrigger() {
  const kind = $('triggerType').value;
  const repeating = kind === 'time' && $('repeatFrequency').value !== 'once';
  $('timeFields').hidden = kind !== 'time';
  $('onceFields').hidden = repeating;
  $('repeatFields').hidden = true;
  $('scheduleTimeRow').hidden = !repeating;
  $('weekdayFields').hidden = $('repeatFrequency').value !== 'weekly';
  $('repeatTime').required = repeating;
  $('dependencyFields').hidden = kind !== 'afterTask';
  $('watchFields').hidden = kind !== 'afterConversation';
  $('watchThread').required = kind === 'afterConversation';
  $('afterTask').required = kind === 'afterTask';
  $('timeList').querySelectorAll('input').forEach(input => { input.required = kind === 'time' && !repeating; });
  $('triggerHelp').textContent = kind === 'time' ? (repeating ? '按电脑本地时间持续重复，暂停或删除任务后停止。后台关闭或电脑睡眠时不能发送；恢复后最多补跑一次，或按高级设置跳过。' : '每个时间发送一次；发送前可编辑。') : kind === 'queue' ? '保存后即可排队，当前运行结束后依次发送。需要晚上开始时，请先暂停队列。' : kind === 'afterConversation' ? '等待桌面端此刻正在运行的任务。需要确认、失败或连接中断时不会自动接续；目标消息发送前可编辑。' : '默认只在前置任务成功后接续。可跨 Agent 接续；沿用对话时需要相同 Agent 和文件夹。';
  const previous = document.querySelector('input[name="threadMode"][value="previous"]');
  previous.disabled = kind !== 'afterTask' || (!!selectedTaskId && editingId !== selectedTaskId);
  if (kind !== 'afterTask' && previous.checked) { document.querySelector('input[name="threadMode"][value="new"]').checked = true; toggleThreadMode(); }
  updateSummary();
}

function renderProviderHelp() {
  const id = $('provider').value;
  $('projectFields').hidden = id === 'codex' || !usesLocalFiles(id);
  $('codexProjectFields').hidden = id !== 'codex';
  $('cwd').required = id !== 'codex' && usesLocalFiles(id);
  $('codexProject').required = false;
  $('nativeProjectFields').hidden = id !== 'doubaoDesktop';
  $('threadSelectLabel').textContent = id === 'doubaoDesktop' ? '豆包已有对话（客户端已加载）' : '项目中的已有对话';
  const provider = state.providers?.find(provider => provider.id === id);
  const desktop = provider?.capabilities.desktop;
  $('providerHelp').textContent = id === 'codex' ? '直接发送到 Codex 客户端所选项目中的对话；模型、权限确认和提问均在客户端处理。' : `${provider?.detail || '等待后台检测'}。` + (desktop ? '直接发送到桌面会话；权限确认和提问请在原客户端处理。' : '使用独立 CLI 入口，版本和登录可能与桌面端不同。');
  $('timeoutMinutes').closest('.timeout-field').hidden = false;
  $('timeoutMinutes').closest('.timeout-field').querySelector('.field-help').textContent = desktop ? '超过监控时间会暂停接续，保留发送记录；客户端中的任务继续运行。' : '到达上限会停止 CLI 并暂停队列，保留结果供核实。';
  $('defaultModel').textContent = id === 'codex' ? '沿用 Codex 客户端的权限模式和目标项目的模型、网络配置。'  : desktop ? (id === 'antigravityDesktop' ? '使用桌面服务默认模型，也可填写桌面模型列表中的完整名称。其他权限由客户端处理。' : '复用桌面账号和会话设置；需要确认时在原客户端处理。') : '文件、命令和网络权限遵循本机 CLI 设置；CLI 需要交互时可能失败，请先完成登录和所需权限配置。';
  $('manualThreadField').hidden = id === 'codex' || desktop;
  scheduled.syncControls();
}

function renderSettings() {
  const settings=state.settings || {};
  $('toggleQueue').textContent=settings.queuePaused?'恢复队列':'暂停队列';
  $('queueReason').textContent=state.maintenance?'正在验证 Agent，队列暂不发送新消息。':settings.pauseReason || (settings.queuePaused?'后续消息暂不发送，正在执行的任务继续运行。':'满足条件的消息按列表顺序发送。');
  $('pauseOnFailure').checked=settings.pauseOnFailure!==false;
  $('keepAwake').checked=!!settings.keepAwake;
  $('autostart').checked=!!state.system?.autostart;
  $('autostart').disabled=!state.system?.supported;
  $('keepAwake').disabled=!state.system?.supported;
  $('systemHelp').textContent=state.system?.error || (state.system?.keepingAwake?'正在保持系统唤醒，屏幕可以关闭。':'关闭网页后后台继续运行。自动启动在登录 Windows 后生效。');
  renderProviders(state.providers,refreshState);
}

async function reorderTask(id, direction) {
  const ids = [...state.tasks].filter(hasPending).sort((a, b) => a.order - b.order).map(task => task.id);
  const index = ids.indexOf(id), next = index + direction;
  if (next < 0 || next >= ids.length) return;
  [ids[index], ids[next]] = [ids[next], ids[index]];
  try { await api('queue/reorder', 'POST', { ids }); await refreshState(); } catch (error) { toast(error.message, true); }
}

$('editTask').addEventListener('click', async () => {
  const id = selectedTaskId;
  try {
    const task=state.tasks.find(task=>task.id===id);
    if(task)await loadTask(task,{force:true});
    await api(`tasks/${id}/hold`, 'POST', { token: editToken });
    if (selectedTaskId !== id) { await api(`tasks/${id}/release`, 'POST', { token: editToken }); return; }
    editingId = id;
    scheduled.editing=true;workspace.showEditor();
    setFormEditable(true);
    toggleTrigger();
    renderTaskActions();
    editTimer = setInterval(() => {
      if (editingId !== id) return;
      void api(`tasks/${id}/hold`, 'POST', { token: editToken }).catch(error => { releaseEditing(); setFormEditable(false); toast('编辑保护已失效：' + error.message, true); });
    }, 20000);
    toast('已进入编辑，这条消息暂不发送。');
  } catch (error) { toast(error.message, true); }
});
$('cancelEdit').addEventListener('click', () => { const task = state.tasks.find(task => task.id === selectedTaskId); if (task) loadTask(task,{force:true}); });
$('followTask').addEventListener('click', async () => {
  const parent = state.tasks.find(task => task.id === selectedTaskId);
  if(!await resetForm())return;
  $('provider').value = parent.provider || 'codex'; restoreCodexProject(parent); $('cwd').value = parent.cwd;
  $('nativeProject').replaceChildren(new Option('不指定项目（普通聊天）',''));
  if (parent.nativeProjectId) $('nativeProject').append(new Option(parent.nativeProjectName || parent.nativeProjectId,parent.nativeProjectId));
  $('nativeProject').value = parent.nativeProjectId || '';
  void loadNativeProjects().catch(error => toast(error.message,true));
  $('taskTitle').value = parent.title + ' · 后续';
  $('triggerType').value = 'afterTask'; renderDependencies(parent.id);
  const capabilities = state.providers?.find(provider => provider.id === parent.provider)?.capabilities;
  const mode = parent.provider === 'codex' || capabilities?.captureThread || parent.threadId ? 'previous' : 'new';
  document.querySelector(`input[name="threadMode"][value="${mode}"]`).checked = true;
  toggleTrigger(); toggleThreadMode(); renderProviderHelp(); formDirty=true; $('prompt').focus();
});
$('triggerType').addEventListener('change', toggleTrigger);
$('repeatFrequency').addEventListener('change', toggleTrigger);
$('repeatTime').addEventListener('input', updateSummary);
$('refreshProjects').addEventListener('click', () => loadNativeProjects().catch(error => toast(error.message,true)));
$('nativeProject').addEventListener('change', () => { savedThread = null; $('threadSelect').value = ''; void loadThreads().catch(error => toast(error.message,true)); });
document.querySelectorAll('input[name="weekday"]').forEach(input => input.addEventListener('change', updateSummary));
$('afterTask').addEventListener('change', () => renderDependencyRuns());
$('provider').addEventListener('change', () => { savedThread = null; restoreCodexProject(); $('manualThread').value = ''; $('threadSelect').replaceChildren(new Option('选择一个对话', '')); renderProviderHelp(); toggleThreadMode(); if ($('provider').value === 'doubaoDesktop') void loadNativeProjects().catch(error => toast(error.message,true)); });
$('provider').addEventListener('change', () => {
  if ($('provider').value === 'workbuddyDesktop') void loadWorkbuddyProjects();
  else ++workbuddyProjectRequest;
});
$('workbuddyProject').addEventListener('refresh', () => void loadWorkbuddyProjects());
$('workbuddyProject').addEventListener('change', () => {
  if ($('workbuddyProject').value === '__browse__') { restoreWorkbuddyProject();$('pickFolder').click();return; }
  $('cwd').value = $('workbuddyProject').value;savedThread = null;$('threadSelect').value = '';formDirty = true;
  restoreWorkbuddyProject();
  if (document.querySelector('input[name="threadMode"]:checked').value === 'existing') void loadThreads().catch(error=>toast(error.message,true));
});
$('cwd').addEventListener('change', restoreWorkbuddyProject);

$('refreshCodexProjects').addEventListener('click', () => void loadCodexProjects());
$('codexProject').addEventListener('change', () => {
  ++projectRequest;
  $('refreshCodexProjects').disabled = false;
  const project = codexProjects.find(project => project.id === $('codexProject').value);
  if (project?.rootPaths?.length) $('cwd').value = project.rootPaths[0];
  savedThread = null; loadedThreads = []; threadCursor = null;
  $('threadSelect').replaceChildren(new Option('选择项目中的对话', ''));
  if (document.querySelector('input[name="threadMode"]:checked').value === 'existing') void loadThreads().catch(error => toast(error.message, true));
});
$('toggleQueue').addEventListener('click', async () => { try { await api('settings', 'POST', { queuePaused: !state.settings?.queuePaused }); await refreshState(); } catch (error) { toast(error.message, true); } });
for (const key of ['pauseOnFailure', 'keepAwake', 'autostart']) $(key).addEventListener('change', async () => { try { await api('settings', 'POST', { [key]: $(key).checked }); await refreshState(); } catch (error) { toast(error.message, true); await refreshState(); } });
window.addEventListener('pagehide', () => {
  if (editingId) void fetch(`/api/tasks/${editingId}/release`, { method: 'POST', credentials: 'same-origin', keepalive: true, headers: { 'Content-Type': 'application/json', 'X-Scheduler-Request': '1' }, body: JSON.stringify({ token: editToken }) });
});

resetForm(false);
setInterval(() => { $('currentTime').textContent = clockFormat.format(new Date(Date.now() + serverOffset)); }, 1000);
const events = new EventSource('/api/events');
events.addEventListener('change', () => refreshState().catch(error => toast(error.message, true)));
events.addEventListener('ready', () => refreshState().catch(error => toast(error.message, true)));
events.onerror = () => { $('engineStatus').textContent = '后台连接中断'; $('engineStatus').className = 'engine-status offline'; };
void refreshState().catch(error => toast(error.message, true));
void api('threads').then(data => {
  const folders = [...new Set(data.threads.map(thread => thread.cwd).filter(Boolean))];
  $('knownFolders').replaceChildren(...folders.map(folder => new Option(folder, folder)));
}).catch(() => {});
