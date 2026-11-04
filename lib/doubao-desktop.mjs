import { existsSync } from 'node:fs';
import { homedir } from 'node:os';
import path from 'node:path';
import { createHash } from 'node:crypto';
import { DesktopRpc } from './desktop.mjs';
import { discoverWindowsDesktop } from './desktop-discovery.mjs';
import { desktopTargets } from './desktop-cdp.mjs';
import { connectOrLaunch } from './desktop-launch.mjs';

const sleep = ms => new Promise(resolve => setTimeout(resolve, ms));
// Only DOM attributes exposed by the chat UI are used. No cookies or private API calls.
export function doubaoPage(action, text) {
  const one = id => document.querySelector(`[data-testid="${id}"]`);
  const chatRows = () => [...document.querySelectorAll('[data-conversation-id]')];
  const projectRows = () => [...document.querySelectorAll('section[data-project-id]')];
  const idFromUrl = value => {
    try {
      const url = new URL(value);
      if (!((['doubao:', 'chrome:'].includes(url.protocol) && url.hostname === 'doubao-chat') || (url.protocol === 'https:' && /^(www\.)?doubao\.com$/.test(url.hostname)))) return null;
      const id = url.pathname.match(/^\/chat\/([a-zA-Z0-9_-]+)\/?$/)?.[1];
      return id && !id.startsWith('local_') ? id : null;
    } catch { return null; }
  };
  const identity = () => {
    const active = chatRows().find(row => row.getAttribute('data-conversation-active') === 'true' || row.getAttribute('aria-current') === 'page' || row.classList.contains('e2e-test-active'));
    const transient = /\/chat(?:\/?|\/local_\d+)(?:[?#].*)?$/.test(location.href);
    const id = idFromUrl(location.href) || (!transient && active?.getAttribute('data-conversation-id')) || null;
    const row = chatRows().find(row => row.getAttribute('data-conversation-id') === id);
    return { threadId: id, projectId: row?.closest('[data-project-id]')?.getAttribute('data-project-id') || null };
  };
  if (action === 'catalog') {
    const projects = projectRows().map(row => ({id:row.getAttribute('data-project-id'),name:row.querySelector('button[aria-expanded] [title]')?.getAttribute('title') || row.querySelector('button[aria-expanded]')?.innerText?.trim().split('\n')[0] || row.getAttribute('data-project-id')}));
    const rows = new Map();
    for (const row of chatRows()) {
      const id = row.getAttribute('data-conversation-id');
      if (!id || !/^[a-zA-Z0-9_-]{1,120}$/.test(id) || id.startsWith('local_')) continue;
      const projectId = row.closest('[data-project-id]')?.getAttribute('data-project-id') || null;
      rows.set(id, {id,name:row.querySelector('[data-testid="chat_list_item_title"]')?.innerText?.trim() || row.querySelector('span[title]')?.getAttribute('title') || row.innerText?.trim().split('\n')[0] || id,projectId});
    }
    const current = identity();
    if (current.threadId && !rows.has(current.threadId)) rows.set(current.threadId,{id:current.threadId,name:document.title || current.threadId,projectId:current.projectId});
    return {projects,threads:[...rows.values()],current};
  }
  const container = one('chat_input_input');
  const input = container?.matches('textarea, [contenteditable="true"]') ? container : container?.querySelector('textarea, [contenteditable="true"]');
  const send = one('chat_input_send_button');
  const messages = [...document.querySelectorAll('[data-testid="message_content"]')].map(el => {
    const content = el.querySelector('[data-testid="message_text_content"]');
    const row = el.closest('[data-message-role]') || el;
    return { id: el.getAttribute('data-message-id') || '', role: row.getAttribute('data-message-role') || (el.classList.contains('justify-end') ? 'user' : 'assistant'),
      text: content?.innerText?.trim() || '',
      finished: !!row.querySelector('[data-testid="message_action_copy"]'),
      streaming: !!el.querySelector('[data-testid="indicator"], [data-show-indicator="true"]') };
  });
  const busy = !!document.querySelector('[data-testid="stop_generate"], [data-testid="indicator"], [data-show-indicator="true"]');
  const draft = input?.value ?? input?.innerText ?? input?.textContent ?? '';
  if (action === 'read') return { ready: !!input, href: location.href, ...identity(), draft, busy,
    canSend: !!send && !send.disabled && send.getAttribute('aria-disabled') !== 'true', messages };
  if (busy) throw new Error('豆包正在生成回复，请等待结束。');
  if (!input) throw new Error('豆包聊天界面不兼容或尚未登录。');
  if (action === 'open') {
    if (draft.trim()) throw new Error('豆包输入框有未发送的草稿，未切换对话。');
    if (identity().threadId === text.id) return true;
    const row = chatRows().find(row => row.getAttribute('data-conversation-id') === text.id);
    if (!row) throw new Error('目标豆包对话未加载，请先在豆包侧栏展开项目或打开该对话，再刷新列表。');
    if (text.projectId && row.closest('[data-project-id]')?.getAttribute('data-project-id') !== text.projectId) throw new Error('豆包对话已不在所选项目中，未发送。');
    row.click(); return true;
  }
  if (action === 'new') {
    if (draft.trim()) throw new Error('豆包输入框有未发送的草稿，未覆盖。');
    let button;
    if (text?.projectId) {
      const project = projectRows().find(row => row.getAttribute('data-project-id') === text.projectId);
      if (!project) throw new Error('豆包项目未加载或已移除，请在客户端展开项目后刷新。');
      button = [...project.querySelectorAll('button[aria-label]')].find(el => /^(新对话|新建对话|New chat)$/i.test(el.getAttribute('aria-label')));
      if (!button) throw new Error('当前豆包版本未提供可识别的项目新建对话按钮，未发送。');
    } else button = one('new_chat_button') || one('app-open-newChat') || one('new-conversation-button') || one('create_conversation_button')?.querySelector('[role="button"]');
    if (!button) throw new Error('未找到豆包新建对话入口。');
    button.click(); return true;
  }
  if (action === 'fill') {
    const prompt = typeof text === 'string' ? text : text.prompt;
    if (draft.trim()) throw new Error('豆包输入框有未发送的草稿，已停止发送。');
    if (typeof text === 'string' ? messages.length : JSON.stringify(messages) !== text.baseline || text.threadId && identity().threadId !== text.threadId) throw new Error('豆包发送前对话已变化，已停止发送。');
    if (!(input instanceof HTMLTextAreaElement)) {
      if (input.getAttribute('contenteditable') !== 'true') throw new Error('豆包输入框版本不兼容。');
      input.focus();
      const range = document.createRange(); range.selectNodeContents(input);
      const selection = window.getSelection(); selection.removeAllRanges(); selection.addRange(range);
      return { rich: true, text: prompt };
    }
    Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype, 'value').set.call(input, prompt);
    input.dispatchEvent(new Event('input', { bubbles: true }));
    input.dispatchEvent(new Event('change', { bubbles: true }));
    return true;
  }
  if (action === 'send') {
    const prompt = typeof text === 'string' ? text : text.prompt;
    const changed = typeof text === 'string' ? messages.length : JSON.stringify(messages) !== text.baseline || text.threadId && identity().threadId !== text.threadId;
    if (changed || draft !== prompt || !send || send.disabled || send.getAttribute('aria-disabled') === 'true') throw new Error('豆包发送前界面已变化或发送按钮不可用。');
    send.click(); return true;
  }
  throw new Error('不支持的豆包界面操作。');
}

export async function discoverDoubao() {
  const found = await discoverWindowsDesktop();
  const processes = found.processes.filter(p => p.name.toLowerCase() === 'doubao.exe');
  const owned = new Set(processes.map(p => p.pid));
  return { processes, ports: found.ports.filter(p => owned.has(p.pid)) };
}

export class DoubaoDesktop {
  constructor({ port = 9338, discovery = discoverDoubao, fetcher = fetch, connect = DesktopRpc.connect, pause = sleep, clock = Date.now } = {}) {
    this.id = 'doubaoDesktop'; this.name = '豆包桌面端';
    Object.assign(this, { port, discovery, fetcher, connect, pause, clock });
    this.available = false; this.detail = '等待检测豆包桌面连接'; this.verification = null;
    this.capabilities = { desktop: true, threads: true, resume: true, captureThread: true, projects: true, watch: false, serial: true, localFiles: false };
  }
  snapshot() { return { id: this.id, name: this.name, available: this.available, detail: this.detail, port: this.port, capabilities: this.capabilities, verification: this.verification }; }
  async page(action = 'read', text) {
    if (!this.rpc) throw new Error('豆包桌面连接已断开。');
    const result = await this.rpc.evaluate(`(${doubaoPage.toString()})(${JSON.stringify(action)},${JSON.stringify(text ?? '')})`);
    if (action === 'fill' && result?.rich) { await this.rpc.request('Input.insertText', { text: result.text }); return true; }
    return result;
  }
  async probe(found) {
    if (this.running) throw new Error('豆包任务运行中，请稍后检测连接。');
    if (this.rpc && !found) {
      try { if ((await this.page()).ready) { this.available = true; return this.snapshot(); } } catch {}
    }
    this.close();
    try {
      found ||= await this.discovery();
      const tabs = await desktopTargets(found, 'Doubao.exe', this.port, this.fetcher);
      if (!tabs.length) throw new Error(found.processes.some(p => p.name.toLowerCase() === 'doubao.exe') ? '豆包已运行，但未开放调试接口。保存对话并完全退出一次，再使用带连接参数的快捷方式或「打开并连接」。' : '豆包尚未运行，点击「打开并连接」。');
      // Require a chat document as well as the owned local port; never attach to arbitrary tabs.
      for (const tab of tabs.filter(t => /^https:\/\/(?:www\.)?doubao\.com\/|^(?:doubao|chrome):\/\/doubao-chat\/chat(?:[/?#]|$)/i.test(t.url || ''))) {
        let rpc;
        try {
          rpc = await this.connect(tab.webSocketDebuggerUrl, tab.port);
          this.rpc = rpc;
          if (!(await this.page()).ready) { this.rpc = null; rpc.close(); continue; }
          rpc.onclosed = () => { if (this.rpc === rpc) { this.rpc = null; this.available = false; this.detail = '豆包桌面连接中断，请重新检测。'; } };
          this.port = tab.port; this.available = true; this.detail = '聊天界面已连接；支持新建、续聊及豆包项目，模型与项目权限沿用客户端设置';
          return this.snapshot();
        } catch { this.rpc = null; rpc?.close(); }
      }
      throw new Error('未找到兼容的豆包聊天页面，请打开已登录的豆包主聊天界面后重新检测。');
    } catch (error) { this.detail = error.message; this.close(); }
    return this.snapshot();
  }
  async launch(onProgress) {
    const local = process.env.LOCALAPPDATA || path.join(homedir(), 'AppData', 'Local');
    const binary = [process.env.DOUBAO_DESKTOP_BINARY, path.join(local, 'Doubao', 'application', 'app', 'Doubao.exe'), path.join(local, 'Doubao', 'application', 'Doubao.exe')].find(x => x && path.isAbsolute(x) && existsSync(x));
    return connectOrLaunch(this, { name: 'Doubao.exe', binary, onProgress });
  }
  async catalog() {
    if (!this.available) throw new Error(this.detail);
    const data = await this.page('catalog');
    return { projects: data.projects || [], threads: (data.threads || []).map(row => ({...row,cwd:'',status:'idle'})) };
  }
  async listProjects() { return (await this.catalog()).projects; }
  async listThreads() { return (await this.catalog()).threads; }
  async listSessions() {
    const catalog = await this.catalog(), current = await this.page();
    const lastUser = current.messages?.filter(row => row.role === 'user').at(-1);
    const version = lastUser ? lastUser.id || createHash('sha256').update(lastUser.text || '').digest('hex') : '';
    return catalog.threads.map(row => ({...row,nativeProjectId:row.projectId,nativeProjectName:catalog.projects.find(project => project.id === row.projectId)?.name || '',
      status:row.id === current.threadId && current.busy ? 'running' : 'idle',version:row.id === current.threadId ? version : '',readOnly:false,
      evidence:row.id === current.threadId ? '豆包当前聊天界面；空闲不等同于任务验收完成' : '豆包侧栏已加载的对话；未推断后台运行状态'}));
  }
  async inspect(id) {
    const catalog = await this.catalog();
    const row = catalog.threads.find(row => row.id === id);
    if (!row) throw new Error('目标豆包对话未加载，请先在客户端打开或展开所属项目后刷新。');
    const current = await this.page();
    return {...row,status:current.threadId === id && current.busy ? 'running' : 'idle'};
  }
  start(task, run, hooks = {}) {
    if (this.running) throw new Error('豆包界面正被另一项任务使用。');
    this.running = true;
    let interrupted = false, attempted = false;
    const completion = (async () => {
      try {
        if (!this.available) throw new Error(this.detail);
        const targetId = run.threadId || task.threadId;
        if (task.threadMode === 'existing' && !targetId) throw new Error('请选择豆包已有对话。');
        if (task.model || task.effort) throw new Error('豆包模型沿用客户端设置，请清空模型与推理强度。');
        const deadline = (run.startedAt ?? this.clock()) + (task.timeoutMinutes || 120) * 60000;
        const check = () => { if (interrupted) throw new Error('已停止豆包监控；客户端中的生成请在豆包中处理。'); if (this.clock() >= deadline) throw new Error('豆包监控超时，未自动重发，请在客户端核实。'); };
        check();
        if (targetId) await this.page('open', {id:targetId,projectId:task.nativeProjectId || null});
        else await this.page('new', {projectId:task.nativeProjectId || null});
        let before;
        for (let i = 0; i < 20; i++) {
          check(); before = await this.page();
          if (before.ready && !before.busy && !before.draft.trim() && (targetId ? before.threadId === targetId : !before.messages.length)) break;
          await this.pause(250);
        }
        if (!before?.ready || before.busy || before.draft.trim() || (targetId ? before.threadId !== targetId : before.messages.length)) throw new Error('未确认豆包已打开所选对话且输入框空闲，未发送。');
        if (task.nativeProjectId && targetId && before.projectId !== task.nativeProjectId) throw new Error('豆包对话与所选项目不一致，未发送。');
        const baseline = before.messages;
        const payload = {prompt:run.prompt,baseline:JSON.stringify(baseline),threadId:targetId || null};
        check(); await this.page('fill', payload); await this.pause(150); check();
        attempted = true; // Persist ambiguity before the click, including transport loss.
        hooks.checkpoint?.({ phase: 'sending', deadline });
        await this.page('send', payload);
        hooks.checkpoint?.({ phase: 'sent', deadline });
        hooks.log?.('system', `消息已发送到豆包${targetId ? '已有' : '新'}对话${task.nativeProjectId ? '（所选豆包项目）' : ''}；使用客户端现有项目资料与权限，不映射本地工作目录。`);
        let stable = 0, previous = '', href = targetId ? before.href : null, missing = 0, capturedId = targetId || null;
        while (true) {
          check(); await this.pause(1000); check();
          const current = await this.page();
          if (targetId && current.threadId && current.threadId !== targetId) throw new Error('豆包已切换到其他对话，结果需核实。');
          if (JSON.stringify(current.messages.slice(0,baseline.length)) !== JSON.stringify(baseline)) throw new Error('豆包原对话内容已变化，结果需核实。');
          const added = current.messages.slice(baseline.length);
          const users = added.filter(m => m.role === 'user');
          if (users.length > 1 || users.length === 1 && users[0].text && users[0].text !== run.prompt.trim()) throw new Error('豆包对话插入了其他消息，结果需核实。');
          if (href && href !== current.href) {
            const native = value => value.replace(/^(?:doubao|chrome):\/\//, 'native://');
            const savedNativeChat = /^(?:doubao|chrome):\/\/doubao-chat\/chat\/local_\d+$/.test(href) && /^(?:doubao|chrome):\/\/doubao-chat\/chat\/\d+$/.test(current.href);
            if (native(href) !== native(current.href) && !savedNativeChat) throw new Error('豆包已切换对话，结果需核实。');
            href = current.href;
          }
          if (users.length === 1 && users[0].text === run.prompt.trim()) {
            href = current.href; missing = 0;
            if (current.threadId && current.threadId !== capturedId) {
              if (capturedId) throw new Error('豆包目标对话编号已变化，结果需核实。');
              capturedId = current.threadId;
              hooks.thread?.(capturedId);
            }
          }
          else if (href && ++missing > 10) throw new Error('豆包原消息持续不可见，结果需核实。');
          const last = current.messages.at(-1);
          if (task.nativeProjectId && current.projectId && current.projectId !== task.nativeProjectId) throw new Error('豆包消息不在所选项目中，结果需核实。');
          const candidate = (!task.nativeProjectId || current.projectId === task.nativeProjectId) && users.length === 1 && users[0].text === run.prompt.trim() && added.length === 2 && last.role === 'assistant' && last.text && !last.streaming && !current.busy && current.ready && last.finished;
          stable = candidate && last.text === previous ? stable + 1 : 0;
          previous = candidate ? last.text : '';
          // Require the exact new user message and a finished, stable assistant message.
          if (stable >= 3) { hooks.output?.(last.text); return { status: 'completed' }; }
        }
      } catch (error) { return { status: attempted ? 'uncertain' : interrupted ? 'interrupted' : 'failed', error: error.message }; }
      finally { this.running = false; }
    })();
    return { completion, interrupt: async () => { interrupted = true; } };
  }
  async verify() {
    let output = '';
    const result = await this.start({ threadMode: 'new', timeoutMinutes: 1 }, { prompt: 'Reply with exactly AGENT_CONNECTION_OK.' }, { output: text => { output = text; } }).completion;
    const verified = result.status === 'completed' && output.trim() === 'AGENT_CONNECTION_OK';
    this.verification = { at: this.clock(), status: verified ? 'verified' : 'failed', error: verified ? '' : result.error || '未收到预期测试回复。' };
    return this.snapshot();
  }
  close() { const rpc = this.rpc; this.rpc = null; this.available = false; rpc?.close(); }
}
