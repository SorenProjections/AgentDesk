import { $, element, icon, api, toast, confirmAction } from './api.js';
import { Workspace } from './workspace.js';
import { renderProviders } from './providers-view.js';
import { SessionsView } from './sessions-view.js';
const names = { idle: '空闲', working: '运行中', planning: '运行中', pending: '待执行', dispatching: '正在发送', running: '运行中', waiting: '等你处理', completed: '已完成', failed: '失败', interrupted: '已停止', uncertain: '待核实', missed: '已跳过', paused: '已暂停' };
Object.assign(names, { ready: '可发送', blocked: '接续受阻', editing: '编辑中', finished: '已发送' });
const providerNames = { codex: 'Codex', antigravity: 'Antigravity CLI', workbuddy: 'WorkBuddy CLI', antigravityDesktop: 'Antigravity 桌面端', workbuddyDesktop: 'WorkBuddy 桌面端' };
const editToken = crypto.randomUUID();
let editingId = null;
let editingRevision = null;
let editTimer = null;
const hasPending = task => task.trigger?.type && task.trigger.type !== 'time' ? task.trigger.state === 'pending' : task.times.some(slot => slot.state === 'pending');
const activeStates = new Set(['dispatching', 'running', 'waiting']);
let state = { tasks: [], runs: [], requests: [], connection: { connected: false, defaults: {} } };
let selectedTaskId = null;
let selectedRunId = null;
let threadCursor = null;
let loadedThreads = [];
let savedThread = null;
let requestSignature = '';
let currentRun = null;
let filter = 'all';
let formDirty = false;
let refreshing = false;
let refreshAgain = false;
let serverOffset = 0;
const workspace = new Workspace({newTask:()=>resetForm(),openRun:id=>openRun(id)});
const sessionsView = new SessionsView({ refresh: () => refreshState(), openRun: id => openRun(id), navigate: page => workspace.navigate(page), continueSession: session => continueSession(session) });
async function continueSession(session) {
  if (!await resetForm()) return;
  $('provider').value = session.provider; $('cwd').value = session.cwd || '';
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

const dateFormat = new Intl.DateTimeFormat('zh-CN', { timeZone: 'Asia/Shanghai', year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit', hour12: false });
const shortFormat = new Intl.DateTimeFormat('zh-CN', { timeZone: 'Asia/Shanghai', month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit', hour12: false });
const weekdayFormat = new Intl.DateTimeFormat('zh-CN', { timeZone: 'Asia/Shanghai', weekday: 'long' });
const clockFormat = new Intl.DateTimeFormat('zh-CN', { timeZone: 'Asia/Shanghai', month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit', second: '2-digit', hour12: false });
const formatDate = value => dateFormat.format(new Date(value));
const chinaInput = value => new Date(value + 8 * 3600000).toISOString().slice(0, 19);
const parseTime = value => Date.parse(value + (value.length === 16 ? ':00' : '') + '+08:00');
const folderName = value => value?.split(/[\\/]/).filter(Boolean).at(-1) || value || '';

function taskStatus(task) {
  const live = state.runs.find(run => run.taskId === task.id && activeStates.has(run.status));
  if (live) return live.status;
  if (task.paused) return 'paused';
  if (hasPending(task)) return task.queueStatus?.status || 'pending';
  return [...state.runs].reverse().find(run => run.taskId === task.id)?.status || 'missed';
}

function renderTaskList() {
  const tasks = [...state.tasks].sort((a, b) => a.order - b.order || a.createdAt - b.createdAt);
  $('taskCount').textContent = tasks.length;
  $('taskList').replaceChildren();
  const search = $('taskSearch').value.trim().toLowerCase();
  const shown = tasks.filter(task => (filter === 'all' || (filter === 'pending' ? hasPending(task) : !hasPending(task))) && (!search || [task.title,task.cwd,providerNames[task.provider]].join(' ').toLowerCase().includes(search)));
  if (!shown.length) $('taskList').append(workspace.emptyQueue({filtered:!!tasks.length}));
  for (const task of shown) {
    const button = element('button', 'task-item' + (task.id === selectedTaskId ? ' selected' : ''));
    button.type = 'button';
    const content=element('span','task-content');
    const top=element('span','task-top');
    top.append(element('span','task-name',task.title));
    content.append(top);
    const folder = element('span', 'task-folder', providerNames[task.provider || 'codex'] + ' · ' + folderName(task.cwd));
    folder.title = task.cwd;
    content.append(folder);
    const bottom = element('span', 'task-bottom');
    const next = task.times.find(slot => slot.state === 'pending');
    const status = taskStatus(task);
    top.append(element('span','badge '+status,names[status]));
    bottom.append(element('span', 'task-date', hasPending(task) ? (task.trigger?.type === 'afterTask' ? '等待 ' + (state.tasks.find(parent => parent.id === task.trigger.taskId)?.title || '前置任务') : task.trigger?.type === 'afterConversation' ? '等待桌面对话' : next ? shortFormat.format(new Date(next.at)) : '轮到时发送') : '本次任务已结束'));
    content.append(bottom);
    if (['blocked','editing'].includes(task.queueStatus?.status)) content.append(element('span','task-reason',task.queueStatus.reason));
    button.append(element('span','queue-number',String(tasks.indexOf(task)+1).padStart(2,'0')),content);
    button.addEventListener('click', () => loadTask(task));
    const row = element('div', 'queue-row');
    row.append(button);
    if (hasPending(task)) {
      const moves = element('div', 'queue-moves');
      for (const [direction, label] of [[-1, '上移'], [1, '下移']]) {
        const move = element('button', 'quiet', direction < 0 ? '↑' : '↓');
        move.type = 'button'; move.setAttribute('aria-label', task.title + label);
        move.addEventListener('click', () => reorderTask(task.id, direction));
        moves.append(move);
      }
      row.append(moves);
    }
    row.title = task.queueStatus?.reason || '';
    $('taskList').append(row);
  }
}

function addTime(at = Math.ceil((Date.now() + serverOffset + 3600000) / 60000) * 60000, status = 'pending') {
  const row = element('div', 'time-row');
  row.dataset.state = status;
  const line = element('div', 'time-row-line');
  const input = element('input');
  input.type = 'datetime-local';
  input.step = '1';
  input.required = true;
  input.value = chinaInput(at);
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
  const times = [...$('timeList').querySelectorAll('input')].filter(input => !input.disabled).map(input => parseTime(input.value)).filter(Number.isFinite).sort((a, b) => a - b);
  $('scheduleSummary').textContent = times.length ? `${formatDate(times[0])}${times.length > 1 ? `，共 ${times.length} 个时间` : '，仅执行一次'}` : '选择一个未来的执行时间';
}

function toggleThreadMode() {
  const existing = document.querySelector('input[name="threadMode"]:checked').value === 'existing';
  $('existingThreadField').hidden = !existing;
  $('newThreadHelp').hidden = document.querySelector('input[name="threadMode"]:checked').value !== 'new';
  const desktop = ['antigravityDesktop', 'workbuddyDesktop'].includes($('provider').value);
  $('threadSelect').required = existing && ($('provider').value === 'codex' || desktop);
  $('manualThreadField').hidden = $('provider').value === 'codex' || desktop;
  if (existing && $('cwd').value.trim()) void loadThreads().catch(error => toast(error.message, true));
}

async function loadThreads(more = false) {
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
    const data = await api('threads?provider=' + encodeURIComponent(requestedProvider) + '&cwd=' + encodeURIComponent(folder.cwd) + (more && threadCursor ? '&cursor=' + encodeURIComponent(threadCursor) : ''));
    if ($('cwd').value.trim() !== folder.cwd || $('provider').value !== requestedProvider) return;
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
  if(formDirty && !await confirmAction('当前修改尚未保存，放弃修改并新建任务？',{title:'放弃当前修改',accept:'放弃并新建'}))return false;
  releaseEditing();
  setFormEditable(true);
  editingRevision = null;
  selectedTaskId = null;
  savedThread = null;
  $('taskForm').reset();
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
  $('newThreadHelp').textContent = '到点创建新对话；添加多个时间时，后续消息继续这个对话。';
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
  if(!force && task.id===selectedTaskId && formDirty){workspace.showEditor();return;}
  if(!force && formDirty && !await confirmAction('当前修改尚未保存，放弃修改并打开其他任务？',{title:'放弃当前修改',accept:'放弃并打开'}))return;
  workspace.showEditor();
  releaseEditing();
  editingRevision = task.revision;
  setFormEditable(false);
  selectedTaskId = task.id;
  savedThread = task.threadId ? { id: task.threadId, name: task.threadTitle || task.title } : null;
  $('provider').value = task.provider || 'codex';
  $('triggerType').value = task.trigger?.type || 'time';
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
  $('sandbox').value = task.sandbox;
  $('approval').value = task.approval;
  $('latePolicy').value = task.latePolicy;
  $('model').value = task.model;
  $('effort').value = task.effort;
  renderProviderHelp();
  $('networkAccess').checked = task.networkAccess;
  $('timeList').replaceChildren();
  task.times.forEach(slot => addTime(slot.at, slot.state));
  $('editorTitle').textContent = '任务详情';
  $('editorSubtitle').textContent = task.title;
  $('saveTask').textContent = '保存修改';
  $('deleteTask').hidden = false;
  $('taskActions').hidden = false;
  $('threadSelect').replaceChildren(new Option(savedThread?.name || '选择一个对话', savedThread?.id || ''));
  $('newThreadHelp').textContent = task.threadMode === 'new' && task.threadId ? '这个预约已经创建对话；后续执行时间继续使用这个对话。' : '到点创建新对话；添加多个时间时，后续消息继续这个对话。';
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
  $('runTask').disabled = task.paused || !!state.activeRunId || editingId === task.id || (task.trigger?.type !== 'time' && task.queueStatus?.status !== 'ready');
  $('saveHint').textContent = editingId === task.id ? '正在编辑，这条消息暂不发送；保存后释放' : task.paused ? '任务已暂停' : '点击“编辑消息”修改尚未发送的内容';
  $('editorTitle').textContent=editingId===task.id?'编辑任务':'任务详情';
  $('taskReadiness').hidden=!task.queueStatus?.reason;
  $('taskReadiness').textContent=task.queueStatus?.reason || '';
}

function renderRunOptions() {
  const runs = [...state.runs].reverse();
  if (!selectedRunId || !runs.some(run => run.id === selectedRunId)) selectedRunId = runs.find(run => run.taskId === selectedTaskId)?.id || runs[0]?.id || null;
  $('runSelect').replaceChildren();
  if (!runs.length) $('runSelect').append(new Option('还没有运行记录', ''));
  for (const run of runs) $('runSelect').append(new Option(`${shortFormat.format(new Date(run.startedAt))} ${run.taskTitle} · ${names[run.status]}`, run.id));
  $('runSelect').value = selectedRunId || '';
  renderRunList();
}

function renderRunList(){
  const search=$('runSearch').value.trim().toLowerCase();
  const runs=[...state.runs].reverse().filter(run=>!search || [run.taskTitle,providerNames[run.provider],names[run.status]].join(' ').toLowerCase().includes(search));
  $('runList').replaceChildren();
  if(!runs.length)$('runList').append(element('p','run-list-empty',state.runs.length?'没有符合条件的运行记录。':'还没有运行记录。\n发送任务后，执行结果会保存在这里。'));
  for(const run of runs){const button=element('button','run-item'+(run.id===selectedRunId?' selected':''));button.type='button';button.append(element('strong','',run.taskTitle));const meta=element('span','run-meta');meta.append(element('span','',shortFormat.format(new Date(run.startedAt))),element('span','badge '+run.status,names[run.status] || run.status));button.append(meta);button.addEventListener('click',()=>openRun(run.id));$('runList').append(button);}
}
function openRun(id){selectedRunId=id;requestSignature='';workspace.showRun();renderRunOptions();void refreshRun().catch(error=>toast(error.message,true));}

function renderRequests() {
  const requests = state.requests.filter(request => request.runId === selectedRunId);
  const signature = requests.map(request => request.id).join(',');
  if (signature === requestSignature) return;
  requestSignature = signature;
  $('requests').replaceChildren();
  for (const request of requests) {
    const box = element('div', 'request-box');
    const isQuestion = request.method === 'item/tool/requestUserInput';
    box.append(element('h3', '', isQuestion ? 'Codex 需要你的回答' : '这一步需要你的确认'));
    const answerInputs = new Map();
    if (isQuestion) {
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
        const answer = isQuestion ? { answers: Object.fromEntries([...answerInputs].map(([id, input]) => [id, input.value])) } : { decision: 'accept' };
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
  if (!runId) { currentRun = null; $('copyOutput').disabled=true; return; }
  if(currentRun?.id!==runId){
    const summary=state.runs.find(run=>run.id===runId);currentRun=null;
    $('runTitle').textContent=summary?.taskTitle || '正在加载运行记录';
    $('runProvider').textContent=providerNames[summary?.provider || 'codex'];
    $('runStatus').className='badge '+(summary?.status || 'pending');$('runStatus').textContent=names[summary?.status] || '正在加载';
    $('runTime').textContent='';$('runOutput').textContent='正在加载运行结果…';$('runLog').textContent='';$('runPrompt').textContent='';$('runError').hidden=true;$('openThread').hidden=true;$('interruptRun').hidden=true;$('copyOutput').disabled=true;renderRequests();
  }
  const run = await api('runs/' + runId);
  if (runId !== selectedRunId) return;
  currentRun = run;
  $('copyOutput').disabled=false;
  $('runTitle').textContent=run.taskTitle;
  $('runProvider').textContent=providerNames[run.provider || 'codex']+' · '+folderName(run.cwd);
  $('runPrompt').textContent=run.prompt;
  $('runStatus').className = 'badge ' + run.status;
  $('runStatus').textContent = names[run.status] || run.status;
  $('runTime').textContent = shortFormat.format(new Date(run.startedAt)) + (run.endedAt ? `\n用时 ${Math.max(1, Math.round((run.endedAt - run.startedAt) / 1000))} 秒` : '');
  $('runError').hidden = !run.error;
  $('runError').textContent = run.error;
  $('openThread').hidden = !run.threadId || (run.provider || 'codex') !== 'codex';
  $('openThread').href = run.threadId ? 'codex://threads/' + encodeURIComponent(run.threadId) : '#';
  $('interruptRun').hidden = !activeStates.has(run.status) || !run.turnId;
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
    serverOffset = state.serverTime - Date.now();
    const connection = state.connection;
    $('engineStatus').textContent = '后台在线';
    $('engineStatus').className = 'engine-status connected';
    $('engineStatus').title = '本机调度后台已连接';
    $('defaultModel').textContent = connection.defaults.model ? `当前 Codex 配置：${connection.defaults.model}${connection.defaults.effort ? `，推理强度 ${connection.defaults.effort}` : ''}。` : '';
    if (connection.defaults.model) $('model').placeholder = '沿用 ' + connection.defaults.model;
    renderSettings();
    renderProviderHelp();
    renderTaskList();
    renderTaskActions();
    renderRunOptions();
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
  const times = $('triggerType').value === 'time' ? [...$('timeList').querySelectorAll('input')].map(input => parseTime(input.value)) : [];
  const threadId = $('provider').value === 'codex' || ['antigravityDesktop','workbuddyDesktop'].includes($('provider').value) ? $('threadSelect').value : $('manualThread').value.trim() || $('threadSelect').value;
  const input = {
    provider: $('provider').value, revision: editingRevision, editToken, timeoutMinutes: Number($('timeoutMinutes').value),
    trigger: { type: $('triggerType').value, taskId: $('afterTask').value, runId: $('afterRun').value || null, onFailure: $('onFailure').value },
    title: $('taskTitle').value, cwd: $('cwd').value, prompt: $('prompt').value, times,
    threadMode: document.querySelector('input[name="threadMode"]:checked').value,
    threadId, threadTitle: loadedThreads.find(thread => thread.id === threadId)?.name || savedThread?.name || '',
    sandbox: $('sandbox').value, approval: $('approval').value, latePolicy: $('latePolicy').value,
    model: $('model').value, effort: $('effort').value, networkAccess: $('networkAccess').checked,
  };
  if (input.trigger.type === 'afterConversation') Object.assign(input.trigger, { provider: $('watchProvider').value, threadId: $('watchThread').value, rearm: rearmWatch.checked });
  if ($('triggerType').value === 'time' && (!times.length || times.some(value => !Number.isFinite(value)))) return toast('请至少选择一个有效的执行时间。', true);
  $('saveTask').disabled = true;
  try {
    const task = await api(selectedTaskId ? 'tasks/' + selectedTaskId : 'tasks', selectedTaskId ? 'PUT' : 'POST', input);
    await refreshState();
    await loadTask(task,{force:true});
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
    if (!result.cancelled) { $('cwd').value = result.cwd; formDirty=true; savedThread = null; await loadThreads(); }
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
  finally { $('runTask').disabled = !!state.activeRunId; }
});
$('deleteTask').addEventListener('click', async () => {
  if (!await confirmAction('删除这条任务及其未来发送时间。已有运行记录会保留。',{title:'删除任务',accept:'删除任务',danger:true})) return;
  try { await api('tasks/' + selectedTaskId, 'DELETE'); formDirty=false;resetForm(false); await refreshState(); toast('任务已删除，运行记录已保留。'); }
  catch (error) { toast(error.message, true); }
});
$('duplicateTask').addEventListener('click', async () => {
  const task = state.tasks.find(task => task.id === selectedTaskId);
  if(!await resetForm())return;
  $('taskTitle').value = task.title + '（副本）';
  $('provider').value = task.provider || 'codex';
  renderProviderHelp();
  $('cwd').value = task.cwd;
  $('prompt').value = task.prompt;
  $('promptCount').textContent = task.prompt.length + ' 字';
  $('sandbox').value = task.sandbox;
  $('approval').value = task.approval;
  $('latePolicy').value = task.latePolicy;
  $('networkAccess').checked = task.networkAccess;
  $('model').value = task.model;
  $('effort').value = task.effort;
  renderProviderHelp();
  formDirty=true;
});
$('runSelect').addEventListener('change', () => { selectedRunId = $('runSelect').value || null; requestSignature = ''; renderRunList(); void refreshRun().catch(error => toast(error.message, true)); });
$('refreshRuns').addEventListener('click', () => refreshState().catch(error => toast(error.message, true)));
$('interruptRun').addEventListener('click', async () => {
  if (!await confirmAction('停止当前运行。已完成的文件修改会保留。',{title:'停止运行',accept:'停止运行',danger:true})) return;
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
  $('timeFields').hidden = kind !== 'time';
  $('dependencyFields').hidden = kind !== 'afterTask';
  $('watchFields').hidden = kind !== 'afterConversation';
  $('watchThread').required = kind === 'afterConversation';
  $('afterTask').required = kind === 'afterTask';
  $('timeList').querySelectorAll('input').forEach(input => { input.required = kind === 'time'; });
  $('triggerHelp').textContent = kind === 'time' ? '每个时间发送一次；发送前可编辑。' : kind === 'queue' ? '保存后即可排队，当前运行结束后依次发送。需要晚上开始时，请先暂停队列。' : kind === 'afterConversation' ? '等待桌面端此刻正在运行的任务。需要确认、失败或连接中断时不会自动接续；目标消息发送前可编辑。' : '默认只在前置任务成功后接续。可跨 Agent 接续；沿用对话时需要相同 Agent 和文件夹。';
  const previous = document.querySelector('input[name="threadMode"][value="previous"]');
  previous.disabled = kind !== 'afterTask' || (!!selectedTaskId && editingId !== selectedTaskId);
  if (kind !== 'afterTask' && previous.checked) { document.querySelector('input[name="threadMode"][value="new"]').checked = true; toggleThreadMode(); }
  updateSummary();
}

function renderProviderHelp() {
  const id = $('provider').value;
  const provider = state.providers?.find(provider => provider.id === id);
  const desktop = provider?.capabilities.desktop;
  $('providerHelp').textContent = id === 'codex' ? '使用 Codex 本地接口，支持已有对话和权限处理。' : `${provider?.detail || '等待后台检测'}。` + (desktop ? '直接发送到桌面会话；权限确认和提问请在原客户端处理。' : '使用独立 CLI 入口，版本和登录可能与桌面端不同。');
  $('timeoutMinutes').closest('.timeout-field').hidden = id === 'codex';
  $('timeoutMinutes').closest('.timeout-field').querySelector('.field-help').textContent = desktop ? '超过监控时间会暂停接续，保留发送记录；客户端中的任务继续运行。' : '到达上限会停止 CLI 并暂停队列，保留结果供核实。';
  for (const key of ['sandbox', 'approval', 'networkAccess']) $(key).parentElement.hidden = id !== 'codex';
  $('defaultModel').textContent = id === 'codex' ? `Codex 当前配置：${state.connection.defaults.model || '默认模型'}。` : desktop ? (id === 'antigravityDesktop' ? '使用桌面服务默认模型，也可填写桌面模型列表中的完整名称。其他权限由客户端处理。' : '复用桌面账号和会话设置；需要确认时在 WorkBuddy 中处理。') : '文件、命令和网络权限遵循本机 CLI 设置；CLI 需要交互时可能失败，请先完成登录和所需权限配置。';
  $('model').parentElement.hidden = desktop && !provider.capabilities.model;
  $('effort').parentElement.hidden = desktop;
  if (desktop) { $('effort').value = ''; if (!provider.capabilities.model) $('model').value = ''; }
  $('model').placeholder = '沿用 ' + (id === 'codex' ? state.connection.defaults.model || '当前配置' : providerNames[id] + ' 配置');
  $('manualThreadField').hidden = id === 'codex' || desktop;
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
  $('provider').value = parent.provider || 'codex'; $('cwd').value = parent.cwd;
  $('taskTitle').value = parent.title + ' · 后续';
  $('triggerType').value = 'afterTask'; renderDependencies(parent.id);
  const capabilities = state.providers?.find(provider => provider.id === parent.provider)?.capabilities;
  const mode = parent.provider === 'codex' || capabilities?.captureThread || parent.threadId ? 'previous' : 'new';
  document.querySelector(`input[name="threadMode"][value="${mode}"]`).checked = true;
  toggleTrigger(); toggleThreadMode(); renderProviderHelp(); formDirty=true; $('prompt').focus();
});
$('triggerType').addEventListener('change', toggleTrigger);
$('afterTask').addEventListener('change', () => renderDependencyRuns());
$('provider').addEventListener('change', () => { savedThread = null; $('manualThread').value = ''; $('threadSelect').replaceChildren(new Option('选择一个对话', '')); renderProviderHelp(); toggleThreadMode(); });
$('toggleQueue').addEventListener('click', async () => { try { await api('settings', 'POST', { queuePaused: !state.settings?.queuePaused }); await refreshState(); } catch (error) { toast(error.message, true); } });
for (const key of ['pauseOnFailure', 'keepAwake', 'autostart']) $(key).addEventListener('change', async () => { try { await api('settings', 'POST', { [key]: $(key).checked }); await refreshState(); } catch (error) { toast(error.message, true); await refreshState(); } });
window.addEventListener('pagehide', () => {
  if (editingId) void fetch(`/api/tasks/${editingId}/release`, { method: 'POST', credentials: 'same-origin', keepalive: true, headers: { 'Content-Type': 'application/json', 'X-Scheduler-Request': '1' }, body: JSON.stringify({ token: editToken }) });
});

resetForm(false);
setInterval(() => { $('currentTime').textContent = clockFormat.format(new Date(Date.now() + serverOffset)) + ' 北京时间'; }, 1000);
const events = new EventSource('/api/events');
events.addEventListener('change', () => refreshState().catch(error => toast(error.message, true)));
events.addEventListener('ready', () => refreshState().catch(error => toast(error.message, true)));
events.onerror = () => { $('engineStatus').textContent = '后台连接中断'; $('engineStatus').className = 'engine-status offline'; };
void refreshState().catch(error => toast(error.message, true));
void api('threads').then(data => {
  const folders = [...new Set(data.threads.map(thread => thread.cwd).filter(Boolean))];
  $('knownFolders').replaceChildren(...folders.map(folder => new Option(folder, folder)));
}).catch(() => {});
