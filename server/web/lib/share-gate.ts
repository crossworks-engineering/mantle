/**
 * The /s gate: an open share link by its token. Every /s route and the
 * share page open the link here, so the request runs as the link (the
 * `link` actor: it reads, it writes nothing). Contact shares, their codes
 * and their cookie are gone (migration 0378): every live share is an open
 * link.
 */
import { setRequestActor } from '@mantle/db';
import type { Share } from '@mantle/db';
import { resolveActiveShareByToken } from '@/lib/shares';

/** The active link this token names, its request bound to the link actor;
 *  null when there is none (revoked, expired, never was): the route's own
 *  not-found. */
export async function openShareLink(token: string): Promise<Share | null> {
  const share = await resolveActiveShareByToken(token);
  if (!share) return null;
  setRequestActor({ kind: 'link' });
  return share;
}
