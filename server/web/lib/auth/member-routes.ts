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
];

export function isMemberRoute(method: string, pattern: string): boolean {
  return MEMBER_ROUTES.includes(`${method.toUpperCase()} ${pattern}`);
}
