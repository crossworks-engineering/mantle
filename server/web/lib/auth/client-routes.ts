/**
 * The ONLY routes a CLIENT login may reach (client logins, plan section 5:
 * deny by default). Each entry is `METHOD pattern`, the pattern exactly as
 * the route manifest writes it (server/route-manifest.gen.ts). A client
 * route is always client-specific: it calls getClientOr401 (or
 * getClientForAsset for bytes) and reads under `withViewer('client', …)`.
 * Never put a shared owner or member route here.
 *
 * server/client-sweep.test.ts drives every manifest route with a client
 * session and proves each route NOT listed here refuses it, and that admins
 * and members are refused on these.
 */
export const CLIENT_ROUTES: readonly string[] = [
  // Who am I + the brain's brand, and the asset token (Phase C2).
  'GET /api/client/shell',
  // "Shared with you": items at client level, read at the client level.
  'GET /api/client/shared',
  'GET /api/client/shared/:id',
  // The client thread on an item at client level (C5, decision 8): read on
  // the client role with the human flag on, written with the level checked.
  'GET /api/client/shared/:id/comments',
  'POST /api/client/shared/:id/comments',
  'DELETE /api/client/shared/:id/comments/:commentId',
  // Bytes of client-level items (session or a client ?at= token).
  'GET /api/client/files/:id',
  'GET /api/client/draws/:id/svg',
  // The client's own chat with the client-responder (Phase C4).
  'GET /api/client/chat',
  'POST /api/client/chat',
  // The client's own space (Phase C5): pages and notes they write, files
  // they upload; private until submitted. No share, no team drafts.
  'GET /api/client/space',
  'POST /api/client/space',
  'GET /api/client/space/:id',
  'PATCH /api/client/space/:id',
  'DELETE /api/client/space/:id',
  'PUT /api/client/space/:id/draft',
  'POST /api/client/space/:id/save',
  'POST /api/client/space/:id/submit',
  'POST /api/client/space/:id/recall',
  'POST /api/client/space-files',
  // Own file bytes (session or a client ?at= token).
  'GET /api/client/space/:id/bytes',
  // The review talk on the client's own submitted item.
  'GET /api/client/space/:id/comments',
  'POST /api/client/space/:id/comments',
  'DELETE /api/client/space/:id/comments/:commentId',
  // My requests: own, with a reviewer, and accepted, in one list.
  'GET /api/client/items',
  // What the client wrote and an admin accepted, as accepted.
  'GET /api/client/accepted/:id',
  // Apps at client level (C6): list, run (a frame ticket, then the frame the
  // ticket opens) and the app's brokers. The frame authenticates with the
  // ticket, not the session: a sandboxed iframe sends no cookie.
  'GET /api/client/apps',
  'POST /api/client/apps/:id/frame-ticket',
  'GET /api/client/apps/:id/frame',
  'POST /api/client/apps/:id/tool-broker',
  'POST /api/client/apps/:id/db-broker',
];

export function isClientRoute(method: string, pattern: string): boolean {
  return CLIENT_ROUTES.includes(`${method.toUpperCase()} ${pattern}`);
}
