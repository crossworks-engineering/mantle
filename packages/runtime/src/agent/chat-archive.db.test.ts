/**
 * Chat archive ("New chat", docs/conversation.md §6c, migration 0231) on a
 * real, migrated Postgres: archiving closes the open range and opens a new
 * one, the summary note is written once, the fresh chat's history and digests
 * start clean, the summary still comes back by relevance, "Continue from
 * this" seeds the new chat, and a running reply blocks the archive. Only the
 * model call, the summarizer worker lookup and the embedder are faked.
 *
 * Seeds its own owner and rows and removes them.
 *   MANTLE_TEST_DATABASE_URL=postgres://… pnpm vitest run packages/runtime/src/agent/chat-archive.db.test.ts
 */
import { randomUUID } from 'node:crypto';
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';

const URL = process.env.MANTLE_TEST_DATABASE_URL;

/** An axis no other test uses: every embedding here points along it, so the
 *  summary note is the nearest node to the query on a shared test database. */
const AXIS = 611;
const vec = (): number[] => {
  const v = new Array<number>(768).fill(0);
  v[AXIS] = 1;
  return v;
};

const h = vi.hoisted(() => ({
  worker: null as null | Record<string, unknown>,
  replies: [] as string[],
  inputs: [] as string[],
}));

vi.mock('@mantle/embeddings', async (importOriginal) => ({
  ...(await importOriginal<Record<string, unknown>>()),
  embed: vi.fn(async () => vec()),
  embedBatch: vi.fn(async (_o: string, texts: string[]) => texts.map(() => vec())),
}));

vi.mock('@mantle/db', async (importOriginal) => ({
  ...(await importOriginal<Record<string, unknown>>()),
  getDefaultWorker: vi.fn(async () => h.worker),
  bumpWorkerUsage: vi.fn(async () => {}),
}));

vi.mock('./chat-failover', async (importOriginal) => ({
  ...(await importOriginal<Record<string, unknown>>()),
  resolveChatKey: vi.fn(async () => ({ ok: true, apiKey: 'sk-test' })),
  chatWithFailover: vi.fn(async (_o: string, _r: unknown, opts: { messages: unknown[] }) => {
    h.inputs.push(JSON.stringify(opts.messages));
    return {
      result: { text: h.replies.shift() ?? '', tokensIn: 100, tokensOut: 20, model: 'test/model' },
      failedOver: false,
      usedProvider: 'openrouter',
    };
  }),
}));

const WORKER = {
  id: randomUUID(),
  slug: 'summarizer-test',
  provider: 'openrouter',
  model: 'test/flash-lite',
  apiKeyId: null,
  baseUrl: null,
  viaTailnet: false,
  backupEnabled: false,
  params: {},
};

describe.skipIf(!URL)('chat archive on Postgres', () => {
  type Db = typeof import('@mantle/db');
  let m: Db;
  let sqlTag: typeof import('drizzle-orm').sql;
  let archive: typeof import('./chat-archive');
  let conv: typeof import('./conversation');
  const owner = randomUUID();
  const tag = `chat-archive-${owner.slice(0, 8)}`;
  const agentId = randomUUID();
  const agent = {
    id: agentId,
    ownerId: owner,
    slug: `assistant-${tag}`,
    audience: 'admin',
    memoryConfig: {
      history_limit: 20,
      digest_limit: 3,
      fact_limit: 0,
      content_hit_limit: 3,
      chunk_limit: 0,
      corpus_map_limit: 0,
    },
    personaNotes: [],
  } as never;

  const exec = (q: ReturnType<typeof sqlTag>) => m.db.execute(q) as Promise<unknown>;
  const rows = async <T>(q: ReturnType<typeof sqlTag>) => (await m.db.execute(q)) as unknown as T[];
  const ago = (min: number) => new Date(Date.now() - min * 60_000).toISOString();

  const turn = (direction: 'inbound' | 'outbound', text: string, at: string, status = 'complete') =>
    exec(sqlTag`
      insert into assistant_messages (owner_id, agent_id, direction, text, created_at, status)
      values (${owner}, ${agentId}, ${direction}, ${text}, ${at}::timestamptz, ${status})`);

  const context = (inboundText: string) =>
    conv.loadConversationContext({ ownerId: owner, agent, inboundText, includeJournal: false });

  beforeAll(async () => {
    process.env.DATABASE_URL = URL;
    m = await import('@mantle/db');
    sqlTag = (await import('drizzle-orm')).sql;
    archive = await import('./chat-archive');
    conv = await import('./conversation');
    await exec(sqlTag`
      insert into auth.users (id, email, password_hash, role)
      values (${owner}, ${`${tag}@example.invalid`}, 'x', 'admin')`);
    await exec(
      sqlTag`insert into spaces (id, kind, login_id) values (${owner}, 'brain', ${owner})`,
    );
    await exec(sqlTag`
      insert into agents (id, owner_id, slug, name, model, system_prompt)
      values (${agentId}, ${owner}, ${`assistant-${tag}`}, 'Test', 'test/model', 'You are a test agent.')`);
  }, 120_000);

  afterAll(async () => {
    if (!m) return;
    await exec(sqlTag`delete from chat_threads where owner_id = ${owner}`);
    await exec(sqlTag`delete from assistant_messages where owner_id = ${owner}`);
    await exec(sqlTag`delete from traces where owner_id = ${owner}`);
    await exec(sqlTag`delete from agents where owner_id = ${owner}`);
    await exec(sqlTag`delete from nodes where owner_id = ${owner}`);
    await exec(sqlTag`delete from spaces where id = ${owner} or login_id = ${owner}`);
    await exec(sqlTag`delete from auth.users where id = ${owner}`);
    await m.closeDb();
  });

  beforeEach(() => {
    h.worker = WORKER;
    h.replies = [];
    h.inputs = [];
  });

  it('an empty, never-used chat is a no-op', async () => {
    const r = await archive.archiveAgentChat({ ownerId: owner, agentId });
    expect(r).toEqual({ archived: null, open: null });
    expect(h.inputs).toHaveLength(0);
  });

  it('New chat: archives the forever-thread, writes one summary note, starts clean', async () => {
    await turn('inbound', 'Let us plan the vegetable garden', ago(120));
    await turn('outbound', 'Tomatoes in the north bed, beans by the fence.', ago(119));
    await turn('inbound', 'And the compost?', ago(61));
    await turn('outbound', 'Turn it every two weeks.', ago(60));
    // A digest of the first exchange, as the summarizer would have written it.
    await exec(sqlTag`
      insert into nodes (owner_id, type, title, path, tags, data, embedding)
      values (${owner}, 'note', 'Garden digest', 'notes.auto_filed.assistant',
        ARRAY['conversation-digest']::text[],
        ${JSON.stringify({
          kind: 'conversation_digest',
          agent_id: agentId,
          topic: 'Garden Beds',
          summary: 'Tomatoes go in the north bed.',
          period_start: ago(120),
          period_end: ago(119),
        })}::jsonb, ${`[${vec().join(',')}]`}::vector)`);
    await exec(sqlTag`
      update assistant_messages set digest_node_id =
        (select id from nodes where owner_id = ${owner} and title = 'Garden digest')
       where owner_id = ${owner} and created_at <= ${ago(100)}::timestamptz`);

    // Before: the forever-thread is all history, the digest is in.
    const before = await context('what about the beans?');
    expect(before.history.map((t) => t.text).join(' ')).toContain('vegetable garden');
    expect(before.digests.map((d) => d.topic)).toContain('Garden Beds');

    h.replies = [
      '```json\n{"title": "Vegetable Garden Plan", "summary": "The user planned the garden: tomatoes in the north bed, beans by the fence, compost turned every two weeks."}\n```',
    ];
    const r = await archive.archiveAgentChat({ ownerId: owner, agentId, archivedBy: owner });
    expect(r.archived).toMatchObject({
      status: 'archived',
      title: 'Vegetable Garden Plan',
      turnCount: 4,
    });
    expect(r.archived!.summaryNodeId).toBeTruthy();
    expect(r.open).toMatchObject({ status: 'open', seedThreadId: null });
    // The ranges meet: the new chat starts where the archived one ends.
    expect(r.open!.startedAt.getTime()).toBe(r.archived!.archivedAt!.getTime());
    // A forever-thread's archived range starts at its first turn.
    const [first] = await rows<{ at: Date }>(sqlTag`
      select min(created_at) as at from assistant_messages where owner_id = ${owner}`);
    expect(r.archived!.startedAt.getTime()).toBe(new Date(first!.at).getTime());

    // One model call; it read the digest and the undigested tail, not the
    // digested turns again.
    expect(h.inputs).toHaveLength(1);
    expect(h.inputs[0]).toContain('Tomatoes go in the north bed.');
    expect(h.inputs[0]).toContain('Turn it every two weeks.');
    expect(h.inputs[0]).not.toContain('Let us plan the vegetable garden');

    const [note] = await rows<{ tags: string[]; data: Record<string, unknown>; has_vec: boolean }>(
      sqlTag`select tags, data, embedding is not null as has_vec from nodes where id = ${r.archived!.summaryNodeId}`,
    );
    expect(note!.tags).toContain('chat-archive');
    expect(note!.data).toMatchObject({
      kind: 'chat_archive',
      thread_id: r.archived!.id,
      agent_id: agentId,
      topic: 'Vegetable Garden Plan',
    });
    expect(note!.has_vec).toBe(true);

    // After: no old turns, no old digest; the summary comes back by relevance.
    const after = await context('what about the beans?');
    expect(after.history).toHaveLength(0);
    expect(after.digests).toHaveLength(0);
    expect(after.snapshot.history.since).toBe(r.open!.startedAt.toISOString());
    expect(after.contentHits.map((c) => c.nodeId)).toContain(r.archived!.summaryNodeId);

    // A new turn is the whole history of the fresh chat.
    await turn('inbound', 'Fresh question about bees', new Date().toISOString());
    const next = await context('bees?');
    expect(next.history.map((t) => t.text)).toEqual(['Fresh question about bees']);
  });

  it('summarizeChatThread never re-bills a thread that has a summary', async () => {
    const [t] = await rows<{ id: string }>(
      sqlTag`select id from chat_threads where owner_id = ${owner} and status = 'archived' limit 1`,
    );
    const again = await archive.summarizeChatThread(owner, t!.id);
    expect(again!.title).toBe('Vegetable Garden Plan');
    expect(h.inputs).toHaveLength(0);
  });

  it('a running reply blocks New chat', async () => {
    await turn('outbound', '', new Date().toISOString(), 'pending');
    await expect(archive.archiveAgentChat({ ownerId: owner, agentId })).rejects.toBeInstanceOf(
      archive.ChatArchiveBusyError,
    );
    await exec(
      sqlTag`delete from assistant_messages where owner_id = ${owner} and status = 'pending'`,
    );
  });

  it('with no summarizer worker the thread keeps a plain title and no summary', async () => {
    h.worker = null;
    const r = await archive.archiveAgentChat({ ownerId: owner, agentId });
    expect(r.archived).toMatchObject({ title: 'Fresh question about bees', summaryNodeId: null });
    expect(h.inputs).toHaveLength(0);
  });

  it('Continue from this seeds the new chat with the archived summary', async () => {
    const [garden] = await rows<{ id: string }>(
      sqlTag`select id from chat_threads where owner_id = ${owner} and title = 'Vegetable Garden Plan'`,
    );
    // The open chat is empty: it is re-seeded, not archived.
    const r = await archive.archiveAgentChat({ ownerId: owner, agentId, continueFrom: garden!.id });
    expect(r.archived).toBeNull();
    expect(r.open!.seedThreadId).toBe(garden!.id);

    const ctx = await context('where were we?');
    expect(ctx.digests[0]!.topic).toContain('Vegetable Garden Plan');
    expect(ctx.digests[0]!.summary).toContain('beans by the fence');
    expect(ctx.snapshot.history.continuedFrom).toBe('Vegetable Garden Plan');
    expect(ctx.history).toHaveLength(0);

    await expect(
      archive.archiveAgentChat({ ownerId: owner, agentId, continueFrom: randomUUID() }),
    ).rejects.toBeInstanceOf(archive.ChatThreadNotFoundError);
  });

  it('keeps exactly one open thread per agent chat', async () => {
    const [n] = await rows<{ open: string; total: string }>(sqlTag`
      select count(*) filter (where status = 'open') as open, count(*) as total
        from chat_threads where owner_id = ${owner} and agent_id = ${agentId}`);
    expect(Number(n!.open)).toBe(1);
    expect(Number(n!.total)).toBe(3);
  });
});
