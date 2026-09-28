/**
 * The small shared core of a personal space (member logins Phase 2): the
 * state error the routes map to 409/404, the scope guard, and the item cap.
 * Split out so member-space.ts and member-space-files.ts share it without
 * importing each other.
 */
import { and, eq, ne, sql } from 'drizzle-orm';
import { currentSpaceScope, db, nodes } from '@mantle/db';

/** Thrown when an item may not change now: it is submitted (frozen), or the
 *  requested move is not allowed from its state (routes answer 409), or it is
 *  not the caller's to change at all (`not-found`, routes answer 404: another
 *  member's item looks exactly like one that does not exist). */
export class SpaceItemStateError extends Error {
  constructor(
    readonly reason:
      | 'not-found'
      | 'frozen'
      | 'not-draft'
      | 'not-submitted'
      | 'unsaved-draft'
      | 'quota'
      | 'embed'
      | 'not-shared'
      | 'too-large'
      | 'invalid'
      // An admin took the item over (audit F07): the member cannot open or
      // change it until it comes back.
      | 'with-admin'
      // Give back refused: the author cannot take it (deactivated, deleted,
      // no longer a member). Accept or delete it instead.
      | 'author-inactive'
      // A taken item of an author who can take it back: give it back
      // instead of deleting it.
      | 'taken',
    message: string,
    /** For `embed`: the referenced ids the item may not use. */
    readonly ids: string[] = [],
  ) {
    super(message);
    this.name = 'SpaceItemStateError';
  }
}

/** Another member's item looks exactly like one that does not exist. */
export const spaceNotFound = () => new SpaceItemStateError('not-found', 'Not found.');

/** The caller's own space scope, or a loud error: every "Mine" function runs
 *  inside `withSpace` for exactly this space. */
export function requireSpace(spaceId: string): { spaceId: string; loginId: string } {
  const scope = currentSpaceScope();
  if (!scope || scope.spaceId !== spaceId) {
    throw new Error('personal space read outside its space scope: wrap it in withSpace');
  }
  return scope;
}

/**
 * Serialize one space's quota checks (audit D3): two uploads, or an upload
 * and a table save, must not both pass the same headroom. A transaction
 * advisory lock, held until the caller's space transaction ends, so the
 * check and the write it guards are one step.
 */
export async function lockSpaceQuota(spaceId: string): Promise<void> {
  requireSpace(spaceId);
  await db.execute(
    sql`select pg_advisory_xact_lock(hashtextextended(${`space-quota:${spaceId}`}, 0))`,
  );
}

/** Items one personal space may hold (plan section 8, quotas). Folders a
 *  space makes for itself (the per-kind roots) do not count. */
export const SPACE_ITEM_LIMIT = 2000;

/** Refuse a new item when the space already holds SPACE_ITEM_LIMIT. */
export async function assertItemRoom(spaceId: string): Promise<void> {
  requireSpace(spaceId);
  const [held] = await db
    .select({ n: sql<number>`count(*)::int` })
    .from(nodes)
    .where(and(eq(nodes.ownerId, spaceId), ne(nodes.type, 'branch')));
  if ((held?.n ?? 0) >= SPACE_ITEM_LIMIT) {
    throw new SpaceItemStateError(
      'quota',
      `Your space is full (${SPACE_ITEM_LIMIT} items). Delete something first.`,
    );
  }
}
