/**
 * DELETE /api/agents/:id against a real, migrated Postgres: the
 * `?conversation=keep|delete` choice. Keep (the default, 0127) leaves the
 * stream orphaned-but-preserved; delete removes the agent's assistant_messages
 * and its conversation-digest notes in the same transaction, so replay_window
 * and digest search stop returning a thread no UI can reach. A second agent's
 * stream is the control: it must survive both. Only the owner check is stubbed.
 * Seeds its own owner and rows and removes them.
 *   MANTLE_TEST_DATABASE_URL=postgres://… pnpm vitest run agent-delete.db.test
 */
import { randomUUID } from 'node:crypto';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';

const URL = process.env.MANTLE_TEST_DATABASE_URL;
const h = vi.hoisted(() => ({ owner: '' }));

vi.mock('@/lib/auth', () => ({ getOwnerOr401: vi.fn(async () => ({ id: h.owner })) }));

describe.skipIf(!URL)('DELETE /api/agents/:id conversation handling on Postgres', () => {
  type Db = typeof import('@mantle/db');
  let m: Db;
  let route: typeof import('./route');
  let replayWindow: (typeof import('@mantle/tools'))['REPLAY_TOOLS'][number];
  let sqlTag: typeof import('drizzle-orm').sql;
  const owner = randomUUID();
  h.owner = owner;
  const tag = `agent-delete-${owner.slice(0, 8)}`;
  const day = '2026-01-15';

  const del = (id: string, query = '') =>
    route.DELETE(new Request(`http://brain.test/api/agents/${id}${query}`, { method: 'DELETE' }), {
      params: Promise.resolve({ id }),
    });

  const count = async (q: ReturnType<typeof sqlTag>) =>
    Number(((await m.db.execute(q)) as unknown as { n: string | number }[])[0]!.n);

  const messagesOf = (agentId: string | null) =>
    count(
      agentId
        ? sqlTag`select count(*) as n from assistant_messages where owner_id = ${owner} and agent_id = ${agentId}`
        : sqlTag`select count(*) as n from assistant_messages where owner_id = ${owner} and agent_id is null`,
    );

  const digestsOf = (agentId: string) =>
    count(sqlTag`
      select count(*) as n from nodes
       where owner_id = ${owner} and type = 'note'
         and tags @> ARRAY['conversation-digest']::text[]
         and data->>'agent_id' = ${agentId}`);

  const replayTexts = async () => {
    const res = await replayWindow.handler(
      { from: day, to: day, surface: 'web' },
      { ownerId: owner },
    );
    if (!res.ok) throw new Error(res.error);
    return (res.output as { turns: { text: string }[] }).turns.map((t) => t.text).sort();
  };

  /** One agent with a two-turn web stream, a digest and a read cursor. */
  const seedAgent = async (slug: string) => {
    const id = randomUUID();
    await m.db.execute(sqlTag`
      insert into agents (id, owner_id, slug, name, model, system_prompt)
      values (${id}, ${owner}, ${slug}, ${slug}, 'test/model', 'You are a test agent.')`);
    await m.db.execute(sqlTag`
      insert into assistant_messages (owner_id, agent_id, direction, text, created_at) values
        (${owner}, ${id}, 'inbound',  ${`${slug} question`}, ${`${day}T10:00:00Z`}::timestamptz),
        (${owner}, ${id}, 'outbound', ${`${slug} answer`},   ${`${day}T10:00:05Z`}::timestamptz)`);
    await m.db.execute(sqlTag`
      insert into nodes (owner_id, type, title, path, tags, data) values
        (${owner}, 'note', ${`${slug} digest`}, 'conversations',
         ARRAY['conversation-digest', ${`agent:${slug}`}]::text[],
         ${JSON.stringify({ kind: 'conversation_digest', agent_id: id, agent_slug: slug })}::jsonb)`);
    await m.db.execute(sqlTag`
      insert into assistant_read_cursors (owner_id, agent_id) values (${owner}, ${id})`);
    return id;
  };

  beforeAll(async () => {
    process.env.DATABASE_URL = URL;
    m = await import('@mantle/db');
    route = await import('./route');
    const tools = await import('@mantle/tools');
    replayWindow = tools.REPLAY_TOOLS.find((t) => t.slug === 'replay_window')!;
    sqlTag = (await import('drizzle-orm')).sql;
    await m.db.execute(sqlTag`
      insert into auth.users (id, email, password_hash, role) values (${owner}, ${`${tag}@example.invalid`}, 'x', 'admin')`);
    await m.db.execute(sqlTag`
      insert into spaces (id, kind, login_id) values (${owner}, 'brain', ${owner})`);
  }, 60_000);

  afterAll(async () => {
    await m.db.execute(sqlTag`delete from assistant_messages where owner_id = ${owner}`);
    await m.db.execute(sqlTag`delete from agents where owner_id = ${owner}`);
    await m.db.execute(sqlTag`delete from nodes where owner_id = ${owner}`);
    await m.db.execute(sqlTag`delete from spaces where id = ${owner} or login_id = ${owner}`);
    await m.db.execute(sqlTag`delete from auth.users where id = ${owner}`);
    await m.closeDb();
  });

  it('keeps the stream by default: agent gone, messages orphaned, digest kept', async () => {
    const kept = await seedAgent(`${tag}-kept`);
    const res = await del(kept);
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({
      ok: true,
      conversation: 'keep',
      deletedMessages: 0,
      deletedDigests: 0,
    });
    expect(await count(sqlTag`select count(*) as n from agents where id = ${kept}`)).toBe(0);
    expect(await messagesOf(null)).toBe(2);
    expect(await digestsOf(kept)).toBe(1);
    expect(
      await count(
        sqlTag`select count(*) as n from assistant_read_cursors where agent_id = ${kept}`,
      ),
    ).toBe(0);
    // Preserved on purpose: replay still reads the orphaned turns.
    expect(await replayTexts()).toEqual([`${tag}-kept answer`, `${tag}-kept question`]);

    // Clear the orphans so the next case starts from a known window.
    await m.db.execute(
      sqlTag`delete from assistant_messages where owner_id = ${owner} and agent_id is null`,
    );
  });

  it('?conversation=delete removes the stream and digests, and leaves other agents alone', async () => {
    const gone = await seedAgent(`${tag}-gone`);
    const other = await seedAgent(`${tag}-other`);

    const res = await del(gone, '?conversation=delete');
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({
      ok: true,
      conversation: 'delete',
      deletedMessages: 2,
      deletedDigests: 1,
    });

    expect(await count(sqlTag`select count(*) as n from agents where id = ${gone}`)).toBe(0);
    expect(await messagesOf(null)).toBe(0);
    expect(await digestsOf(gone)).toBe(0);
    expect(
      await count(
        sqlTag`select count(*) as n from assistant_read_cursors where agent_id = ${gone}`,
      ),
    ).toBe(0);

    // The surviving agent is untouched.
    expect(await messagesOf(other)).toBe(2);
    expect(await digestsOf(other)).toBe(1);

    // Replay returns only the survivor's turns: nothing agent-less comes back.
    expect(await replayTexts()).toEqual([`${tag}-other answer`, `${tag}-other question`]);
  });

  it('refuses an unknown conversation mode without deleting', async () => {
    const id = await seedAgent(`${tag}-bad`);
    const res = await del(id, '?conversation=purge');
    expect(res.status).toBe(400);
    expect(await count(sqlTag`select count(*) as n from agents where id = ${id}`)).toBe(1);
    expect(await messagesOf(id)).toBe(2);
  });

  it('404s an agent that is not this owner’s, and deletes nothing', async () => {
    const res = await del(randomUUID(), '?conversation=delete');
    expect(res.status).toBe(404);
  });
});
