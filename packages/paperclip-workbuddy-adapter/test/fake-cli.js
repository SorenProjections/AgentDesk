import { writeFileSync } from 'node:fs';
import { spawn } from 'node:child_process';
if (process.argv.includes('--help')) {
  console.log('--print --input-format --output-format --resume --permission-mode'); process.exit(0);
}
let input = '';
for await (const chunk of process.stdin) input += chunk;
const prompt = JSON.parse(input).message.content;
const resumeIndex = process.argv.indexOf('--resume');
const session = resumeIndex >= 0 ? process.argv[resumeIndex + 1] : 'fake-session';
const mode = process.env.FAKE_MODE;
if (mode === 'hang' || mode === 'tree') {
  if (mode === 'tree') {
    const child = spawn(process.execPath, ['-e', 'setInterval(()=>{},1000)'], { stdio: 'inherit', windowsHide: true });
    writeFileSync(process.env.FAKE_PID_FILE, String(child.pid));
  }
  console.log(JSON.stringify({ type: 'system', session_id: session }));
  setInterval(() => {}, 1000);
} else if (mode === 'missing') {
  console.log(JSON.stringify({ type: 'assistant', session_id: session, message: { content: [{ type: 'text', text: 'Done' }] } }));
} else {
  const summary = mode === 'identity' ? JSON.stringify({
    agent: process.env.PAPERCLIP_AGENT_ID, company: process.env.PAPERCLIP_COMPANY_ID,
    run: process.env.PAPERCLIP_RUN_ID, task: process.env.PAPERCLIP_TASK_ID,
    tokenPresent: !!process.env.PAPERCLIP_API_KEY, configDir: process.env.CODEBUDDY_CONFIG_DIR,
    prompt, args: process.argv.slice(2),
  }) : mode === 'secret' ? process.env.TEST_API_KEY : '中文结果: unauthorized and login required are ordinary text';
  const event = JSON.stringify({ type: 'result', subtype: mode === 'failure' ? 'error_during_execution' : 'success',
    result: mode === 'empty' ? '' : summary, session_id: session,
    permission_denials: mode === 'denied' ? [{}] : [], usage: { input_tokens: 10, output_tokens: 5, cache_read_input_tokens: 2, cache_creation_input_tokens: 3 },
    ...(mode === 'cost' ? { total_cost_usd: 0.002 } : {}),
  }) + '\n';
  if (mode === 'split') {
    const bytes = Buffer.from(event); const at = bytes.indexOf(Buffer.from('中')) + 1;
    process.stdout.write(bytes.subarray(0, at)); await new Promise(resolve => setTimeout(resolve, 15)); process.stdout.write(bytes.subarray(at));
  } else if (mode === 'secret') {
    const at = event.indexOf(process.env.TEST_API_KEY) + 7;
    process.stdout.write(event.slice(0, at)); await new Promise(resolve => setTimeout(resolve, 15)); process.stdout.write(event.slice(at));
  } else process.stdout.write(event);
  if (mode === 'nonzero') process.exitCode = 2;
}
