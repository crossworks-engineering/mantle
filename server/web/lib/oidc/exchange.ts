/**
 * POST /api/auth/oidc/exchange: a client spends the one-time code its flow
 * came back with (handoff.ts, docs/oidc-sign-in.md), with the verifier it
 * kept. A sign-in answers a bearer. A link is made here, not at the callback,
 * so only the client that started the flow can finish it; a link that started
 * on a held ticket answers a bearer too.
 *
 * The bearer lasts MANTLE_OIDC_SESSION_HOURS, carries the login's session
 * epoch and the company mark (`so`), and never rotates. The epoch is what
 * makes a racing unlink safe: the unlink bumps it, which ends this token, as
 * it ends the cookie a callback mints (store.ts signInTarget).
 *
 * Every failure of a code answers the same 401: whether it never existed, was
 * spent, lapsed, or met a wrong verifier. The verifier is compared after the
 * code is spent, so a wrong one burns it.
 */
import { randomUUID } from 'node:crypto';
import { NextResponse } from '@/server/http-compat';
import { z } from 'zod';
import { db, authUsers, eq, mobileTokens } from '@mantle/db';
import type { OidcExchangeRefusal, OidcLinkAnswer, OidcTokenAnswer } from '@mantle/client-types';
import { buildMobileToken, stampCompanySignIn } from '@/lib/auth';
import { loginRole } from '@/lib/auth/admin-seat';
import { auditFireAndForget, requestMetaFrom } from '@/lib/audit';
import { brainIdField } from '@/lib/brain-identity';
import { CACHE_CONTROL } from '@/lib/cache-control';
import { readJson } from '@/lib/read-body';
import { deviceLabel } from '@/lib/token-login';
import { oidcOffAnswer } from './flow';
import { handoffCodeHash, verifierMatches } from './handoff';
import { forgetHolds } from './hold';
import { notifyLinkMade } from './notify';
import { oidcSettings, type OidcOn } from './settings';
import { createLink, oidcLoginRow, spendHandoffCode, type OidcLoginRow } from './store';

const NO_STORE = { 'Cache-Control': CACHE_CONTROL.none } as const;

const Body = z.object({
  code: z.string().min(1).max(128),
  verifier: z.string().min(1).max(128),
  // A label, never a credential: read loosely, as a token login does.
  deviceName: z.unknown().optional(),
});

function refused(status: number, body: OidcExchangeRefusal): NextResponse {
  return NextResponse.json(body, { status, headers: NO_STORE });
}

const CODE_GONE: OidcExchangeRefusal = {
  error: 'This sign-in has ended. Start again.',
  code: 'expired',
};

/** The bearer a code buys, as device-login answers one. */
async function bearerAnswer(
  req: Request,
  s: OidcOn,
  row: OidcLoginRow,
  deviceName: unknown,
  how: 'signin' | 'link',
): Promise<NextResponse> {
  const label = deviceLabel(deviceName, 'Company sign-in');
  const jti = randomUUID();
  const { value, expiresInSec, expiresAt } = buildMobileToken(
    row.id,
    jti,
    s.sessionSeconds,
    row.sessionEpoch,
    { oidc: true },
  );
  await db
    .insert(mobileTokens)
    .values({ id: jti, userId: row.id, label, expiresAt, signedInAt: new Date() });
  await stampCompanySignIn(row.id);
  auditFireAndForget({
    actorId: row.id,
    actorEmail: row.email,
    action: 'auth.login',
    method: 'POST',
    path: '/api/auth/oidc/exchange',
    detail: { channel: 'oidc', via: how, device: label, deviceId: jti },
    ...requestMetaFrom(req),
  });
  const [login] = await db
    .select({ role: loginRole(row.id) })
    .from(authUsers)
    .where(eq(authUsers.id, row.id))
    .limit(1);
  const body: OidcTokenAnswer = {
    token: value,
    expiresIn: expiresInSec,
    expiresAt: expiresAt.toISOString(),
    deviceId: jti,
    role: login?.role ?? 'member',
    loginId: row.id,
    ...(await brainIdField()),
    sso: true,
    ...(how === 'link' ? { linked: true as const } : {}),
  };
  return NextResponse.json(body, { headers: NO_STORE });
}

/** POST /api/auth/oidc/exchange. */
export async function oidcExchange(req: Request): Promise<NextResponse> {
  const s = oidcSettings();
  if (s.mode === 'off') return oidcOffAnswer();
  const parsed = Body.safeParse((await readJson(req)) ?? {});
  if (!parsed.success) return refused(401, CODE_GONE);
  const { code, verifier, deviceName } = parsed.data;
  const spent = await spendHandoffCode(handoffCodeHash(code), ['signin', 'link']);
  if (!spent?.challenge || !verifierMatches(verifier, spent.challenge)) {
    return refused(401, CODE_GONE);
  }
  // The login as the code found it: a disable, a password change or a sign
  // out everywhere since then ends the flow.
  const row = await oidcLoginRow(spent.loginId);
  if (!row?.usable || row.sessionEpoch !== spent.epoch) return refused(401, CODE_GONE);
  if (spent.purpose === 'signin') return bearerAnswer(req, s, row, deviceName, 'signin');

  const { identity } = spent;
  if (!identity) return refused(401, CODE_GONE);
  const result = await createLink(row.id, spent.epoch, identity);
  // The gate reads the link now, not a kept "unlinked" (hold.ts).
  forgetHolds(row.id);
  if (result === 'expired') return refused(401, CODE_GONE);
  if (result !== 'linked') {
    const error =
      result === 'taken'
        ? 'This company account is linked to another login.'
        : 'This login holds another company account. Remove that link first.';
    return refused(409, { error, code: result });
  }
  void notifyLinkMade(row.id);
  auditFireAndForget({
    actorId: row.id,
    actorEmail: row.email,
    action: 'auth.oidc_linked',
    method: 'POST',
    path: '/api/auth/oidc/exchange',
    // As at the callback: which provider account, for an admin (display
    // only, never matched on).
    detail: {
      issuer: identity.issuer,
      subject: identity.subject,
      display: identity.display,
      held: spent.held,
      handed: true,
    },
    ...requestMetaFrom(req),
  });
  if (spent.held) return bearerAnswer(req, s, row, deviceName, 'link');
  return NextResponse.json({ linked: true } satisfies OidcLinkAnswer, { headers: NO_STORE });
}
