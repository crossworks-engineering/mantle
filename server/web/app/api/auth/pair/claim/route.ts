import { NextResponse } from '@/server/http-compat';
import { z } from 'zod';
import { db, authUsers, eq, sql } from '@mantle/db';
import { auditFireAndForget, requestMetaFrom } from '@/lib/audit';
import { claimPairCode } from '@/lib/pair-code';
import { brainIdField } from '@/lib/brain-identity';
import { isWorkspaceMobileBuild, updateTheAppResponse } from '@/lib/mobile-build';
import { readJson } from '@/lib/read-body';
import { routePolicy } from '@/lib/auth/route-declaration';

export const policy = routePolicy({
  POST: {
    class: 'self',
    public: true,
    item: { none: "the login's own things, not an item" },
    limits: { rateLimit: ['authPairClaim'] },
  },
});

/**
 * POST /api/auth/pair/claim — the phone's half of QR sign-in. Public (the
 * phone has no session yet), rate-limited by IP like the token logins, body
 * `{ code, deviceName? }`. A good code mints the same kind-'m' bearer
 * `mobile-login` does and answers the same shape (plus `email`, so the phone
 * can show who it is). Every failure — unknown, expired, already used,
 * malformed — is one 401 with one line, so nothing can be enumerated.
 *
 * Any login since workspaces W7e: a member's code is claimed by a phone
 * build that sends `X-Jackdaw-Mobile` at or above the minimum build
 * (lib/mobile-build.ts); an older app gets 426 "Update the app" and the code
 * stays unused.
 */
const Body = z.object({
  code: z.string().trim().min(16).max(128),
  deviceName: z.string().trim().min(1).max(80).optional(),
});

const CLAIM_FAILED_MESSAGE =
  "That code didn't work. Show a fresh one on the web app and scan again.";

export async function POST(req: Request) {
  // The row's limit (lib/route-limits.ts: authPairClaim) is the gate's.
  const raw = (await readJson(req)) ?? {};
  const parsed = Body.safeParse(raw);
  if (!parsed.success) {
    return NextResponse.json({ error: CLAIM_FAILED_MESSAGE }, { status: 401 });
  }

  const claimed = await claimPairCode(parsed.data.code, parsed.data.deviceName, new Date(), {
    nonAdmin: isWorkspaceMobileBuild(req),
  });
  if (claimed === 'update-app') return updateTheAppResponse();
  if (!claimed) {
    auditFireAndForget({
      actorEmail: '',
      action: 'auth.login_failed',
      method: 'POST',
      path: '/api/auth/pair/claim',
      detail: { channel: 'mobile-qr' },
      ...requestMetaFrom(req),
    });
    return NextResponse.json({ error: CLAIM_FAILED_MESSAGE }, { status: 401 });
  }

  await db
    .update(authUsers)
    .set({ lastLoginAt: sql`now()` })
    .where(eq(authUsers.id, claimed.userId));
  auditFireAndForget({
    actorId: claimed.userId,
    actorEmail: claimed.email,
    action: 'auth.login',
    method: 'POST',
    path: '/api/auth/pair/claim',
    detail: { channel: 'mobile-qr', device: claimed.label },
    ...requestMetaFrom(req),
  });

  return NextResponse.json({
    token: claimed.token,
    expiresIn: claimed.expiresIn,
    expiresAt: claimed.expiresAt.toISOString(),
    deviceId: claimed.deviceId,
    email: claimed.email,
    // Additive (v1.1): the login and this brain, the pair a device holding
    // several logins files the session under. Shipped builds ignore both.
    loginId: claimed.userId,
    ...(await brainIdField()),
  });
}
