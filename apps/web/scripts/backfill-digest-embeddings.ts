/**
 * Embed (or re-embed) every conversation-digest note from its canonical text.
 *
 * Context: the summarizer historically inserted digest nodes with NO embedding
 * (the extractor deliberately skips digests, and re-embed excludes them), while
 * `find_window` — Remy's recall routing — filters on `embedding IS NOT NULL`
 * and cosine-ranks. Net effect: every digest was invisible to recall, and the
 * few that DID carry vectors were clobber-era ones embedded from garbage
 * paraphrases. The summarizer now embeds at insert time
 * (apps/agent/src/summarizer.ts); this script heals everything that predates
 * that fix, plus any digest whose insert-time embed failed (embedder down).
 *
 * Re-embeds ALL digests, not just NULL ones — that also replaces the
 * clobber-era garbage vectors with vectors over the canonical text. Idempotent:
 * the embedding cache makes a same-model re-run free.
 *
 * Canonical text is the shared `digestEmbedText` from @mantle/embeddings
 * (label + "\n" + summary) — the same composition the summarizer uses at
 * insert and the re-embed walk uses on model swaps. Older digests without
 * data.topic fall back to summary/content/title.
 *
 * Dry-run by default:
 *   ALLOWED_USER_ID=<uuid> pnpm -C apps/web backfill:digest-embeddings
 *   ... --apply
 */

import { db, nodes } from '@mantle/db';
import { digestEmbedText, embedBatch } from '@mantle/embeddings';
import { and, eq, sql } from 'drizzle-orm';

const OWNER_ID = process.env.ALLOWED_USER_ID;
if (!OWNER_ID) {
  console.error('backfill-digest-embeddings: ALLOWED_USER_ID must be set');
  process.exit(1);
}
const apply = process.argv.slice(2).includes('--apply');

function canonicalText(title: string, data: Record<string, unknown>): string | null {
  const topic = typeof data.topic === 'string' ? data.topic.trim() : '';
  const summary =
    typeof data.summary === 'string' && data.summary.trim()
      ? data.summary.trim()
      : typeof data.content === 'string'
        ? data.content.trim()
        : '';
  if (topic && summary) return digestEmbedText(topic, summary);
  if (summary) return summary;
  return title.trim() || null;
}

async function main() {
  const rows = await db
    .select({
      id: nodes.id,
      title: nodes.title,
      data: nodes.data,
      hasEmbedding: sql<boolean>`${nodes.embedding} IS NOT NULL`,
    })
    .from(nodes)
    .where(
      and(
        eq(nodes.ownerId, OWNER_ID!),
        eq(nodes.type, 'note'),
        sql`${nodes.tags} @> ARRAY['conversation-digest']::text[]`,
      ),
    );

  const targets = rows
    .map((r) => ({
      id: r.id,
      title: r.title,
      hadEmbedding: r.hasEmbedding,
      text: canonicalText(r.title, (r.data ?? {}) as Record<string, unknown>),
    }))
    .filter((r): r is typeof r & { text: string } => r.text != null);

  const missing = targets.filter((t) => !t.hadEmbedding).length;
  console.log(
    `${rows.length} conversation-digest node(s); ${missing} missing an embedding, ` +
      `${rows.length - missing} re-embedded from canonical text (replaces clobber-era vectors).`,
  );
  for (const t of targets.slice(0, 10)) {
    console.log(`  - [${t.hadEmbedding ? 're-embed' : 'MISSING '}] ${t.title.slice(0, 70)}`);
  }
  if (targets.length > 10) console.log(`  … and ${targets.length - 10} more`);

  if (!apply) {
    console.log('\nDry run — re-run with --apply to commit.');
    process.exit(0);
  }
  if (targets.length === 0) {
    console.log('\nNothing to do.');
    process.exit(0);
  }

  // Batch the embeds (cache-aware), then write each vector back.
  const BATCH = 50;
  let updated = 0;
  for (let i = 0; i < targets.length; i += BATCH) {
    const slice = targets.slice(i, i + BATCH);
    const vecs = await embedBatch(
      OWNER_ID!,
      slice.map((t) => t.text),
    );
    for (let j = 0; j < slice.length; j++) {
      const vec = vecs[j];
      if (!vec) continue;
      await db.update(nodes).set({ embedding: vec }).where(eq(nodes.id, slice[j]!.id));
      updated++;
    }
    console.log(`  embedded ${Math.min(i + BATCH, targets.length)}/${targets.length}`);
  }
  console.log(`\nDone — ${updated} digest embedding(s) written.`);
  process.exit(0);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
