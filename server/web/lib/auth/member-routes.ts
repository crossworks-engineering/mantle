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
export const MEMBER_ROUTES: readonly string[] = [];

export function isMemberRoute(method: string, pattern: string): boolean {
  return MEMBER_ROUTES.includes(`${method.toUpperCase()} ${pattern}`);
}
