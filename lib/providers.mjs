import { spawn, execFile } from 'node:child_process';
import { existsSync } from 'node:fs';
import { homedir } from 'node:os';
import path from 'node:path';
import { StringDecoder } from 'node:string_decoder';

export const providerNames = { antigravity: 'Antigravity CLI', workbuddy: 'WorkBuddy CLI' };
const redact = text => String(text).replace(/(Bearer\s+)[^\s"']+/gi, '$1[redacted]').replace(/\bsk-[\w-]{12,}/g, '[redacted]');

export function findAgent(id, configured = '') {
  const local = process.env.LOCALAPPDATA || path.join(homedir(), 'AppData', 'Local');
  const suffix = process.platform === 'win32' ? '.exe' : '';
  const candidates = id === 'antigravity'
    ? [process.env.ANTIGRAVITY_SCHEDULER_BINARY, path.join(local, 'agy', 'bin', 'agy' + suffix), path.join(homedir(), '.local', 'bin', 'agy')]
    : [process.env.WORKBUDDY_SCHEDULER_BINARY, ...[path.join(local, 'Programs', 'WorkBuddy'), path.join(local, 'WorkBuddy'), 'E:\\workbuddy', 'D:\\workbuddy', 'C:\\workbuddy'].map(root => path.join(root, 'resources', 'app.asar.unpacked', 'cli', 'dist', 'codebuddy-headless.js'))];
  const binary = configured || candidates.find(file => file && existsSync(file));
  if (binary) {
    if (!path.isAbsolute(binary) || !existsSync(binary)) throw new Error('配置的程序路径不存在，请选择完整路径。');
    if (/\.(?:c?js|mjs)$/i.test(binary)) return { command: process.execPath, args: [binary], location: binary };
    if (/\.(?:cmd|bat|ps1)$/i.test(binary)) throw new Error('请选择 .exe 或 CLI 的 .js/.mjs 入口，不使用 shell 脚本。');
    return { command: binary, args: [], location: binary };
  }
  return { command: id === 'antigravity' ? 'agy' : 'workbuddy', args: [], location: '' };
}

function environment(id) {
  if (id !== 'workbuddy') return process.env;
  return { ...process.env, CODEBUDDY_CONFIG_DIR: process.env.WORKBUDDY_CONFIG_DIR || path.join(homedir(), '.workbuddy') };
}

export function commandFor(id, capabilities, task, run) {
  const args = [];
  let input;
  if (id === 'antigravity') {
    if (capabilities.streamInput) {
      args.push('--input-format', 'stream-json', '--output-format', 'stream-json');
      input = JSON.stringify({ event: 'user', message: { content: run.prompt } }) + '\n';
    } else {
      if (run.prompt.length > 12000) throw new Error('当前 Antigravity CLI 使用命令行传入消息，最多 12000 字；支持流式输入的版本可发送更长消息。');
      args.push('-p', run.prompt);
      if (capabilities.structured) args.push('--output-format', 'stream-json');
    }
    if (run.threadId) args.push('--conversation', run.threadId);
    if (capabilities.printTimeout) args.push('--print-timeout', `${task.timeoutMinutes || 120}m`);
  } else {
    args.push('--print', '--input-format', 'stream-json', '--output-format', 'stream-json', '--verbose');
    input = JSON.stringify({ type: 'user', message: { role: 'user', content: run.prompt } }) + '\n';
    if (run.threadId) args.push('--resume', run.threadId);
    if (capabilities.dontAsk) args.push('--permission-mode', 'dontAsk');
  }
  if (task.model) {
    if (!capabilities.model) throw new Error('当前 CLI 不支持单独指定模型，请清空模型设置后再运行。');
    args.push('--model', task.model);
  }
  if (task.effort) {
    if (!capabilities.effort) throw new Error('当前 CLI 不支持单独指定推理强度，请清空推理设置。');
    args.push('--effort', task.effort);
  }
  return { args, input };
}

// Normalize actual CLI terminal events; transport EOF alone is not a success signal.
export function parseAgentEvent(id, value) {
  if (id === 'antigravity') {
    const result = value.event === 'result' ? value.result : null;
    const step = value.step_update;
    return {
      threadId: value.conversation_id || result?.conversation_id || step?.conversation_id,
      delta: step?.step_type === 'agent_response' ? step.text_delta : '',
      final: result ? { status: result.status === 'SUCCESS' ? 'completed' : ['CANCELED', 'INTERRUPTED'].includes(result.status) ? 'interrupted' : 'failed', output: result.response || '', error: result.error || '' } : null,
    };
  }
  const denied = Array.isArray(value.permission_denials) && value.permission_denials.length > 0;
  const final = value.type === 'result' ? {
    status: value.is_error || denied || (value.subtype && value.subtype !== 'success') ? 'failed' : 'completed',
    output: value.result || value.response || '',
    error: denied ? '部分操作因权限不足未执行，请检查结果和 WorkBuddy 权限设置。' : (value.errors?.join?.('\n') || (value.is_error ? value.result || 'Agent 返回执行错误。' : '')),
  } : null;
  return {
    threadId: value.session_id,
    delta: value.type === 'assistant' ? (value.message?.content || []).filter(block => block.type === 'text').map(block => block.text).join('\n') : '',
    final,
  };
}

export class CommandProvider {
  constructor(id, { binary = '', cwd = process.cwd(), spawnProcess = spawn, verification = null } = {}) {
    this.id = id;
    this.name = providerNames[id];
    this.configured = binary;
    this.cwd = cwd;
    this.spawnProcess = spawnProcess;
    this.available = false;
    this.detail = '正在检测本机接口';
    this.capabilities = { threads: false, resume: true, captureThread: false };
    this.verification = verification;
  }

  snapshot() {
    return { id: this.id, name: this.name, available: this.available, detail: this.detail, binary: this.binary?.location || this.configured, capabilities: this.capabilities, verification: this.verification };
  }

  async verify() {
    let output = '';
    const handle = this.start({ cwd: this.cwd, timeoutMinutes: 1 }, { prompt: 'Reply with exactly AGENT_CONNECTION_OK. Do not use tools, read files, or make changes.' }, { log() {}, thread() {}, output: text => { output = text; } });
    const result = await handle.completion;
    this.verification = { at: Date.now(), status: result.status === 'completed' && output.trim() === 'AGENT_CONNECTION_OK' ? 'verified' : 'failed', error: result.error || (output.trim() === 'AGENT_CONNECTION_OK' ? '' : 'Agent 未返回预期的测试回复。') };
    return this.snapshot();
  }

  async probe(configured = this.configured) {
    this.configured = configured;
    try {
      this.binary = findAgent(this.id, configured);
      const help = await new Promise((resolve, reject) => execFile(this.binary.command, [...this.binary.args, '--help'], { cwd: this.cwd, windowsHide: true, timeout: 15000, maxBuffer: 512000, env: environment(this.id) }, (error, out, err) => error ? reject(error) : resolve(out + err)));
      if (!help.includes('--print')) throw new Error('这个程序没有提供可用于调度的非交互接口。');
      const structured = help.includes('--output-format');
      this.capabilities = { threads: false, resume: help.includes(this.id === 'antigravity' ? '--conversation' : '--resume'), captureThread: structured, structured, streamInput: help.includes('--input-format'), printTimeout: help.includes('--print-timeout'), model: /--model\b/.test(help), effort: /--effort\b/.test(help), dontAsk: help.includes('dontAsk') };
      if (this.id === 'workbuddy' && (!structured || !this.capabilities.streamInput)) throw new Error('此 WorkBuddy 内核不支持所需的流式接口。');
      this.available = true;
      this.detail = structured ? '本机 CLI 可用；账号状态在运行时验证' : '本机 CLI 提供文本输出；新建对话暂不返回编号，已有对话可填写编号';
    } catch (error) {
      this.available = false;
      this.detail = error.code === 'ENOENT' ? '未找到自动化入口，请设置 CLI 路径' : redact(error.message).slice(0, 800);
    }
    return this.snapshot();
  }

  start(task, run, hooks) {
    if (!this.available) throw new Error(this.name + ' 尚不可用：' + this.detail);
    const { args, input } = commandFor(this.id, this.capabilities, task, run);
    const proc = this.spawnProcess(this.binary.command, [...this.binary.args, ...args], { cwd: task.cwd, env: environment(this.id), windowsHide: true, stdio: ['pipe', 'pipe', 'pipe'], shell: false });
    let final = null, output = '', errors = '', buffer = '', interrupted = false, timedOut = false, settled = false, drainTimer;
    const decoder = new StringDecoder('utf8');
    const errDecoder = new StringDecoder('utf8');
    let settle;
    const completion = new Promise(resolve => { settle = resolve; });
    const kill = async () => {
      if (settled) return;
      if (proc.exitCode !== null) { proc.stdout.destroy(); proc.stderr.destroy(); return; }
      if (process.platform === 'win32' && proc.pid) await new Promise((resolve, reject) => execFile('taskkill.exe', ['/PID', String(proc.pid), '/T', '/F'], { windowsHide: true }, error => error && !settled ? reject(error) : resolve()));
      else proc.kill('SIGTERM');
    };
    const timer = setTimeout(() => { timedOut = true; void kill().catch(error => { hooks.log('error', redact(error.message)); finish({ status: 'uncertain', error: '运行已超时，但无法确认子进程已停止，请检查 Agent。' }); }); }, (task.timeoutMinutes || 120) * 60000);
    const finish = result => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      clearTimeout(drainTimer);
      settle(result);
    };
    const line = text => {
      if (!text.trim()) return;
      try {
        const event = parseAgentEvent(this.id, JSON.parse(text));
        if (event.threadId && /^[a-zA-Z0-9][a-zA-Z0-9_:-]{0,119}$/.test(event.threadId)) hooks.thread(event.threadId);
        if (event.delta) hooks.log('delta', event.delta);
        if (event.final) { final = event.final; hooks.output(final.output); }
      } catch { hooks.log('system', redact(text).slice(0, 2000)); }
    };
    proc.stdout.on('data', chunk => {
      const text = decoder.write(chunk);
      if (!this.capabilities.structured) { output = (output + text).slice(-1000000); hooks.log('delta', text); return; }
      buffer += text;
      let index;
      while ((index = buffer.indexOf('\n')) >= 0) { line(buffer.slice(0, index)); buffer = buffer.slice(index + 1); }
      if (buffer.length > 4000000) { buffer = ''; hooks.log('error', 'CLI 返回了过长的事件，已忽略；请检查最终结果。'); }
    });
    proc.stderr.on('data', chunk => { const text = redact(errDecoder.write(chunk)); errors = (errors + text).slice(-16000); hooks.log('system', text); });
    proc.stdin.on('error', error => { hooks.log('error', redact(error.message)); });
    proc.on('error', error => finish({ status: 'failed', error: redact(error.message) }));
    proc.on('exit', () => {
      // Some CLIs spawn persistent helpers inheriting stdout. Do not wait forever for their pipes.
      drainTimer = setTimeout(() => { proc.stdout.destroy(); proc.stderr.destroy(); }, 2000);
      drainTimer.unref();
    });
    proc.on('close', code => {
      buffer += decoder.end();
      if (this.capabilities.structured && buffer) line(buffer);
      if (!this.capabilities.structured) hooks.output(output);
      if (timedOut) return finish({ status: 'uncertain', error: '已达到最长运行时间并停止进程，请核实已执行的操作；不会自动重发。' });
      if (interrupted) return finish({ status: 'interrupted', error: '已停止 CLI 及其子进程。' });
      if (code !== 0) return finish({ status: 'failed', error: redact(errors || `CLI 退出代码：${code}`) });
      if (/soft.denied|permission denied|requires approval|permission.*denied/i.test(errors)) return finish({ status: 'failed', error: '部分操作因权限限制未执行，请查看日志。' });
      if (final) return finish(final);
      finish(this.capabilities.structured || !output.trim() ? { status: 'uncertain', error: 'CLI 已退出但没有返回最终完成结果，请检查对话。' } : { status: 'completed' });
    });
    proc.stdin.end(input || undefined);
    hooks.log('system', `${this.name} 开始执行。权限沿用本机 CLI 设置。`);
    return { completion, interrupt: async () => { interrupted = true; await kill(); } };
  }
}
