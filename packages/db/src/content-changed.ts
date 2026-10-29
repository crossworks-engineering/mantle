/**
 * The one way a write re-indexes its item (docs/content.md,
 * "Re-index after a write").
 *
 * A service that changed an item calls `markContentChanged(tx, node, fields)`
 * inside the write's own transaction, after the write, naming the fields it
 * changed. The kind registry (`indexed`, @mantle/client-types/kinds) says
 * what each field feeds, and the most any of them asks for is done once:
 *
 *  - 'embed': the vector is cleared and the summary kept; the extractor
 *    re-embeds the item from its title and that summary (one local
 *    embedding, no model call);
 *  - 'extract': the vector and the summary keys are cleared; the extractor
 *    runs its whole pass (one model call);
 *  - nothing: no field the write changed feeds the index; no reset, no
 *    announcement.
 *
 * The reset stamps the work it asks for on the row, `data.index_work`
 * (INDEX_WORK_KEY), which is what the extractor's gate reads: an 'embed'
 * stamp is never a model call (re-embedded from the kept summary, or, with
 * none, from the title and the text read locally), whatever else the row
 * holds. An 'extract' stamp is never downgraded: a rename that lands while a
 * content change still waits for its pass keeps 'extract', so the new
 * content is still summarised. The extractor drops the stamp when it has done
 * the work. The stamp is set, read and dropped through index-work.ts only,
 * and this file is its only setter.
 *
 * The announcement is a `pg_notify` on the write's transaction, so Postgres
 * delivers it once the write commits and drops it when the write rolls back:
 * the extractor never reads a row that is not there yet, and a refused write
 * starts no work. A personal-space write and a quiet create are never
 * announced (as notifyNodeIngested; cost safety).
 *
 * `resignalNode` is the other door, for work that changes nothing: a sweep
 * or a tool that asks the extractor to look at an item again. Nothing else
 * calls notifyNodeIngested, clears an embedding or drops a summary by hand
 * (pinned at 0 outside the named files, eslint-rules/arch-counts.mjs).
 *
 * One door, so every kind re-indexes alike (hand-rolled copies disagree: a
 * rename re-indexing a task but never a note). The extractor's boot drain and
 * periodic sweep (server/api/src/agent/runtime.ts) stay as the safety net for
 * a notify lost while the agent was down.
 */
import { eq, sql } from 'drizzle-orm';
import type { PostgresJsDatabase } from 'drizzle-orm/postgres-js';
import {
  indexWorkFor,
  type IndexWork,
  type IndexedField,
  type ItemKind,
} from '@mantle/client-types/kinds';
import type * as schema from './schema/index';
import { nodes, type Node } from './schema/nodes';
import { notifyNodeIngested } from './notify';
import { stampIndexWork } from './index-work';
import { currentCreateHome, currentSpaceScope } from './viewer';

/** The keys of nodes.data an 'extract' reset drops: what the extractor
 *  derived from the old content (it writes them again). */
export const SUMMARY_KEYS = ['summary', 'summary_model', 'summary_at', 'entities'] as const;

const DROP_SUMMARY = sql.raw(`array[${SUMMARY_KEYS.map((k) => `'${k}'`).join(', ')}]::text[]`);

/** Any transaction (or pool) of the schema: db.transaction's, the heads
 *  helpers', a scope's. */
export type ContentTx = Pick<PostgresJsDatabase<typeof schema>, 'update' | 'execute'>;

/**
 * Reset what the fields `changed` of `node` feed and announce it, on `tx`,
 * after the write that changed them. Returns the row as the reset left it
 * (the caller answers with it), or null when nothing was reset.
 */
export async function markContentChanged<K extends ItemKind>(
  tx: ContentTx,
  node: { readonly id: string; readonly type: K },
  changed: readonly IndexedField<K>[],
): Promise<Node | null> {
  const work = indexWorkFor(node.type, changed);
  if (!work) return null;
  const [row] = await resetIndex(tx, node.id, work);
  await announce(tx, node.id);
  return row ?? null;
}

/** The reset itself: one UPDATE of the item's own row. An 'embed' reset
 *  stamps 'embed' unless a content change is still waiting ('extract'). */
function resetIndex(tx: ContentTx, id: string, work: IndexWork) {
  return tx
    .update(nodes)
    .set({ embedding: null, data: stampIndexWork(work, DROP_SUMMARY) })
    .where(eq(nodes.id, id))
    .returning();
}

/** The announcement on the write's transaction: delivered at its commit. */
async function announce(tx: ContentTx, id: string): Promise<void> {
  // Never announced (as notifyNodeIngested): a personal item, and a quiet
  // create (a read-only snapshot copy).
  if (currentSpaceScope()) return;
  if (currentCreateHome()?.quiet) return;
  await tx.execute(sql`select pg_notify('node_ingested', ${id}::text)`);
}

/**
 * Ask the extractor to look at `nodeId` again when nothing about it changed:
 * the reindex tool, a hand-run re-scan. Best effort, outside any
 * transaction (notifyNodeIngested). A write that changed the item calls
 * markContentChanged instead.
 */
export async function resignalNode(nodeId: string): Promise<void> {
  await notifyNodeIngested(nodeId);
}

/** The names among `pairs` whose two values differ: the fields a write
 *  changed, for markContentChanged. Compared as JSON with object keys in one
 *  order (a value read back from jsonb has its keys in jsonb's order), and
 *  undefined the same as null. */
export function changedFields<F extends string>(
  pairs: Partial<Record<F, readonly [unknown, unknown]>>,
): F[] {
  const out: F[] = [];
  for (const [name, pair] of Object.entries(pairs) as Array<[F, readonly [unknown, unknown]]>) {
    if (!pair) continue;
    if (canonicalJson(pair[0]) !== canonicalJson(pair[1])) out.push(name);
  }
  return out;
}

function canonicalJson(value: unknown): string {
  return JSON.stringify(value ?? null, (_k, v: unknown) =>
    v && typeof v === 'object' && !Array.isArray(v)
      ? Object.fromEntries(
          Object.entries(v as Record<string, unknown>).sort(([a], [b]) => (a < b ? -1 : 1)),
        )
      : v,
  );
}
