import { execFile } from 'node:child_process';
import { readFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { promisify } from 'node:util';
import {
  buildPaperclipEnv, buildRuntimeToolsEnv, joinPromptSections, renderTemplate,
  selectPaperclipPromptSections, runChildProcess, runningProcesses, signalRunningProcess,
  readPaperclipRuntimeSkillEntries,
} from '@paperclipai/adapter-utils/server-utils';
import { assertLocal, resolveConfig, text } from './config.js';
import { createParser } from './parse.js';
import { createRedactor } from './redact.js';
import { resumableSession } from './session.js';

const execFileAsync = promisify(execFile);

/** @param {import('@paperclipai/adapter-utils').AdapterExecutionContext & { getFreshSessionHandoff?: () => Promise<string | null> }} ctx */
export async function execute(ctx) {
  /** @type {ReturnType<typeof setTimeout> | undefined} */
  let timer, killTimer;
  /** @type {Promise<void> | undefined} */
  let stopPromise;
  let timedOut = false, cancelled = false, logFailed = false;
  const parser = createParser();
  const redact = createRedactor([
    ...Object.entries(process.env).filter(([key]) => /token|secret|password|api.?key/i.test(key)).map(([, value]) => value || ''),
    ...Object.entries(ctx.config.env || {}).filter(([key]) => /token|secret|password|api.?key/i.test(key)).map(([, value]) => text(value)),
    ctx.authToken || '', ctx.runtimeTools?.bearerToken || '',
  ]);
  /** @param {string} message @param {string} code */
  const failure = (message, code) => ({ exitCode: 1, signal: null, timedOut, errorMessage: redact(message), errorCode: code });
  /** @param {boolean} timeout */
  const stop = async timeout => {
    if (timeout) timedOut = true; else cancelled = true;
    if (stopPromise) return stopPromise;
    const running = runningProcesses.get(ctx.runId);
    if (!running) return;
    running.child.stdin?.destroy();
    stopPromise = (async () => {
      if (process.platform === 'win32' && running.child.pid) {
        if (running.child.exitCode === null && running.child.signalCode === null) {
          try { await execFileAsync('taskkill.exe', ['/PID', String(running.child.pid), '/T', '/F'], { windowsHide: true, timeout: 15000 }); }
          catch (error) { if (running.child.exitCode === null && running.child.signalCode === null) throw error; }
        }
      } else {
        signalRunningProcess(running, 'SIGTERM');
        killTimer = setTimeout(() => signalRunningProcess(running, 'SIGKILL'), Math.max(1, running.graceSec) * 1000);
      }
    })();
    return stopPromise;
  };
  const abort = () => { void stop(false).catch(() => { logFailed = true; }); };
  try {
    assertLocal(ctx.executionTarget); assertLocal(ctx.executionTransport);
    const config = resolveConfig(ctx.config);
    const sessionId = resumableSession(ctx.runtime.sessionParams, config);
    if (ctx.signal?.aborted) return failure('Run cancelled before dispatch.', 'workbuddy_cancelled');
    await ctx.onCancellationReady?.();
    if (ctx.signal?.aborted) return failure('Run cancelled before dispatch.', 'workbuddy_cancelled');
    const handoff = sessionId ? '' : ctx.getFreshSessionHandoff
      ? await ctx.getFreshSessionHandoff() || '' : text(ctx.context.paperclipFreshSessionHandoffMarkdown);
    // Released SDKs omit this section; deliver it explicitly once across SDK versions.
    const promptContext = { ...ctx.context };
    delete promptContext.paperclipFreshSessionHandoffMarkdown;
    const sections = selectPaperclipPromptSections(promptContext, { resumedSession: !!sessionId });
    const instructions = config.instructionsFilePath ? await readFile(config.instructionsFilePath, 'utf8') : '';
    const skillEntries = await readPaperclipRuntimeSkillEntries({ ...ctx.config, paperclipRuntimeSkills: ctx.config.paperclipRuntimeSkills ?? [] }, fileURLToPath(new URL('.', import.meta.url)));
    const skillInstructions = await Promise.all(skillEntries.map(async entry => {
      if (entry.sourceStatus === 'missing' || !path.isAbsolute(entry.source)) throw new Error(`Assigned skill ${entry.key} is not available locally.`);
      return `Skill ${entry.key} (relative references resolve from ${entry.source}):\n${await readFile(path.join(entry.source, 'SKILL.md'), 'utf8')}`;
    }));
    const prompt = joinPromptSections([
      instructions, ...skillInstructions, sections.taskContextNote, handoff, sections.wakePrompt,
      config.promptTemplate ? renderTemplate(config.promptTemplate, { agent: ctx.agent, context: ctx.context, run: { id: ctx.runId } }) : '',
    ]);
    if (!prompt.trim()) return failure('Paperclip did not supply task context or a promptTemplate.', 'workbuddy_missing_prompt');
    const args = [...config.prefixArgs, '--print', '--input-format', 'stream-json', '--output-format', 'stream-json', '--verbose', '--permission-mode', config.permissionMode];
    if (sessionId) args.push('--resume', sessionId);
    if (config.model) args.push('--model', config.model);
    if (config.effort) args.push('--effort', config.effort);
    /** @type {Record<string, string>} */
    const env = {
      ...config.env, CODEBUDDY_CONFIG_DIR: config.configDir,
      ...buildPaperclipEnv(ctx.agent), ...buildRuntimeToolsEnv(ctx.runtimeTools), PAPERCLIP_RUN_ID: ctx.runId,
      ...(ctx.authToken ? { PAPERCLIP_API_KEY: ctx.authToken } : {}),
    };
    const issueId = text(ctx.context.issueId) || text(ctx.context.taskId);
    if (issueId) env.PAPERCLIP_TASK_ID = issueId;
    await ctx.onMeta?.({ adapterType: 'workbuddy_local', command: config.command, cwd: config.cwd, commandArgs: args, commandNotes: ['Local WorkBuddy CLI; prompt via stdin. No permission bypass.'] });
    if (ctx.signal?.aborted) return failure('Run cancelled before dispatch.', 'workbuddy_cancelled');
    /** @type {Record<'stdout' | 'stderr', string>} */
    const logs = { stdout: '', stderr: '' };
    ctx.signal?.addEventListener('abort', abort, { once: true });
    const proc = await runChildProcess(ctx.runId, config.command, args, {
      cwd: config.cwd, env, timeoutSec: 0, graceSec: config.graceSec,
      stdin: JSON.stringify({ type: 'user', message: { role: 'user', content: prompt } }) + '\n',
      onLogError: () => { logFailed = true; },
      onSpawn: async meta => {
        // The helper registers the process immediately after invoking onSpawn.
        await Promise.resolve();
        const running = runningProcesses.get(ctx.runId);
        running?.child.stdout?.setEncoding('utf8'); running?.child.stderr?.setEncoding('utf8');
        try { await ctx.onSpawn?.(meta); }
        catch (error) { logFailed = true; await stop(false); throw error; }
        if (ctx.signal?.aborted) { await stop(false); return; }
        if (config.timeoutSec > 0) timer = setTimeout(() => { void stop(true).catch(() => { logFailed = true; }); }, config.timeoutSec * 1000);
      },
      onLog: async (stream, chunk) => {
        if (stream === 'stdout') parser.push(chunk);
        // Line buffering prevents a token split across transport chunks leaking to the run log.
        logs[stream] += chunk;
        const last = logs[stream].lastIndexOf('\n');
        if (last >= 0) { const output = logs[stream].slice(0, last + 1); logs[stream] = logs[stream].slice(last + 1); await ctx.onLog(stream, redact(output)); }
        if (logs[stream].length > 4 * 1024 * 1024) { logs[stream] = ''; logFailed = true; }
      },
    });
    clearTimeout(timer); clearTimeout(killTimer);
    if (stopPromise) await stopPromise;
    for (const stream of /** @type {const} */ (['stdout', 'stderr'])) if (logs[stream]) await ctx.onLog(stream, redact(logs[stream]));
    const result = parser.finish();
    await ctx.onProviderStopped?.();
    const newSession = !result.invalid ? result.sessionId : null;
    const sessionParams = newSession ? { sessionId: newSession, cwd: config.cwd, configDir: config.configDir, command: config.prefixArgs[0] || config.command } : ctx.runtime.sessionParams;
    const errorCode = timedOut ? 'workbuddy_timeout' : cancelled || result.cancelled ? 'workbuddy_cancelled' : proc.exitCode !== 0 ? 'workbuddy_process_failed' : logFailed ? 'workbuddy_log_failed' : !result.success ? 'workbuddy_incomplete_result' : null;
    const errorMessage = timedOut ? 'WorkBuddy timed out. Inspect the session before retrying.' : cancelled ? 'WorkBuddy execution was cancelled.' : proc.exitCode !== 0 ? `WorkBuddy exited with code ${proc.exitCode}; inspect the run log.` : logFailed ? 'Run logs could not be recorded completely.' : result.error;
    return {
      exitCode: errorCode ? proc.exitCode || 1 : 0, signal: proc.signal, timedOut,
      errorCode, errorMessage: errorCode ? redact(errorMessage) : null,
      sessionParams, sessionDisplayId: newSession || sessionId, summary: redact(result.summary),
      usage: result.usage, usageComplete: result.usageComplete, usageBasis: /** @type {const} */ ('per_run'),
      costUsd: result.costUsd, costStatus: result.costStatus,
      resultJson: { finalResultSeen: result.finalSeen, deliveryUncertain: !result.finalSeen || timedOut },
    };
  } catch (error) {
    return failure(error instanceof Error ? error.message : String(error), 'workbuddy_adapter_error');
  } finally {
    clearTimeout(timer); clearTimeout(killTimer); ctx.signal?.removeEventListener('abort', abort);
  }
}
