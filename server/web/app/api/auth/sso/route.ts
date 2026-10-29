/**
 * POST /api/auth/sso — silent bearer→cookie upgrade (admin or member). All logic (and the
 * contract tests) live in lib/owner-sso.ts. A public row: the login is the
 * one the pipeline answers at the read (cookieUpgradeCaller), read by the handler after its throttle and origin check.
 */
import { cookieUpgradeCaller } from '@/lib/auth';
import { handleOwnerSso } from '@/lib/owner-sso';
import { routePolicy } from '@/lib/auth/route-declaration';

export const policy = routePolicy({
  POST: {
    class: 'self',
    public: true,
    caller: 'cookieUpgrade',
    item: { none: "the login's own things, not an item" },
    limits: { rateLimit: ['ownerSso'] },
  },
});

export async function POST(req: Request) {
  // Awaited where it is called (owner-caller-imports): the read runs the
  // answer the gate took, once handleOwnerSso asks for it.
  return handleOwnerSso(req, async () => await cookieUpgradeCaller());
}
