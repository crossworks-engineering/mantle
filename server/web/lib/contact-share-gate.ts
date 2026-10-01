/**
 * The /s gate for CONTACT shares (contact shares, migration 0214; docs/
 * sharing.md, "Contact shares"). Modelled on the retired team gate (cookie
 * checked, liveness re-checked on every call).
 *
 * An open link (no contact) passes as before. A contact share passes only
 * when:
 *  - the share is active and not expired (resolveActiveShareRowByToken);
 *  - the contact's code row has a code (sharing on), is not locked, and
 *    belongs to the share's brain;
 *  - a visitor value in the `mantle_contact` cookie names THIS contact, this
 *    brain, and the row's current code epoch.
 * Otherwise the page route shows the code prompt (no item title, no contact
 * name) and every other route answers 401. Nothing here trusts a contact id
 * from the URL or the body: the contact is always the one the SHARE names.
 */
import { NextResponse } from '@/server/http-compat';
import { contactShareGateRow, type ContactShareGateRow } from '@mantle/content';
import { resolveActiveShareRowByToken } from '@/lib/shares';
import type { Share } from '@mantle/db';
import {
  CONTACT_VISITOR_COOKIE,
  buildContactVisitorValue,
  verifyContactVisitorValue,
  type ContactVisitorClaims,
} from '@/lib/auth';
import { cookieValues } from '@/lib/auth/request';
import { secureCookies } from '@/lib/auth-constants';

/** A browser keeps at most this many contacts' values in the cookie. */
export const CONTACT_COOKIE_MAX_VALUES = 8;
/** Values are joined by this (never in a base64url value or its dot). */
const JOIN = '~';

export type ShareGate =
  /** Pass: an open link (`contact` null) or a contact share whose gate held. */
  | { kind: 'ok'; share: Share; contact: { contactId: string; codeEpoch: number } | null }
  /** A live contact share with no admitting cookie: prompt or 401. */
  | { kind: 'code'; share: Share }
  /** No such active share: the route's own not-found. */
  | { kind: 'missing' };

/** Every contact visitor value the request carries (one cookie, maybe
 *  several values; a stray second cookie of the same name too). */
export function contactVisitorValues(cookieHeader: string | null): string[] {
  return cookieValues(cookieHeader, CONTACT_VISITOR_COOKIE)
    .flatMap((v) => v.split(JOIN))
    .filter(Boolean)
    .slice(0, CONTACT_COOKIE_MAX_VALUES * 2);
}

/** Does a contact's live gate row admit these claims for this share? */
export function claimsAdmit(
  claims: ContactVisitorClaims | null,
  share: Pick<Share, 'ownerId' | 'contactId'>,
  row: ContactShareGateRow | null,
): boolean {
  return (
    !!claims &&
    !!row &&
    row.open &&
    !!share.contactId &&
    row.ownerId === share.ownerId &&
    claims.contactId === share.contactId &&
    claims.ownerId === share.ownerId &&
    claims.codeEpoch === row.codeEpoch
  );
}

/** Resolve a token and run the gate on the request's cookie. */
export async function gateShare(req: Request, token: string): Promise<ShareGate> {
  return gateShareCookie(req.headers.get('cookie'), token);
}

export async function gateShareCookie(
  cookieHeader: string | null,
  token: string,
): Promise<ShareGate> {
  const share = await resolveActiveShareRowByToken(token);
  if (!share) return { kind: 'missing' };
  if (!share.contactId) return { kind: 'ok', share, contact: null };
  const row = await contactShareGateRow(share.contactId);
  for (const value of contactVisitorValues(cookieHeader)) {
    if (claimsAdmit(verifyContactVisitorValue(value), share, row)) {
      return {
        kind: 'ok',
        share,
        contact: { contactId: share.contactId, codeEpoch: row!.codeEpoch },
      };
    }
  }
  return { kind: 'code', share };
}

/** The live check a frame ticket gets (the frame navigation carries no
 *  cookie): the contact and epoch the ticket names must still admit. */
export async function contactTicketAdmits(
  share: Share,
  ticket: { contactId?: string; codeEpoch?: number },
): Promise<boolean> {
  if (!share.contactId) return ticket.contactId === undefined;
  if (ticket.contactId !== share.contactId || ticket.codeEpoch === undefined) return false;
  const row = await contactShareGateRow(share.contactId);
  return claimsAdmit(
    {
      contactId: ticket.contactId,
      ownerId: share.ownerId,
      codeEpoch: ticket.codeEpoch,
      issuedAt: 0,
    },
    share,
    row,
  );
}

/** The 401 every /s route but the page answers on a contact share without
 *  an admitting cookie. Says nothing about the item or the contact. */
export function contactCodeRequired(): Response {
  return NextResponse.json(
    { ok: false, error: 'code required' },
    { status: 401, headers: { 'cache-control': 'no-store' } },
  );
}

/**
 * Set the contact visitor cookie after a good code: the new value, plus the
 * values the browser already holds for OTHER contacts that still verify,
 * newest first, at most {@link CONTACT_COOKIE_MAX_VALUES}. Path /s/, so the
 * contact's other links open with no prompt. SameSite=Lax: the link is
 * opened from mail or chat.
 */
export function setContactVisitorCookie(
  res: NextResponse,
  req: Request,
  claims: { contactId: string; ownerId: string; codeEpoch: number },
): void {
  const minted = buildContactVisitorValue(claims);
  const kept = contactVisitorValues(req.headers.get('cookie')).filter((v) => {
    const c = verifyContactVisitorValue(v);
    return !!c && c.contactId !== claims.contactId;
  });
  const values = [minted.value, ...kept].slice(0, CONTACT_COOKIE_MAX_VALUES);
  res.cookies.set(CONTACT_VISITOR_COOKIE, values.join(JOIN), {
    httpOnly: true,
    sameSite: 'lax',
    secure: secureCookies(req),
    path: '/s/',
    maxAge: minted.maxAgeSec,
  });
}
