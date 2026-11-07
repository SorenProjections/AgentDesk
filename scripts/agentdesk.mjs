#!/usr/bin/env node
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import path from 'node:path';
import { ControlClient } from '../lib/control-client.mjs';

export async function main(argv = process.argv.slice(2)) {
  const [command, ...rest] = argv;
  if (!command || command === 'help' || command === '--help') return { commands: [
    'status', 'experts', 'sessions [--provider workbuddyDesktop] [--cwd <目录>]', 'tasks', 'projects --provider codex', 'create --file <普通任务.json>',
    'get <运行ID>', 'pause|resume|run <任务ID>', 'interrupt <运行ID>'
  ], options: '--url http://127.0.0.1:<端口>; --file <JSON文件或->; --json <JSON>',
  note: 'create 保存普通任务，并按发送条件执行；run 会立即执行一次。' };
  const options = {}, positional = [];
  for (let i = 0; i < rest.length; i++) {
    if (['--file', '--json', '--url', '--provider', '--cwd'].includes(rest[i])) {
      if (!rest[i + 1]) throw new Error('参数缺少值：' + rest[i]);
      options[rest[i].slice(2)] = rest[++i];
    } else if (rest[i].startsWith('--')) throw new Error('未知参数：' + rest[i]);
    else positional.push(rest[i]);
  }
  if (options.file && options.json) throw new Error('--file 和 --json 只能选择一个。');
  const payload = options.file ? JSON.parse(readFileSync(options.file === '-' ? 0 : options.file, 'utf8').replace(/^\uFEFF/, '')) : options.json ? JSON.parse(options.json) : {};
  const client = new ControlClient(options.url ? { base: options.url } : {});
  const id = positional[0];
  if (command === 'status') {
    const s = await client.request('state');
    return { serverTime: s.serverTime, timezone: s.timezone, activeRunId: s.activeRunId,
      providers: s.providers?.map(({ id, name, available, detail }) => ({ id, name, available, detail })) };
  }
  if (command === 'sessions') {
    const params = new URLSearchParams();
    if (options.provider) params.set('provider', options.provider);
    if (options.cwd) params.set('cwd', options.cwd);
    return client.request('threads?' + params);
  }
  if (command === 'experts') {
    if (positional.length || (options.provider && options.provider !== 'workbuddyDesktop')) throw new Error('experts 仅支持 workbuddyDesktop 目录读取。');
    return client.request('desktop/workbuddy/experts');
  }
  if (command === 'tasks') return (await client.request('state')).tasks;
  if (command === 'projects') return client.request('projects?' + new URLSearchParams({provider:options.provider || 'codex'}));
  if (command === 'create') return client.request('tasks', 'POST', payload);
  if (!id || positional.length !== 1 || !/^[a-zA-Z0-9-]+$/.test(id)) throw new Error('请提供唯一有效的任务或运行 ID。');
  if (command === 'get') return client.request('runs/' + id);
  if (['pause', 'resume', 'run'].includes(command)) return client.request('tasks/' + id + '/' + command, 'POST', payload);
  if (command === 'interrupt') return client.request('runs/' + id + '/interrupt', 'POST');
  throw new Error('未知命令：' + command);
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  main().then(result => console.log(JSON.stringify(result, null, 2))).catch(error => {
    console.error(JSON.stringify({ error: error.message })); process.exitCode = 1;
  });
}
