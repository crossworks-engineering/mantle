/**
 * POST /s/[token]/code { code } — a contact types their code at a contact
 * share's prompt (contact shares, migration 0214; docs/sharing.md).
 *
 * The code is trimmed, its spaces dropped, then checked in constant time
 * against the HMAC of the contact the SHARE names. Every failure (a wrong
 * code, sharing off, a locked contact, a revoked or missing share, an open
 * link) is the same 401 after the same work (checkContactShareCode).
 *
 * Limits: per address (an IPv4 address or an IPv6 /64) 10 a minute and 30
 * an hour; per share 10 failures an hour; per contact 30 failures a day,
 * then a 24-hour lock, an audit row and an admin notice in "Needs you". The
 * share and contact counters live in the database, so a restart or a second
 * web process does not reset them. The attacker needs the 128-bit link
 * first, then faces 46 bits at 30 tries a day.
 *
 * A good code sets the `mantle_contact` visitor cookie (path /s/, so the
 * contact's other links open with no prompt) and writes
 * `auth.contact_code_signin`; a bad one writes `auth.contact_code_failed`.
 */
import { NextResponse } from '@/server/http-compat';
import { z } from 'zod';
import { checkContactShareCode, resolveActiveShareRowByToken } from '@mantle/content';
import { setContactVisitorCookie } from '@/lib/contact-share-gate';
import { auditFireAndForget, requestMetaFrom } from '@/lib/audit';
import { rateLimited, refuseCrossSiteAuthPost } from '@/lib/auth/preflight';
import { AUTH_BODY_CEILING_BYTES, readJsonCapped } from '@/lib/body-limit';
import { clientIpKey, rateLimit } from '@/lib/rate-limit';

const Body = z.object({ code: z.string().max(64) });

const PATH = '/s/:token/code';

/** Uniform failure: never says which case applied. */
function invalid() {
  return NextResponse.json(
    { ok: false, error: 'That code was not recognised.' },
    { status: 401, headers: { 'cache-control': 'no-store' } },
  );
}

export async function POST(req: Request, ctx: { params: Promise<{ token: string }> }) {
  const refused = refuseCrossSiteAuthPost(req);
  if (refused) return refused;
  const { token } = await ctx.params;

  const ip = clientIpKey(req);
  const denied = rateLimited(
    rateLimit(`contact-code:ip:${ip}`, { max: 10, windowMs: 60_000 }),
    rateLimit(`contact-code:ip-hour:${ip}`, { max: 30, windowMs: 60 * 60_000 }),
  );
  if (denied) return denied;

  const parsed = Body.safeParse(await readJsonCapped(req, AUTH_BODY_CEILING_BYTES));
  const share = await resolveActiveShareRowByToken(token);
  // The same check runs for every case: an open link and a missing share
  // check against no contact, so the work does not tell them apart.
  const result = await checkContactShareCode(
    share ? { id: share.id, ownerId: share.ownerId, contactId: share.contactId ?? null } : null,
    parsed.success ? parsed.data.code : '',
  );
  const meta = requestMetaFrom(req);
  if (!result.ok) {
    auditFireAndForget({
      actorEmail: '(contact code)',
      action: 'auth.contact_code_failed',
      method: 'POST',
      path: PATH,
      detail: {
        ...(share ? { shareId: share.id } : {}),
        ...(result.contactId ? { contactId: result.contactId } : {}),
        ...(result.lockedNow ? { locked: true } : {}),
      },
      ...meta,
    });
    if (result.lockedNow) {
      auditFireAndForget({
        actorEmail: '(contact code)',
        action: 'contact.sharing_locked',
        method: 'POST',
        path: PATH,
        detail: { contactId: result.contactId, shareId: share?.id ?? null },
        ...meta,
      });
    }
    return invalid();
  }

  auditFireAndForget({
    actorEmail: '(contact code)',
    action: 'auth.contact_code_signin',
    method: 'POST',
    path: PATH,
    detail: { contactId: result.contactId, shareId: share!.id },
    ...meta,
  });
  const res = NextResponse.json({ ok: true }, { headers: { 'cache-control': 'no-store' } });
  setContactVisitorCookie(res, req, {
    contactId: result.contactId,
    ownerId: result.ownerId,
    codeEpoch: result.codeEpoch,
  });
  return res;
}
