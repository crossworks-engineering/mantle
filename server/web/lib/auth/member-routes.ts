/**
 * The ONLY routes a MEMBER login may reach (member logins, plan section 3:
 * deny by default). Each entry is `METHOD pattern`, the pattern exactly as the
 * route manifest writes it (server/route-manifest.gen.ts). A member route is
 * always member-specific (it calls getMemberOr401 and reads under
 * `withViewer(…)`): never put a shared owner route here. That is how
 * the July read-only login failed.
 *
 * server/member-sweep.test.ts drives every manifest route with a member
 * session and proves each route NOT listed here refuses it.
 */
export const MEMBER_ROUTES: readonly string[] = [
  // Its own phone's push enrolment, device list and toggles (mobile_roles_push).
  'POST /api/member/push/connect',
  'POST /api/member/push/subscriptions',
  'GET /api/member/push/subscriptions',
  'DELETE /api/member/push/subscriptions/:id',
  'GET /api/member/push/preferences',
  'PUT /api/member/push/preferences',
  // Live changes to own and team-shared personal items (SSE).
  'GET /api/member/realtime',
  // The member home: the pinned home app and what its hub.get() answers.
  'GET /api/member/home',
  // The member's own MCP screen (team apps Phase 1): the connector URL, their
  // own MCP and Write switches (read only), and their OWN connected clients,
  // one of which they may disconnect (lib/mcp-clients.ts, actor-scoped).
  'GET /api/member/mcp',
  'DELETE /api/member/mcp/clients/:id',
  // The member routes retired over W5c to W8d (the shell, the Library and
  // its tree, the member chat, the space, the team drafts, the member apps
  // and frame, my apps, the accepted items and the client requests)
  // answered 410 until arch A7, which deleted their stubs.
];

export function isMemberRoute(method: string, pattern: string): boolean {
  return MEMBER_ROUTES.includes(`${method.toUpperCase()} ${pattern}`);
}
