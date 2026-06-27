/**
 * POST /api/secrets/[id]/reveal — return decrypted note + fields.
 *
 * Separate path so reveal is greppable in access logs and easy to audit.
 * Owner-scoped via `getOwnerOr401` (a JSON API — 401s rather than redirecting).
 * No cache headers; never proxied.
 */
import { NextResponse } from 'next/server';
import { getOwnerOr401 } from '@/lib/auth';
import { revealSecret } from '@/lib/secrets';

export async function POST(
  _req: Request,
  ctx: { params: Promise<{ id: string }> },
) {
  const user = await getOwnerOr401();
  if (user instanceof Response) return user;
  const { id } = await ctx.params;
  const result = await revealSecret(user.id, id);
  if (!result) return NextResponse.json({ error: 'not found' }, { status: 404 });
  return NextResponse.json(
    { metadata: result.metadata, payload: result.payload },
    {
      headers: {
        // Sensitive — never store this in any cache between us and the browser.
        'Cache-Control': 'no-store, no-cache, must-revalidate, private',
      },
    },
  );
}
