/**
 * The HTTP answer to a refusal: what THE
 * one mapper (mapAccessError, @mantle/std access-error.ts) says, as a
 * Response. The one place the HTTP layer turns a refusal into an answer
 * (server/app.ts onError):
 *
 *  - a database refusal on /api (the workspace and edit checks): the edit
 *    check's detail read into the wire's `code` (no_read: 404; read_only
 *    and ro_actor: 403 read-only; no_edit or no detail: 403
 *    item-workspace, as before; a folder that holds items the caller
 *    cannot move: 409);
 *  - a refusal of the gate (AccessError, @mantle/db gate.ts): its body.
 *
 * Anything else is no refusal: null, and the caller's own error path runs
 * (busy: 409; else the opaque 500).
 */
import { mapAccessError } from '@mantle/std';

/** Whether `path` is an API path (JSON answers). */
function isApiPath(path: string): boolean {
  return path === '/api' || path.startsWith('/api/');
}

export function scopeRefusalResponse(err: unknown, path: string = '/api/'): Response | null {
  const refusal = mapAccessError(err);
  // A page (the share page, print): a refusal stays the page's own error.
  if (!refusal?.http || !isApiPath(path)) return null;
  return Response.json(refusal.http.body, { status: refusal.http.status });
}
