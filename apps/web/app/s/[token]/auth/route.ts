/**
 * POST /s/[token]/auth — exchange a contact TEAM TOKEN for a team-visitor
 * cookie on a team-mode app share.
 *
 * Rate-limited per IP AND per share (an unauthenticated endpoint taking a
 * short secret gets both). On success: sets the signed `mantle_team` cookie,
 * PATH-SCOPED to this share's /s/<token> so it authenticates nothing else,
 * bumps the token's last_used_at (inside verifyTeamToken) and writes an
 * 'auth' row to the app access log — the audit trail's "who paired" record.
 *
 * Every failure is a uniform 401 'invalid token': whether the share is
 * public-mode, the token is wrong, or it belongs to another brain's contact,
 * the response never distinguishes — nothing to enumerate.
 */
import { NextResponse } from 'next/server';
import { z } from 'zod';
import { resolveActiveShareByToken } from '@/lib/shares';
import { shareModeOf, verifyTeamToken, recordAppAccess } from '@mantle/content';
import { buildTeamVisitorCookie, TEAM_VISITOR_COOKIE } from '@/lib/auth';
import { secureCookies } from '@/lib/auth-constants';
import { rateLimit } from '@/lib/rate-limit';

export const runtime = 'nodejs';

const Body = z.object({ token: z.string().min(1).max(64) });

function clientIp(req: Request): string {
  const fwd = req.headers.get('x-forwarded-for');
  return fwd?.split(',')[0]?.trim() || 'local';
}

export async function POST(req: Request, ctx: { params: Promise<{ token: string }> }) {
  const { token: shareToken } = await ctx.params;

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
  if (!share || share.nodeType !== 'app') {
    return NextResponse.json({ ok: false, error: 'not found' }, { status: 404 });
  }

  const parsed = Body.safeParse(await req.json().catch(() => ({})));
  if (!parsed.success) return NextResponse.json({ ok: false, error: 'invalid input' }, { status: 400 });

  const member =
    shareModeOf(share) === 'team' ? await verifyTeamToken(parsed.data.token) : null;
  if (!member || member.ownerId !== share.ownerId) {
    return NextResponse.json({ ok: false, error: 'invalid token' }, { status: 401 });
  }

  recordAppAccess({
    ownerId: share.ownerId,
    appNodeId: share.nodeId,
    shareId: share.id,
    contactId: member.contactId,
    kind: 'auth',
  });

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
