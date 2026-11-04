import { $, element, api, toast, confirmAction } from './api.js';

const labels = { draft: '待安排', bound: '已绑定', scheduled: '已预约', correction_pending: '纠偏待发送', running: '执行中', collecting: '验收中', review_pending: '等待判断', correction_needed: '需要纠偏', accepted: '验收通过', exhausted: '纠偏次数已用完', blocked: '执行受阻', uncertain: '待核实', paused: '已暂停' };
let selected = null, detailKey = '', loading = false, fieldSequence = 0;
const section = $('supervisionPage');
const list = element('div', 'supervision-list'), detail = element('div', 'supervision-detail');
const layout = element('div', 'supervision-layout'); layout.append(list, detail);
const intro = element('p', 'page-note', '保存目标与验收标准，执行完成后检查实际产物。人工或本对话判断通过后，再进入下一阶段。');
const createButton = element('button', 'primary', '新建督导任务'); createButton.type = 'button';
const leasesBox = element('details', 'supervision-leases'); leasesBox.append(element('summary', '', '文件占用与保护范围'));
const leaseList = element('div'); leasesBox.append(leaseList);
section.append(intro, createButton, layout, leasesBox);
const deletedLabel=element('label','run-history-filter','已删除任务'),showDeleted=element('input');showDeleted.type='checkbox';deletedLabel.prepend(showDeleted);
const picked=new Set(),batch=element('div','history-batch'),pickAll=element('button','text-button','全选可删除任务'),clearPicked=element('button','text-button','取消选择'),managePicked=element('button','text-button danger','删除所选');
for(const node of [pickAll,clearPicked,managePicked])node.type='button';
batch.append(pickAll,clearPicked,managePicked);createButton.after(deletedLabel,batch);
let missionRows=[],historyManagement=false;
const visibleMissions=()=>missionRows.filter(m=>!!m.deletedAt===showDeleted.checked);
const manageable=m=>!['running','dispatching','collecting'].includes(m.state);
function updateSelection(){
  const allowed=new Set(visibleMissions().filter(manageable).map(m=>m.id));
  for(const id of picked)if(!allowed.has(id))picked.delete(id);
  pickAll.disabled=!historyManagement||!allowed.size;clearPicked.hidden=!picked.size;
  pickAll.textContent=showDeleted.checked?'全选已删除任务':'全选可删除任务';
  managePicked.disabled=!historyManagement||!picked.size;managePicked.textContent=(showDeleted.checked?'恢复所选':'删除所选')+(picked.size?'（'+picked.size+'）':'');
}
async function manageHistory(ids,action){
  if(!await confirmAction((action==='delete'?'删除':'恢复')+'所选 '+ids.length+' 个督导任务？'+(action==='delete'?'未发送的指令将暂停。项目文件、客户端对话、验收证据和文件保护保留；可在“已删除任务”恢复。':'恢复后不会自动发送暂停的指令。'),{title:action==='delete'?'删除督导任务':'恢复督导任务',accept:action==='delete'?'删除任务':'恢复任务',danger:action==='delete'}))return;
  await api('supervision/history','POST',{ids,action});picked.clear();selected=null;detailKey='';detail.replaceChildren();await refresh(true);toast(action==='delete'?'督导任务已删除，可在“已删除任务”恢复。':'督导任务已恢复；暂停的指令需要手动恢复。');
}
showDeleted.addEventListener('change',()=>{picked.clear();selected=null;detailKey='';detail.replaceChildren();void refresh(true).catch(error=>toast(error.message,true));});
pickAll.addEventListener('click',()=>{for(const m of visibleMissions().filter(manageable))picked.add(m.id);void refresh(true).catch(error=>toast(error.message,true));});
clearPicked.addEventListener('click',()=>{picked.clear();void refresh(true).catch(error=>toast(error.message,true));});
managePicked.addEventListener('click',async()=>{managePicked.disabled=true;try{await manageHistory([...picked],showDeleted.checked?'restore':'delete');}catch(error){toast(error.message,true);}finally{updateSelection();}});

function button(label, action, className = 'secondary', refreshAfter = true) {
  const node = element('button', className, label); node.type = 'button';
  node.addEventListener('click', async () => {
    node.disabled = true;
    try { await action(); if (refreshAfter) await refresh(true); } catch (error) { toast(error.message, true); }
    finally { node.disabled = false; }
  }); return node;
}
function field(container, label, tag = 'input', initial = '') {
  const wrapper = element('div', 'supervision-field'), caption = element('label', '', label); wrapper.append(caption);
  const input = element(tag); if (tag === 'textarea') input.rows = 3;
  input.id = 'supervision-field-' + (++fieldSequence); caption.htmlFor = input.id;
  input.value = initial; wrapper.append(input); container.append(wrapper); return input;
}
function select(container, label, options) {
  const node = field(container, label, 'select');
  for (const [value, name] of options) node.append(new Option(name, value));
  return node;
}
const lines = input => input.value.split(/\r?\n/).map(x => x.trim()).filter(Boolean);
function createForm() {
  selected = null; detailKey = '';
  detail.replaceChildren();
  const form = element('form', 'supervision-form');
  form.append(element('h2', '', '新建督导任务'));
  const title = field(form, '任务名称'); title.required = true; title.maxLength = 88;
  const cwd = field(form, '项目文件夹（完整路径）'); cwd.required = true;
  const provider = select(form, '执行客户端', [['workbuddyDesktop', 'WorkBuddy'], ['antigravityDesktop', 'Antigravity'], ['codex', 'Codex']]);
  const thread = select(form, '目标会话', [['', '新建会话']]);
  const loadSessions = button('读取这个文件夹的会话', async () => {
    const result = await api('threads?' + new URLSearchParams({ provider: provider.value, cwd: cwd.value }));
    thread.replaceChildren(new Option('新建会话', ''));
    for (const item of result.threads || []) thread.append(new Option((item.name || item.id) + ' · ' + item.status, item.id));
  }); form.append(loadSessions);
  provider.addEventListener('change', () => thread.replaceChildren(new Option('新建会话', '')));
  cwd.addEventListener('input', () => thread.replaceChildren(new Option('新建会话', '')));
  const objective = field(form, '目标', 'textarea'); objective.required = true;
  const constraints = field(form, '约束（每行一条）', 'textarea');
  const access = select(form, '文件访问', [['write', '允许修改约定文件'], ['read', '只读检查']]);
  const writePaths = field(form, '工作范围（项目相对路径，每行一条；. 表示整个项目）', 'textarea', '.');
  const artifacts = field(form, '阶段产物（文件的相对路径，每行一条）', 'textarea');
  const criteriaBox = element('div', 'supervision-criteria'); criteriaBox.append(element('h3', '', '验收标准')); form.append(criteriaBox);
  const rows = [];
  function addCriterion() {
    const row = element('fieldset', 'supervision-criterion');
    row.append(element('legend', '', '验收条件'));
    const type = select(row, '检查方式', [['manual', '本对话或人工判断'], ['file', '产物文件存在'], ['contains', '文件包含预期文字'], ['command', '运行验收命令']]);
    const description = field(row, '通过标准'); description.required = true;
    const fileBox = element('div'), commandBox = element('div'); row.append(fileBox, commandBox);
    const file = field(fileBox, '文件相对路径'), contains = field(fileBox, '预期文字');
    const executable = field(commandBox, '测试程序（如 node、python.exe）');
    const args = field(commandBox, '程序参数（每行一个）', 'textarea');
    const timeout = field(commandBox, '最长等待秒数', 'input', '60'); timeout.type = 'number'; timeout.min = 1; timeout.max = 300;
    function update() { fileBox.hidden = !['file', 'contains'].includes(type.value); contains.closest('.supervision-field').hidden = type.value !== 'contains'; commandBox.hidden = type.value !== 'command'; }
    type.addEventListener('change', update); update();
    const entry = { row, type, description, file, contains, executable, args, timeout }; rows.push(entry);
    row.append(button('删除这条', async () => { rows.splice(rows.indexOf(entry), 1); row.remove(); }));
    criteriaBox.append(row);
  }
  form.append(button('添加验收条件', async () => addCriterion())); addCriterion();
  const maximum = field(form, '最大纠偏次数', 'input', '2'); maximum.type = 'number'; maximum.min = 0; maximum.max = 10;
  const auto = field(form, '验收失败后自动安排纠偏'); auto.type = 'checkbox';
  form.append(element('p', '', '测试命令按保存的程序和参数运行。自动纠偏遵守原目标与约束；需要判断的验收条件仍等待本对话或人工审查。'));
  const submit = element('button', 'primary', '保存目标与标准'); submit.type = 'submit'; form.append(submit);
  form.addEventListener('submit', async event => {
    event.preventDefault(); submit.disabled = true;
    try {
      const created = await api('supervision/missions', 'POST', {
        title: title.value, cwd: cwd.value, provider: provider.value, threadId: thread.value || undefined,
        objective: objective.value, constraints: lines(constraints), access: access.value,
        writePaths: lines(writePaths), artifacts: lines(artifacts), maxCorrections: Number(maximum.value), autoCorrect: auto.checked,
        criteria: rows.map(r => ({ type: r.type.value, description: r.description.value, path: r.file.value,
          contains: r.contains.value, command: r.executable.value, args: lines(r.args), timeoutSeconds: Number(r.timeout.value) }))
      }); selected = created.id; detailKey = ''; await refresh(true); toast('已保存；安排执行后才会发送任务。');
    } catch (error) { toast(error.message, true); } finally { submit.disabled = false; }
  }); detail.append(form);
}

async function renderDetail(m) {
  const key = [m.id, m.state, m.instructions.length, m.reviews.at(-1)?.id, m.error, m.deletedAt, historyManagement].join(':');
  if (key === detailKey) return;
  detailKey = key; detail.replaceChildren();
  detail.append(element('h2', '', m.title), element('p', '', labels[m.state] + ' · 纠偏 ' + m.corrections + '/' + m.maxCorrections),
    element('p', '', '文件夹：' + m.cwd), element('p', '', '会话：' + (m.binding?.threadId || '执行时新建')),
    element('h3', '', '目标'), element('p', '', m.objective), element('h3', '', '约束'));
  const constraints = element('ul');
  for (const c of m.constraints) constraints.append(element('li', '', c));
  detail.append(constraints, element('p', '', '工作范围：' + m.writePaths.join('、')));
  if (m.error) detail.append(element('p', 'supervision-error', m.error));
  const actions = element('div', 'supervision-actions'); detail.append(actions);
  const remove=button(m.deletedAt?'恢复任务':'删除任务',()=>manageHistory([m.id],m.deletedAt?'restore':'delete'),'text-button danger');remove.disabled=!historyManagement||!manageable(m);actions.append(remove);
  if(m.lease)detail.append(element('p','page-note','此任务保留文件保护。删除不会释放占用；可在下方“文件占用与保护范围”核实并释放。'));
  if(m.deletedAt){detail.append(element('p','','此任务已删除。恢复后可查看与处理原任务；不会自动发送指令。'));return;}
  const stage = element('pre'); stage.hidden = true; detail.append(stage);
  actions.append(button('查看阶段产物与进度', async () => {
    stage.textContent = JSON.stringify(await api('supervision/missions/' + m.id + '/observe'), null, 2); stage.hidden = false;
  }, 'secondary', false));
  if (['draft', 'bound'].includes(m.state)) {
    const at = field(detail, '可选预约时间（北京时间）'); at.type = 'datetime-local';
    actions.append(button('安排执行', async () => {
      await api('supervision/missions/' + m.id + '/dispatch', 'POST', { requestId: crypto.randomUUID(), at: at.value ? at.value + ':00+08:00' : undefined });
    }, 'primary'));
  }
  if (m.state === 'correction_needed') {
    const feedback = field(detail, '额外纠偏要求（可留空使用验收结论）', 'textarea');
    actions.append(button('安排纠偏', () => api('supervision/missions/' + m.id + '/correct', 'POST', { requestId: crypto.randomUUID(), feedback: feedback.value || undefined }), 'primary'));
  }
  if (['review_pending', 'correction_needed', 'exhausted'].includes(m.state)) actions.append(button('重新收集并运行验收', () => api('supervision/missions/' + m.id + '/evidence', 'POST', {}, 650000)));
  if (m.state === 'paused') actions.append(button('恢复督导', () => api('supervision/missions/' + m.id + '/resume', 'POST')));
  else if (!['running', 'collecting', 'accepted'].includes(m.state)) {
    const reason = field(detail, '暂停原因');
    actions.append(button('暂停督导', () => api('supervision/missions/' + m.id + '/pause', 'POST', { reason: reason.value })));
  }
  if (m.state === 'running' && m.latestRunId) actions.append(button('停止当前运行', () => api('runs/' + m.latestRunId + '/interrupt', 'POST')));
  const latest = m.reviews.at(-1);
  if (latest) {
    const packet = latest.packet;
    detail.append(element('h3', '', '本轮验收'));
    const decisions = [];
    for (const check of packet.checks) {
      const box = element('div', 'supervision-check'); box.append(element('strong', '', check.description),
        element('p', '', check.status === 'passed' ? '通过' : check.status === 'failed' ? '未通过' : '等待判断'));
      if (check.reason) box.append(element('p', '', check.reason));
      if (check.command) {
        const log = element('details'); log.append(element('summary', '', '测试结果 · 退出代码 ' + check.command.exitCode),
          element('pre', '', [check.command.output, check.command.errors, check.command.error].filter(Boolean).join('\n'))); box.append(log);
      }
      if (m.state === 'review_pending' && check.status === 'pending') {
        const verdict = select(box, '结论', [['', '请选择'], ['passed', '通过'], ['failed', '未通过']]);
        const reason = field(box, '判断依据', 'textarea'); decisions.push({ check, verdict, reason });
      } detail.append(box);
    }
    if (m.state === 'review_pending') {
      let incomplete;
      if (!packet.scanComplete || !packet.baselineComplete) { incomplete = field(detail, '已人工核验扫描遗漏的文件'); incomplete.type = 'checkbox'; }
      const reason = field(detail, '总体审查结论', 'textarea');
      detail.append(button('保存审查结论', async () => {
        await api('supervision/missions/' + m.id + '/review', 'POST', { evidenceId: packet.id, reason: reason.value,
          confirmIncompleteScan: incomplete?.checked || false,
          decisions: decisions.filter(d => d.verdict.value).map(d => ({ criterionId: d.check.id, status: d.verdict.value, reason: d.reason.value })) });
      }, 'primary'));
    }
    const evidence = element('details'); evidence.append(element('summary', '', '产物、修改与客户端回复'));
    evidence.append(element('p', '', '扫描问题：' + (packet.scanIssues.join('；') || '无')),
      element('pre', '', JSON.stringify(packet.changes, null, 2)), element('pre', '', packet.execution.output));
    for (const a of packet.artifacts) evidence.append(element('h4', '', a.path + ' · ' + a.status), element('pre', '', a.text || '没有可读取的文本'));
    for (const a of packet.changedFilePreviews || []) if (!packet.artifacts.some(p => p.path === a.path)) evidence.append(element('h4', '', '修改文件：' + a.path), element('pre', '', a.text || '没有可读取的文本'));
    evidence.append(element('pre', '', packet.git.diff || '无 Git 差异记录')); detail.append(evidence);
    if (packet.unattributedChanges?.length) {
      const elsewhere = element('details'); elsewhere.append(element('summary', '', '工作空间其他变化（未归因于本任务）'));
      elsewhere.append(element('p', '', '其他独立研究可能同时写入各自目录，这些变化不作为当前任务的越界或验收失败依据。'),
        element('pre', '', JSON.stringify(packet.unattributedChanges, null, 2))); detail.append(elsewhere);
    }
  }
  const history = element('details'); history.append(element('summary', '', '指令与轮次记录（' + m.instructions.length + '）'));
  for (const i of m.instructions) history.append(element('h4', '', '第 ' + i.round + ' 轮 · ' + i.state),
    element('p', '', '运行：' + (i.runId || '尚未发送')), element('pre', '', i.prompt));
  detail.append(history);
}

async function refresh(force = false) {
  if (loading) return;
  loading = true;
  try {
    const snapshot = await api('supervision');
    missionRows=snapshot.missions;historyManagement=!!snapshot.historyManagement;updateSelection();
    list.replaceChildren(element('h2', '', '督导任务'));
    if (!visibleMissions().length) list.append(element('p', '', showDeleted.checked?'没有已删除的督导任务。':'没有督导任务。'));
    for (const m of visibleMissions()) {
      const row=element('div','history-select-row'),check=element('input');check.type='checkbox';check.setAttribute('aria-label','选择督导任务：'+m.title);check.checked=picked.has(m.id);check.disabled=!historyManagement||!manageable(m);
      check.addEventListener('change',()=>{check.checked?picked.add(m.id):picked.delete(m.id);updateSelection();});
      row.append(check,button(m.title + ' · ' + labels[m.state], async () => {
      selected = m.id; detailKey = '';
    }, selected === m.id ? 'primary supervision-list-item' : 'secondary supervision-list-item'));list.append(row);
    }
    leaseList.replaceChildren(element('p', '', '占用按任务声明的文件范围判断。共用项目目录或存在其他活动聊天不会锁住整个项目；独立研究使用独立产物目录。不确定的实际占用仍保留，此保护不能禁止手动修改。'));
    if(!snapshot.leases.length)leaseList.append(element('p','','没有保留的文件占用。'));
    for (const lease of snapshot.leases) {
      const mission=snapshot.missions.find(row=>row.id===lease.owner);
      const box=element('section','supervision-check');
      box.append(element('h3','',mission?.title || '运行记录 '+(lease.runId || lease.owner)),
        element('p','',mission?labels[mission.state]+' · 文件保护仍保留':'文件保护仍保留'),
        element('p','','项目：'+lease.cwd),element('p','','保护范围：'+lease.paths.join('、')),
        element('p','','保留时间：'+new Intl.DateTimeFormat('zh-CN',{timeZone:'Asia/Shanghai',dateStyle:'medium',timeStyle:'short'}).format(new Date(lease.acquiredAt))));
      if(mission)box.append(button('查看来源任务',async()=>{selected=mission.id;detailKey='';}));
      box.append(button('核实并释放占用',async()=>{
        if(!await confirmAction('将核实“'+(mission?.title || lease.owner)+'”的原客户端会话已空闲，再释放 '+lease.paths.join('、')+' 的文件保护。旧督导将暂停，原结果与文件保留；等待此范围的新任务可能开始执行。',{title:'释放旧任务文件占用',accept:'核实并释放'}))return;
        await api('supervision/leases/'+lease.id+'/release','POST',{confirmedIdle:true,reason:'用户在文件占用管理中核实并释放历史任务保护，保留原始执行和验收记录。'});
        toast('原会话已核实为空闲，文件占用已释放。');
      }));leaseList.append(box);
    }
    if (selected) {
      const m = await api('supervision/missions/' + selected);
      if (force) detailKey = ''; await renderDetail(m);
    } else if (!detail.children.length) detail.append(element('p', '', '选择任务查看目标、验收和纠偏记录。'));
  } finally { loading = false; }
}
createButton.addEventListener('click', createForm);
window.addEventListener('open-file-leases',()=>{leasesBox.open=true;leasesBox.scrollIntoView({block:'start',behavior:'smooth'});});
const events = new EventSource('/api/events');
events.addEventListener('change', () => refresh().catch(e => toast(e.message, true)));
events.addEventListener('ready', () => refresh().catch(e => toast(e.message, true)));
void refresh().catch(e => toast(e.message, true));
