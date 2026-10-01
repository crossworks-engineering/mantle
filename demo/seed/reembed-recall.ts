/**
 * Re-embed the Recall prompt cards with the brain's CURRENT embedder.
 *
 * Part of the embedder switch (demo/deploy/README-embedder.md). The brain is
 * seeded on the local embedder and served on an online one, and `pnpm -C
 * server/web re-embed` walks nodes, facts, entities and content_chunks, not
 * `recall_nodes`. A prompt card's vector is what `recall_match` compares the
 * embedded question with, so a prompt left on its seed-time vector is matched
 * across two models: quietly wrong, with no error anywhere.
 *
 * This clears the prompt vectors and lets the brain's own code fill them
 * (`embedPendingRecallPrompts`, the function a card write and `recall_match`
 * call). It needs the WRITABLE seed stack: the serve-time reader cannot store
 * a vector. Run it AFTER the embedding config points at the serve-time model
 * and BEFORE pack.sh:
 *
 *   (the env of demo/scripts/seed.sh: DATABASE_URL, MANTLE_MASTER_KEY, ...)
 *   pnpm -C server/web exec tsx ../../demo/seed/reembed-recall.ts
 */
import postgres from '../../server/web/node_modules/postgres/src/index.js';
// The brain's own function, by relative path: the demo tree is not a
// workspace member (see seed.ts). Its imports resolve from its own package.
import { embedPendingRecallPrompts } from '../../packages/content/src/recall.ts';
// @mantle/content does not reach up to the adapter layer: the process that
// owns the embedder registers it (server/web/server/main.ts does this at
// boot). This process is that owner here.
import { registerRecallEmbedder } from '../../packages/content/src/embed-bridge.ts';
import { embedBatch } from '../../packages/embeddings/src/index.ts';
import type { Sql } from './lib/types.ts';

const DB = process.env.DATABASE_URL ?? 'postgres://postgres:postgres@127.0.0.1:56432/postgres';
const OWNER_EMAIL = process.env.DEMO_OWNER_EMAIL ?? 'alex@harbourlabs.example.com';

async function main() {
  const sql = postgres(DB, { onnotice: () => {} }) as unknown as Sql;
  const owner = (await sql`select id from auth.users where email = ${OWNER_EMAIL} limit 1`)[0]?.id;
  if (!owner) throw new Error(`no owner ${OWNER_EMAIL} on this database: seed it first`);
  const prompts = Number((await sql`select count(*)::int n from recall_nodes where kind = 'prompt' and not prompt_pending and owner_id = ${owner}::uuid`)[0]?.n ?? 0);
  if (prompts === 0) throw new Error('no confirmed Recall prompt on this brain: nothing to re-embed (did the Recall seed run?)');

  registerRecallEmbedder(embedBatch);
  // Owner-scoped, like the refill. The clear and the refill cannot be one
  // transaction (the refill is a network call to the embedder), so a failure
  // in between leaves prompts with no vector. That state is safe and loud:
  // this script exits 1 below, pack.sh refuses a brain that has one, and on a
  // writable brain the next recall_match fills it.
  await sql`update recall_nodes set embedding = null where kind = 'prompt' and owner_id = ${owner}::uuid`;
  const filled = await embedPendingRecallPrompts(String(owner));
  const left = Number((await sql`select count(*)::int n from recall_nodes where kind = 'prompt' and not prompt_pending and embedding is null and owner_id = ${owner}::uuid`)[0]?.n ?? 0);
  const model = (await sql`select model, dimensions from embedding_config limit 1`)[0];
  await sql.end();
  if (left > 0) throw new Error(`${left} of ${prompts} prompt(s) still have no vector: is the embedder reachable?`);
  console.log(`✓ ${filled} Recall prompt vector(s) rebuilt with ${model ? `${model.model} (${model.dimensions}d)` : 'the local fallback embedder'}`);
  process.exit(0);
}

main().catch((err) => {
  console.error('✗ reembed-recall failed:', err instanceof Error ? err.message : err);
  process.exit(1);
});
