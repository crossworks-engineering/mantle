/**
 * The summarizer and "New chat" cuts (chat archive, docs/conversation.md §6c)
 * on a real, migrated Postgres. A digest must never hold turns from both
 * sides of a cut, or the fresh chat would read an archived turn back through
 * it. So the closed range is digested alone, even below the threshold, and
 * then never again; the open range waits for the threshold as before. Only
 * the model call, the worker lookup and the embedder are faked.
 *
 * Seeds its own owner and rows and removes them.
 *   MANTLE_TEST_DATABASE_URL=postgres://… pnpm vitest run server/api/src/agent/summarizer-cut.db.test.ts
 */
import { randomUUID } from 'node:crypto';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';

const URL = process.env.MANTLE_TEST_DATABASE_URL;

const h = vi.hoisted(() => ({ calls: [] as string[] }));

vi.mock('@mantle/embeddings', async (importOriginal) => ({
  ...(await importOriginal<Record<string, unknown>>()),
  embedBatch: vi.fn(async (_o: string, texts: string[]) => texts.map(() => null)),
}));

vi.mock('@mantle/db', async (importOriginal) => ({
  ...(await importOriginal<Record<string, unknown>>()),
  getDefaultWorker: vi.fn(async () => ({
    id: randomUUID(),
    slug: 'summarizer-test',
    provider: 'openrouter',
    model: 'test/flash-lite',
    apiKeyId: null,
    baseUrl: null,
    viaTailnet: false,
    backupEnabled: false,
    params: { summarize_threshold: 30, summarize_batch: 20 },
    systemPrompt: null,
  })),
  bumpWorkerUsage: vi.fn(async () => {}),
}));

vi.mock('@mantle/runtime/agent', async (importOriginal) => ({
  ...(await importOriginal<Record<string, unknown>>()),
  resolveChatKey: vi.fn(async () => ({ ok: true, apiKey: 'sk-test' })),
  chatWithFailover: vi.fn(async (_o: string, _r: unknown, opts: { messages: unknown[] }) => {
    const text = JSON.stringify(opts.messages);
    h.calls.push(text);
    // One topic over every turn number the transcript carries.
    const n = (text.match(/#\d+ \[/g) ?? []).length;
    return {
      result: {
        text: JSON.stringify({
          topics: [
            {
              label: 'Test Topic',
              summary: 'A test summary.',
              turn_indexes: Array.from({ length: n }, (_, i) => i + 1),
            },
          ],
        }),
        tokensIn: 10,
        tokensOut: 10,
        model: 'test/flash-lite',
      },
      failedOver: false,
      usedProvider: 'openrouter',
    };
  }),
}));

describe.skipIf(!URL)('summarizer respects New chat cuts', () => {
  type Db = typeof import('@mantle/db');
  let m: Db;
  let sqlTag: typeof import('drizzle-orm').sql;
  let summarize: (typeof import('./summarizer'))['summarizeAgentConversation'];
  const owner = randomUUID();
  const agentId = randomUUID();
  const tag = `sum-cut-${owner.slice(0, 8)}`;
  const exec = (q: ReturnType<typeof sqlTag>) => m.db.execute(q) as Promise<unknown>;
  const undigested = async (before?: string) => {
    const r = (await m.db.execute(
      before
        ? sqlTag`select count(*) as n from assistant_messages where owner_id = ${owner}
                   and digest_node_id is null and created_at < ${before}::timestamptz`
        : sqlTag`select count(*) as n from assistant_messages where owner_id = ${owner}
                   and digest_node_id is null`,
    )) as unknown as { n: string }[];
    return Number(r[0]!.n);
  };
  const cut = new Date(Date.now() - 60 * 60_000).toISOString();

  beforeAll(async () => {
    process.env.DATABASE_URL = URL;
    m = await import('@mantle/db');
    sqlTag = (await import('drizzle-orm')).sql;
    summarize = (await import('./summarizer')).summarizeAgentConversation;
    await exec(sqlTag`
      insert into auth.users (id, email, password_hash, role)
      values (${owner}, ${`${tag}@example.invalid`}, 'x', 'admin')`);
    await exec(
      sqlTag`insert into spaces (id, kind, login_id) values (${owner}, 'brain', ${owner})`,
    );
    await exec(sqlTag`
      insert into agents (id, owner_id, slug, name, model, system_prompt)
      values (${agentId}, ${owner}, ${tag}, 'Test', 'test/model', 'You are a test agent.')`);
    // 4 turns before the cut (the archived chat), 6 after (the fresh chat).
    for (let i = 0; i < 10; i++) {
      const at = new Date(Date.parse(cut) + (i < 4 ? -(10 - i) : i + 1) * 60_000).toISOString();
      await exec(sqlTag`
        insert into assistant_messages (owner_id, agent_id, direction, text, created_at)
        values (${owner}, ${agentId}, ${i % 2 ? 'outbound' : 'inbound'}, ${`turn ${i}`}, ${at}::timestamptz)`);
    }
    const start = new Date(Date.parse(cut) - 60 * 60_000).toISOString();
    await exec(sqlTag`
      insert into chat_threads (owner_id, agent_id, status, started_at, archived_at, turn_count)
      values (${owner}, ${agentId}, 'archived', ${start}::timestamptz, ${cut}::timestamptz, 4),
             (${owner}, ${agentId}, 'open', ${cut}::timestamptz, null, 0)`);
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

  it('digests the closed range alone, below the threshold', async () => {
    await summarize(owner, agentId);
    expect(h.calls).toHaveLength(1);
    expect(h.calls[0]).toContain('turn 3');
    expect(h.calls[0]).not.toContain('turn 4');
    expect(await undigested(cut)).toBe(0);
    expect(await undigested()).toBe(6);
  });

  it('then leaves the open range to the threshold, as before', async () => {
    await summarize(owner, agentId);
    expect(h.calls).toHaveLength(1);
    expect(await undigested()).toBe(6);
  });
});
