/**
 * What a member or a client is told about on its phone (migration mobile_roles_push), on
 * a real, migrated Postgres:
 *
 *  - the `login_notice` event fires for a finished reply in a login's own
 *    chat thread and for a review result (accepted, returned, taken), and
 *    for nothing else (an inbound or pending row, a failed reply, a portal
 *    thread, a submit, a recall, a save; comments are gone, 2026-10-09);
 *  - the message built from an event is for the ONE login it concerns, with
 *    words that login could read by opening the app: never an admin, never a
 *    disabled login, never a stale row, never a thread the reader may not
 *    read (an item raised above client level tells no client);
 *  - a login's unread count: nothing unread at first, finished replies only,
 *    a reply still being written is not marked read by mistake;
 *  - the trigger functions only notify (cost-safety: no write, no job).
 *
 * It runs on a scratch database of its own: "nothing fired" must be provable
 * and the brain is looked up as THE brain space.
 *   MANTLE_TEST_DATABASE_URL=postgres://… pnpm vitest run packages/content/src/login-notices.viewer.db.test.ts
 */
import { randomUUID } from 'node:crypto';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { LoginNotice } from './login-notices';

const URL = process.env.MANTLE_TEST_DATABASE_URL;
const CHANNEL = 'login_notice';

describe.skipIf(!URL)('login notices: the event, who is told, the unread count', () => {
  type Db = typeof import('@mantle/db');
  let m: Db;
  let sp: typeof import('./member-space');
  let rv: typeof import('./member-review');
  let tk: typeof import('./member-takeover');
  let tm: typeof import('./team-messages');
  let ln: typeof import('./login-notices');
  let ts: typeof import('@mantle/db/test-support');
  let sqlTag: typeof import('drizzle-orm').sql;
  let scratch: { url: string; drop: () => Promise<void> } | undefined;
  let unlisten: (() => Promise<void>) | undefined;
  const raw: string[] = [];
  const tag = `lnote-${randomUUID().slice(0, 8)}`;
  const anchor = randomUUID();
  const adminA = randomUUID();
  const member = randomUUID();
  const member2 = randomUUID();
  const client = randomUUID();
  const client2 = randomUUID();
  const agent = randomUUID();
  const spaceOf: Record<string, string> = {};
  const root = mkdtempSync(path.join(tmpdir(), 'mantle-login-notices-'));

  const as = <T>(login: string, fn: () => Promise<T>) =>
    m.withSpace({ spaceId: spaceOf[login]!, loginId: login }, fn);
  const exec = async <T>(q: ReturnType<typeof sqlTag>) =>
    (await m.systemDb.execute(q)) as unknown as T[];
  const actorA = () => ({ loginId: adminA, spaceId: spaceOf[adminA]! });
  const say = (text: string) => ({
    type: 'doc',
    content: [{ type: 'paragraph', content: [{ type: 'text', text }] }],
  });
  const admin = () =>
    (m.systemDb as unknown as { $client: Parameters<typeof ts.notifyBarrier>[0] }).$client;

  /** Wait until everything committed so far has reached the listener. */
  const drain = async (): Promise<string> => {
    let sentinel = '';
    await ts.notifyBarrier(admin(), CHANNEL, {
      payload: (s) => JSON.stringify({ kind: 'barrier', id: s }),
      seen: (s) => {
        sentinel = s;
        return raw.some((p) => p.includes(s));
      },
    });
    return sentinel;
  };
  /** The notices `fn` sent, parsed (the barrier's own payload is not one). */
  const sent = async (fn: () => Promise<unknown>): Promise<LoginNotice[]> => {
    await drain();
    raw.length = 0;
    await fn();
    await drain();
    return raw.map((p) => ln.parseLoginNotice(p)).filter((n): n is LoginNotice => n !== null);
  };

  const newPage = async (login: string, title: string) => {
    const s = spaceOf[login]!;
    const id = (await as(login, () => sp.createMineItem(s, { type: 'page', title }))).id;
    expect((await as(login, () => sp.saveMinePage(s, id, say(`${title} words`)))).ok).toBe(true);
    return id;
  };
  const newNote = async (login: string, title: string) =>
    (
      await as(login, () =>
        sp.createMineItem(spaceOf[login]!, { type: 'note', title, content: 'x' }),
      )
    ).id;
  const submit = (login: string, id: string) => as(login, () => sp.submitItem(spaceOf[login]!, id));
  const reply = (loginId: string, text: string, extra: Record<string, unknown> = {}) =>
    tm.appendTeamMessage({
      ownerId: anchor,
      contactId: null,
      loginId,
      direction: 'outbound',
      text,
      ...extra,
    });

  beforeAll(async () => {
    ts = await import('@mantle/db/test-support');
    scratch = await ts.createMigratedScratchDatabase(URL!);
    process.env.DATABASE_URL = scratch.url;
    process.env.MANTLE_MASTER_KEY ??= 'mantle-viewer-test-key';
    process.env.MANTLE_SPACES_ROOT = path.join(root, 'spaces');
    process.env.TABLE_DB_DIR = path.join(root, 'table-dbs');
    process.env.MANTLE_FILES_ROOT = path.join(root, 'files');
    m = await import('@mantle/db');
    sp = await import('./member-space');
    rv = await import('./member-review');
    tk = await import('./member-takeover');
    tm = await import('./team-messages');
    ln = await import('./login-notices');
    sqlTag = (await import('drizzle-orm')).sql;
    const pool = (m.systemDb as unknown as { $client: Parameters<Db['ensureViewerRoles']>[0] })
      .$client;
    await m.ensureViewerRoles(pool, process.env.MANTLE_MASTER_KEY);
    const sub = await pool.listen(CHANNEL, (p: string) => raw.push(p));
    unlisten = () => sub.unlisten();

    await m.systemDb.execute(sqlTag`
      insert into auth.users (id, email, password_hash, role, display_name, is_owner) values
        (${anchor}, ${`${tag}-anchor@example.invalid`}, 'x', 'admin', null, true)`);
    await m.systemDb.execute(sqlTag`
      insert into auth.users (id, email, password_hash, role, display_name) values
        (${adminA}, ${`${tag}-a@example.invalid`}, 'x', 'admin', 'Ada Admin'),
        (${member}, ${`${tag}-m@example.invalid`}, 'x', 'member', 'Mia Member'),
        (${member2}, ${`${tag}-n@example.invalid`}, 'x', 'member', 'Noah'),
        (${client}, ${`${tag}-c@example.invalid`}, 'x', 'client', 'Cleo Client'),
        (${client2}, ${`${tag}-d@example.invalid`}, 'x', 'client', 'Dan Client')`);
    await m.systemDb.execute(sqlTag`
      insert into spaces (id, kind, login_id) values (${anchor}, 'brain', ${anchor})
      on conflict (id) do nothing`);
    const rows = await exec<{ id: string; login_id: string }>(sqlTag`
      select id, login_id from spaces where kind = 'personal'
        and login_id in (${adminA}, ${member}, ${member2}, ${client}, ${client2})`);
    for (const r of rows) spaceOf[r.login_id] = r.id;
    await m.systemDb.execute(sqlTag`
      insert into agents (id, owner_id, slug, name, model, system_prompt, audience)
      values (${agent}, ${anchor}, 'team-responder', 'Tess', 'test/model', 'x', 'team')`);
  }, 180_000);

  afterAll(async () => {
    await unlisten?.();
    await m?.closeDb();
    await scratch?.drop();
    rmSync(root, { recursive: true, force: true });
  }, 120_000);

  // ── Chat ────────────────────────────────────────────────────────────────

  it('a finished reply in a login thread fires once; nothing else in a thread does', async () => {
    let id = '';
    expect(await sent(async () => (id = (await reply(member, 'Hello Mia')).id))).toEqual([
      { kind: 'chat', loginId: member, id },
    ]);
    // The member's own message, a "thinking" bubble, a portal (contact) row.
    expect(
      await sent(() =>
        tm.appendTeamMessage({
          ownerId: anchor,
          contactId: null,
          loginId: member,
          direction: 'inbound',
          text: 'a question',
        }),
      ),
    ).toEqual([]);
    let pending = '';
    expect(
      await sent(async () => (pending = (await reply(member, '', { status: 'pending' })).id)),
    ).toEqual([]);
    // The bubble finalized: once.
    expect(
      await sent(() =>
        tm.updateTeamMessageOutcome({
          ownerId: anchor,
          id: pending,
          status: 'complete',
          text: 'The answer',
        }),
      ),
    ).toEqual([{ kind: 'chat', loginId: member, id: pending }]);
    // Written again while already finished (attachments, a repair): silent.
    expect(
      await sent(() =>
        tm.updateTeamMessageOutcome({ ownerId: anchor, id: pending, status: 'complete' }),
      ),
    ).toEqual([]);
    // A failed reply never notifies.
    const failing = (await reply(member, '', { status: 'pending' })).id;
    expect(
      await sent(() =>
        tm.updateTeamMessageOutcome({ ownerId: anchor, id: failing, status: 'failed', error: 'x' }),
      ),
    ).toEqual([]);
  });

  it('the chat message is for that login, in words from its own thread', async () => {
    const row = await reply(member, '  The pump spec is **ready**.\n\n![chart](media:abc)  ', {
      agentId: agent,
    });
    const n = await ln.chatReplyNotice({ loginId: member, id: row.id });
    expect(n).toEqual({
      loginId: member,
      role: 'member',
      ownerId: anchor,
      kind: 'chat',
      title: 'Tess',
      // Plain words: the marks and the picture are gone.
      body: 'The pump spec is ready.',
      deepLink: '/portal/chat',
      collapseKey: 'chat',
    });
    // An admin's note (no agent): never the admin's name.
    const note = await reply(client, 'We fixed the date.');
    const c = await ln.chatReplyNotice({ loginId: client, id: note.id });
    expect(c).toMatchObject({ loginId: client, role: 'client', title: 'New message' });
    expect(JSON.stringify(c)).not.toContain('Ada');
  });

  it('tells nobody for another login, an admin, a disabled login or an old row', async () => {
    const row = await reply(member, 'for Mia only');
    // The event names a login the row is not for.
    expect(await ln.chatReplyNotice({ loginId: member2, id: row.id })).toBeNull();
    expect(await ln.chatReplyNotice({ loginId: client, id: row.id })).toBeNull();
    // An admin's own thread with the team agent: not a member or a client.
    const own = await reply(adminA, 'admin thread');
    expect(await ln.chatReplyNotice({ loginId: adminA, id: own.id })).toBeNull();
    // Old: a backfill that touches old rows pages nobody. Judged on the
    // database's clock, against the row's own time.
    const old = await reply(member, 'from long ago');
    expect(await ln.chatReplyNotice({ loginId: member, id: old.id })).not.toBeNull();
    await m.systemDb.execute(sqlTag`
      update team_messages set created_at = now() - interval '31 minutes' where id = ${old.id}`);
    expect(await ln.chatReplyNotice({ loginId: member, id: old.id })).toBeNull();
    // Disabled.
    const m2 = await reply(member2, 'for Noah');
    await m.systemDb.execute(
      sqlTag`update auth.users set disabled_at = now() where id = ${member2}`,
    );
    expect(await ln.chatReplyNotice({ loginId: member2, id: m2.id })).toBeNull();
    await m.systemDb.execute(
      sqlTag`update auth.users set disabled_at = null where id = ${member2}`,
    );
    expect(await ln.chatReplyNotice({ loginId: member2, id: m2.id })).not.toBeNull();
  });

  // ── Review results ──────────────────────────────────────────────────────

  let pageId = '';

  it('a submit, a recall and a save tell the author nothing', async () => {
    expect(
      await sent(async () => {
        pageId = await newPage(member, `${tag} spec`);
        await submit(member, pageId);
        await as(member, () => sp.recallItem(spaceOf[member]!, pageId));
      }),
    ).toEqual([]);
  });

  it('Return tells the author', async () => {
    await submit(member, pageId);
    expect(await sent(() => rv.returnReviewItem(pageId, { loginId: adminA }))).toEqual([
      { kind: 'review', loginId: member, id: pageId, state: 'returned' },
    ]);
    expect(await ln.reviewResultNotice(member, 'returned', [pageId])).toEqual({
      loginId: member,
      role: 'member',
      ownerId: anchor,
      kind: 'review',
      title: 'Returned',
      body: `"${tag} spec" was returned.`,
      deepLink: `/portal/items/${pageId}`,
      itemId: pageId,
      state: 'returned',
      collapseKey: `review:${pageId}`,
    });
    // Not for anyone else, and not for a state it is not in.
    expect(await ln.reviewResultNotice(member2, 'returned', [pageId])).toBeNull();
    expect(await ln.reviewResultNotice(member, 'accepted', [pageId])).toBeNull();
  });

  it('Take over tells the author under the title it had; Give back and Accept tell them too', async () => {
    await submit(member, pageId);
    expect(await sent(() => rv.takeOverReviewItem(pageId, actorA()))).toEqual([
      { kind: 'review', loginId: member, id: pageId, state: 'taken' },
    ]);
    // The admin renames its working copy: the author never reads that title.
    await m.systemDb.execute(
      sqlTag`update nodes set title = 'ADMIN WORKING TITLE' where id = ${pageId}`,
    );
    const taken = await ln.reviewResultNotice(member, 'taken', [pageId]);
    expect(taken).toMatchObject({
      title: 'With an admin',
      body: `An admin is working on "${tag} spec".`,
      deepLink: '/portal/items',
      state: 'taken',
    });
    expect(JSON.stringify(taken)).not.toContain('ADMIN WORKING TITLE');
    await m.systemDb.execute(
      sqlTag`update nodes set title = ${`${tag} spec`} where id = ${pageId}`,
    );

    expect(await sent(() => tk.giveBackTakenItem(anchor, actorA(), pageId))).toEqual([
      { kind: 'review', loginId: member, id: pageId, state: 'returned' },
    ]);

    await submit(member, pageId);
    expect(await sent(() => rv.acceptReviewItem(anchor, pageId, { loginId: adminA }))).toEqual([
      { kind: 'review', loginId: member, id: pageId, state: 'accepted' },
    ]);
    expect(await ln.reviewResultNotice(member, 'accepted', [pageId])).toMatchObject({
      title: 'Accepted',
      body: `"${tag} spec" was accepted.`,
      deepLink: `/portal/items/${pageId}`,
    });
    // The item is the brain's now. An admin renames it: the author is told
    // by the title it was accepted with, never the admin's new one.
    await m.systemDb.execute(
      sqlTag`update nodes set title = 'ADMIN RENAMED IT' where id = ${pageId}`,
    );
    const after = await ln.reviewResultNotice(member, 'accepted', [pageId]);
    expect(after?.body).toBe(`"${tag} spec" was accepted.`);
    expect(JSON.stringify(after)).not.toContain('ADMIN RENAMED IT');
    // A result that is old tells nobody (the database's clock).
    await m.systemDb.execute(sqlTag`
      update space_items set updated_at = now() - interval '31 minutes' where node_id = ${pageId}`);
    expect(await ln.reviewResultNotice(member, 'accepted', [pageId])).toBeNull();
  });

  it('a bundle is one message, named after its main item', async () => {
    const note = await newNote(member, `${tag} part`);
    const page = await newPage(member, `${tag} whole`);
    for (const id of [note, page]) {
      await submit(member, id);
      await rv.acceptReviewItem(anchor, id, { loginId: adminA });
    }
    const n = await ln.reviewResultNotice(member, 'accepted', [note, page]);
    expect(n).toMatchObject({ itemId: page, body: `"${tag} whole" was accepted.` });
  });

  it('a client author is told as a client', async () => {
    const id = await newNote(client, `${tag} request`);
    await submit(client, id);
    expect(await sent(() => rv.returnReviewItem(id, { loginId: adminA }))).toEqual([
      { kind: 'review', loginId: client, id, state: 'returned' },
    ]);
    expect(await ln.reviewResultNotice(client, 'returned', [id])).toMatchObject({
      loginId: client,
      role: 'client',
      title: 'Returned',
    });
  });

  // ── Unread ──────────────────────────────────────────────────────────────

  it('a login starts with nothing unread, then counts finished replies only', async () => {
    // member has a history by now.
    const first = await tm.loginChatUnread(anchor, member);
    expect(first.unread).toBe(0);
    await reply(member, 'one');
    await reply(member, 'two');
    await tm.appendTeamMessage({
      ownerId: anchor,
      contactId: null,
      loginId: member,
      direction: 'inbound',
      text: 'mine',
    });
    await reply(member, '', { status: 'pending' });
    await reply(member2, 'for someone else');
    expect((await tm.loginChatUnread(anchor, member)).unread).toBe(2);
    // The first read did not move the cursor again.
    expect((await tm.loginChatUnread(anchor, member)).lastReadAt).toBe(first.lastReadAt);
  });

  it('mark read clears it, never moves backwards, and the future is now', async () => {
    // No reply is being written for this login.
    await m.systemDb.execute(sqlTag`
      update team_messages set status = 'failed' where login_id = ${member} and status = 'pending'`);
    const read = await tm.markLoginChatRead(anchor, member);
    expect(read.unread).toBe(0);
    const back = await tm.markLoginChatRead(anchor, member, new Date(Date.now() - 3_600_000));
    expect(back.lastReadAt).toBe(read.lastReadAt);
    const future = await tm.markLoginChatRead(anchor, member, new Date(Date.now() + 3_600_000));
    expect(new Date(future.lastReadAt).getTime()).toBeLessThanOrEqual(Date.now() + 1000);
    await reply(member, 'three');
    expect((await tm.loginChatUnread(anchor, member)).unread).toBe(1);
  });

  it('`at` = the createdAt the chat route sent (milliseconds) clears that message', async () => {
    await tm.markLoginChatRead(anchor, member);
    // Several replies: with microseconds in the row, a cursor set to the
    // millisecond the app was given must still cover the row it names.
    const shown: string[] = [];
    for (let i = 0; i < 12; i += 1) {
      // Each reply in its own millisecond. The cursor covers the whole
      // millisecond it is given, so two replies in one are read together
      // (the next test); on a fast runner back-to-back inserts share one.
      await new Promise((r) => setTimeout(r, 3));
      const row = await reply(member, `reply ${i}`);
      // What GET /api/member/chat sends: an ISO time, milliseconds.
      shown.push(row.createdAt.toISOString());
    }
    expect(new Set(shown).size).toBe(12);
    expect((await tm.loginChatUnread(anchor, member)).unread).toBe(12);
    // The app showed the first eleven.
    expect((await tm.markLoginChatRead(anchor, member, new Date(shown[10]!))).unread).toBe(1);
    // Then the last one.
    expect((await tm.markLoginChatRead(anchor, member, new Date(shown[11]!))).unread).toBe(0);
    // The row itself holds more than milliseconds (else this proves nothing).
    const [micro] = await exec<{ n: number }>(sqlTag`
      select count(*)::int as n from team_messages
       where login_id = ${member} and created_at <> date_trunc('milliseconds', created_at)`);
    expect(micro!.n).toBeGreaterThan(0);
  });

  it('two replies in one millisecond are read together: the app cannot tell them apart', async () => {
    await tm.markLoginChatRead(anchor, member);
    await new Promise((r) => setTimeout(r, 5));
    const a = await reply(member, 'same ms a');
    const b = await reply(member, 'same ms b');
    // Both in the millisecond of the first, 300 and 700 microseconds into it.
    const ms = a.createdAt.toISOString();
    await m.systemDb.execute(sqlTag`
      update team_messages set created_at = ${ms}::timestamptz + interval '300 microseconds'
       where id = ${a.id}`);
    await m.systemDb.execute(sqlTag`
      update team_messages set created_at = ${ms}::timestamptz + interval '700 microseconds'
       where id = ${b.id}`);
    expect((await tm.loginChatUnread(anchor, member)).unread).toBe(2);
    // The app names the first by its millisecond: the second goes with it.
    expect((await tm.markLoginChatRead(anchor, member, new Date(ms))).unread).toBe(0);
  });

  it('a reply still being written is not marked read: it counts when it lands', async () => {
    const bubble = (await reply(client, '', { status: 'pending' })).id;
    await tm.loginChatUnread(anchor, client);
    // The client reads the thread while the reply is being written.
    expect((await tm.markLoginChatRead(anchor, client)).unread).toBe(0);
    await tm.updateTeamMessageOutcome({
      ownerId: anchor,
      id: bubble,
      status: 'complete',
      text: 'Here it is',
    });
    expect((await tm.loginChatUnread(anchor, client)).unread).toBe(1);
    expect((await tm.markLoginChatRead(anchor, client)).unread).toBe(0);
  });

  // ── Cost safety ─────────────────────────────────────────────────────────

  it('the trigger functions only notify: no write, no job, nothing an LLM could follow', async () => {
    const names = [
      'mantle_notify_login_chat',
      'mantle_notify_login_review',
      'mantle_notify_login_comment',
    ];
    const fns = await exec<{ proname: string; src: string }>(sqlTag`
      select proname, prosrc as src from pg_proc
       where proname in ('mantle_notify_login_chat', 'mantle_notify_login_review',
                         'mantle_notify_login_comment')`);
    expect(fns.map((f) => f.proname).sort()).toEqual([...names].sort());
    for (const f of fns) {
      expect(f.src).toMatch(/pg_notify\(\s*'login_notice'/);
      expect(f.src).not.toMatch(
        /insert\s+into|update\s+\S+\s+set|delete\s+from|pgboss|perform\s+(?!pg_notify)/i,
      );
    }
    const [other] = await exec<{ n: number }>(sqlTag`
      select count(*)::int as n from pg_proc
       where prosrc like '%login_notice%'
         and proname not in ('mantle_notify_login_chat', 'mantle_notify_login_review',
                             'mantle_notify_login_comment')`);
    expect(other!.n).toBe(0);
  });
});
