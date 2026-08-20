/**
 * Resolve a client-supplied context ref — "the thing the user is looking at" —
 * to a node the agent's existing tools can read.
 *
 * The client sends `{ kind, id }` where `id` is the id the SURFACE holds. That
 * is deliberately not always a node id (see `resolveContextRef`), so exactly one
 * function does the mapping and every consumer goes through it. Lives in
 * @mantle/db because it spans two schemas (`nodes`, `emails`) and is called from
 * both the web API and the agent runtime.
 *
 * Two rules this file exists to enforce, both from the 2026-08-19 design:
 *
 *  1. **Owner-scope everything.** `id` now arrives from the client and can be
 *     any uuid, so an unscoped lookup here is a cross-owner read.
 *  2. **Degrade, never throw.** A stale id after a delete is normal traffic, not
 *     an exceptional condition. Callers get `null` and carry on without context.
 */

import { and, eq } from 'drizzle-orm';
import { db } from './client';
import { nodeType, nodes } from './schema/nodes';
import { emailAccounts, emails } from './schema/emails';

/** The `node_type` enum's value union, derived so this file cannot drift from
 *  the schema when a node type is added or renamed. */
type NodeType = (typeof nodeType.enumValues)[number];

/**
 * The kinds a context ref may name. Mirrors jackdaw's `CONTEXT_KINDS`
 * (`client/web/components/assistant/assistant-dock.tsx`), which is the client's
 * source of truth for the same list.
 *
 * ⚠ These are two copies of one contract, kept in step by hand. They can only be
 * merged once the ref rides the wire as a structured block rather than the prose
 * preamble the client builds today — at which point it belongs in
 * `@mantle/client-types` with the other wire types. Until then, adding a kind
 * means editing both. An unknown kind resolves to `null` rather than erroring,
 * so a jackdaw that runs ahead of its brain degrades instead of breaking.
 */
export const CONTEXT_KINDS = [
  'file',
  'folder',
  'page',
  'note',
  'table',
  'journal',
  'task',
  'event',
  'app',
  'draw',
  'formula',
  'email',
  'contact',
] as const;

export type ContextKind = (typeof CONTEXT_KINDS)[number];

/** A ref as it arrives from the client. `id` is KIND-RELATIVE — see below. */
export type ContextRef = {
  kind: ContextKind;
  id: string;
  /** Cheap identifying data the client already had. Never trusted for lookups. */
  meta?: Record<string, string>;
};

/**
 * A resolved ref. `meta` is what the BRAIN learned during resolution, which the
 * client could not have sent — today only the mail thread key. Callers should
 * merge it over the client's own `meta`.
 */
export type ResolvedContextRef = {
  nodeId: string;
  /** The node's actual `nodes.type`, for callers that want to phrase a preamble. */
  type: NodeType;
  meta?: Record<string, string>;
};

/**
 * Context kind → `nodes.type`. Explicit rather than a cast, because the two
 * vocabularies are NOT the same: the client's `folder` is a `branch` node (the
 * generic container type used for note/journal/event/mail folders alike). Every
 * other kind happens to share its name today, but nothing enforces that, so the
 * map is written out in full.
 *
 * `email` is absent on purpose — its id is not a node id and it takes the lookup
 * path instead.
 */
export const NODE_TYPE_BY_KIND: Record<Exclude<ContextKind, 'email'>, NodeType> = {
  file: 'file',
  folder: 'branch',
  page: 'page',
  note: 'note',
  table: 'table',
  journal: 'journal',
  task: 'task',
  event: 'event',
  app: 'app',
  draw: 'draw',
  formula: 'formula',
  contact: 'contact',
};

/**
 * Map a context ref to a node id, scoped to `ownerId`. Returns `null` for
 * anything that does not resolve — unknown kind, wrong owner, deleted row, a
 * kind that disagrees with the node's real type.
 *
 * **`id` is kind-relative.** For every kind except `email` the surface id IS the
 * node id, so this is an existence-and-ownership check rather than a mapping.
 * For `email` the surface holds the `emails` row id — the node id is dropped
 * from `MessageDetailDTO` by design and never reaches the client — so that kind
 * takes one indexed hop through `emails.node_id`. Passing a node id for an
 * `email` ref resolves to nothing; that is the documented footgun of the typed
 * union, and it is silent by rule 2 above.
 *
 * The design note called the identity path "free of a round trip". It is not,
 * quite: it costs one primary-key lookup, because rule 1 (owner-scope
 * everything) cannot be satisfied without reading the row. Correctness wins over
 * saving an indexed PK hit — what the note was guarding against was a join or a
 * mapping table, and there is neither.
 */
export async function resolveContextRef(
  ownerId: string,
  ref: ContextRef,
): Promise<ResolvedContextRef | null> {
  if (!ownerId || !ref?.id || !ref?.kind) return null;

  try {
    if (ref.kind === 'email') return await resolveEmailRef(ownerId, ref.id);

    const expected = NODE_TYPE_BY_KIND[ref.kind as Exclude<ContextKind, 'email'>];
    if (!expected) return null; // kind from a newer client than this brain

    const [row] = await db
      .select({ id: nodes.id, type: nodes.type })
      .from(nodes)
      .where(and(eq(nodes.id, ref.id), eq(nodes.ownerId, ownerId), eq(nodes.type, expected)))
      .limit(1);

    return row ? { nodeId: row.id, type: row.type } : null;
  } catch {
    // Rule 2: a malformed uuid makes Postgres throw on the cast. That is a
    // degenerate ref, not an outage — the turn proceeds without context.
    return null;
  }
}

/**
 * `emails.id → emails.node_id`, owner-scoped through the account, plus the
 * thread key the client could not supply.
 *
 * Jason settled 2026-08-20 that an `email` ref means the THREAD — "replying
 * means the whole conversation". It resolves to the MESSAGE node anyway, because
 * `email_thread` is a declared node type that nothing populates: there is no
 * `email_threads` table and no insert anywhere, so a thread node cannot be
 * returned. Instead the provider's thread key rides back in `meta`, and a caller
 * can pull the conversation with one indexed query — `where account_id = ? and
 * thread_id = ?`, owner-scoped like everything else (`emails_thread_idx`).
 *
 * ⚠ `threadId` is nullable — IMAP without threading headers, and historical
 * rows. Then `meta` simply carries no thread and the ref means the single
 * message. That fallback is silent by design.
 */
async function resolveEmailRef(
  ownerId: string,
  emailId: string,
): Promise<ResolvedContextRef | null> {
  const [row] = await db
    .select({
      nodeId: emails.nodeId,
      threadId: emails.threadId,
      accountId: emails.accountId,
    })
    .from(emails)
    .innerJoin(emailAccounts, eq(emails.accountId, emailAccounts.id))
    .where(and(eq(emails.id, emailId), eq(emailAccounts.userId, ownerId)))
    .limit(1);

  if (!row?.nodeId) return null;

  return {
    nodeId: row.nodeId,
    type: 'email',
    // Only a real thread key is worth sending; accountId is what makes it
    // queryable, so the two travel together or not at all.
    meta: row.threadId ? { threadId: row.threadId, accountId: row.accountId } : undefined,
  };
}
