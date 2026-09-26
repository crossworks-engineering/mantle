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
  // Teammates' team-shared items (Phase 2): team role, human flag on.
  'GET /api/member/team-drafts',
  'GET /api/member/team-drafts/:id',
];

export function isMemberRoute(method: string, pattern: string): boolean {
  return MEMBER_ROUTES.includes(`${method.toUpperCase()} ${pattern}`);
}
