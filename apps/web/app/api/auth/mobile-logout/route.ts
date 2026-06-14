import { NextResponse } from 'next/server';
import { db, mobileTokens, eq } from '@mantle/db';
import { mobileTokenJti } from '@/lib/auth';

/**
 * Revoke the calling device's mobile token. Self-authenticates from the
 * Authorization: Bearer token (its `jti`), so it lives under the public
 * /api/auth prefix. Idempotent — always 200, so it can't be used to probe
 * whether a token is valid.
 */
function bearer(req: Request): string | null {
  const h = req.headers.get('authorization') ?? '';
  const m = /^Bearer\s+(.+)$/i.exec(h.trim());
  return m ? m[1]!.trim() : null;
}

export async function POST(req: Request) {
  const token = bearer(req);
  const jti = token ? mobileTokenJti(token) : null;
  if (jti) {
    await db.update(mobileTokens).set({ revokedAt: new Date() }).where(eq(mobileTokens.id, jti));
  }
  return NextResponse.json({ ok: true });
}
