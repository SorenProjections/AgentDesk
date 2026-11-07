import { readFile, writeFile } from 'node:fs/promises';
import { randomUUID } from 'node:crypto';
import { createServerAdapter } from '../src/index.js';

const args = process.argv.slice(2);
const configIndex = args.indexOf('--config');
if (configIndex < 0 || !args[configIndex + 1]) throw new Error('Usage: npm run smoke -- --config <local-config.json> [--report <path>]');
const config = JSON.parse(await readFile(args[configIndex + 1], 'utf8'));
const adapter = createServerAdapter();
const diagnostics = await adapter.testEnvironment({ companyId: 'smoke', adapterType: adapter.type, config });
if (diagnostics.status === 'fail') { console.log(JSON.stringify(diagnostics, null, 2)); process.exit(1); }
const ctx = {
  runId: randomUUID(), agent: { id: 'workbuddy-smoke', companyId: 'smoke', name: 'WorkBuddy Smoke', adapterType: adapter.type, adapterConfig: {} },
  runtime: { sessionId: null, sessionDisplayId: null, sessionParams: null, taskKey: 'smoke' },
  config: { ...config, timeoutSec: 120, permissionMode: 'dontAsk' },
  context: { paperclipTaskMarkdown: 'Reply with exactly WORKBUDDY_PAPERCLIP_OK. Do not use tools, read files, or make changes.' },
  onLog: async () => {},
};
const first = await adapter.execute(ctx);
const firstOK = first.exitCode === 0 && first.summary?.trim() === 'WORKBUDDY_PAPERCLIP_OK';
let second = null;
if (firstOK && first.sessionParams) {
  ctx.runId = randomUUID(); ctx.runtime.sessionParams = first.sessionParams;
  ctx.context.paperclipTaskMarkdown = 'Reply with exactly WORKBUDDY_RESUME_OK. Do not use tools, read files, or make changes.';
  second = await adapter.execute(ctx);
}
const report = {
  testedAt: new Date().toISOString(), adapterType: adapter.type, diagnostics,
  first: { passed: firstOK, exitCode: first.exitCode, errorCode: first.errorCode, errorMessage: first.errorMessage, sessionReturned: !!first.sessionParams, usage: first.usage, costStatus: first.costStatus },
  resume: second ? { passed: second.exitCode === 0 && second.summary?.trim() === 'WORKBUDDY_RESUME_OK', exitCode: second.exitCode, errorCode: second.errorCode, errorMessage: second.errorMessage, sameSession: second.sessionDisplayId === first.sessionDisplayId } : null,
};
console.log(JSON.stringify(report, null, 2));
const reportIndex = args.indexOf('--report');
if (reportIndex >= 0 && args[reportIndex + 1]) await writeFile(args[reportIndex + 1], JSON.stringify(report, null, 2) + '\n');
if (!firstOK || !report.resume?.passed || !report.resume.sameSession) process.exitCode = 1;
