#!/usr/bin/env node
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import path from 'node:path';
import { ControlClient } from '../lib/control-client.mjs';

export async function main(argv = process.argv.slice(2)) {
  const [command, ...rest] = argv;
  if (!command || command === 'help' || command === '--help') return { commands: [
    'status', 'sessions [--provider workbuddyDesktop] [--cwd <目录>]', 'missions', 'create --file <任务.json>',
    'get|observe <任务ID>', 'bind|dispatch|review|correct|pause|resume <任务ID> [--file <参数.json>]',
    'evidence <任务ID> [--refresh]', 'interrupt <运行ID>', 'release <占用ID> --file <核验说明.json>'
  ], options: '--url http://127.0.0.1:<端口>; --file <JSON文件或->; --json <JSON>',
  note: 'dispatch/correct 会安排真实任务；使用 requestId 防重复。evidence --refresh 会重新执行保存的验收命令。' };
  const options = {}, positional = [];
  for (let i = 0; i < rest.length; i++) {
    if (rest[i] === '--refresh') options.refresh = true;
    else if (['--file', '--json', '--url', '--provider', '--cwd'].includes(rest[i])) {
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
      providers: s.providers?.map(({ id, name, available, detail }) => ({ id, name, available, detail })), supervision: s.supervision };
  }
  if (command === 'sessions') {
    const params = new URLSearchParams();
    if (options.provider) params.set('provider', options.provider);
    if (options.cwd) params.set('cwd', options.cwd);
    return client.request('threads?' + params);
  }
  if (command === 'missions') return client.request('supervision');
  if (command === 'create') return client.request('supervision/missions', 'POST', payload);
  if (!id || positional.length !== 1 || !/^[a-zA-Z0-9-]+$/.test(id)) throw new Error('请提供唯一有效的任务、运行或占用 ID。');
  if (command === 'get') return client.request('supervision/missions/' + id);
  if (command === 'observe') return client.request('supervision/missions/' + id + '/observe');
  if (command === 'evidence') return client.request('supervision/missions/' + id + '/evidence', options.refresh ? 'POST' : 'GET', payload);
  if (['bind', 'dispatch', 'review', 'correct', 'pause', 'resume'].includes(command)) return client.request('supervision/missions/' + id + '/' + command, 'POST', payload);
  if (command === 'interrupt') return client.request('runs/' + id + '/interrupt', 'POST');
  if (command === 'release') return client.request('supervision/leases/' + id + '/release', 'POST', payload);
  throw new Error('未知命令：' + command);
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  main().then(result => console.log(JSON.stringify(result, null, 2))).catch(error => {
    console.error(JSON.stringify({ error: error.message })); process.exitCode = 1;
  });
}
