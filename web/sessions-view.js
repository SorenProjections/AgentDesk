import { $, element, icon, api, toast, containDialogFocus } from './api.js';

const names = { codex: 'Codex', workbuddyDesktop: 'WorkBuddy', antigravityDesktop: 'Antigravity', workbuddy: 'WorkBuddy CLI', antigravity: 'Antigravity CLI' };
const labels = { running: '运行中', dispatching: '正在发送', waiting: '等你处理', completed: '已完成', failed: '失败', interrupted: '已停止', uncertain: '待核实', idle: '空闲' };
const active = new Set(['running', 'dispatching', 'waiting']);
const date = new Intl.DateTimeFormat('zh-CN', { timeZone: 'Asia/Shanghai', month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit', hour12: false });
const time = value => value && Number.isFinite(Number(value)) ? date.format(new Date(Number(value))) : '时间未知';
const folderName = path => path?.split(/[\\/]/).filter(Boolean).at(-1) || '未关联项目';
const needsAttention = session => session.needsAttention || session.disconnected && active.has(session.status);
const title = session => session.alias || session.name;

function button(text, action, className = 'quiet', symbol) {
  const node = element('button', className, text);
  node.type = 'button';
  if (symbol) node.prepend(icon(symbol));
  node.addEventListener('click', () => Promise.resolve().then(action).catch(error => toast(error.message, true)));
  return node;
}

function providerMark(provider) {
  const mark = element('span', 'provider-mark ' + provider, provider === 'codex' ? 'C' : provider.startsWith('antigravity') ? 'A' : 'W');
  mark.setAttribute('aria-hidden', 'true');
  return mark;
}

export class SessionsView {
  constructor({ refresh, openRun, navigate, continueSession }) {
    Object.assign(this, { refresh, openRun, navigate, continueSession });
    this.filter = 'active'; this.inboxFilter = 'all'; this.drafts = new Map();
    containDialogFocus($('sessionDetail'));
    $('sessionSearch').addEventListener('input', () => this.renderList());
    $('sessionProvider').addEventListener('change', () => this.renderList());
    document.querySelectorAll('[data-session-filter]').forEach(node => node.addEventListener('click', () => { this.filter = node.dataset.sessionFilter; this.renderList(); }));
    document.querySelectorAll('[data-inbox-filter]').forEach(node => node.addEventListener('click', () => { this.inboxFilter = node.dataset.inboxFilter; this.renderInbox(); }));
    $('syncSessions').addEventListener('click', async () => {
      const node = $('syncSessions'), label = node.querySelector('span');
      node.disabled = true; label.textContent = '同步中…';
      try { await api('sessions/sync', 'POST', {}, 120000); await refresh(); }
      catch (error) { toast(error.message, true); }
      finally { node.disabled = false; label.textContent = '同步会话'; }
    });
    for (const [id, minutes] of [['studyBreak', 25], ['restBreak', 60], ['endBreak', 0]]) $(id).addEventListener('click', () => this.configure({ quietMinutes: minutes }));
    $('desktopNotifications').addEventListener('change', () => this.configure({ desktopNotifications: $('desktopNotifications').checked }));
    $('readAllNotifications').addEventListener('click', () => this.read('all'));
    $('testNotification').addEventListener('click', async () => {
      try { await api('notifications/test', 'POST'); toast('系统已接收测试提醒；如果未看到弹窗，请检查 Windows 通知设置。'); }
      catch (error) { toast(error.message, true); }
    });
    $('sessionDetail').addEventListener('close', () => {
      const key = this.selected;
      this.selected = null; this.detailSignature = ''; this.renderList();
      if (!$('sessionsPage').hidden) {
        const row = [...$('sessionList').children].find(node => node.dataset.sessionKey === key);
        (row || $('sessionSearch')).focus({ preventScroll: true });
      }
    });
    $('sessionDetail').addEventListener('click', event => {
      if (event.target !== $('sessionDetail')) return;
      const rect = event.target.getBoundingClientRect();
      if (event.clientX < rect.left || event.clientX > rect.right || event.clientY < rect.top || event.clientY > rect.bottom) event.target.close();
    });
    document.addEventListener('keydown', event => {
      if (event.key !== '/' || event.ctrlKey || event.metaKey || event.altKey || $('sessionsPage').hidden || document.querySelector('dialog[open]')) return;
      if (event.target.closest('input, textarea, select, [contenteditable="true"]')) return;
      event.preventDefault(); $('sessionSearch').focus();
    });
  }

  async configure(input) {
    try { await api('sessions/settings', 'POST', input); await this.refresh(); }
    catch (error) { if (this.hub) $('desktopNotifications').checked = this.hub.settings.desktopNotifications; toast(error.message, true); }
  }
  async read(id) { try { await api(`notifications/${id}/read`, 'POST'); await this.refresh(); } catch (error) { toast(error.message, true); } }
  async update(key, input) { await api('sessions/' + encodeURIComponent(key), 'PUT', input); await this.refresh(); }

  render(hub) {
    if (!hub) return;
    this.hub = hub;
    const disconnected = hub.sources.filter(source => !source.available);
    const needs = hub.sessions.filter(session => !session.hidden && needsAttention(session));
    const connected = hub.sources.filter(source => source.available).length;
    $('sessionAssurance').textContent = needs.length ? `${needs.length} 个会话需要处理` : hub.sources.length && !connected ? '会话来源尚未连接' : hub.counts.running ? `${hub.counts.running} 个会话正在进行` : '当前没有进行中的会话';
    $('sessionAssuranceDetail').textContent = `${hub.counts.running} 个进行中，${hub.counts.unread} 条未读提醒。` + (disconnected.length ? `${disconnected.map(source => source.name).join('、')} 尚未连接。` : connected ? '已连接的来源正在持续同步。' : '正在连接会话来源。');
    document.querySelector('.session-presence').classList.toggle('needs-attention', !!needs.length);
    $('navSessions').hidden = !hub.counts.unread; $('navSessions').textContent = hub.counts.unread;
    this.renderSources();
    const quiet = hub.settings.quietUntil > Date.now();
    $('endBreak').hidden = !quiet; $('quietStatus').hidden = !quiet;
    $('quietLabel').textContent = quiet ? '安静时段已开启' : '留一段专注时间';
    $('quietDetail').textContent = quiet ? `系统弹窗暂缓至 ${time(hub.settings.quietUntil)}，结果仍会保存在收件箱。` : '暂缓系统弹窗，结果仍会保存在收件箱。';
    $('desktopNotifications').checked = hub.settings.desktopNotifications;
    $('notificationSettingState').textContent = hub.settings.desktopNotifications ? quiet ? '暂缓中' : '已开启' : '已关闭';
    $('syncSessions').title = hub.lastSyncAt ? '最近同步：' + time(hub.lastSyncAt) : '同步原生客户端会话';
    this.renderList(); this.renderInbox();
  }

  renderSources() {
    const signature = JSON.stringify(this.hub.sources);
    if (signature === this.sourceSignature) return;
    this.sourceSignature = signature;
    const container = $('sessionSources');
    const open = new Set([...container.querySelectorAll('details[open]')].map(node => node.dataset.source));
    container.replaceChildren();
    for (const source of this.hub.sources) {
      const node = element('details', 'session-source' + (source.available ? ' connected' : ''));
      node.dataset.source = source.id; node.open = open.has(source.id);
      const summary = element('summary'), copy = element('span', 'source-copy');
      copy.append(element('strong', '', names[source.id] || source.name), element('span', '', source.available ? `${source.count} 个会话已同步` : '连接待恢复'));
      summary.append(providerMark(source.id), copy, element('span', 'source-status', source.available ? '已连接' : '未连接'), icon('chevron'));
      node.append(summary, element('p', '', source.detail));
      const actions = element('div', 'source-actions');
      actions.append(button('仅查看此 Agent', () => { $('sessionProvider').value = source.id; this.filter = 'recent'; this.renderList(); }, 'text-button'));
      if (!source.available) actions.append(button('前往接入', () => this.navigate('agents'), 'text-button'));
      node.append(actions); container.append(node);
    }
  }

  matchesFilter(session, filter) {
    if (filter === 'hidden') return session.hidden;
    if (session.hidden) return false;
    return filter === 'recent' || filter === 'active' && active.has(session.status) || filter === 'attention' && needsAttention(session) || filter === 'pinned' && session.pinned;
  }

  renderList() {
    if (!this.hub) return;
    const search = $('sessionSearch').value.toLowerCase().trim(), provider = $('sessionProvider').value;
    const scoped = this.hub.sessions.filter(session => {
      if (provider !== 'all' && (provider === 'cli' ? !['workbuddy', 'antigravity'].includes(session.provider) : session.provider !== provider)) return false;
      return !search || [session.alias, session.name, session.cwd, session.note, session.nativeId, names[session.provider]].join(' ').toLowerCase().includes(search);
    });
    document.querySelectorAll('[data-session-filter]').forEach(node => {
      const selected = node.dataset.sessionFilter === this.filter;
      node.classList.toggle('selected', selected); node.setAttribute('aria-pressed', String(selected));
      node.querySelector('[data-session-count]').textContent = scoped.filter(session => this.matchesFilter(session, node.dataset.sessionFilter)).length;
    });
    const rows = scoped.filter(session => this.matchesFilter(session, this.filter)).sort((a, b) => Number(b.pinned) - Number(a.pinned) || (b.updatedAt || b.lastSeenAt) - (a.updatedAt || a.lastSeenAt));
    $('sessionCount').textContent = rows.length;
    const list = $('sessionList'), focused = list.contains(document.activeElement) ? document.activeElement.dataset.sessionKey : null;
    list.replaceChildren();
    if (!rows.length) {
      const filtered = !!search || provider !== 'all', box = element('div', 'session-empty');
      const mark = element('span', 'empty-mark'); mark.append(icon(filtered ? 'search' : 'message'));
      box.append(mark, element('h3', '', filtered ? '没有找到匹配的会话' : this.filter === 'active' ? '暂时没有进行中的会话' : this.filter === 'attention' ? '没有需要处理的会话' : this.filter === 'pinned' ? '还没有置顶会话' : this.filter === 'hidden' ? '没有收起的会话' : '还没有同步到会话'));
      box.append(element('p', '', filtered ? '试试其他关键词，或清除 Agent 筛选。' : this.filter === 'active' ? '在原客户端启动任务，进展会自动出现在这里。' : this.filter === 'pinned' ? '在会话详情中置顶，让重要的工作更容易找到。' : '可以查看最近会话，或同步原生客户端中的进展。'));
      box.append(button(filtered ? '清除筛选' : '查看最近会话', () => {
        if (filtered) { $('sessionSearch').value = ''; $('sessionProvider').value = 'all'; } else this.filter = 'recent';
        this.renderList();
      }, 'text-button'));
      list.append(box);
    }
    for (const session of rows) {
      const row = button('', () => { this.selected = session.key; this.renderList(); }, 'session-row' + (session.key === this.selected ? ' selected' : ''));
      row.dataset.sessionKey = session.key; row.setAttribute('aria-haspopup', 'dialog');
      const body = element('span', 'session-row-body'), heading = element('span', 'session-row-title');
      heading.append(element('strong', '', title(session)));
      if (session.pinned) { const pin = icon('pin'); pin.classList.add('pin-icon'); heading.append(pin); }
      const meta = element('span', 'session-row-meta'); meta.title = session.cwd || '未关联项目';
      meta.append(element('span', 'session-provider-name', names[session.provider] || session.provider), icon('folder'), element('span', 'session-folder', folderName(session.cwd)));
      const evidence = `${session.disconnected ? '连接中断，上次状态：' : !session.watched ? '未关注提醒：' : ''}${session.evidence || ''}`;
      const detail = element('span', 'session-row-evidence', evidence); detail.title = evidence;
      body.append(heading, meta, detail);
      const state = element('span', 'session-row-state');
      state.append(element('span', 'badge ' + (session.disconnected ? 'uncertain' : session.status), session.disconnected ? '未同步' : labels[session.status] || session.status), element('small', '', time(session.updatedAt || session.lastSeenAt)));
      row.append(providerMark(session.provider), body, state, icon('chevron')); list.append(row);
      if (session.key === focused) row.focus({ preventScroll: true });
    }
    this.renderDetail();
  }

  renderDetail() {
    const session = this.hub.sessions.find(item => item.key === this.selected), panel = $('sessionDetail');
    if (!session) { if (panel.open) panel.close(); return; }
    // Background snapshots must not replace a focused field or move its caret.
    const status = panel.querySelector('[data-detail-status]');
    if (status) { status.className = 'badge ' + (session.disconnected ? 'uncertain' : session.status); status.textContent = session.disconnected ? '未同步' : labels[session.status] || session.status; }
    const signature = JSON.stringify(session);
    if (panel.open && signature === this.detailSignature) return;
    if (panel.dataset.key === session.key && panel.contains(document.activeElement) && document.activeElement.matches('input, textarea')) return;
    const focusAction = panel.contains(document.activeElement) ? document.activeElement.dataset.action : null;
    this.detailSignature = signature; panel.dataset.key = session.key; panel.replaceChildren();
    const top = element('div', 'detail-topline'), origin = element('span', 'detail-origin');
    origin.append(providerMark(session.provider), document.createTextNode(names[session.provider] || session.provider));
    const close = button('', () => panel.close(), 'icon-button', 'close'); close.setAttribute('aria-label', '关闭会话详情'); close.autofocus = true;
    top.append(origin, close); panel.append(top);
    const heading = element('h2', '', title(session)); heading.id = 'sessionDetailTitle';
    const badge = element('span', 'badge ' + (session.disconnected ? 'uncertain' : session.status), session.disconnected ? '未同步' : labels[session.status] || session.status); badge.dataset.detailStatus = '';
    panel.append(heading, badge, element('p', 'detail-evidence', session.evidence || '暂无状态说明'));
    const facts = element('dl', 'session-facts');
    for (const [label, value] of [['项目文件夹', session.cwd || '未关联项目'], ['会话编号', session.nativeId || '等待创建']]) facts.append(element('dt', '', label), element('dd', '', value));
    panel.append(facts);
    const actions = element('div', 'session-actions');
    for (const [id, label, input, symbol] of [
      ['pin', session.pinned ? '取消置顶' : '置顶会话', { pinned: !session.pinned }, 'pin'],
      ['watch', session.watched ? '关闭此会话提醒' : '关注此会话提醒', { watched: !session.watched }, 'bell'],
      ['hide', session.hidden ? '恢复显示' : '收起会话', { hidden: !session.hidden }, null],
    ]) { const action = button(label, () => this.update(session.key, input), 'secondary', symbol); action.dataset.action = id; actions.append(action); }
    if (session.needsAttention && !active.has(session.status)) actions.append(button('已核实', () => this.update(session.key, { reviewed: true }), 'secondary', 'check'));
    panel.append(actions);
    const primaryActions = element('div', 'session-primary-actions');
    if (session.provider === 'codex' && session.nativeId) { const link = element('a', 'primary', '在 Codex 打开'); link.href = 'codex://threads/' + encodeURIComponent(session.nativeId); primaryActions.append(link); }
    if (session.runId) primaryActions.append(button('查看执行记录', () => { panel.close(); this.openRun(session.runId); }, 'secondary'));
    if (session.nativeId && session.cwd && !active.has(session.status) && !session.disconnected && session.status !== 'uncertain' && !session.readOnly) primaryActions.append(button('安排接续消息', () => { panel.close(); return this.continueSession(session); }, 'secondary', 'plus'));
    if (primaryActions.childElementCount) panel.append(primaryActions);
    if (session.provider !== 'codex') panel.append(element('p', 'field-help', '权限请求和追问请在原客户端处理，可用会话编号查找此对话。'));
    if (session.readOnly) panel.append(element('p', 'field-help', '当前通过原生记录观察。启用桌面桥后，可安排接续消息。'));
    const form = element('form', 'session-notes'), alias = element('input'), note = element('textarea');
    alias.id = 'sessionAlias'; alias.value = this.drafts.get(session.key)?.alias ?? session.alias ?? ''; alias.maxLength = 100; alias.placeholder = session.name;
    note.id = 'sessionNote'; note.value = this.drafts.get(session.key)?.note ?? session.note ?? ''; note.maxLength = 2000; note.rows = 3; note.placeholder = '记下待查看的结果，或下一步计划…';
    for (const input of [alias, note]) input.addEventListener('input', () => this.drafts.set(session.key, { alias: alias.value, note: note.value }));
    form.append(element('h3', '', '名称与备注'));
    for (const [text, input] of [['工作台名称', alias], ['备注', note]]) { const label = element('label', '', text); label.htmlFor = input.id; form.append(label, input); }
    const save = element('button', 'primary', '保存名称与备注'); save.type = 'submit'; form.append(save);
    form.addEventListener('submit', async event => {
      event.preventDefault();
      const submitted = { alias: alias.value, note: note.value }; save.disabled = true;
      try { await this.update(session.key, submitted); if (JSON.stringify(this.drafts.get(session.key)) === JSON.stringify(submitted)) this.drafts.delete(session.key); toast('会话备注已保存'); }
      catch (error) { toast(error.message, true); }
      finally { save.disabled = false; }
    });
    panel.append(form, element('p', 'field-help', '名称与备注仅保存在本工作台。收起会话后仍会提醒，取消关注后关闭提醒。'));
    if (session.output) { const output = element('details', 'session-output'); output.append(element('summary', '', '最近完成回复'), element('pre', '', session.output)); panel.append(output); }
    if (!panel.open) panel.showModal();
    else if (focusAction) panel.querySelector(`[data-action="${focusAction}"]`)?.focus({ preventScroll: true });
  }

  renderInbox() {
    if (!this.hub) return;
    const unread = this.hub.counts.unread;
    $('unreadNotifications').textContent = unread; $('readAllNotifications').disabled = !unread;
    document.querySelectorAll('[data-inbox-filter]').forEach(node => { const selected = node.dataset.inboxFilter === this.inboxFilter; node.classList.toggle('selected', selected); node.setAttribute('aria-pressed', String(selected)); });
    const list = $('notificationList'), scrollTop = list.scrollTop;
    list.replaceChildren();
    const items = this.hub.notifications.filter(note => this.inboxFilter !== 'unread' || !note.readAt);
    if (!items.length) {
      const empty = element('div', 'inbox-empty'); empty.append(icon('check'), element('strong', '', this.inboxFilter === 'unread' ? '未读提醒已清空' : '还没有新的提醒'), element('p', '', '任务完成或需要处理时，会显示在这里。')); list.append(empty);
    }
    for (const notification of items) {
      const row = element('article', 'notification-item' + (notification.readAt ? ' read' : ' unread'));
      const meta = element('div', 'notification-meta'); meta.append(element('span', '', names[notification.provider] || notification.provider), element('time', '', time(notification.at)));
      row.append(meta, element('strong', '', notification.title));
      if (notification.detail) row.append(element('p', '', notification.detail));
      if (notification.delivery === 'failed') row.append(element('p', 'notification-failure', '系统弹窗未送达，提醒已保留。' + (notification.deliveryError || '')));
      const actions = element('div', 'notification-actions');
      actions.append(button('查看会话', () => { this.navigate('sessions'); this.selected = notification.sessionKey; this.renderList(); return this.read(notification.id); }, 'text-button'));
      if (!notification.readAt) actions.append(button('标为已读', () => this.read(notification.id), 'text-button'));
      row.append(actions); list.append(row);
    }
    list.scrollTop = scrollTop;
  }
}
