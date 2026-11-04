import { existsSync } from 'node:fs';
import { homedir } from 'node:os';
import path from 'node:path';
import { DesktopRpc } from './desktop.mjs';
import { discoverWindowsDesktop } from './desktop-discovery.mjs';
import { desktopTargets } from './desktop-cdp.mjs';
import { connectOrLaunch } from './desktop-launch.mjs';

const sleep = ms => new Promise(resolve => setTimeout(resolve, ms));
// Only DOM attributes exposed by the chat UI are used. No cookies or private API calls.
export function doubaoPage(action, text) {
  const one = id => document.querySelector(`[data-testid="${id}"]`);
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
  if (action === 'read') return { ready: !!input, href: location.href, draft, busy,
    canSend: !!send && !send.disabled && send.getAttribute('aria-disabled') !== 'true', messages };
  if (busy) throw new Error('豆包正在生成回复，请等待结束。');
  if (!input) throw new Error('豆包聊天界面不兼容或尚未登录。');
  if (action === 'new') {
    if (draft.trim()) throw new Error('豆包输入框有未发送的草稿，未覆盖。');
    const button = one('new_chat_button') || one('app-open-newChat') || one('create_conversation_button')?.querySelector('[role="button"]');
    if (!button) throw new Error('未找到豆包新建对话入口。');
    button.click(); return true;
  }
  if (action === 'fill') {
    if (messages.length || draft.trim()) throw new Error('豆包新对话不为空，已停止发送。');
    if (!(input instanceof HTMLTextAreaElement)) {
      if (input.getAttribute('contenteditable') !== 'true') throw new Error('豆包输入框版本不兼容。');
      input.focus();
      const range = document.createRange(); range.selectNodeContents(input);
      const selection = window.getSelection(); selection.removeAllRanges(); selection.addRange(range);
      return { rich: true };
    }
    Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype, 'value').set.call(input, text);
    input.dispatchEvent(new Event('input', { bubbles: true }));
    input.dispatchEvent(new Event('change', { bubbles: true }));
    return true;
  }
  if (action === 'send') {
    if (messages.length || draft !== text || !send || send.disabled || send.getAttribute('aria-disabled') === 'true') throw new Error('豆包发送前界面已变化或发送按钮不可用。');
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
    this.capabilities = { desktop: true, threads: false, resume: false, captureThread: false, watch: false, serial: true };
  }
  snapshot() { return { id: this.id, name: this.name, available: this.available, detail: this.detail, port: this.port, capabilities: this.capabilities, verification: this.verification }; }
  async page(action = 'read', text) {
    if (!this.rpc) throw new Error('豆包桌面连接已断开。');
    const result = await this.rpc.evaluate(`(${doubaoPage.toString()})(${JSON.stringify(action)},${JSON.stringify(text ?? '')})`);
    if (action === 'fill' && result?.rich) { await this.rpc.request('Input.insertText', { text }); return true; }
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
          this.port = tab.port; this.available = true; this.detail = '聊天界面已连接；支持定时或排队新建对话，模型沿用豆包设置';
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
  start(task, run, hooks = {}) {
    if (this.running) throw new Error('豆包界面正被另一项任务使用。');
    this.running = true;
    let interrupted = false, attempted = false;
    const completion = (async () => {
      try {
        if (!this.available) throw new Error(this.detail);
        if (run.threadId || task.threadMode && task.threadMode !== 'new') throw new Error('豆包目前仅支持新建对话。');
        if (task.model || task.effort) throw new Error('豆包模型沿用客户端设置，请清空模型与推理强度。');
        const deadline = (run.startedAt ?? this.clock()) + (task.timeoutMinutes || 120) * 60000;
        const check = () => { if (interrupted) throw new Error('已停止豆包监控；客户端中的生成请在豆包中处理。'); if (this.clock() >= deadline) throw new Error('豆包监控超时，未自动重发，请在客户端核实。'); };
        check();
        await this.page('new');
        let empty;
        for (let i = 0; i < 20; i++) { check(); empty = await this.page(); if (empty.ready && !empty.busy && !empty.messages.length && !empty.draft.trim()) break; await this.pause(250); }
        if (!empty?.ready || empty.busy || empty.messages.length || empty.draft.trim()) throw new Error('未确认豆包已打开空白新对话。');
        check(); await this.page('fill', run.prompt); await this.pause(150); check();
        attempted = true; // Persist ambiguity before the click, including transport loss.
        hooks.checkpoint?.({ phase: 'sending', deadline });
        await this.page('send', run.prompt);
        hooks.checkpoint?.({ phase: 'sent', deadline });
        hooks.log?.('system', '消息已发送到豆包新对话；项目路径仅用于面板归档，不授予文件访问权限。');
        let stable = 0, previous = '', href, missing = 0;
        while (true) {
          check(); await this.pause(1000); check();
          const current = await this.page();
          const users = current.messages.filter(m => m.role === 'user');
          if (users.length > 1 || users.length === 1 && users[0].text && users[0].text !== run.prompt.trim()) throw new Error('豆包对话插入了其他消息，结果需核实。');
          if (href && href !== current.href) {
            const native = value => value.replace(/^(?:doubao|chrome):\/\//, 'native://');
            const savedNativeChat = /^(?:doubao|chrome):\/\/doubao-chat\/chat\/local_\d+$/.test(href) && /^(?:doubao|chrome):\/\/doubao-chat\/chat\/\d+$/.test(current.href);
            if (native(href) !== native(current.href) && !savedNativeChat) throw new Error('豆包已切换对话，结果需核实。');
            href = current.href;
          }
          if (users.length === 1 && users[0].text === run.prompt.trim()) {
            href = current.href; missing = 0;
          }
          else if (href && ++missing > 10) throw new Error('豆包原消息持续不可见，结果需核实。');
          const last = current.messages.at(-1);
          const candidate = users.length === 1 && users[0].text === run.prompt.trim() && current.messages.length === 2 && last.role === 'assistant' && last.text && !last.streaming && !current.busy && current.ready && last.finished;
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
