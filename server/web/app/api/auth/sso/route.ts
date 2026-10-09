/**
 * POST /api/auth/sso — silent bearer→cookie upgrade (admin or member). All logic (and the
 * contract tests) live in lib/owner-sso.ts.
 */
import { handleOwnerSso } from '@/lib/owner-sso';

export async function POST(req: Request) {
  return handleOwnerSso(req);
}
