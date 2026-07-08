/**
 * POST /s/[token]/auth — exchange a contact TEAM TOKEN for a team-visitor
 * cookie on a team-mode share (any kind — page, app, file, …).
 *
 * Rate-limited per IP AND per share (an unauthenticated endpoint taking a
 * short secret gets both). On success: sets the signed `mantle_team` cookie,
 * PATH-SCOPED to this share's /s/<token> so it authenticates nothing else,
 * marks the token used (audit liveness) and writes an 'auth' row to the
 * audit trail — the app access log for app shares (the "who paired" record),
 * the team access log for every other kind.
 *
 * Every non-rate-limit failure is a uniform 401 'invalid token' — a missing
 * share, a public-mode share, a wrong token, and a token from another brain
 * all return the same response, so nothing about which case applies can be
 * enumerated.
 */
import { NextResponse } from 'next/server';
import { z } from 'zod';
import { resolveActiveShareByToken } from '@/lib/shares';
import {
  shareModeOf,
  verifyTeamToken,
  markTeamTokenUsed,
  recordAppAccess,
  recordTeamAccess,
} from '@mantle/content';
import { buildTeamVisitorCookie, TEAM_VISITOR_COOKIE } from '@/lib/auth';
import { secureCookies } from '@/lib/auth-constants';
import { rateLimit, clientIp } from '@/lib/rate-limit';

export const runtime = 'nodejs';

const Body = z.object({ token: z.string().min(1).max(64) });

/** Uniform failure — never distinguishes "no such share" from "wrong token". */
function invalid() {
  return NextResponse.json({ ok: false, error: 'invalid token' }, { status: 401 });
}

export async function POST(req: Request, ctx: { params: Promise<{ token: string }> }) {
  const { token: shareToken } = await ctx.params;

  // clientIp counts hops from the RIGHT past MANTLE_TRUSTED_PROXIES — the
  // leftmost X-Forwarded-For entry is client-supplied and forgeable, so keying
  // on it would let an attacker mint a fresh per-IP bucket per request.
  const ipGate = rateLimit(`team-auth:ip:${clientIp(req)}`, { max: 8, windowMs: 60_000 });
  const shareGate = rateLimit(`team-auth:share:${shareToken}`, { max: 20, windowMs: 60_000 });
  if (!ipGate.ok || !shareGate.ok) {
    const retryAfterSec = Math.max(ipGate.retryAfterSec, shareGate.retryAfterSec);
    return NextResponse.json(
      { ok: false, error: 'too many attempts — try again shortly' },
      { status: 429, headers: { 'Retry-After': String(retryAfterSec) } },
    );
  }

  const share = await resolveActiveShareByToken(shareToken);
  if (!share) return invalid();

  const parsed = Body.safeParse(await req.json().catch(() => ({})));
  if (!parsed.success) return NextResponse.json({ ok: false, error: 'invalid input' }, { status: 400 });

  const member =
    shareModeOf(share) === 'team' ? await verifyTeamToken(parsed.data.token) : null;
  if (!member || member.ownerId !== share.ownerId) return invalid();

  // Mark used only now that the token is confirmed to belong to THIS share's
  // owner — so presenting a valid token from brain A to brain B's link never
  // touches brain A's row.
  await markTeamTokenUsed(share.ownerId, member.contactId);

  if (share.nodeType === 'app') {
    recordAppAccess({
      ownerId: share.ownerId,
      appNodeId: share.nodeId,
      shareId: share.id,
      contactId: member.contactId,
      kind: 'auth',
    });
  } else {
    recordTeamAccess({
      ownerId: share.ownerId,
      contactId: member.contactId,
      kind: 'auth',
      detail: { surface: 'share', shareId: share.id, nodeType: share.nodeType },
    });
  }

  const cookie = buildTeamVisitorCookie(share.id, member.contactId);
  const res = NextResponse.json({ ok: true });
  res.cookies.set(TEAM_VISITOR_COOKIE, cookie.value, {
    httpOnly: true,
    sameSite: 'lax',
    secure: secureCookies(req),
    path: `/s/${shareToken}`,
    maxAge: cookie.maxAgeSec,
  });
  return res;
}
