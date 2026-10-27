/**
 * The messenger store (Messenger V1, plan page d8954876 section 17), on a
 * migrated scratch brain on workspaces:
 *
 *  - the row security matrix: a participant reads; a non-participant, an
 *    Admin user not in the chat and the brain owner read nothing; a left
 *    participant reads up to left_seq and not after; an agent row never
 *    widens a human's read; favourites are the login's own;
 *  - seq: 50 concurrent sends give 1..50, no gap, no duplicate;
 *  - an idempotent send (client_msg_id);
 *  - the unread arithmetic (send, read, mention, clear, mute) and the badge
 *    total with an agent thread;
 *  - direct dedup, and the pair cannot change;
 *  - the directory (shared workspaces; an Admin user sees everyone; the
 *    agents of the login's workspaces);
 *  - favourites (a pin needs a participant row or an agent the login may
 *    chat with; favourites first);
 *  - the triggers' payloads are ids only; the author and a muted
 *    participant get no notice.
 *
 * The MCP tools and messenger_wait: packages/tools/src/builtins-messenger.db.test.ts.
 *
 *   MANTLE_TEST_DATABASE_URL=postgres://… pnpm vitest run packages/content/src/messenger.db.test.ts
 */
import { randomUUID } from 'node:crypto';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

const URL = process.env.MANTLE_TEST_DATABASE_URL;

describe.skipIf(!URL)('the messenger store (Messenger V1 Phase 1)', () => {
  type Ts = typeof import('@mantle/db/test-support');
  let ts: Ts;
  let scratch: Awaited<ReturnType<Ts['createMigratedScratchDatabase']>> | undefined;
  let m: typeof import('@mantle/db');
  let ms: typeof import('./messenger');
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

  const actor = (loginId: string, via?: { label: string | null; ref: string }) => ({
    ownerId: owner,
    loginId,
    via: via ?? null,
  });
  const as = <T>(loginId: string, fn: () => Promise<T>) => m.withViewer({ login: loginId }, fn);
  /** Rows the workspace role reads, with no WHERE of the module's own. */
  const raw = async (loginId: string, table: string, c: string) =>
    as(loginId, async () => {
      const col = table === 'messenger_conversations' ? 'id' : 'conversation_id';
      const rows = (await m.db.execute(
        sqlTag.raw(`select * from ${table} where ${col} = '${c}'`),
      )) as unknown as Record<string, unknown>[];
      return rows;
    });

  beforeAll(async () => {
    ts = await import('@mantle/db/test-support');
    scratch = await ts.createMigratedScratchDatabase(URL!);
    process.env.DATABASE_URL = scratch.url;
    process.env.MANTLE_MASTER_KEY ??= 'mantle-viewer-test-key';
    m = await import('@mantle/db');
    ms = await import('./messenger');
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

  afterAll(async () => {
    for (const u of unlistens) await u().catch(() => {});
    await m?.closeDb();
    await scratch?.drop();
  }, 120_000);

  // ── Row security ───────────────────────────────────────────────────────

  it('the row security matrix: participants read, nobody else does, a leaver up to left_seq', async () => {
    const direct = await ms.createMessengerConversation(actor(A), {
      kind: 'direct',
      participants: [B],
    });
    for (const t of ['one', 'two'])
      await ms.sendMessengerMessage(actor(A), direct.conversationId, { body: t });
    const group = await ms.createMessengerConversation(actor(A), {
      kind: 'group',
      participants: [B],
      title: 'Room',
    });
    const g = group.conversationId;
    await ms.sendMessengerMessage(actor(A), g, { body: 'before' });
    await ms.leaveMessengerConversation(actor(B), g);
    const leftRows = (await su(
      sqlTag`select left_seq::int as left_seq from messenger_participants
              where conversation_id = ${g} and login_id = ${B}`,
    )) as { left_seq: number }[];
    const leftSeq = leftRows[0]!.left_seq;
    await ms.sendMessengerMessage(actor(A), g, { body: 'after B left' });
    // An agent row in the group widens nobody's read.
    await su(sqlTag`insert into messenger_participants (conversation_id, kind, agent_id)
      values (${g}, 'agent', ${agent})`);

    for (const [who, n] of [
      [A, 2],
      [B, 2],
      [C, 0],
      [owner, 0],
      [adminB, 0],
    ] as const) {
      expect((await raw(who, 'messenger_messages', direct.conversationId)).length, who).toBe(n);
      expect((await raw(who, 'messenger_conversations', direct.conversationId)).length, who).toBe(
        n ? 1 : 0,
      );
      expect((await raw(who, 'messenger_participants', direct.conversationId)).length, who).toBe(
        n ? 2 : 0,
      );
    }
    const bSees = (await raw(B, 'messenger_messages', g)).map((r) => Number(r.seq));
    expect(Math.max(...bSees)).toBe(leftSeq);
    const aSees = (await raw(A, 'messenger_messages', g)).map((r) => Number(r.seq));
    expect(Math.max(...aSees)).toBeGreaterThan(leftSeq);
    for (const who of [C, owner, adminB]) {
      expect(await raw(who, 'messenger_messages', g)).toEqual([]);
      expect(await raw(who, 'messenger_participants', g)).toEqual([]);
    }
    // The module answers the same: an outsider hears "not found".
    await expect(as(C, () => ms.getMessengerConversation(actor(C), g))).rejects.toThrow(
      ms.MessengerNotFoundError,
    );
    await expect(as(owner, () => ms.listMessengerMessages(actor(owner), g))).rejects.toThrow(
      ms.MessengerNotFoundError,
    );
    const page = await as(B, () => ms.listMessengerMessages(actor(B), g, { limit: 100 }));
    expect(Math.max(...page.messages.map((x) => x.seq))).toBe(leftSeq);
    // A left participant cannot send.
    await expect(ms.sendMessengerMessage(actor(B), g, { body: 'back?' })).rejects.toThrow(
      ms.MessengerRefusedError,
    );
  });

  it('after a leave the list shows no newer line; an added login reads from its add line, never the gap', async () => {
    const { conversationId: g } = await ms.createMessengerConversation(actor(A), {
      kind: 'group',
      participants: [B],
      title: 'Gap',
    });
    await ms.sendMessengerMessage(actor(A), g, { body: 'old history' });
    await ms.removeMessengerParticipant(actor(A), g, B);
    const secret = `after-${randomUUID()}`;
    await ms.sendMessengerMessage(actor(A), g, { body: secret });
    // Removed: the list row carries no preview, time or seq past the removal.
    const row = (await as(B, () => ms.listMessengerConversations(actor(B)))).find(
      (r) => r.id === g,
    )!;
    expect(JSON.stringify(row)).not.toContain(secret);
    expect(row.preview).toBeNull();
    const conv = await as(B, () => ms.getMessengerConversation(actor(B), g));
    expect(conv.lastSeq).toBe(conv.me.leftSeq);
    // D, added now, and B, added back: both read from the add line only.
    await ms.addMessengerParticipants(actor(A), g, [B, D]);
    await ms.sendMessengerMessage(actor(A), g, { body: 'welcome' });
    for (const who of [B, D]) {
      const page = await as(who, () => ms.listMessengerMessages(actor(who), g, { limit: 100 }));
      const bodies = page.messages.map((m) => m.body);
      expect(bodies, who).not.toContain(secret);
      expect(bodies[0], who).toMatch(/ added /);
      expect(bodies, who).toContain('welcome');
      // Row security agrees, with no WHERE of the module's own.
      const rawBodies = (await raw(who, 'messenger_messages', g)).map((r) => String(r.body));
      expect(rawBodies, who).not.toContain(secret);
    }
    expect((await raw(D, 'messenger_messages', g)).map((r) => String(r.body))).not.toContain(
      'old history',
    );
    // Their unread starts at the add line, not the whole history.
    const dRow = (await as(D, () => ms.listMessengerConversations(actor(D)))).find(
      (r) => r.id === g,
    )!;
    expect(dRow.unread).toBe(2);
  });

  it("favourites are the login's own rows", async () => {
    const c = await ms.createMessengerConversation(actor(A), { kind: 'group', participants: [B] });
    await ms.setMessengerFavourite(actor(A), 'conversation', c.conversationId);
    const mine = await as(
      A,
      async () =>
        (await m.db.execute(sqlTag`select * from messenger_favourites`)) as unknown as unknown[],
    );
    const theirs = await as(
      B,
      async () =>
        (await m.db.execute(sqlTag`select * from messenger_favourites`)) as unknown as unknown[],
    );
    expect(mine.length).toBeGreaterThan(0);
    expect(theirs).toEqual([]);
  });

  // ── Seq and idempotency ────────────────────────────────────────────────

  it('50 concurrent sends to one conversation give 1..50, no gap, no duplicate', async () => {
    const { conversationId: c } = await ms.createMessengerConversation(actor(A), {
      kind: 'group',
      participants: [B],
    });
    await Promise.all(
      Array.from({ length: 50 }, (_, i) =>
        ms.sendMessengerMessage(actor(i % 2 ? A : B), c, { body: `n${i}` }),
      ),
    );
    const rows = (await su(
      sqlTag`select seq::int as seq from messenger_messages where conversation_id = ${c} order by seq`,
    )) as { seq: number }[];
    expect(rows.map((r) => r.seq)).toEqual(Array.from({ length: 50 }, (_, i) => i + 1));
    const [conv] = (await su(
      sqlTag`select last_seq::int as last_seq from messenger_conversations where id = ${c}`,
    )) as { last_seq: number }[];
    expect(conv!.last_seq).toBe(50);
  });

  it('the same client_msg_id twice stores one row and answers the same seq', async () => {
    const { conversationId: c } = await ms.createMessengerConversation(actor(A), {
      kind: 'group',
      participants: [],
    });
    const one = await ms.sendMessengerMessage(actor(A), c, { body: 'hi', clientMsgId: 'k-1' });
    const two = await ms.sendMessengerMessage(actor(A), c, { body: 'hi', clientMsgId: 'k-1' });
    expect([one.created, two.created]).toEqual([true, false]);
    expect(two.message.seq).toBe(one.message.seq);
    const rows = (await su(
      sqlTag`select count(*)::int as n from messenger_messages where conversation_id = ${c}`,
    )) as { n: number }[];
    expect(rows[0]!.n).toBe(1);
  });

  // ── Unread ─────────────────────────────────────────────────────────────

  it('unread arithmetic: send, read, mention, clear, mute; the badge counts agent threads', async () => {
    const { conversationId: c } = await ms.createMessengerConversation(actor(A), {
      kind: 'group',
      participants: [B],
    });
    const rowOf = async () =>
      (await as(B, () => ms.listMessengerConversations(actor(B)))).find((r) => r.id === c)!;
    for (const t of ['a', 'b', 'c']) await ms.sendMessengerMessage(actor(A), c, { body: t });
    expect((await rowOf()).unread).toBe(3);
    await ms.markMessengerRead(actor(B), c, 2);
    expect((await rowOf()).unread).toBe(1);
    // The cursor never moves back.
    expect((await ms.markMessengerRead(actor(B), c, 1)).lastReadSeq).toBe(2);
    await ms.sendMessengerMessage(actor(A), c, {
      body: '@Ben look',
      mentions: [{ kind: 'login', id: B }],
    });
    expect((await rowOf()).mention).toBe(true);
    expect((await rowOf()).unread).toBe(2);
    // Muted chats still count.
    await ms.patchMessengerConversation(actor(B), c, { muted: true });
    expect((await rowOf()).unread).toBe(2);
    expect((await rowOf()).muted).toBe(true);
    await ms.clearMessengerForMe(actor(B), c);
    expect(await rowOf()).toMatchObject({ unread: 0, mention: false });
    // Cleared: nothing older shows, for B only.
    expect((await as(B, () => ms.listMessengerMessages(actor(B), c))).messages).toEqual([]);
    expect(
      (await as(A, () => ms.listMessengerMessages(actor(A), c))).messages.length,
    ).toBeGreaterThan(0);
    // The author's own message is read for the author.
    expect(
      (await as(A, () => ms.listMessengerConversations(actor(A)))).find((r) => r.id === c)!.unread,
    ).toBe(0);

    // An agent thread: two assistant replies to B, no read cursor.
    await su(sqlTag`with q as (select set_config('mantle.conversation_notify', 'off', true) as s)
      insert into assistant_messages (owner_id, agent_id, login_id, direction, text, data)
      select ${owner}, ${agent}, ${B}, 'outbound', t, '{"digest_skip": true}'::jsonb
        from q, unnest(array['r1', 'r2']) as t`);
    const before = await as(B, () => ms.messengerUnread(actor(B)));
    expect(before.agents).toBe(2);
    const list = await as(B, () => ms.listMessengerConversations(actor(B)));
    const total = list.reduce((s, r) => s + r.unread, 0);
    expect(before.total).toBe(total);
    expect(list.find((r) => r.kind === 'agent' && r.id === agent)?.unread).toBe(2);
  });

  // ── Direct dedup ───────────────────────────────────────────────────────

  it('a pair has one direct chat, and the pair cannot change', async () => {
    const one = await ms.createMessengerConversation(actor(A), {
      kind: 'direct',
      participants: [D],
    });
    const two = await ms.createMessengerConversation(actor(D), {
      kind: 'direct',
      participants: [A],
    });
    expect(two.conversationId).toBe(one.conversationId);
    expect([one.created, two.created]).toEqual([true, false]);
    await expect(ms.addMessengerParticipants(actor(A), one.conversationId, [B])).rejects.toThrow(
      ms.MessengerRefusedError,
    );
    await expect(ms.leaveMessengerConversation(actor(A), one.conversationId)).rejects.toThrow(
      ms.MessengerRefusedError,
    );
    await expect(
      ms.createMessengerConversation(actor(A), { kind: 'direct', participants: [B, D] }),
    ).rejects.toThrow();
  });

  // ── Directory ──────────────────────────────────────────────────────────

  it('the directory: shared workspaces only; an Admin user sees everyone; the assistants', async () => {
    const ids = async (who: string) =>
      (await ms.messengerDirectory(actor(who))).map((e) => `${e.kind}:${e.id}`);
    const a = await ids(A);
    expect(a).toEqual(expect.arrayContaining([`login:${B}`, `login:${D}`, `agent:${agent}`]));
    expect(a).not.toContain(`login:${C}`);
    expect(a).not.toContain(`login:${A}`);
    const c = await ids(C);
    expect(c.filter((x) => x.startsWith('login:'))).toEqual([]);
    expect(c).not.toContain(`agent:${agent}`);
    const o = await ids(owner);
    expect(o).toEqual(
      expect.arrayContaining([`login:${A}`, `login:${B}`, `login:${C}`, `login:${adminB}`]),
    );
    // The assistant of a workspace the Admin user is not in is not theirs.
    expect(o).not.toContain(`agent:${agent}`);
    // Starting a chat outside the directory is refused.
    await expect(
      ms.createMessengerConversation(actor(A), { kind: 'direct', participants: [C] }),
    ).rejects.toThrow(ms.MessengerRefusedError);
  });

  // ── Favourites ─────────────────────────────────────────────────────────

  it('a pin needs a participant row or an agent I may chat with; favourites come first', async () => {
    const mine = await ms.createMessengerConversation(actor(A), {
      kind: 'group',
      participants: [],
    });
    const notMine = await ms.createMessengerConversation(actor(B), {
      kind: 'group',
      participants: [],
    });
    await expect(
      ms.setMessengerFavourite(actor(A), 'conversation', notMine.conversationId),
    ).rejects.toThrow(ms.MessengerNotFoundError);
    await expect(ms.setMessengerFavourite(actor(C), 'agent', agent)).rejects.toThrow(
      ms.MessengerNotFoundError,
    );
    await ms.setMessengerFavourite(actor(A), 'agent', agent, 1);
    await ms.setMessengerFavourite(actor(A), 'conversation', mine.conversationId, 0);
    // A newer chat without a pin stays below the pins.
    const newer = await ms.createMessengerConversation(actor(A), {
      kind: 'group',
      participants: [B],
    });
    await ms.sendMessengerMessage(actor(A), newer.conversationId, { body: 'newest' });
    const list = await as(A, () => ms.listMessengerConversations(actor(A)));
    const firstPlain = list.findIndex((r) => !r.favourite);
    expect(list.slice(firstPlain).some((r) => r.favourite)).toBe(false);
    const at = (id: string) => list.findIndex((r) => r.id === id);
    expect(at(mine.conversationId)).toBeLessThan(at(agent));
    expect(at(agent)).toBeLessThan(firstPlain);
    expect(at(newer.conversationId)).toBeGreaterThanOrEqual(firstPlain);
    await ms.removeMessengerFavourite(actor(A), 'agent', agent);
    const after = await as(A, () => ms.listMessengerConversations(actor(A)));
    expect(after.find((r) => r.id === agent)?.favourite ?? false).toBe(false);
  });

  // ── Triggers ───────────────────────────────────────────────────────────

  it('the triggers carry ids only; the author and a muted participant get no notice', async () => {
    const { conversationId: c } = await ms.createMessengerConversation(actor(A), {
      kind: 'group',
      participants: [B, D],
    });
    await ms.patchMessengerConversation(actor(D), c, { muted: true });
    changed.length = 0;
    notices.length = 0;
    const secret = `secret-${randomUUID()}`;
    const { message } = await ms.sendMessengerMessage(actor(A), c, { body: secret });
    await ts.pollUntil(() => changed.some((p) => p.includes(c)) && notices.length >= 1, {
      what: 'the messenger notifies',
    });
    // A beat for any stray notice to land.
    await new Promise((r) => setTimeout(r, 300));
    for (const p of [...changed, ...notices]) expect(p).not.toContain(secret);
    const ch = changed.map((p) => JSON.parse(p)).filter((p) => p.c === c && p.kind === 'new');
    expect(ch).toEqual([{ c, seq: message.seq, kind: 'new', actor: A }]);
    expect(Object.keys(ch[0]!).sort()).toEqual(['actor', 'c', 'kind', 'seq']);
    const ln = notices.map((p) => JSON.parse(p)).filter((p) => p.c === c);
    expect(ln).toEqual([{ kind: 'message', loginId: B, c, seq: message.seq }]);
  });
});
