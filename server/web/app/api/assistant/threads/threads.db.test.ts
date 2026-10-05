/**
 * The chat archive routes the /assistant window uses (docs/conversation.md
 * §6c) against a real, migrated Postgres: New chat, the Previous chats list,
 * one archived thread, its paging, Continue from this, and the open-only
 * transcript on /api/assistant/thread and /api/assistant/messages. Only the
 * owner check is stubbed; there is no summarizer worker, so no model call
 * runs and an archived thread takes its first user line as its title.
 *
 * Seeds its own owner and rows and removes them.
 *   MANTLE_TEST_DATABASE_URL=postgres://… pnpm vitest run threads.db.test
 */
import { randomUUID } from 'node:crypto';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import type { ChatArchiveResponse, ChatThreadRow } from '@mantle/client-types';

const URL = process.env.MANTLE_TEST_DATABASE_URL;
const h = vi.hoisted(() => ({ owner: '' }));

vi.mock('@/lib/auth', () => ({
  getOwnerOr401: vi.fn(async () => ({ id: h.owner, email: 'x', actor: { id: h.owner } })),
}));
vi.mock('@mantle/db', async (importOriginal) => ({
  ...(await importOriginal<Record<string, unknown>>()),
  getDefaultWorker: vi.fn(async () => null),
}));

describe.skipIf(!URL)('/api/assistant/threads on Postgres', () => {
  type Db = typeof import('@mantle/db');
  let m: Db;
  let sqlTag: typeof import('drizzle-orm').sql;
  let threads: typeof import('./route');
  let one: typeof import('./[id]/route');
  let cont: typeof import('./[id]/continue/route');
  let bundle: typeof import('../thread/route');
  let page: typeof import('../messages/route');
  const owner = randomUUID();
  h.owner = owner;
  const tag = `threads-${owner.slice(0, 8)}`;
  const slug = `assistant-${tag}`;
  const agentId = randomUUID();
  const exec = (q: ReturnType<typeof sqlTag>) => m.db.execute(q) as Promise<unknown>;
  const req = (path: string, init?: RequestInit) => new Request(`http://brain.test${path}`, init);
  const ago = (min: number) => new Date(Date.now() - min * 60_000).toISOString();
  const turn = (direction: string, text: string, at: string) =>
    exec(sqlTag`
      insert into assistant_messages (owner_id, agent_id, direction, text, created_at)
      values (${owner}, ${agentId}, ${direction}, ${text}, ${at}::timestamptz)`);

  beforeAll(async () => {
    process.env.DATABASE_URL = URL;
    m = await import('@mantle/db');
    sqlTag = (await import('drizzle-orm')).sql;
    threads = await import('./route');
    one = await import('./[id]/route');
    cont = await import('./[id]/continue/route');
    bundle = await import('../thread/route');
    page = await import('../messages/route');
    await exec(sqlTag`
      insert into auth.users (id, email, password_hash, role)
      values (${owner}, ${`${tag}@example.invalid`}, 'x', 'admin')`);
    await exec(
      sqlTag`insert into spaces (id, kind, login_id) values (${owner}, 'brain', ${owner})`,
    );
    await exec(sqlTag`
      insert into agents (id, owner_id, slug, name, model, system_prompt, role, enabled)
      values (${agentId}, ${owner}, ${slug}, 'Test', 'test/model', 'You are a test agent.', 'assistant', true)`);
    await turn('inbound', 'Plan the garden please', ago(30));
    await turn('outbound', 'Tomatoes north, beans south.', ago(29));
  }, 120_000);

  afterAll(async () => {
    if (!m) return;
    await exec(sqlTag`delete from chat_threads where owner_id = ${owner}`);
    await exec(sqlTag`delete from assistant_messages where owner_id = ${owner}`);
    await exec(sqlTag`delete from agents where owner_id = ${owner}`);
    await exec(sqlTag`delete from nodes where owner_id = ${owner}`);
    await exec(sqlTag`delete from spaces where id = ${owner} or login_id = ${owner}`);
    await exec(sqlTag`delete from auth.users where id = ${owner}`);
    await m.closeDb();
  });

  let archived: ChatThreadRow;

  it('New chat archives the chat; the window then shows only the fresh chat', async () => {
    const res = await threads.POST(
      req('/api/assistant/threads', { method: 'POST', body: JSON.stringify({ agent: slug }) }),
    );
    expect(res.status).toBe(200);
    const body = (await res.json()) as ChatArchiveResponse;
    expect(body.archived).toMatchObject({
      status: 'archived',
      title: 'Plan the garden please',
      turnCount: 2,
      summary: null,
    });
    expect(body.open).toMatchObject({ status: 'open', archivedAt: null, continuedFrom: null });
    archived = body.archived!;

    await turn('inbound', 'Fresh: bees?', new Date().toISOString());
    const b = (await (await bundle.GET(req(`/api/assistant/thread?agent=${slug}`))).json()) as {
      messages: { text: string }[];
      thread: ChatThreadRow;
    };
    expect(b.messages.map((x) => x.text)).toEqual(['Fresh: bees?']);
    expect(b.thread).toMatchObject({ id: body.open!.id, status: 'open' });

    const latest = (await (
      await page.GET(req(`/api/assistant/messages?agent=${slug}`))
    ).json()) as {
      messages: { text: string }[];
    };
    expect(latest.messages.map((x) => x.text)).toEqual(['Fresh: bees?']);
  });

  it('lists Previous chats and reads one read-only, with paging inside its range', async () => {
    const list = (await (
      await threads.GET(req(`/api/assistant/threads?agent=${slug}`))
    ).json()) as {
      threads: ChatThreadRow[];
    };
    expect(list.threads.map((t) => t.status)).toEqual(['open', 'archived']);

    const detail = await one.GET(req(`/api/assistant/threads/${archived.id}`), {
      params: Promise.resolve({ id: archived.id }),
    });
    const d = (await detail.json()) as { thread: ChatThreadRow; messages: { text: string }[] };
    expect(d.thread.id).toBe(archived.id);
    expect(d.messages.map((x) => x.text)).toEqual([
      'Plan the garden please',
      'Tomatoes north, beans south.',
    ]);

    const older = (await (
      await page.GET(
        req(
          `/api/assistant/messages?thread=${archived.id}&before=${encodeURIComponent(ago(29.5))}`,
        ),
      )
    ).json()) as { messages: { text: string }[] };
    expect(older.messages.map((x) => x.text)).toEqual(['Plan the garden please']);

    const bad = await page.GET(req('/api/assistant/messages?thread=nope'));
    expect(bad.status).toBe(400);
  });

  it('Continue from this archives the fresh chat and seeds a new one', async () => {
    const res = await cont.POST(req(`/api/assistant/threads/${archived.id}/continue`), {
      params: Promise.resolve({ id: archived.id }),
    });
    const body = (await res.json()) as ChatArchiveResponse;
    expect(body.archived).toMatchObject({ title: 'Fresh: bees?' });
    expect(body.open!.continuedFrom).toEqual({ id: archived.id, title: 'Plan the garden please' });

    const missing = await cont.POST(req('/api/assistant/threads/x/continue'), {
      params: Promise.resolve({ id: randomUUID() }),
    });
    expect(missing.status).toBe(404);
  });
});
