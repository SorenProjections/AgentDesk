// Reuses the main server's authentication and same-origin mutation checks.
import {updateMissionHistory} from './mission-history.mjs';
export async function supervisionRoutes(request, response, url, { supervision, body, send }) {
  const prefix = '/api/supervision';
  if (request.method === 'GET' && url.pathname === prefix) { send(response, 200, supervision.snapshot()); return true; }
  if (request.method === 'POST' && url.pathname === prefix + '/missions') { send(response, 201, await supervision.create(await body(request))); return true; }
  if (request.method==='POST' && url.pathname===prefix+'/history') {
    const input=await body(request);send(response,200,{missions:updateMissionHistory(supervision,input.ids,input.action)});return true;
  }
  const match = url.pathname.match(/^\/api\/supervision\/missions\/([a-zA-Z0-9-]+)(?:\/(bind|dispatch|observe|evidence|review|correct|pause|resume))?$/);
  if (match) {
    const [, id, action] = match;
    if (request.method === 'GET' && !action) { send(response, 200, supervision.detail(id)); return true; }
    if (request.method === 'GET' && action === 'evidence') { send(response, 200, await supervision.evidence(id)); return true; }
    if (request.method === 'GET' && action === 'observe') { send(response, 200, await supervision.observe(id)); return true; }
    if (request.method === 'POST' && ['bind', 'dispatch', 'review', 'correct', 'pause', 'resume', 'evidence'].includes(action)) {
      const input = await body(request);
      send(response, 200, action === 'evidence' ? await supervision.evidence(id, { refresh: true }) : await supervision[action](id, input));
      return true;
    }
  }
  const lease = url.pathname.match(/^\/api\/supervision\/leases\/([a-zA-Z0-9-]+)\/release$/);
  if (request.method === 'POST' && lease) { send(response, 200, await supervision.releaseLease(lease[1], await body(request))); return true; }
  return false;
}
