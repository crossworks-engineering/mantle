/**
 * Recall — the helpers the native path (recall-native.ts) and the serving
 * tools share: the Recall root, folder crumbs, and the prompt embed refill.
 *
 * Until R5 this file also held v1, the page compiler that turned a `recall`
 * tagged page tree into serving rows on every commit. Page-built maps were
 * retired in R5 (2026-09-30); `recall` and `prompt` are ordinary page tags
 * again, and a map is only ever a `recall` item written natively.
 *
 * Plan: "PLAN: Recall v2, its own content type" (dev brain, task 5d6ce06a).
 */

import { and, eq, inArray, isNull, notInArray, sql } from 'drizzle-orm';

import { db, nodes, recallNodes } from '@mantle/db';
import { getRecallEmbedder } from './embed-bridge';

/**
 * Recall v2: the ltree root label for the Recall item tree, the `*_ROOT_LABEL`
 * convention every kind follows (NOTES_ROOT_LABEL, JOURNAL_ROOT_LABEL, ...).
 * A map is a `recall` node under this root, optionally inside folders (at most
 * TREE_MAX_DEPTH of them). Cards are ROWS, never nodes, so they never appear
 * in the tree.
 *
 * Plan: "PLAN: Recall v2, its own content type" (dev brain, task 5d6ce06a).
 */
export const RECALL_ROOT_LABEL = 'recall';

/**
 * Make sure the Recall root branch exists for this owner. Idempotent, and
 * shaped exactly like every other kind's `ensureRoot` — the same conflict
 * target, so two concurrent callers cannot make two roots. Called by the
 * native write path before a map is created.
 */
export async function ensureRecallRoot(ownerId: string): Promise<void> {
  await db
    .insert(nodes)
    .values({
      ownerId,
      type: 'branch',
      title: 'Recall',
      slug: RECALL_ROOT_LABEL,
      path: RECALL_ROOT_LABEL,
      data: {
        description: 'Memory maps for agents: what to read, and when. Owner-authored.',
      },
    })
    .onConflictDoNothing({
      target: [nodes.ownerId, nodes.path],
      where: sql`${nodes.type} = 'branch'`,
    });
}

/**
 * The display crumbs for each map's folder, keyed by map id.
 *
 * A map's ltree `path` is the Recall root plus the labels of the folders it
 * sits in ("recall.mantle.fleet"); the crumbs are those folders' TITLES, which
 * is what a person recognises ("Mantle / Fleet"). Resolved in one query over
 * the branch nodes on those paths, so a catalog stays two round-trips no
 * matter how many maps there are.
 *
 * A map at the root is unsorted and gets null.
 *
 * Shared by `recall_index` and the owner API (GET /api/recall/maps), so the
 * agent catalog and the owner's never disagree about where a map is filed.
 */
export async function recallFolderCrumbs(
  ownerId: string,
  maps: { id: string; path: string | null }[],
): Promise<Map<string, string | null>> {
  const out = new Map<string, string | null>();
  const prefixes = new Set<string>();
  for (const m of maps) {
    const labels = (m.path ?? '').split('.').filter(Boolean);
    // Drop the root label; what remains is the folder chain.
    const chain = labels[0] === RECALL_ROOT_LABEL ? labels.slice(1) : labels;
    if (chain.length === 0) {
      out.set(m.id, null);
      continue;
    }
    for (let i = 1; i <= chain.length; i += 1) {
      prefixes.add([RECALL_ROOT_LABEL, ...chain.slice(0, i)].join('.'));
    }
  }
  if (prefixes.size === 0) return out;
  const branches = await db
    .select({ path: nodes.path, title: nodes.title })
    .from(nodes)
    .where(
      and(eq(nodes.ownerId, ownerId), eq(nodes.type, 'branch'), inArray(nodes.path, [...prefixes])),
    );
  const titleOf = new Map(branches.map((b) => [String(b.path), b.title]));
  for (const m of maps) {
    if (out.has(m.id)) continue;
    const labels = (m.path ?? '').split('.').filter(Boolean);
    const chain = labels[0] === RECALL_ROOT_LABEL ? labels.slice(1) : labels;
    const crumbs = chain.map((_, i) => {
      const p = [RECALL_ROOT_LABEL, ...chain.slice(0, i + 1)].join('.');
      // Fall back to the label when a folder row is missing: a crumb that
      // reads "mantle" is still an orientation, an empty string is not.
      return titleOf.get(p) ?? chain[i];
    });
    out.set(m.id, crumbs.join(' / '));
  }
  return out;
}

/** Embed prompt rows whose vector is missing. Fire-and-forget from the native
 *  writes, and from recall_match, which is what heals a prompt whose embed
 *  failed at write time (an embedder that was down, a process restart).
 *  The embedder is injected at boot (see embed-bridge.ts), so this package
 *  never reaches up into the adapter layer. Throws when the process forgot to
 *  register one — deliberately loud, because the caller is fire-and-forget and
 *  a silent zero here is invisible until recall_match stops finding prompts. */
export async function embedPendingRecallPrompts(ownerId: string): Promise<number> {
  // Batches of 50 until none are left. A row the embedder skipped, or whose
  // text moved under it, is not asked for twice in one call: `seen` keeps a
  // stubborn row from looping, and the next call (recall_match) retries it.
  // The round cap is a guard, not a product limit: 2,000 prompts.
  const seen: string[] = [];
  let done = 0;
  for (let round = 0; round < 40; round += 1) {
    const { tried, written } = await embedPendingBatch(ownerId, seen);
    done += written;
    if (tried.length < RECALL_EMBED_BATCH) break;
    seen.push(...tried);
  }
  return done;
}

const RECALL_EMBED_BATCH = 50;

async function embedPendingBatch(
  ownerId: string,
  seen: string[],
): Promise<{ tried: string[]; written: number }> {
  const pending = await db
    .select({
      id: recallNodes.id,
      title: recallNodes.title,
      useWhen: recallNodes.useWhen,
      bodyMd: recallNodes.bodyMd,
    })
    .from(recallNodes)
    .where(
      and(
        eq(recallNodes.ownerId, ownerId),
        eq(recallNodes.kind, 'prompt'),
        isNull(recallNodes.embedding),
        ...(seen.length > 0 ? [notInArray(recallNodes.id, seen)] : []),
      ),
    )
    .limit(RECALL_EMBED_BATCH);
  if (pending.length === 0) return { tried: [], written: 0 };

  const embedBatch = getRecallEmbedder();
  const texts = pending.map((p) => `${p.title}\n${p.useWhen}\n${p.bodyMd}`.slice(0, 6000));
  const vectors = await embedBatch(ownerId, texts);
  let done = 0;
  for (let i = 0; i < pending.length; i++) {
    const vec = vectors[i];
    const p = pending[i]!;
    if (!vec) continue;
    // Only onto the text it was built from. Two quick edits can run two
    // embeds; without this guard the one for the OLDER text could land last
    // and leave a vector that matches words the card no longer has.
    await db
      .update(recallNodes)
      .set({ embedding: vec })
      .where(
        and(
          eq(recallNodes.id, p.id),
          isNull(recallNodes.embedding),
          eq(recallNodes.kind, 'prompt'),
          eq(recallNodes.title, p.title),
          eq(recallNodes.useWhen, p.useWhen),
          eq(recallNodes.bodyMd, p.bodyMd),
        ),
      );
    done++;
  }
  return { tried: pending.map((p) => p.id), written: done };
}
