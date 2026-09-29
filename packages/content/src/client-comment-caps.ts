/**
 * The comment caps where a CLIENT writes (client logins C5 audit, I2): a
 * client login writes at most CLIENT_COMMENTS_PER_DAY comments in 24 hours
 * across every thread (its review talk and the client threads), and one
 * thread holds at most THREAD_COMMENT_LIMIT comments.
 *
 * The day count is a ledger (client_comment_ledger, migration 0195), not the
 * comments: deleting a comment never gives its place back. The review talk
 * runs in the client's own space (the space role records its own login's
 * rows); the client thread is written on the admin pool, which records there
 * too. Each check runs in the writer's transaction under an advisory lock
 * (the login's count, then the thread's), so two tabs cannot both take the
 * last place.
 */
import { and, eq, gt, sql } from 'drizzle-orm';
import { asSystem, clientCommentLedger, db, nodeComments } from '@mantle/db';
import { errorMessage } from '@mantle/std';
import { SpaceItemStateError } from './member-space-core';
import { CLIENT_COMMENTS_PER_DAY, THREAD_COMMENT_LIMIT } from './space-limits';
import { recordClientQuotaRefusal } from './client-quota-log';

type Tx = Parameters<Parameters<typeof db.transaction>[0]>[0];
type Via = Pick<Tx, 'select' | 'insert' | 'execute'>;

/** Which thread a comment joins: a client's review talk, or the client
 *  thread on a client-level item. */
export type CappedThread = 'review' | 'client';

const lock = (via: Via, key: string) =>
  via.execute(sql`select pg_advisory_xact_lock(hashtextextended(${key}, 0))`);

/** The day cap's refusal (routes answer 429 `comment-cap`). */
export const commentCapError = () =>
  new SpaceItemStateError(
    'comment-cap',
    `You can write ${CLIENT_COMMENTS_PER_DAY} comments a day. Try again tomorrow.`,
  );

/** A full thread's refusal (routes answer 409 `thread-full`). */
export const threadFullError = () =>
  new SpaceItemStateError(
    'thread-full',
    `This discussion is full (${THREAD_COMMENT_LIMIT} comments). Start a new request instead.`,
  );

/**
 * Refuse a comment on a thread that already holds THREAD_COMMENT_LIMIT
 * comments of its scope (409 `thread-full`). Locks the thread for the rest of
 * the writer's transaction first. Reads through `via`: in a client's space
 * the space role counts what it can see of the review talk, which is every
 * comment there (a client's item is never team-shared).
 */
export async function assertThreadRoom(
  via: Via,
  nodeId: string,
  scope: CappedThread,
): Promise<void> {
  await lock(via, `comment-thread:${nodeId}`);
  const [r] = await via
    .select({ n: sql<number>`count(*)::int` })
    .from(nodeComments)
    .where(and(eq(nodeComments.nodeId, nodeId), eq(nodeComments.threadScope, scope)));
  if ((r?.n ?? 0) >= THREAD_COMMENT_LIMIT) throw threadFullError();
}

/**
 * Take one of a CLIENT login's comment places for today, in the writer's
 * transaction: refuse at the day cap (`comment-cap`) or on a full thread
 * (`thread-full`), both recorded for the admin card; else one ledger row,
 * which commits with the comment (and rolls back with it). Deleting the
 * comment later never removes the row.
 */
export async function takeClientCommentPlace(
  via: Via,
  loginId: string,
  nodeId: string,
  scope: CappedThread,
): Promise<void> {
  await lock(via, `client-comments:${loginId}`);
  const [r] = await via
    .select({ n: sql<number>`count(*)::int` })
    .from(clientCommentLedger)
    .where(
      and(
        eq(clientCommentLedger.loginId, loginId),
        gt(clientCommentLedger.createdAt, sql`now() - interval '24 hours'`),
      ),
    );
  if ((r?.n ?? 0) >= CLIENT_COMMENTS_PER_DAY) {
    await recordClientQuotaRefusal(loginId, 'comment-cap');
    throw commentCapError();
  }
  try {
    await assertThreadRoom(via, nodeId, scope);
  } catch (err) {
    if (err instanceof SpaceItemStateError && err.reason === 'thread-full') {
      await recordClientQuotaRefusal(loginId, 'thread-full');
    }
    throw err;
  }
  await via.insert(clientCommentLedger).values({ loginId });
  await trimLedger(loginId);
}

/** Drop this login's ledger rows older than two days (the cap reads one):
 *  on the admin pool, since nothing below admin deletes from it. Never
 *  throws. */
async function trimLedger(loginId: string): Promise<void> {
  try {
    await asSystem(() =>
      db.execute(sql`
        delete from client_comment_ledger
         where login_id = ${loginId} and created_at < now() - interval '2 days'`),
    );
  } catch (err) {
    console.error('[client-comments] ledger trim failed:', errorMessage(err));
  }
}
