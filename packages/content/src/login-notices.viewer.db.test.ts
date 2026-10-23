/**
 * What a member is told about on its phone (migration mobile_roles_push), on
 * a real, migrated Postgres (there is no client login since W8a):
 *
 *  - the `login_notice` event fires for a finished reply in a login's own
 *    chat thread and for a review result (accepted, returned, taken), and
 *    for nothing else (an inbound or pending row, a failed reply, a portal
 *    thread, a submit, a recall, a save; comments are gone, 2026-10-09).
 *    The admin's review was removed in workspaces W5c: a result is set in
 *    SQL here;
 *  - the message built from an event is for the ONE login it concerns, with
 *    words that login could read by opening the app: never an admin, never a
 *    disabled login, never a stale row, never a thread the reader may not
 *    read;
 *  - since 0269 (W7c) a reply is a row of the login's own thread in
 *    assistant_messages; the anchor's own replies never fire it (they reach
 *    the owner's devices by conversation_changed). The unread count moved to
 *    the per-thread inbox (GET /api/assistant/conversations);
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
import { asSuperuser } from '@mantle/db/test-support';

const URL = process.env.MANTLE_TEST_DATABASE_URL;
const CHANNEL = 'login_notice';

describe.skipIf(!URL)('login notices: the event, who is told, the unread count', () => {
  type Db = typeof import('@mantle/db');
  let m: Db;
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
  const agent = randomUUID();
  const spaceOf: Record<string, string> = {};
  const root = mkdtempSync(path.join(tmpdir(), 'mantle-login-notices-'));

  const exec = async <T>(q: ReturnType<typeof sqlTag>) =>
    (await m.systemDb.execute(q)) as unknown as T[];

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

  const reply = (loginId: string, text: string, extra: { status?: 'pending' | 'complete' } = {}) =>
    tm.appendThreadMessage({
      ownerId: anchor,
      agentId: agent,
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
    tm = await import('./team-messages');
    ln = await import('./login-notices');
    sqlTag = (await import('drizzle-orm')).sql;
    const pool = (m.systemDb as unknown as { $client: Parameters<Db['ensureViewerRoles']>[0] })
      .$client;
    // The shared viewer roles belong to the test database (the global setup
    // migrated it): set them from there, never from this scratch database.
    await ts.ensureTestViewerRoles(URL!, process.env.MANTLE_MASTER_KEY);
    const sub = await pool.listen(CHANNEL, (p: string) => raw.push(p));
    unlisten = () => sub.unlisten();

    await asSuperuser()(sqlTag`
      insert into auth.users (id, email, password_hash, role, display_name, is_owner) values
        (${anchor}, ${`${tag}-anchor@example.invalid`}, 'x', 'admin', null, true)`);
    await asSuperuser()(sqlTag`
      insert into auth.users (id, email, password_hash, role, display_name) values
        (${adminA}, ${`${tag}-a@example.invalid`}, 'x', 'admin', 'Ada Admin'),
        (${member}, ${`${tag}-m@example.invalid`}, 'x', 'member', 'Mia Member'),
        (${member2}, ${`${tag}-n@example.invalid`}, 'x', 'member', 'Noah')`);
    await m.systemDb.execute(sqlTag`
      insert into spaces (id, kind, login_id) values (${anchor}, 'brain', ${anchor})
      on conflict (id) do nothing`);
    const rows = await exec<{ id: string; login_id: string }>(sqlTag`
      select id, login_id from spaces where kind = 'personal'
        and login_id in (${adminA}, ${member}, ${member2})`);
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
    // The member's own message, a "thinking" bubble, the anchor's own reply.
    expect(
      await sent(() =>
        tm.appendThreadMessage({
          ownerId: anchor,
          agentId: agent,
          loginId: member,
          direction: 'inbound',
          text: 'a question',
        }),
      ),
    ).toEqual([]);
    expect(await sent(() => reply(anchor, 'the owner reads this on their own devices'))).toEqual(
      [],
    );
    let pending = '';
    expect(
      await sent(async () => (pending = (await reply(member, '', { status: 'pending' })).id)),
    ).toEqual([]);
    // The bubble finalized: once.
    expect(
      await sent(() =>
        tm.updateThreadMessageOutcome({
          ownerId: anchor,
          loginId: member,
          id: pending,
          status: 'complete',
          text: 'The answer',
        }),
      ),
    ).toEqual([{ kind: 'chat', loginId: member, id: pending }]);
    // Written again while already finished (attachments, a repair): silent.
    expect(
      await sent(() =>
        tm.updateThreadMessageOutcome({
          ownerId: anchor,
          loginId: member,
          id: pending,
          status: 'complete',
        }),
      ),
    ).toEqual([]);
    // A failed reply never notifies.
    const failing = (await reply(member, '', { status: 'pending' })).id;
    expect(
      await sent(() =>
        tm.updateThreadMessageOutcome({
          ownerId: anchor,
          loginId: member,
          id: failing,
          status: 'failed',
          error: 'x',
        }),
      ),
    ).toEqual([]);
  });

  it('the chat message is for that login, in words from its own thread', async () => {
    const row = await reply(member, '  The pump spec is **ready**.\n\n![chart](media:abc)  ');
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
    // The assistant's name, never an admin's.
    const note = await reply(member, 'We fixed the date.');
    const c = await ln.chatReplyNotice({ loginId: member, id: note.id });
    expect(c).toMatchObject({ loginId: member, role: 'member', title: 'Tess' });
    expect(JSON.stringify(c)).not.toContain('Ada');
  });

  it('tells nobody for another login, an admin, a disabled login or an old row', async () => {
    const row = await reply(member, 'for Mia only');
    // The event names a login the row is not for.
    expect(await ln.chatReplyNotice({ loginId: member2, id: row.id })).toBeNull();
    // An admin's own thread with the team agent: not a member.
    const own = await reply(adminA, 'admin thread');
    expect(await ln.chatReplyNotice({ loginId: adminA, id: own.id })).toBeNull();
    // Old: a backfill that touches old rows pages nobody. Judged on the
    // database's clock, against the row's own time.
    const old = await reply(member, 'from long ago');
    expect(await ln.chatReplyNotice({ loginId: member, id: old.id })).not.toBeNull();
    await m.systemDb.execute(sqlTag`
      update assistant_messages set created_at = now() - interval '31 minutes' where id = ${old.id}`);
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

  it('an Admin user’s finished reply makes no member-path push: one push per reply (W7c fix round 1, L5)', async () => {
    // The event may fire (the trigger cannot read roles); the handler's
    // notice for an Admin login is null, so only pushOutbound (the Admin
    // user's own devices) sends.
    const got = await sent(() => reply(adminA, 'second admin reply'));
    for (const n of got) {
      if (n.kind === 'chat') expect(await ln.chatReplyNotice(n)).toBeNull();
    }
    // A member's reply still tells the member.
    const mine = await sent(() => reply(member, 'member reply'));
    const forMember = mine.find((n) => n.kind === 'chat' && n.loginId === member);
    expect(forMember && (await ln.chatReplyNotice(forMember))).not.toBeNull();
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
