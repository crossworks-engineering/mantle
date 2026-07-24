/**
 * POST /api/team/auth — exchange a contact TEAM TOKEN for a team-chat
 * credential.
 *
 * Two modes, one verification path:
 *   - default: sets the signed `mantle_team_chat` cookie (brain-level, path
 *     `/` — see lib/auth.ts for why that's safe). Same-origin browsers.
 *   - `mode:'bearer'`: returns the SAME signed value in the body
 *     (`{teamToken, expiresAt}`) and sets nothing — the split client app holds
 *     it in localStorage and sends `Authorization: Bearer` (cookies can't
 *     cross origins; resolveTeamChatCaller verifies both carriers alike).
 *
 * The /team analogue of /s/[token]/auth: rate-limited per IP AND globally (an
 * unauthenticated endpoint taking a short secret gets both), uniform 401 on
 * every failure so nothing about which case applies can be enumerated. On
 * success either way: marks the token used and writes an 'auth' row to the
 * team access log.
 */
import { NextResponse } from '@/server/http-compat';
import { z } from 'zod';
import { verifyTeamToken, markTeamTokenUsed, recordTeamAccess } from '@mantle/content';
import { buildTeamChatToken, TEAM_CHAT_COOKIE } from '@/lib/auth';
import { secureCookies } from '@/lib/auth-constants';
import { rateLimit, clientIp } from '@/lib/rate-limit';

const Body = z.object({
  token: z.string().min(1).max(64),
  mode: z.enum(['cookie', 'bearer']).optional(),
});

function invalid() {
  return NextResponse.json({ ok: false, error: 'invalid token' }, { status: 401 });
}

export async function POST(req: Request) {
  // Same posture as the app-share exchange: per-IP (rightmost trusted hop) +
  // a global bucket standing in for per-share (this surface is brain-level).
  const ipGate = rateLimit(`team-chat-auth:ip:${clientIp(req)}`, { max: 8, windowMs: 60_000 });
  const globalGate = rateLimit('team-chat-auth:global', { max: 30, windowMs: 60_000 });
  if (!ipGate.ok || !globalGate.ok) {
    const retryAfterSec = Math.max(ipGate.retryAfterSec, globalGate.retryAfterSec);
    return NextResponse.json(
      { ok: false, error: 'too many attempts — try again shortly' },
      { status: 429, headers: { 'Retry-After': String(retryAfterSec) } },
    );
  }

  const parsed = Body.safeParse(await req.json().catch(() => ({})));
  if (!parsed.success) {
    return NextResponse.json({ ok: false, error: 'invalid input' }, { status: 400 });
  }

  const member = await verifyTeamToken(parsed.data.token);
  if (!member) return invalid();

  await markTeamTokenUsed(member.ownerId, member.contactId);
  recordTeamAccess({
    ownerId: member.ownerId,
    contactId: member.contactId,
    kind: 'auth',
    detail: { surface: 'team-chat' },
  });

  const minted = buildTeamChatToken(member.ownerId, member.contactId);
  if (parsed.data.mode === 'bearer') {
    // The split client stores this and authenticates by header — no cookie.
    return NextResponse.json({ ok: true, teamToken: minted.value, expiresAt: minted.expiresAt });
  }
  const res = NextResponse.json({ ok: true });
  res.cookies.set(TEAM_CHAT_COOKIE, minted.value, {
    httpOnly: true,
    sameSite: 'lax',
    secure: secureCookies(req),
    path: '/',
    maxAge: minted.maxAgeSec,
  });
  return res;
}
