/**
 * The messenger's MCP tools (Messenger V1, plan page d8954876 sections 6, 12
 * and 17) on a migrated scratch brain: every tool runs as the caller, in its
 * scope; messenger_wait answers on a NOTIFY and empty at the timeout; a
 * message sent through the caller's own credential (via) is no answer to its
 * wait; a group with one human works; two member logins chat with send and
 * wait; fix round 2: a route's send and the tool's take one budget (the
 * 61st in a minute is refused either way); an outsider is refused send,
 * wait and mark read.
 *
 *   MANTLE_TEST_DATABASE_URL=postgres://… pnpm vitest run packages/tools/src/builtins-messenger.db.test.ts
 */
import { randomUUID } from 'node:crypto';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';

const URL = process.env.MANTLE_TEST_DATABASE_URL;

describe.skipIf(!URL)('the messenger MCP tools (Messenger V1 Phase 1)', () => {
  type Ts = typeof import('@mantle/db/test-support');
  let ts: Ts;
  let scratch: Awaited<ReturnType<Ts['createMigratedScratchDatabase']>> | undefined;
  let m: typeof import('@mantle/db');
  let tools: typeof import('./builtins-messenger');
  let ms: typeof import('@mantle/content/messenger');
  let sqlTag: typeof import('drizzle-orm').sql;
  let su: (q: ReturnType<typeof import('drizzle-orm').sql>) => Promise<unknown[]>;
  let pool: {
    listen: (c: string, cb: (p: string) => void) => Promise<{ unlisten: () => Promise<void> }>;
  };

  const tag = `ms${randomUUID().replace(/-/g, '').slice(0, 8)}`;
  const owner = randomUUID();
  const adminB = randomUUID();
  const A = randomUUID();
  const B = randomUUID();
  const C = randomUUID();
  const D = randomUUID();
  const W = randomUUID();
  const W2 = randomUUID();
  const agent = randomUUID();
  const changed: string[] = [];
  const notices: string[] = [];
  const unlistens: (() => Promise<void>)[] = [];

  const as = <T>(loginId: string, fn: () => Promise<T>) => m.withViewer({ login: loginId }, fn);
  beforeAll(async () => {
    ts = await import('@mantle/db/test-support');
    scratch = await ts.createMigratedScratchDatabase(URL!);
    process.env.DATABASE_URL = scratch.url;
    process.env.MANTLE_MASTER_KEY ??= 'mantle-viewer-test-key';
    m = await import('@mantle/db');
    tools = await import('./builtins-messenger');
    ms = await import('@mantle/content/messenger');
    sqlTag = (await import('drizzle-orm')).sql;
    await ts.ensureTestViewerRoles(URL!, process.env.MANTLE_MASTER_KEY);
    su = (q) => ts.superuserExec(scratch!.url, q);
    pool = (m.systemDb as unknown as { $client: typeof pool }).$client;
    unlistens.push((await pool.listen('messenger_changed', (p) => changed.push(p))).unlisten);
    unlistens.push((await pool.listen('login_notice', (p) => notices.push(p))).unlisten);

    await su(sqlTag`insert into auth.users (id, email, password_hash, role, is_owner, display_name)
      values (${owner}, ${`${tag}-o@example.invalid`}, 'x', 'admin', true, 'Olive Owner')`);
    await ts.runWorkspacesSwitch(scratch.url);
    await su(sqlTag`insert into auth.users (id, email, password_hash, role, display_name) values
      (${adminB}, ${`${tag}-b@example.invalid`}, 'x', 'admin', 'Bea Admin'),
      (${A}, ${`${tag}-a@example.invalid`}, 'x', 'member', 'Ann'),
      (${B}, ${`${tag}-bb@example.invalid`}, 'x', 'member', 'Ben'),
      (${C}, ${`${tag}-c@example.invalid`}, 'x', 'member', 'Cat'),
      (${D}, ${`${tag}-d@example.invalid`}, 'x', 'member', 'Dan')`);
    const [adminWs] = (await su(
      sqlTag`select id::text as id from workspaces where is_admin and archived_at is null limit 1`,
    )) as { id: string }[];
    await su(sqlTag`insert into workspace_users (workspace_id, login_id) values (${adminWs!.id}, ${adminB})
      on conflict do nothing`);
    await su(sqlTag`insert into workspaces (id, owner_id, name) values
      (${W}, ${owner}, ${`${tag} W`}), (${W2}, ${owner}, ${`${tag} W2`})`);
    await su(sqlTag`delete from workspace_users where login_id in (${A}, ${B}, ${C}, ${D})`);
    await su(sqlTag`insert into workspace_users (workspace_id, login_id) values
      (${W}, ${A}), (${W}, ${B}), (${W}, ${D}), (${W2}, ${C})`);
    await su(sqlTag`insert into agents (id, owner_id, slug, name, model, system_prompt, role, workspace_id)
      values (${agent}, ${owner}, ${`${tag}-tess`}, 'Tess', 'test/model', 'x', 'assistant', ${W})`);
    await su(sqlTag`insert into workspace_resources (workspace_id, type, ref_id)
      values (${W}, 'assistant', ${agent})`);
  }, 180_000);

  beforeEach(() => ms?.resetMessengerBudgetsForTests());

  afterAll(async () => {
    for (const u of unlistens) await u().catch(() => {});
    await m?.closeDb();
    await scratch?.drop();
  }, 120_000);

  // ── MCP tools and wait ─────────────────────────────────────────────────

  const ctxFor = (loginId: string, keyId: string) => ({
    ownerId: owner,
    surface: {
      kind: 'owner' as const,
      via: 'mcp' as const,
      loginId,
      mcp: { via: 'key' as const, write: true, keyId },
    },
  });
  const tool = (slug: string) => tools.MESSENGER_TOOLS.find((t) => t.slug === slug)!;
  const call = (slug: string, loginId: string, keyId: string, input: Record<string, unknown>) =>
    as(loginId, () => tool(slug).handler(input, ctxFor(loginId, keyId) as never)) as Promise<{
      ok: boolean;
      output?: Record<string, unknown>;
      error?: string;
    }>;

  it('the MCP tools run as the caller; wait answers on a NOTIFY and skips its own via', async () => {
    const k1 = randomUUID();
    const k2 = randomUUID();
    // One login, two credentials, a group with one human (decision 19.3 B).
    const made = await call('messenger_create', A, k1, { kind: 'group', participants: [] });
    expect(made.ok, made.error).toBe(true);
    const c = made.output!.conversation as string;
    const first = await call('messenger_send', A, k1, { conversation: c, text: 'from k1' });
    expect(first.ok).toBe(true);
    const after = (first.output!.message as { seq: number }).seq;

    // k1 waits; k1's own message is not an answer; k2's is.
    const waiting = call('messenger_wait', A, k1, { conversation: c, after_seq: 0, timeout_s: 10 });
    const sent = await call('messenger_send', A, k2, { conversation: c, text: 'from k2' });
    expect(sent.ok).toBe(true);
    const woke = await waiting;
    expect(woke.ok).toBe(true);
    const got = woke.output!.messages as { text: string; seq: number }[];
    expect(got.map((x) => x.text)).toEqual(['from k2']);
    expect(got[0]!.seq).toBeGreaterThan(after);
    expect(woke.output!.timedOut).toBe(false);

    // Nothing new from another credential: empty at the timeout.
    const t0 = Date.now();
    const idle = await call('messenger_wait', A, k2, {
      conversation: c,
      after_seq: got[0]!.seq,
      timeout_s: 1,
    });
    expect(idle.output).toMatchObject({ messages: [], timedOut: true });
    expect(Date.now() - t0).toBeGreaterThanOrEqual(900);

    // A participant only: an outsider's tools hear "not found".
    const outsider = await call('messenger_open', C, randomUUID(), { conversation: c });
    expect(outsider.ok).toBe(false);
    const listed = await call('messenger_list', A, k1, {});
    expect((listed.output!.chats as { id: string }[]).some((r) => r.id === c)).toBe(true);
    const read = await call('messenger_mark_read', A, k1, { conversation: c, seq: 2 });
    expect(read.output).toEqual({ lastReadSeq: 2 });
    const dir = await call('messenger_directory', A, k1, {});
    expect((dir.output!.entries as { id: string }[]).some((e) => e.id === B)).toBe(true);
    // No face reaches a model: the content module always sets avatar (null
    // without a seed), and the tools leave it and photoVersion out.
    for (const e of dir.output!.entries as Record<string, unknown>[]) {
      expect('avatar' in e || 'photoVersion' in e).toBe(false);
    }
  }, 30_000);

  it('a connection that names no login is refused, never the owner (a peer of an Admin user)', async () => {
    const peerCtx = {
      ownerId: owner,
      surface: {
        kind: 'owner' as const,
        via: 'federation' as const,
        mcp: { via: 'peer' as const, write: true, peerId: randomUUID() },
      },
    };
    for (const slug of ['messenger_list', 'messenger_directory', 'messenger_create']) {
      const out = (await tool(slug).handler(
        slug === 'messenger_create' ? { kind: 'group', participants: [] } : {},
        peerCtx as never,
      )) as { ok: boolean; error?: string };
      expect(out.ok, slug).toBe(false);
      expect(out.error, slug).toMatch(/one login/);
    }
  });

  it('two member logins chat through send and wait', async () => {
    const made = await call('messenger_create', A, randomUUID(), {
      kind: 'direct',
      participants: [B],
    });
    expect(made.ok, made.error).toBe(true);
    const c = made.output!.conversation as string;
    const opened = await call('messenger_open', B, randomUUID(), { conversation: c });
    const people = (opened.output!.conversation as { participants: Record<string, unknown>[] })
      .participants;
    expect(people.length).toBe(2);
    for (const p of people) expect('avatar' in p || 'photoVersion' in p).toBe(false);
    const last = opened.output!.lastSeq as number;
    const waiting = call('messenger_wait', B, randomUUID(), {
      conversation: c,
      after_seq: last,
      timeout_s: 10,
    });
    await call('messenger_send', A, randomUUID(), { conversation: c, text: 'ping' });
    const woke = await waiting;
    expect((woke.output!.messages as { text: string; author: string }[])[0]).toMatchObject({
      text: 'ping',
      author: 'Ann',
    });
  }, 30_000);

  it('a route and the tools take one budget: the 61st send in a minute is refused either way', async () => {
    const k = randomUUID();
    const made = await call('messenger_create', D, k, { kind: 'group', participants: [] });
    expect(made.ok, made.error).toBe(true);
    const c = made.output!.conversation as string;
    // POST /api/messenger/c/:id/messages calls the store as this does.
    const routeSend = (body: string) =>
      as(D, () => ms.sendMessengerMessage({ ownerId: owner, loginId: D }, c, { body }));
    for (let i = 0; i < 30; i++) await routeSend(`route ${i}`);
    for (let i = 0; i < 30; i++) {
      const out = await call('messenger_send', D, k, { conversation: c, text: `tool ${i}` });
      expect(out.ok, out.error).toBe(true);
    }
    const over = await call('messenger_send', D, k, { conversation: c, text: 'one too many' });
    expect(over.ok).toBe(false);
    expect(over.error).toMatch(/Try again in \d+ s/);
    await expect(routeSend('and by the route')).rejects.toThrow(ms.MessengerRateLimitedError);
    const [n] = (await su(
      sqlTag`select count(*)::int as n from messenger_messages where conversation_id = ${c}`,
    )) as { n: number }[];
    expect(n!.n).toBe(60);
  }, 60_000);

  it('an outsider is refused send, wait and mark read with "not found"', async () => {
    const made = await call('messenger_create', A, randomUUID(), {
      kind: 'group',
      participants: [B],
    });
    const c = made.output!.conversation as string;
    await call('messenger_send', A, randomUUID(), { conversation: c, text: 'members only' });
    for (const [slug, input] of [
      ['messenger_send', { conversation: c, text: 'let me in' }],
      ['messenger_wait', { conversation: c, after_seq: 0, timeout_s: 0 }],
      ['messenger_mark_read', { conversation: c, seq: 1 }],
      ['messenger_open', { conversation: c }],
    ] as const) {
      const out = await call(slug, C, randomUUID(), input);
      expect(out.ok, slug).toBe(false);
      expect(out.error, slug).toMatch(/not found/i);
      expect(JSON.stringify(out), slug).not.toContain('members only');
    }
    const [n] = (await su(
      sqlTag`select count(*)::int as n from messenger_messages where conversation_id = ${c}`,
    )) as { n: number }[];
    expect(n!.n).toBe(1);
  });
});
