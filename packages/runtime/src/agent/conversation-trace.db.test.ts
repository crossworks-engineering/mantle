/**
 * Decision trace v1 on the real loader: snapshot.trace names every passage
 * of the pool with the arm that found it and the reason it was kept or
 * dropped, and its kept rows are exactly what the prompt got. Only the query
 * embedding is faked: it points along one axis the seeded rows own, so the
 * shared test anchor's other rows sit far away.
 *
 * Seeds its own rows on the shared test anchor (unique tag), removes them by
 * id after (the anchor stays).
 *   MANTLE_TEST_DATABASE_URL=postgres://… pnpm vitest run packages/runtime/src/agent/conversation-trace.db.test.ts
 */
import { randomUUID } from 'node:crypto';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import type { ContextTraceRow } from '@mantle/client-types';

const URL = process.env.MANTLE_TEST_DATABASE_URL;

/** Two axes no other test uses: the query sits on A; a row at angle t from A
 *  has cosine distance 1 - cos(t). */
const AXIS_A = 517;
const AXIS_B = 518;
const at = (dist: number): number[] => {
  const c = 1 - dist;
  const v = new Array<number>(768).fill(0);
  v[AXIS_A] = c;
  v[AXIS_B] = Math.sqrt(Math.max(0, 1 - c * c));
  return v;
};
const lit = (v: number[]) => `[${v.join(',')}]`;

vi.mock('@mantle/embeddings', async (importOriginal) => ({
  ...(await importOriginal<Record<string, unknown>>()),
  embed: vi.fn(async () => at(0)),
}));

describe.skipIf(!URL)('the decision trace on a real turn', () => {
  type Db = typeof import('@mantle/db');
  type Admin = Parameters<Db['ensureViewerRoles']>[0];
  let m: Db;
  let admin: Admin;
  let ownerId = '';
  const tag = `ctrace-${randomUUID().slice(0, 8)}`;
  // A coined word only the far passage holds: the keyword arm's rare literal.
  const rare = `zq${randomUUID()
    .slice(0, 6)
    .replace(/[^a-z]/g, 'x')}vold`;
  const node = { near: randomUUID(), far: randomUUID(), filler: randomUUID() };
  const factId = randomUUID();

  beforeAll(async () => {
    process.env.DATABASE_URL = URL;
    process.env.MANTLE_MASTER_KEY ??= 'mantle-viewer-test-key';
    m = await import('@mantle/db');
    const { ensureTestAnchor } = await import('@mantle/db/test-support');
    admin = (m.systemDb as unknown as { $client: Admin }).$client;
    await m.ensureViewerRoles(admin, process.env.MANTLE_MASTER_KEY);
    ownerId = await ensureTestAnchor(admin);
    await admin`insert into nodes (id, owner_id, type, title, path, data, embedding, audience) values
      (${node.near}, ${ownerId}, 'page', ${`${tag} near page`}, 'pages',
       ${JSON.stringify({ summary: 'the near page' })}::jsonb, ${lit(at(0.1))}::vector, 'admin'),
      (${node.far}, ${ownerId}, 'page', ${`${tag} far page`}, 'pages',
       ${JSON.stringify({ summary: 'the far page' })}::jsonb, ${lit(at(0.9))}::vector, 'admin'),
      (${node.filler}, ${ownerId}, 'note', ${`${tag} filler`}, 'notes', '{}'::jsonb, null, 'admin')`;
    // Six near passages at rising distance, one far passage holding the
    // coined word (the keyword arm finds it; the 0.65 cutoff drops it).
    for (let i = 0; i < 6; i++) {
      await admin`insert into content_chunks (owner_id, node_id, ordinal, text, embedding) values
        (${ownerId}, ${node.near}, ${i}, ${`${tag} passage ${i} about the plan`},
         ${lit(at(0.05 + i * 0.05))}::vector)`;
    }
    await admin`insert into content_chunks (owner_id, node_id, ordinal, text, embedding) values
      (${ownerId}, ${node.far}, 0, ${`${tag} the ${rare} clause`}, ${lit(at(0.9))}::vector)`;
    // Rarity is table-wide (keyword-query.ts): unembedded filler rows and a
    // fresh ANALYZE make the coined word rare on a near-empty test database.
    for (let i = 0; i < 40; i++) {
      await admin`insert into content_chunks (owner_id, node_id, ordinal, text) values
        (${ownerId}, ${node.filler}, ${i}, ${`${tag} filler row ${i}`})`;
    }
    await admin`analyze content_chunks`;
    await admin`insert into facts (id, owner_id, content, kind, source_node_id, embedding) values
      (${factId}, ${ownerId}, ${`${tag} the plan is due in May`}, 'factual', ${node.near},
       ${lit(at(0.08))}::vector)`;
  }, 60_000);

  afterAll(async () => {
    if (!admin) return;
    await admin`delete from facts where id = ${factId}`;
    await admin`delete from nodes where id in ${admin(Object.values(node))}`;
    await m.closeDb();
  });

  it('names each candidate, its arm and why, and its kept rows are what the prompt got', async () => {
    const { loadConversationContext } = await import('./conversation');
    const agent = {
      id: randomUUID(),
      ownerId,
      slug: `assistant-${tag}`,
      audience: 'admin',
      memoryConfig: {
        digest_limit: 0,
        history_limit: 0,
        corpus_map_limit: 0,
        fact_limit: 3,
        content_hit_limit: 2,
        chunk_limit: 3,
      },
      personaNotes: [],
    } as never;
    const ctx = await loadConversationContext({
      ownerId,
      agent,
      inboundText: `what does the ${rare} clause say about the plan?`,
      includeJournal: false,
    });
    const trace = ctx.snapshot.trace!;
    expect(trace.v).toBe(1);
    const row = (b: ContextTraceRow['b'], k: string) =>
      trace.rows.find((r) => r.b === b && r.k === k);

    // Kept passages in the trace = the passages the prompt got.
    const keptChunks = trace.rows
      .filter((r) => r.b === 'chunk' && r.out === 'kept')
      .map((r) => r.k);
    expect(new Set(keptChunks)).toEqual(
      new Set(ctx.chunkHits.map((c) => `${c.nodeId}:${c.ordinal ?? ''}`)),
    );
    expect(ctx.chunkHits.map((c) => c.ordinal)).toEqual([0, 1, 2]);

    // The 4th and 5th near passages lost to the budget cap.
    expect(row('chunk', `${node.near}:0`)).toMatchObject({
      out: 'kept',
      at: 'select',
      why: 'sent',
    });
    expect(row('chunk', `${node.near}:3`)).toMatchObject({
      out: 'dropped',
      at: 'select',
      why: 'limit:3',
    });
    // The coined word: found by the keyword arm, then cut on distance.
    const far = row('chunk', `${node.far}:0`)!;
    expect(far.kr).toBe(1);
    expect(['keyword', 'both']).toContain(far.arm);
    expect(far).toMatchObject({ out: 'dropped', at: 'select', why: 'cut:0.65' });
    expect(trace.search).toMatchObject({ mode: 'hybrid', keyword: 'rare' });

    // Facts and content hits carry their raw and ranking distances.
    const fact = row('fact', factId)!;
    expect(fact).toMatchObject({ out: 'kept', at: 'facts', why: 'sent', arm: 'vector', rank: 1 });
    expect(fact.d).toBeCloseTo(0.08, 2);
    expect(row('hit', node.near)).toMatchObject({ out: 'kept', why: 'sent', arm: 'vector' });
    expect(row('hit', node.far)).toMatchObject({ out: 'dropped', why: 'cut:0.6' });

    const names = trace.stages.map((s) => s.name);
    for (const s of ['embed', 'facts', 'hits', 'search', 'select'] as const)
      expect(names).toContain(s);
    // Ids and codes only: no passage text rides in the trace.
    expect(JSON.stringify(trace)).not.toContain('about the plan');
  });
});
