/**
 * The ONLY routes a MEMBER login may reach (member logins, plan section 3:
 * deny by default). Each entry is `METHOD pattern`, the pattern exactly as the
 * route manifest writes it (server/route-manifest.gen.ts). A member route is
 * always member-specific (it calls getMemberOr401 and reads under
 * `withViewer('team', …)`): never put a shared owner route here. That is how
 * the July read-only login failed.
 *
 * server/member-sweep.test.ts drives every manifest route with a member
 * session and proves each route NOT listed here refuses it.
 */
export const MEMBER_ROUTES: readonly string[] = [
  // Who am I + the brain's brand (Phase 1).
  'GET /api/member/shell',
  // The Library: team-level items, read at the team level (Phase 1).
  'GET /api/member/library',
  'GET /api/member/library/:id',
  'GET /api/member/files/:id',
  'GET /api/member/draws/:id/svg',
  // Chat with the team-level agent, the login's own thread (Phase 1).
  'GET /api/member/chat',
  'POST /api/member/chat',
  // The member's own space, "Mine" (Phase 2): every one runs in withSpace.
  'GET /api/member/space',
  'POST /api/member/space',
  'GET /api/member/space/:id',
  'PATCH /api/member/space/:id',
  'DELETE /api/member/space/:id',
  'PUT /api/member/space/:id/draft',
  'POST /api/member/space/:id/save',
  'POST /api/member/space/:id/share',
  'POST /api/member/space/:id/submit',
  'POST /api/member/space/:id/recall',
  // Files in the own space: upload, then the bytes (Phase 2, space disk root).
  'POST /api/member/space-files',
  'GET /api/member/space/:id/bytes',
  // Comments on own items (shared or submitted) and teammates' shared items.
  'GET /api/member/space/:id/comments',
  'POST /api/member/space/:id/comments',
  'DELETE /api/member/space/:id/comments/:commentId',
  'GET /api/member/team-drafts/:id/comments',
  'POST /api/member/team-drafts/:id/comments',
  'DELETE /api/member/team-drafts/:id/comments/:commentId',
  // Live changes to own and team-shared personal items (SSE).
  'GET /api/member/realtime',
  // Teammates' team-shared items (Phase 2): team role, human flag on.
  'GET /api/member/team-drafts',
  'GET /api/member/team-drafts/:id',
  'GET /api/member/team-drafts/:id/bytes',
  // Apps (Phase 4b): run only. Team level or lower, published build only.
  'GET /api/member/apps',
  'POST /api/member/apps/:id/frame-ticket',
  // Ticket-authed (a sandboxed iframe sends no cookie): a member ticket only.
  'GET /api/member/apps/:id/frame',
  'POST /api/member/apps/:id/tool-broker',
  'POST /api/member/apps/:id/db-broker',
  // The member home: the pinned home app and what its hub.get() answers.
  'GET /api/member/home',
  // What the member wrote and an admin accepted (Phase 4, plan 6.2): the
  // list and the saved version, for the author only, on the admin pool with
  // the author rule in every query (member-accepted.ts).
  'GET /api/member/accepted',
  'GET /api/member/accepted/:id',
  // Everything above in ONE list (item-list alignment): each source read
  // under its own rules, exactly as its own route reads it (member-items.ts).
  'GET /api/member/items',
];

export function isMemberRoute(method: string, pattern: string): boolean {
  return MEMBER_ROUTES.includes(`${method.toUpperCase()} ${pattern}`);
}
