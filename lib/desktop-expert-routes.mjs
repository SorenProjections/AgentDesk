// Called only after the main server's authentication and origin checks.
export async function desktopExpertRoutes(request, response, url, { providers, send }) {
  if (request.method !== 'GET' || url.pathname !== '/api/desktop/workbuddy/experts') return false;
  const provider = providers.get('workbuddyDesktop');
  if (typeof provider?.getExpertCatalog !== 'function') throw new Error('WorkBuddy 专家目录接口尚不可用。');
  send(response, 200, await provider.getExpertCatalog());
  return true;
}
