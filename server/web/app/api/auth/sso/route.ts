/**
 * POST /api/auth/sso — silent owner bearer→cookie upgrade. All logic (and the
 * contract tests) live in lib/owner-sso.ts.
 */
import { handleOwnerSso } from '@/lib/owner-sso';

export async function POST(req: Request) {
  return handleOwnerSso(req);
}
