import test from 'node:test';
import assert from 'node:assert/strict';
import { createDesktopDiscovery, parseDesktopPorts } from '../lib/desktop-discovery.mjs';
import { AntigravityDesktop } from '../lib/desktop.mjs';

test('native port discovery keeps only loopback listeners owned by known desktop processes', () => {
  const output = `
  TCP    127.0.0.1:9337    0.0.0.0:0    LISTENING    12
  TCP    127.0.0.1:8623    0.0.0.0:0    LISTENING    13
  TCP    127.0.0.1:9338    0.0.0.0:0    LISTENING    99
  TCP    0.0.0.0:9337      0.0.0.0:0    LISTENING    12
  TCP    [::1]:9337        [::]:0       LISTENING    12
  TCP    127.0.0.1:443     127.0.0.1:2  ESTABLISHED  12
  UDP    127.0.0.1:9337    *:*                        12
  TCP    127.0.0.1:99999   0.0.0.0:0    LISTENING    12`;
  assert.deepEqual(parseDesktopPorts(output, [{ pid: 12 }, { pid: 13 }]), [{ port: 9337, pid: 12 }, { port: 8623, pid: 13 }]);
});

test('desktop providers share in-flight native discovery and never invoke CIM port queries', async () => {
  const calls = [];
  const discovery = createDesktopDiscovery({ platform: 'win32', run: async (command, args) => {
    calls.push({ command, args });
    if (command === 'netstat.exe') return ' TCP 127.0.0.1:9337 0.0.0.0:0 LISTENING 12';
    return '\uFEFF[{"pid":12,"name":"WorkBuddy.exe","exe":"E:/workbuddy/WorkBuddy.exe"}]';
  } });
  const [a, b, c] = await Promise.all([discovery(), discovery(), discovery()]);
  assert.equal(a, b); assert.equal(b, c); assert.equal(calls.length, 2);
  const script = Buffer.from(calls[0].args.at(-1), 'base64').toString('utf16le');
  assert.match(script, /Get-Process/); assert.doesNotMatch(script, /Get-CimInstance|Get-NetTCPConnection|CommandLine/);
  assert.deepEqual(a.ports, [{ pid: 12, port: 9337 }]);
  await discovery(); assert.equal(calls.length, 2);
  await discovery({fresh:true}); assert.equal(calls.length, 4);
});

test('discovery failures identify process and port errors and allow the next retry', async () => {
  for (const failure of ['powershell.exe', 'netstat.exe']) {
    let fail = true;
    const discovery = createDesktopDiscovery({ platform: 'win32', run: async command => {
      if (fail && command === failure) throw new Error('timeout');
      return command === 'powershell.exe' ? '[]' : '';
    } });
    await assert.rejects(discovery(), failure === 'netstat.exe' ? /netstat/ : /进程查询/);
    fail = false; assert.deepEqual(await discovery(), { processes: [], ports: [] });
  }
  const malformed = createDesktopDiscovery({ platform: 'win32', run: async () => '{}' });
  await assert.rejects(malformed(), /格式/);
});

test('Antigravity authenticates using bootstrap config on a port owned by its installed server', async () => {
  let suppliedToken;
  const p = new AntigravityDesktop({ discovery: async () => ({ processes: [{ pid: 13, name: 'language_server.exe', exe: 'C:/Programs/antigravity/resources/bin/language_server.exe' }], ports: [{ pid: 13, port: 8623 }] }),
    fetcher: async (url, options) => url.endsWith('/') ? { text: async () => 'window.__APP_CONFIG__ = {"productName":"antigravity","csrfToken":"fixture-token","appVersion":"2.28.2"};' }
      : (suppliedToken = options.headers['x-codeium-csrf-token'], { ok: true, json: async () => ({ trajectorySummaries: {} }) }) });
  assert.equal((await p.probe()).available, true); assert.equal(suppliedToken, 'fixture-token');
  p.discovery = async () => ({ processes: [{ pid: 13, name: 'language_server.exe', exe: 'C:/OtherApp/server.exe' }], ports: [{ pid: 13, port: 8623 }] });
  assert.equal((await p.probe()).available, false);
});

test('Antigravity refuses bootstrap token mismatches when discovery supplies a token', async () => {
  const p = new AntigravityDesktop({ discovery: async () => ({ processes: [{ pid: 13, name: 'language_server.exe', exe: 'C:/antigravity/language_server.exe', csrf: 'expected' }], ports: [{ pid: 13, port: 8623 }] }),
    fetcher: async () => ({ text: async () => 'window.__APP_CONFIG__ = {"productName":"antigravity","csrfToken":"wrong"};' }) });
  assert.equal((await p.probe()).available, false);
});
