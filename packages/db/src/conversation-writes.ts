/**
 * The one conversation store's writes (assistant_messages: recordTurn,
 * updateAssistantMessageOutcome and markTurnSuperseded in @mantle/runtime
 * agent/conversation.ts) on the system pool: systemDb, the narrow route in
 * a turn or request scope, as team-messages.ts writes a workspace thread's
 * rows. A turn's rows are the store the turn engine keeps for a login's
 * thread, never a write of the caller's scope: a login's scoped write sent
 * them to the system pool anyway.
 *
 * A row names its login whenever a login actor is bound (threadLoginFor).
 * On the system pool the database's stamp reads no login (the identity
 * readers answer none on the narrow route, and the system pool sets none),
 * so an unset login would land the row in the anchor's thread: a member's
 * turn in the owner's. With a login actor bound the row is that login's,
 * and a row naming another login is refused.
 */
import { and, eq, inArray, sql } from 'drizzle-orm';
import type { PostgresJsDatabase } from 'drizzle-orm/postgres-js';
import { currentActor } from './actor';
import { systemDb } from './client';
import { onFullSystemRoute } from './viewer';
import type * as schema from './schema/index';
import { assistantMessages, type AssistantMessage, type NewAssistantMessage } from './schema/index';

/** A caller's own transaction or pool, when it folds a turn row into a
 *  larger write; none: systemDb. */
export type ConversationExecutor = Pick<PostgresJsDatabase<typeof schema>, 'insert' | 'update'>;

/** A turn row naming a login other than the one bound. */
export class ThreadLoginMismatchError extends Error {
  constructor() {
    super(
      "a turn row names another login's thread than the login bound: a login writes only its own thread",
    );
    this.name = 'ThreadLoginMismatchError';
  }
}

/**
 * The login a turn row names. A login actor bound: that login (`loginId`,
 * when given, must be it, else ThreadLoginMismatchError); for the owner's
 * actor this is the anchor's own id, the row the stamp gave before. Any
 * other actor: `loginId` as given, or null (the stamp's: the anchor's).
 */
export function threadLoginFor(loginId: string | null | undefined): string | null {
  const actor = currentActor();
  if (actor?.kind !== 'login') return loginId ?? null;
  if (loginId && loginId.toLowerCase() !== actor.loginId) throw new ThreadLoginMismatchError();
  return actor.loginId;
}

/** Append one turn row (recordTurn). `values.loginId`: see threadLoginFor. */
export async function insertConversationRow(
  values: NewAssistantMessage,
  exec?: ConversationExecutor,
): Promise<AssistantMessage> {
  const { loginId: asked, ...rest } = values;
  const loginId = threadLoginFor(asked);
  const [row] = await (exec ?? systemDb)
    .insert(assistantMessages)
    .values({ ...rest, ...(loginId ? { loginId } : {}) })
    .returning();
  if (!row) throw new Error('recordTurn: insert returned no row');
  return row;
}

/** What a turn's outcome writes on its row (updateAssistantMessageOutcome):
 *  only the columns a settle holds (0323 lets the narrow role write them
 *  on a pending row). */
export type ConversationOutcome = {
  status: 'complete' | 'failed';
  text?: string;
  model?: string | null;
  error?: string | null;
  attachments?: NewAssistantMessage['attachments'];
  /** Merged into `data` (`data || patch`), never replacing it. */
  dataPatch?: Record<string, unknown>;
};

/** Settle the row `id` of brain `ownerId` (owner-scoped, as before). The
 *  row, or null if it vanished. */
export async function settleConversationRow(
  ownerId: string,
  id: string,
  outcome: ConversationOutcome,
  exec?: ConversationExecutor,
): Promise<AssistantMessage | null> {
  const patch = outcome.dataPatch ?? {};
  const [row] = await (exec ?? systemDb)
    .update(assistantMessages)
    .set({
      status: outcome.status,
      text: outcome.text,
      model: outcome.model,
      error: outcome.error,
      attachments: outcome.attachments,
      ...(Object.keys(patch).length > 0
        ? { data: sql`${assistantMessages.data} || ${JSON.stringify(patch)}::jsonb` }
        : {}),
    })
    .where(and(eq(assistantMessages.id, id), eq(assistantMessages.ownerId, ownerId)))
    .returning();
  return row ?? null;
}

/**
 * Stamp both rows of a cancelled turn pair `data.superseded_by` (the cancel
 * route's premature-Enter correction): the brain's rows of the login's
 * thread only (threadLoginFor), at the full-route spot turn-supersede. The
 * inbound row is settled, which the narrow role never rewrites (0323), so
 * this one write keeps the system pool it ran on. The rows stamped.
 */
export async function supersedeConversationTurn(args: {
  ownerId: string;
  inboundId: string;
  outboundId: string;
  newTurnId: string;
  loginId?: string | null;
}): Promise<number> {
  const loginId = threadLoginFor(args.loginId);
  const rows = await onFullSystemRoute('turn-supersede', () =>
    systemDb
      .update(assistantMessages)
      .set({
        data: sql`${assistantMessages.data} || ${JSON.stringify({ superseded_by: args.newTurnId })}::jsonb`,
      })
      .where(
        and(
          inArray(assistantMessages.id, [args.inboundId, args.outboundId]),
          eq(assistantMessages.ownerId, args.ownerId),
          loginId ? eq(assistantMessages.loginId, loginId) : undefined,
        ),
      )
      .returning({ id: assistantMessages.id }),
  );
  return rows.length;
}
