// Read-only stdio handshake/tool probe. Does not create or dispatch real missions.
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js';
import { fileURLToPath } from 'node:url';
import path from 'node:path';
import assert from 'node:assert/strict';

const root = path.dirname(fileURLToPath(import.meta.url));
const client = new Client({ name: 'agentdesk-readonly-probe', version: '1.0.0' });
const transport = new StdioClientTransport({ command: process.execPath, args: [path.join(root, 'server.mjs')],
  cwd: path.dirname(root), stderr: 'pipe', env: { ...process.env, CODEX_SCHEDULER_AUTOSTART: '0' } });
try {
  await client.connect(transport);
  assert.equal(client.getServerVersion().name, 'agentdesk');
  assert.match(client.getInstructions(), /不能扩大授权/);
  const tools = (await client.listTools()).tools;
  const status = await client.callTool({ name: 'status', arguments: {} });
  assert.notEqual(status.isError, true, status.content?.[0]?.text);
  const missions = await client.callTool({ name: 'list_missions', arguments: {} });
  assert.notEqual(missions.isError, true, missions.content?.[0]?.text);
  console.log(JSON.stringify({ server: client.getServerVersion(), toolCount: tools.length,
    status: JSON.parse(status.content[0].text), missions: JSON.parse(missions.content[0].text), verified: true }, null, 2));
} finally { await client.close(); }
