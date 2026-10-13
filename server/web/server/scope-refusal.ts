/**
 * The HTTP answer to a refusal (arch plan v2, section 10; A3c): what THE
 * one mapper (mapAccessError, @mantle/std access-error.ts) says, as a
 * Response. The one place the HTTP layer turns a refusal into an answer
 * (server/app.ts onError):
 *
 *  - a database refusal on /api (the workspace and edit checks): the edit
 *    check's detail read into the wire's `code` (no_read: 404; read_only
 *    and ro_actor: 403 read-only; no_edit or no detail: 403
 *    item-workspace, as before; a folder that holds items the caller
 *    cannot move: 409);
 *  - a viewer level conflict: 403 level-conflict on /api, a plain 403 on a
 *    page (it folded the level-conflict mapper in, A3c);
 *  - a refusal of the gate (AccessError, @mantle/db gate.ts): its body.
 *
 * Anything else is no refusal: null, and the caller's own error path runs
 * (busy: 409; else the opaque 500).
 */
import { LEVEL_CONFLICT_MESSAGE, mapAccessError } from '@mantle/std';

/** Whether `path` is an API path (JSON answers). */
function isApiPath(path: string): boolean {
  return path === '/api' || path.startsWith('/api/');
}

export function scopeRefusalResponse(err: unknown, path: string = '/api/'): Response | null {
  const refusal = mapAccessError(err);
  if (!refusal?.http) return null;
  if (!isApiPath(path)) {
    // A page (the share page, print): only a level conflict answers there,
    // in plain text; a database refusal stays the page's own error.
    if (refusal.kind !== 'level-conflict') return null;
    return new Response(LEVEL_CONFLICT_MESSAGE, {
      status: 403,
      headers: { 'content-type': 'text/plain' },
    });
  }
  return Response.json(refusal.http.body, { status: refusal.http.status });
}
