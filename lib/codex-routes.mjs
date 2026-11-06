export async function codexRoutes(request, response, url, { scheduler, body, send }) {
  const match = url.pathname.match(/^\/api\/runs\/([a-zA-Z0-9-]+)\/handoff-codex$/);
  if (request.method !== 'POST' || !match) return false;
  const input = await body(request);
  send(response, 200, await scheduler.handoffCodex(match[1], { interrupt: input.interrupt === true }));
  return true;
}
