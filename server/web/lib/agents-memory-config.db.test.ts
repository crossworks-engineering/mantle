/**
 * Saving an agent from the settings form must not erase the memory_config keys
 * the form does not show (corpus map, Journal, delegation, the manifest's tool
 * caps, anything set by SQL), and a field cleared in the form must go back to
 * the runtime default. updateAgent merges memory_config with jsonb `||` and
 * removes the keys sent as null. Real Postgres, one throwaway agent on the
 * shared test anchor, removed at the end.
 *   MANTLE_TEST_DATABASE_URL=postgres://… pnpm vitest run server/web/lib/agents-memory-config.db.test.ts
 */
import { randomUUID } from 'node:crypto';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { ensureTestAnchor } from '@mantle/db/test-support';

const URL = process.env.MANTLE_TEST_DATABASE_URL;

describe.skipIf(!URL)('agent memory_config saves merge', () => {
  let m: typeof import('@mantle/db');
  let sql: Parameters<typeof m.ensureViewerRoles>[0];
  let lib: typeof import('./agents');
  let anchor = '';
  let agentId = '';

  // What a brain stores today on an assistant: keys set by the manifest,
  // the Studio, SQL and the API, none of which the settings form shows.
  const stored = {
    history_limit: 20,
    digest_limit: 3,
    corpus_map_limit: 300,
    corpus_map_chars: 9_000,
    delegate_to: ['researcher', 'coder'],
    inject_journal: true,
    inject_working_notes: false,
    journal_tiers: 'live' as const,
    journal_relevance_min: 0.6,
    journal_relevant_chars: 4_000,
    notes_target: 'journal' as const,
    chunk_limit: 4,
    max_iterations: 12,
    max_tool_calls: 60,
    max_calls_per_tool: 20,
  };

  const read = async () => {
    const [row] = await sql<{ memory_config: Record<string, unknown> }[]>`
      select memory_config from agents where id = ${agentId}`;
    return row!.memory_config;
  };

  beforeAll(async () => {
    process.env.DATABASE_URL = URL;
    process.env.MANTLE_MASTER_KEY ??= 'mantle-viewer-test-key';
    m = await import('@mantle/db');
    sql = (m.systemDb as unknown as { $client: typeof sql }).$client;
    anchor = await ensureTestAnchor(sql);
    lib = await import('./agents');
    const row = await lib.createAgent(anchor, {
      slug: `mc-merge-${randomUUID().slice(0, 8)}`,
      name: 'Memory config merge test',
      role: 'assistant',
      model: 'test/model',
      apiKeyId: null,
      systemPrompt: 'test',
      memoryConfig: stored,
      enabled: false,
    });
    agentId = row.id;
  });

  afterAll(async () => {
    if (agentId) await sql`delete from agents where id = ${agentId}`;
  });

  it('a form-shaped save keeps every key the form leaves out', async () => {
    // The body the jackdaw agents form sends for an assistant.
    await lib.updateAgent(anchor, agentId, {
      memoryConfig: {
        history_limit: 25,
        digest_limit: 2,
        fact_limit: 10,
        content_hit_limit: 5,
        delegate_to: ['researcher', 'coder'],
        result_handling: {},
      },
    });
    const mc = await read();
    expect(mc).toMatchObject({
      ...stored,
      history_limit: 25,
      digest_limit: 2,
      fact_limit: 10,
      content_hit_limit: 5,
    });
  });

  it('a key sent as null is removed, the rest stay', async () => {
    await lib.updateAgent(anchor, agentId, {
      memoryConfig: { corpus_map_chars: null, history_window_hours: null },
    });
    const mc = await read();
    expect(mc).not.toHaveProperty('corpus_map_chars');
    expect(mc).not.toHaveProperty('history_window_hours');
    expect(mc).toMatchObject({ corpus_map_limit: 300, journal_tiers: 'live' });
  });

  it('a value sets the key again, and an empty array still clears delegation', async () => {
    await lib.updateAgent(anchor, agentId, {
      memoryConfig: { corpus_map_chars: 4_000, delegate_to: [] },
    });
    const mc = await read();
    expect(mc.corpus_map_chars).toBe(4_000);
    expect(mc.delegate_to).toEqual([]);
    expect(mc.notes_target).toBe('journal');
  });

  it('create drops null keys instead of storing them', async () => {
    const row = await lib.createAgent(anchor, {
      slug: `mc-create-${randomUUID().slice(0, 8)}`,
      name: 'Memory config create test',
      role: 'assistant',
      model: 'test/model',
      apiKeyId: null,
      systemPrompt: 'test',
      memoryConfig: { history_limit: 5, history_window_hours: null },
      enabled: false,
    });
    try {
      const [r] = await sql<{ memory_config: Record<string, unknown> }[]>`
        select memory_config from agents where id = ${row.id}`;
      expect(r!.memory_config).toEqual({ history_limit: 5 });
    } finally {
      await sql`delete from agents where id = ${row.id}`;
    }
  });
});
