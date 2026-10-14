/**
 * POST /api/auth/sso — silent bearer→cookie upgrade (admin or member). All logic (and the
 * contract tests) live in lib/owner-sso.ts. A public row: the login is the
 * one the pipeline answers at the read (cookieUpgradeCaller, A4 hand
 * batch B), read by the handler after its throttle and origin check.
 */
import { cookieUpgradeCaller } from '@/lib/auth';
import { handleOwnerSso } from '@/lib/owner-sso';

export async function POST(req: Request) {
  // Awaited where it is called (owner-caller-imports): the read runs the
  // answer the gate took, once handleOwnerSso asks for it.
  return handleOwnerSso(req, async () => await cookieUpgradeCaller());
}
