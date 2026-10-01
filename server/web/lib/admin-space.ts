/**
 * The HTTP side of an ADMIN's private space (member logins Phase 7, Jason
 * 2026-09-28). Every login has a personal space (migration 0165); an admin
 * keeps items private there, edits and saves them, and accepts them into the
 * brain themselves, with no review. No share, submit, recall or comments:
 * nobody else ever reads an admin's private item, not another admin and not
 * a member.
 *
 * The routes under /api/admin/space mirror the member ones (same methods,
 * bodies, query params and response shapes), so a client swaps the base
 * path. They pass the admin gate (getOwnerOr401: a member gets 403
 * `member-login`), then act for the admin's OWN space: the acting login's
 * (`actor.id`), never the anchor's for another admin. The work runs through
 * the same content functions inside `withSpace`, so row security holds every
 * read and write to that one space, exactly as for a member.
 */
import { withSpace } from '@mantle/db';
import { takenFromOf, type SpaceItemRow, type SpaceWriter } from '@mantle/content';
import type { AdminSpaceItemRow } from '@mantle/client-types';
import { NextResponse } from '@/server/http-compat';
import { getOwnerForAsset, getOwnerOr401, type SessionUser } from '@/lib/auth';
import { loadPersonalSpaceId } from '@/lib/auth/login-row';

export type AdminSpaceCaller = {
  /** The brain (the anchor's id): what Accept moves an item into. */
  brainId: string;
  /** The acting admin login. */
  loginId: string;
  /** That login's own personal space. */
  spaceId: string;
  user: SessionUser;
};

async function spaceOf(user: SessionUser): Promise<AdminSpaceCaller> {
  const spaceId = await loadPersonalSpaceId(user.actor.id);
  // Made with the login by a trigger, or lazily above; none is a broken row.
  if (!spaceId) throw new Error('admin space: the login has no personal space');
  return { brainId: user.id, loginId: user.actor.id, spaceId, user };
}

/** The admin gate, then the caller's own space. */
export async function getAdminSpaceOr401(): Promise<AdminSpaceCaller | NextResponse> {
  const user = await getOwnerOr401();
  if (user instanceof NextResponse) return user;
  return spaceOf(user);
}

/** The owner asset gate (a session, or an `?at=` token whose `act` names the
 *  login it was minted for), then that login's own space. */
export async function getAdminSpaceForAsset(
  req: Request,
): Promise<AdminSpaceCaller | NextResponse> {
  const user = await getOwnerForAsset(req);
  if (user instanceof NextResponse) return user;
  return spaceOf(user);
}

/** Run `fn` inside the admin's own space. */
export function inAdminSpace<T>(caller: AdminSpaceCaller, fn: () => Promise<T>): Promise<T> {
  return withSpace({ spaceId: caller.spaceId, loginId: caller.loginId }, fn);
}

/** The embed rule's writer: this admin, for their brain (the brain's items
 *  at every level may be used; member-space.ts re-checks the login). */
export function adminWriter(caller: AdminSpaceCaller): SpaceWriter {
  return { adminOfBrain: caller.brainId };
}

/** The admin space's rows with whom each taken one was taken from (audit
 *  F07: `takenFrom`, null for the admin's own items). */
export async function withTakenFrom(
  caller: AdminSpaceCaller,
  rows: SpaceItemRow[],
): Promise<AdminSpaceItemRow[]> {
  const taken = rows.filter((r) => r.reviewState === 'taken').map((r) => r.id);
  const from = await takenFromOf(caller.spaceId, taken);
  return rows.map((r) => ({ ...r, takenFrom: from.get(r.id) ?? null }));
}

/** One item's answer (`{ row, body }`) with `takenFrom` on its row. */
export async function itemWithTakenFrom<T extends { row: SpaceItemRow }>(
  caller: AdminSpaceCaller,
  got: T,
): Promise<T & { row: AdminSpaceItemRow }> {
  const [row] = await withTakenFrom(caller, [got.row]);
  return { ...got, row: row! };
}
