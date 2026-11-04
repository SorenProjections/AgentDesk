import { spawn } from 'node:child_process';

// Reuse an existing bridge. Never terminate a client or assume that spawning it
// means a connection succeeded; the renderer must pass the provider's probe.
export async function connectOrLaunch(provider, { name, binary, spawnProcess = spawn, pause = ms => new Promise(r => setTimeout(r, ms)), attempts = 6, clock = Date.now, onProgress = () => {} } = {}) {
  if (provider.available) { const live = await provider.probe(); if (live.available) return { launched: false, connected: true, provider: live }; }
  provider.detail = '正在查找客户端进程和已有连接接口…'; onProgress();
  const found = await provider.discovery();
  const current = await provider.probe(found);
  if (current.available) return { launched: false, connected: true, provider: current };
  if (found.processes.some(p => p.name?.toLowerCase() === name.toLowerCase())) {
    return { launched: false, connected: false, requiresRestart: true, provider: current };
  }
  if (!binary) throw new Error('未找到客户端程序，请检查安装路径。');
  const child = spawnProcess(binary, [`--remote-debugging-port=${provider.port}`, '--remote-debugging-address=127.0.0.1'], { windowsHide: true, detached: true, stdio: 'ignore', shell: false });
  await new Promise((resolve, reject) => { child.once('spawn', resolve); child.once('error', reject); });
  child.unref();
  provider.detail = '客户端已启动，正在等待调试接口和聊天界面就绪…'; onProgress();
  const deadline = clock() + 30000;
  for (let i = 0; i < attempts && clock() < deadline; i++) {
    await pause(1000);
    const result = await provider.probe();
    if (result.available) return { launched: true, connected: true, provider: result };
    onProgress();
  }
  return { launched: true, connected: false, provider: provider.snapshot() };
}
