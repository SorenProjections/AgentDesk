// Inspect only ports owned by the selected client, including ports chosen by
// another launcher. Opening AgentDesk after the client does not require a
// particular startup order or a particular debugging-port number.
export async function desktopTargets(found, name, preferredPort, fetcher = fetch) {
  const pids = new Set(found.processes.filter(p => p.name.toLowerCase() === name.toLowerCase()).map(p => p.pid));
  const ports = [...new Set(found.ports.filter(p => pids.has(p.pid)).map(p => p.port))].sort((a, b) => Number(b === preferredPort) - Number(a === preferredPort));
  const results = await Promise.allSettled(ports.map(async port => {
    const response = await fetcher(`http://127.0.0.1:${port}/json/list`, { signal: AbortSignal.timeout(1500), redirect: 'error' });
    if (!response.ok) return [];
    const tabs = await response.json();
    if (!Array.isArray(tabs)) return [];
    return tabs.filter(tab => tab.type === 'page' && typeof tab.webSocketDebuggerUrl === 'string').map(tab => ({ ...tab, port }));
  }));
  return results.flatMap(result => result.status === 'fulfilled' ? result.value : []);
}
