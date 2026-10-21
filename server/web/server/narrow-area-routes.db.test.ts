/**
 * The Admin area routes on the narrow system route, driven through the real
 * app (createApp) with a signed session cookie, the switch on
 * (MANTLE_NARROW_SYSTEM, the tests' default): each row is a route whose
 * handler writes a content table on its area exit, so it must reach that
 * write at a named full-route spot (packages/db/src/viewer.ts
 * FULL_ROUTE_SPOTS). A write the narrow role refuses is recorded and fails
 * the test (vitest.setup.ts); a row also fails on a 500, on a database
 * error's own text in the answer, and when the write it exists for did not
 * happen (so a row cannot pass by doing nothing).
 *
 * With MANTLE_NARROW_SYSTEM=0 (the suite's switch-off run) the same rows
 * pass on the full route: the answers do not change.
 *
 * A new area route that writes a content table gets a row here.
 *   MANTLE_TEST_DATABASE_URL=postgres://… pnpm vitest run server/web/server/narrow-area-routes.db.test.ts
 */
import { randomUUID } from 'node:crypto';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { sql } from 'drizzle-orm';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';

const URL = process.env.MANTLE_TEST_DATABASE_URL;

// The vault seals with the box's master key; the test key is the viewer
// roles' and is not a sealing key.
vi.mock('@mantle/crypto', async (importOriginal) => ({
  ...(await importOriginal<Record<string, unknown>>()),
  seal: vi.fn(() => ({ ciphertext: Buffer.from('sealed'), keyVersion: 1 })),
  open: vi.fn(() => JSON.stringify({ note: 'n', fields: [] })),
}));

// The embedding rebuild calls a provider: a stub that answers 768 numbers
// per input, so the rebuild reaches its writes.
vi.mock('@mantle/voice', async (importOriginal) => {
  const orig = await importOriginal<Record<string, unknown>>();
  return {
    ...orig,
    getEmbeddingAdapter: () => ({
      embed: async ({ input }: { input: unknown[] }) => ({
        vectors: input.map(() => Array.from({ length: 768 }, () => 0.01)),
      }),
    }),
  };
});

describe.skipIf(!URL)('the Admin area routes that write content, switch on', () => {
  type Ts = typeof import('@mantle/db/test-support');
  let scratch: Awaited<ReturnType<Ts['createMigratedScratchDatabase']>> | undefined;
  let m: typeof import('@mantle/db');
  let app: { request: (path: string, init: RequestInit) => Response | Promise<Response> };
  let cookie = '';
  let dir = '';
  const owner = randomUUID();
  const tag = `nar${randomUUID().slice(0, 6)}`;

  const x = async <T = Record<string, unknown>>(q: ReturnType<typeof sql>): Promise<T[]> =>
    m.asSystem(async () => [...((await m.db.execute(q)) as unknown as T[])], 'test');

  const call = async (path: string, method = 'GET', body?: unknown) => {
    const res = await app.request(path, {
      method,
      headers: { 'content-type': 'application/json', cookie },
      ...(method === 'GET' || method === 'DELETE' ? {} : { body: JSON.stringify(body ?? {}) }),
    });
    return { status: res.status, text: await res.text().catch(() => '') };
  };

  /** A row: not a 500, no database text in the answer. */
  const clean = (r: { status: number; text: string }) => {
    expect(r.status, r.text.slice(0, 300)).not.toBe(500);
    expect(r.text).not.toMatch(/Failed query|permission denied|insert into|delete from/i);
  };

  beforeAll(async () => {
    const ts: Ts = await import('@mantle/db/test-support');
    scratch = await ts.createMigratedScratchDatabase(URL!);
    process.env.DATABASE_URL = scratch.url;
    process.env.MANTLE_MASTER_KEY ??= 'mantle-viewer-test-key';
    process.env.SESSION_SECRET = 'narrow-area-routes-secret-at-least-32-characters';
    dir = mkdtempSync(join(tmpdir(), 'narrow-area-'));
    process.env.MANTLE_DOCS_ROOT = join(dir, 'docs');
    process.env.MANTLE_BACKUP_DIR = join(dir, 'backups');
    // Not a folder a built-in collection names (guide, _changelog, ...).
    mkdirSync(join(dir, 'docs', `${tag}-col`), { recursive: true });
    writeFileSync(join(dir, 'docs', `${tag}-col`, 'a.md'), `# ${tag} guide\n\nSome text.\n`);
    m = await import('@mantle/db');
    await x(sql`insert into auth.users (id, email, password_hash, is_owner, role, display_name)
      values (${owner}, ${`${tag}-owner@example.test`}, 'x', true, 'admin', 'Olive Owner')`);
    await x(sql`insert into spaces (id, kind, login_id) values (${owner}, 'brain', ${owner})
      on conflict (id) do nothing`);
    await ts.runWorkspacesSwitch();
    // The brain's profile row (the backups routes update it).
    await x(sql`insert into profiles (user_id) values (${owner}) on conflict do nothing`);
    const tokens = await import('../lib/auth/tokens');
    cookie = `mantle_session=${tokens.buildSessionCookie(owner).value}`;
    const { createApp } = await import('./app');
    app = await createApp();
  }, 240_000);

  afterAll(async () => {
    await m?.closeDb();
    await scratch?.drop();
    if (dir) rmSync(dir, { recursive: true, force: true });
  });

  it('secrets: POST, PATCH, DELETE (secret-item)', async () => {
    const made = await call('/api/secrets', 'POST', {
      title: `${tag} secret`,
      kind: 'password',
      note: 'n',
      fields: [{ label: 'user', value: 'v' }],
    });
    clean(made);
    const id = (JSON.parse(made.text) as { secret?: { id: string }; id?: string }).secret?.id;
    const row = await x<{ id: string }>(
      sql`select id::text as id from nodes where owner_id = ${owner} and type = 'secret' and title = ${`${tag} secret`}`,
    );
    expect(row).toHaveLength(1);
    const sid = id ?? row[0]!.id;
    clean(await call(`/api/secrets/${sid}`, 'PATCH', { title: `${tag} secret 2`, note: 'm' }));
    expect(
      await x(sql`select 1 from nodes where id = ${sid} and title = ${`${tag} secret 2`}`),
    ).toHaveLength(1);
    clean(await call(`/api/secrets/${sid}`, 'DELETE'));
    expect(await x(sql`select 1 from nodes where id = ${sid}`)).toHaveLength(0);
  });

  it('backups: POST the schedule, POST run (profile-row)', async () => {
    clean(
      await call('/api/backups', 'POST', {
        enabled: false,
        frequency: 'daily',
        hour: 3,
        keep: 7,
        location: join(dir, 'backups'),
      }),
    );
    clean(await call('/api/backups/run', 'POST'));
    const [p] = await x<{ backup: unknown; status: unknown }>(
      sql`select preferences->'backup' as backup, preferences->'backupStatus' as status
            from profiles where user_id = ${owner}`,
    );
    expect(p?.backup).toBeTruthy();
    expect(p?.status).toBeTruthy();
  });

  it('embedding rebuild and AI workers re-embed (reembed)', async () => {
    const vec = `[${Array.from({ length: 768 }, () => 0.5).join(',')}]`;
    await x(sql`insert into nodes (owner_id, type, title, path, embedding)
      values (${owner}, 'note', ${`${tag} embedded`}, 'notes', ${vec}::vector)`);
    for (const path of ['/api/embedding/rebuild', '/api/ai-workers/reembed']) {
      await x(sql`update nodes set embedding = ${vec}::vector where title = ${`${tag} embedded`}`);
      clean(await call(path, 'POST', {}));
      const [n] = await x<{ v: string }>(
        sql`select (embedding::text) as v from nodes where title = ${`${tag} embedded`}`,
      );
      expect(n?.v.startsWith('[0.01'), `${path} wrote the vector`).toBe(true);
    }
  });

  it('docs collections: POST, PATCH, POST all (docs-collection)', async () => {
    const made = await call('/api/docs/collections', 'POST', {
      label: `${tag} Guide`,
      key: `${tag}-guide`,
      rootPath: join(dir, 'docs', `${tag}-col`),
      brainDepth: 'retrieval',
    });
    clean(made);
    expect(JSON.parse(made.text), made.text).toMatchObject({ ok: true });
    const docs = sql`select 1 from nodes where owner_id = ${owner} and type = 'documentation'
                       and data::text like ${`%${tag}-guide%`}`;
    expect((await x(docs)).length).toBeGreaterThan(0);
    const [c] = await x<{ id: string }>(
      sql`select id::text as id from doc_collections where key = ${`${tag}-guide`}`,
    );
    const off = await call(`/api/docs/collections/${c!.id}`, 'PATCH', { enabled: false });
    clean(off);
    expect(JSON.parse(off.text), off.text).toMatchObject({ ok: true });
    expect(await x(docs)).toHaveLength(0);
    const all = await call('/api/docs/collections/all', 'POST', { enabled: true });
    clean(all);
    expect(JSON.parse(all.text), all.text).toMatchObject({ ok: true });
    expect((await x(docs)).length).toBeGreaterThan(0);
  });

  it('email discover: POST contacts (sender-contact)', async () => {
    const r = await call('/api/email/discover/contacts', 'POST', {
      address: `${tag}.sender@example.test`,
      displayName: 'Sam Sender',
    });
    clean(r);
    expect(r.status).toBe(200);
    expect(
      await x(sql`select 1 from nodes where owner_id = ${owner} and type = 'contact'
                    and data::text like ${`%${tag}.sender@example.test%`}`),
    ).toHaveLength(1);
  });

  it('calendar: DELETE a calendar with synced events (calendar-events)', async () => {
    const [cal] = await x<{ id: string }>(sql`insert into calendar_accounts
        (owner_id, provider, display_name) values (${owner}, 'ics', ${`${tag} cal`})
        returning id::text as id`);
    await x(sql`insert into nodes (owner_id, type, title, path, data) values
      (${owner}, 'event', ${`${tag} event`}, 'events',
       ${JSON.stringify({ external_account_id: cal!.id })}::jsonb)`);
    clean(await call(`/api/calendar/${cal!.id}`, 'DELETE'));
    expect(await x(sql`select 1 from nodes where title = ${`${tag} event`}`)).toHaveLength(0);
    expect(await x(sql`select 1 from calendar_accounts where id = ${cal!.id}`)).toHaveLength(0);
  });

  it('assistants: DELETE with its conversation (agent-conversation)', async () => {
    const id = randomUUID();
    const slug = `${tag}-agent`;
    await x(sql`insert into agents (id, owner_id, slug, name, model, system_prompt)
      values (${id}, ${owner}, ${slug}, ${slug}, 'test/model', 'You are a test agent.')`);
    await x(sql`insert into assistant_messages (owner_id, agent_id, direction, text)
      values (${owner}, ${id}, 'inbound', ${`${tag} question`})`);
    clean(await call(`/api/agents/${id}?conversation=delete`, 'DELETE'));
    expect(await x(sql`select 1 from agents where id = ${id}`)).toHaveLength(0);
    expect(await x(sql`select 1 from assistant_messages where agent_id = ${id}`)).toHaveLength(0);
  });

  it("assistants: POST block and unpair of a chat on the assistant's bot (its definer on the narrow role)", async () => {
    // Not a content write: the measure of the narrow role's EXECUTE on
    // mantle_tg_chat_set (0313; runtime-role.ts NARROW_SYSTEM_FUNCTIONS).
    // The area route's exit runs the definer on the narrow route; a refused
    // EXECUTE is a narrow denial, which fails the test (vitest.setup.ts).
    const agent = randomUUID();
    const channel = randomUUID();
    const account = randomUUID();
    const chat = randomUUID();
    await x(sql`insert into agents (id, owner_id, slug, name, model, system_prompt)
      values (${agent}, ${owner}, ${`${tag}-tg`}, ${`${tag}-tg`}, 'test/model', 'p')`);
    await x(sql`insert into channels (id, owner_id, agent_id, type, display_name, credentials_enc)
      values (${channel}, ${owner}, ${agent}, 'telegram', ${`@${tag}_tg`}, '\\x00')`);
    await x(sql`insert into telegram_accounts (id, user_id, bot_username, branch_path, channel_id)
      values (${account}, ${owner}, ${`${tag}_tg_bot`}, 'inbox.telegram_test', ${channel})`);
    await x(sql`insert into telegram_chats
        (id, account_id, user_id, telegram_chat_id, chat_type, title, allowlist_status, login_id)
      values (${chat}, ${account}, ${owner}, '9001', 'private', 'Pat', 'allowed', ${owner})`);
    const status = async () =>
      (
        await x<{ s: string; login: string | null }>(sql`
          select allowlist_status::text as s, login_id::text as login
            from telegram_chats where id = ${chat}`)
      )[0];
    const block = await call(`/api/agents/${agent}/telegram/chats`, 'POST', {
      chatId: chat,
      status: 'denied',
    });
    clean(block);
    expect(block.status, block.text).toBe(200);
    expect(await status()).toEqual({ s: 'denied', login: null });
    const unpair = await call(`/api/agents/${agent}/telegram/chats`, 'POST', {
      chatId: chat,
      status: 'pending',
    });
    clean(unpair);
    expect(unpair.status, unpair.text).toBe(200);
    expect(await status()).toEqual({ s: 'pending', login: null });
    // Another bot's chat id under this assistant: not found, nothing moves.
    const other = await call(`/api/agents/${agent}/telegram/chats`, 'POST', {
      chatId: randomUUID(),
      status: 'denied',
    });
    expect(other.status, other.text).toBe(404);
  });

  /** A builtin tool row of the owner (its handler is the builtin's). */
  const seedTool = async (slug: string) => {
    const { BUILTIN_TOOLS } = await import('@mantle/tools');
    const def = BUILTIN_TOOLS.find((t) => t.slug === slug)!;
    await x(sql`insert into tools (owner_id, slug, name, description, input_schema, handler)
      values (${owner}, ${slug}, ${def.name}, ${def.description},
              ${JSON.stringify(def.inputSchema)}::jsonb,
              ${JSON.stringify({ kind: 'builtin', ref: slug })}::jsonb)
      on conflict do nothing`);
  };

  it('API console: POST execute-tool runs a tool that writes (console-tool)', async () => {
    await seedTool('note_create');
    const r = await call('/api/dev-tools/execute-tool', 'POST', {
      slug: 'note_create',
      input: { title: `${tag} console note`, content: 'x' },
    });
    clean(r);
    expect(JSON.parse(r.text), r.text).toMatchObject({ ok: true });
    expect(await x(sql`select 1 from nodes where title = ${`${tag} console note`}`)).toHaveLength(
      1,
    );
  });

  it('pending: PATCH approve of a row with no login and no origin (pending-call)', async () => {
    await seedTool('note_create');
    const [p] = await x<{
      id: string;
    }>(sql`insert into pending_tool_calls (owner_id, tool_slug, args)
      values (${owner}, 'note_create',
              ${JSON.stringify({ title: `${tag} pending note`, content: 'x' })}::jsonb)
      returning id::text as id`);
    const r = await call(`/api/pending/${p!.id}`, 'PATCH', { decision: 'approve' });
    clean(r);
    expect(await x(sql`select 1 from nodes where title = ${`${tag} pending note`}`)).toHaveLength(
      1,
    );
  });
});
