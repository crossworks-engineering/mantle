/**
 * A REAL team turn under the team viewer role (member logins Phase 0b, plan
 * section 2b spike item 3): runTeamTurn end to end on a provisioned brain,
 * with row level security on. Only the model, the embedder and the API key
 * are faked; everything else (context loader, tool resolution, dispatch,
 * traces, the team thread) is the production code on the limited pool.
 *
 * It proves three things: the turn completes (no table the loop needs is
 * missing from the grant matrix, and infrastructure writes go through
 * systemDb); what the team role reads is only team-visible; the trace is
 * written.
 *
 * Needs a migrated copy of a PROVISIONED brain (team-responder, tools,
 * a contact), so it is not part of CI:
 *   MANTLE_TEST_BRAIN_DATABASE_URL=postgres://postgres:…@host:port/devcopy \
 *     pnpm vitest run packages/runtime/src/assistant/run-team-turn.viewer.db.test.ts
 */
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';

const URL = process.env.MANTLE_TEST_BRAIN_DATABASE_URL;

const h = vi.hoisted(() => ({
  vec: [] as number[],
  hiddenId: '',
  hiddenTitle: '',
  calls: 0,
  seenToolResults: [] as string[],
}));

vi.mock('@mantle/embeddings', async (importOriginal) => ({
  ...(await importOriginal<Record<string, unknown>>()),
  embed: vi.fn(async () => h.vec),
  embedMany: vi.fn(async (_o: string, texts: string[]) => texts.map(() => h.vec)),
}));
vi.mock('@mantle/api-keys', async (importOriginal) => ({
  ...(await importOriginal<Record<string, unknown>>()),
  getApiKeyById: vi.fn(async (id: string) => ({ id, provider: 'openrouter', key: 'sk-fake' })),
}));
vi.mock('@mantle/voice', async (importOriginal) => {
  const actual = await importOriginal<Record<string, unknown>>();
  // A scripted model: first it calls three read tools (one aimed at an
  // admin-only node), then it answers.
  const chat = async (opts: { messages: Array<{ role: string; content?: unknown }> }) => {
    h.calls += 1;
    for (const m of opts.messages) {
      if (m.role === 'tool') h.seenToolResults.push(JSON.stringify(m.content));
    }
    if (h.calls === 1) {
      return {
        text: '',
        model: 'fake/model',
        toolCalls: [
          {
            id: 't1',
            type: 'function',
            function: { name: 'search_nodes', arguments: '{"q":"brain"}' },
          },
          {
            id: 't2',
            type: 'function',
            function: { name: 'search_chunks', arguments: '{"q":"brain"}' },
          },
          {
            id: 't3',
            type: 'function',
            function: { name: 'node_read', arguments: JSON.stringify({ node_id: h.hiddenId }) },
          },
        ],
      };
    }
    return { text: 'ok, done', model: 'fake/model' };
  };
  return {
    ...actual,
    getChatAdapter: vi.fn(() => ({ providerId: 'openrouter', adapterName: 'fake-chat', chat })),
  };
});

describe.skipIf(!URL)('a team turn under the team viewer role', () => {
  type Db = typeof import('@mantle/db');
  let m: Db;
  let sqlTag: typeof import('drizzle-orm').sql;
  let ownerId = '';
  let contactId = '';
  let teamIds = new Set<string>();

  beforeAll(async () => {
    process.env.DATABASE_URL = URL;
    process.env.MANTLE_MASTER_KEY ??= 'team-turn-viewer-test-key';
    m = await import('@mantle/db');
    sqlTag = (await import('drizzle-orm')).sql;
    // The admin pool's own postgres-js client, for setup.
    const admin = (m.systemDb as unknown as { $client: Parameters<Db['ensureViewerRoles']>[0] })
      .$client;
    await m.ensureViewerRoles(admin, process.env.MANTLE_MASTER_KEY);
    const [o] = await admin<{ id: string }[]>`select id from auth.users where is_owner`;
    ownerId = o!.id;
    const [c] = await admin<{ id: string }[]>`select id from nodes where type = 'contact' limit 1`;
    contactId = c!.id;
    const [hidden] = await admin<{ id: string; title: string }[]>`
      select id, title from nodes where audience = 'admin' and type = 'journal'
        and length(title) > 12 limit 1`;
    h.hiddenId = hidden!.id;
    h.hiddenTitle = hidden!.title;
    const [v] = await admin<{ v: string }[]>`
      select embedding::text as v from content_chunks where embedding is not null limit 1`;
    h.vec = JSON.parse(v!.v) as number[];
    const visible = await admin<{ id: string }[]>`
      select id from nodes where owner_id = ${ownerId} and audience <> 'admin'
        and mantle_workspace_kind(type)`;
    teamIds = new Set(visible.map((r) => r.id));
  });

  afterAll(async () => {
    await m?.closeDb();
  });

  it('completes, reads only team-visible items, and writes its trace', async () => {
    const { runTeamTurn } = await import('./run-team-turn');
    const started = new Date();
    const result = await m.withViewer('team', () =>
      runTeamTurn(ownerId, 'what does the brain say about itself?', { contactId }),
    );
    expect(result.reply).toBe('ok, done');

    // Every item a read tool handed the model (its `id` / `nodeId` fields)
    // is team-visible. Ids inside visible TEXT (a page linking a task) are
    // references, not reads, so they are not counted.
    const ids = [
      ...h.seenToolResults
        .join(' ')
        .matchAll(
          /\\*"(?:id|nodeId)\\*"\s*:\s*\\*"([0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12})/g,
        ),
    ].map((mm) => mm[1]!);
    expect(ids.length, 'the read tools returned items').toBeGreaterThan(0);
    const leaked = ids.filter((id) => !teamIds.has(id));
    expect(leaked, 'items outside the team level').toEqual([]);
    // The admin-only journal entry, asked for by id, never reached the model.
    expect(h.seenToolResults.join(' ')).not.toContain(h.hiddenTitle);

    // The trace landed (systemDb), after the turn started.
    const traces = (await m.systemDb.execute(
      sqlTag`select count(*)::int as n from traces where kind = 'responder_turn' and started_at >= ${started.toISOString()}::timestamptz`,
    )) as unknown as { n: number }[];
    expect(traces[0]!.n).toBeGreaterThan(0);
  });
});
