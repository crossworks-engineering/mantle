/**
 * The client tier's abuse limits on a real, migrated Postgres (client logins
 * C5 audit: I2, I3, I5, I7, I8, I11), on real client logins and spaces:
 *
 *  - comments: a client login writes at most 100 a day across every thread
 *    (the review talk and client threads), counted in the ledger, and
 *    deleting never gives a place back; one thread holds at most 1000;
 *    every thread read is paged (the newest 100, oldest first, `hasMore`,
 *    and `before` for older ones);
 *  - text counts: page and note text is in a client's 200 MB and in the
 *    brain-wide total (one definition: mantle_client_space_usage()); a write
 *    that grows the text past the limit is refused, one that shrinks it
 *    passes; a deleted client's space keeps counting until its purge;
 *  - races: two parallel creates at the last item place, two parallel
 *    submits at the last daily place, two clients' parallel uploads at the
 *    last bytes of the total, parallel comments at the last place of the
 *    day and at a thread's last place: exactly one passes each time;
 *  - give back into a client's space holds the client limits;
 *  - space_items.author_role never changes after insert;
 *  - refusals are recorded (reason and login), and the record stays small;
 *  - the admin reads: the client threads clients wrote in, delete every
 *    comment of one client, the storage rows (a former client flagged).
 *
 * Big sizes are FAKE (a `size_bytes` written by the admin pool, a spool that
 * claims a size); no test writes real megabytes. The brain-wide total is set
 * per test through MANTLE_CLIENT_SPACES_TOTAL_BYTES, from what the database
 * holds at that moment.
 *
 * The file holds the 'client-total' test lock from its first fixture to the
 * end of its cleanup: its 200 MB fixtures and its cleanup move the
 * brain-wide client bytes, which the other file that does the same
 * (client-space-c5) reads, and its own race test reads them too.
 *   MANTLE_TEST_DATABASE_URL=postgres://… pnpm vitest run packages/content/src/client-abuse.viewer.db.test.ts
 */
import { randomBytes, randomUUID } from 'node:crypto';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { Readable } from 'node:stream';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { holdTestLock } from '@mantle/db/test-support';

const URL = process.env.MANTLE_TEST_DATABASE_URL;
const MB = 1024 * 1024;

describe.skipIf(!URL)('client abuse limits: comments, text, races, give back', () => {
  type Db = typeof import('@mantle/db');
  let m: Db;
  let sp: typeof import('./member-space');
  let sf: typeof import('./member-space-files');
  let sc: typeof import('./member-space-comments');
  let ct: typeof import('./client-thread');
  let nc: typeof import('./node-comments');
  let rv: typeof import('./member-review');
  let tk: typeof import('./member-takeover');
  let ql: typeof import('./client-quota-log');
  let au: typeof import('./client-admin-usage');
  let fp: typeof import('@mantle/files');
  let sqlTag: typeof import('drizzle-orm').sql;
  const tag = `cabuse-${randomUUID().slice(0, 8)}`;
  let brain = '';
  const adminA = randomUUID();
  const member = randomUUID();
  // One client login per rule, so no test's rows count in another's.
  const c = {
    cap: randomUUID(),
    full: randomUUID(),
    page: randomUUID(),
    text: randomUUID(),
    items: randomUUID(),
    submits: randomUUID(),
    totalA: randomUUID(),
    totalB: randomUUID(),
    back: randomUUID(),
    role: randomUUID(),
    admin: randomUUID(),
    other: randomUUID(),
    raceCap: randomUUID(),
    raceT1: randomUUID(),
    raceT2: randomUUID(),
    raceT3: randomUUID(),
  };
  const former = randomUUID();
  const formerMember = randomUUID();
  const clients = Object.values(c);
  const logins = [adminA, member, ...clients, former, formerMember];
  const spaceOf: Record<string, string> = {};
  const brainNodes: string[] = [];
  const root = mkdtempSync(path.join(tmpdir(), 'mantle-cabuse-'));
  const savedTotal = process.env.MANTLE_CLIENT_SPACES_TOTAL_BYTES;
  let releaseTotal: () => Promise<void> = async () => {};

  const as = <T>(login: string, fn: () => Promise<T>) =>
    m.withSpace({ spaceId: spaceOf[login]!, loginId: login }, fn);
  const exec = async <T>(q: ReturnType<typeof sqlTag>) =>
    (await m.systemDb.execute(q)) as unknown as T[];
  const one = async <T>(q: ReturnType<typeof sqlTag>) => (await exec<T>(q))[0]!;
  const spool = async (size: number) => {
    const s = await fp.spoolUpload(Readable.from([Buffer.from('BYTES')]), {
      maxBytes: sf.SPACE_FILE_MAX_BYTES,
      dir: fp.spaceSpoolDir(),
    });
    return { ...s, size };
  };
  const upload = async (login: string, size: number) =>
    as(login, async () =>
      sf.createMineFile(spaceOf[login]!, { filename: 'f.bin', spooled: await spool(size) }),
    );
  const fakeItems = (login: string, n: number) =>
    m.systemDb.execute(sqlTag`
      insert into nodes (owner_id, type, title, path)
      select ${spaceOf[login]!}, 'note', ${`${tag} fake `} || g, 'notes'
        from generate_series(1, ${n}) g`);
  const fakeFile = async (login: string, bytes: number) => {
    const id = randomUUID();
    await m.systemDb.execute(sqlTag`
      insert into nodes (id, owner_id, type, title, path, data) values
        (${id}, ${spaceOf[login]!}, 'file', ${`${tag} big.bin`}, 'space_files',
         ${JSON.stringify({ filename: `big-${id}.bin`, size_bytes: bytes, storage: 'space' })}::jsonb)`);
    return id;
  };
  const dropNode = (id: string) => m.systemDb.execute(sqlTag`delete from nodes where id = ${id}`);
  const page = async (login: string, title: string) =>
    (await as(login, () => sp.createMineItem(spaceOf[login]!, { type: 'page', title }))).id;
  const submit = (login: string, id: string) => as(login, () => sp.submitItem(spaceOf[login]!, id));
  /** A brain note at client level (the client thread's home). */
  const clientNote = async (title: string) => {
    const id = randomUUID();
    await m.systemDb.execute(sqlTag`
      insert into nodes (id, owner_id, type, title, path, audience)
      values (${id}, ${brain}, 'note', ${`${tag} ${title}`}, 'notes', 'client')`);
    brainNodes.push(id);
    return id;
  };
  /** `n` comments on `nodeId`, one a second back from now. */
  const seedComments = (nodeId: string, n: number, scope: string, kind = 'owner', login = adminA) =>
    m.systemDb.execute(sqlTag`
      insert into node_comments (owner_id, node_id, author_kind, login_id, author_name, body,
                                 thread_scope, created_at)
      select ${brain}, ${nodeId}, ${kind}, ${login}, 'Seed', 'seed ' || g, ${scope},
             now() - make_interval(secs => g)
        from generate_series(1, ${n}) g`);
  const ledgerRows = (login: string, n: number, ago = '0 seconds') =>
    m.systemDb.execute(sqlTag`
      insert into client_comment_ledger (login_id, created_at)
      select ${login}, now() - ${ago}::interval from generate_series(1, ${n})`);
  const text = (t: string) => ({
    type: 'doc',
    content: [{ type: 'paragraph', content: [{ type: 'text', text: t }] }],
  });
  /** Incompressible text of about `n` characters. */
  const noise = (n: number) =>
    randomBytes(Math.ceil(n / 2))
      .toString('base64')
      .slice(0, n);
  const usedBytes = async () =>
    Number((await one<{ n: string }>(sqlTag`select mantle_client_space_bytes()::text as n`)).n);
  const refusals = (login: string) =>
    exec<{ reason: string }>(sqlTag`
      select reason from client_quota_refusals where login_id = ${login} order by created_at`);

  /** A role change no route makes, around the client role guard (0200). */
  const setRole = async (id: string, role: 'member' | 'client') => {
    const { setLoginRoleUnguarded } = await import('@mantle/db/test-support');
    await setLoginRoleUnguarded(
      (m.systemDb as unknown as { $client: Parameters<typeof setLoginRoleUnguarded>[0] }).$client,
      id,
      role,
    );
  };

  // Its own hook and timeout: the other file may hold the lock for its run.
  beforeAll(async () => {
    releaseTotal = await holdTestLock(URL!, 'client-total');
  }, 300_000);

  beforeAll(async () => {
    process.env.DATABASE_URL = URL;
    process.env.MANTLE_MASTER_KEY ??= 'mantle-viewer-test-key';
    process.env.MANTLE_SPACES_ROOT = path.join(root, 'spaces');
    process.env.TABLE_DB_DIR = path.join(root, 'table-dbs');
    process.env.MANTLE_FILES_ROOT = path.join(root, 'files');
    m = await import('@mantle/db');
    sp = await import('./member-space');
    sf = await import('./member-space-files');
    sc = await import('./member-space-comments');
    ct = await import('./client-thread');
    nc = await import('./node-comments');
    rv = await import('./member-review');
    tk = await import('./member-takeover');
    ql = await import('./client-quota-log');
    au = await import('./client-admin-usage');
    fp = await import('@mantle/files');
    sqlTag = (await import('drizzle-orm')).sql;
    const { ensureTestAnchor } = await import('@mantle/db/test-support');
    const admin = (m.systemDb as unknown as { $client: Parameters<Db['ensureViewerRoles']>[0] })
      .$client;
    await m.ensureViewerRoles(admin, process.env.MANTLE_MASTER_KEY);
    brain = await ensureTestAnchor(admin);
    await m.systemDb.execute(sqlTag`
      insert into auth.users (id, email, password_hash, role, display_name) values
        (${adminA}, ${`${tag}-a@example.invalid`}, 'x', 'admin', 'Staff Person'),
        (${member}, ${`${tag}-m@example.invalid`}, 'x', 'member', 'Mia Member'),
        (${former}, ${`${tag}-former@example.invalid`}, 'x', 'client', 'Former'),
        (${formerMember}, ${`${tag}-fm@example.invalid`}, 'x', 'member', 'Former Member')`);
    for (const [name, id] of Object.entries(c)) {
      await m.systemDb.execute(sqlTag`
        insert into auth.users (id, email, password_hash, role, display_name) values
          (${id}, ${`${tag}-${name}@example.invalid`}, 'x', 'client', ${`Client ${name}`})`);
    }
    const rows = await exec<{ id: string; login_id: string }>(sqlTag`
      select id, login_id from spaces where kind = 'personal'
        and login_id = any(${`{${logins.join(',')}}`}::uuid[])`);
    for (const r of rows) spaceOf[r.login_id] = r.id;
  }, 60_000);

  afterAll(async () => {
    try {
      if (savedTotal === undefined) delete process.env.MANTLE_CLIENT_SPACES_TOTAL_BYTES;
      else process.env.MANTLE_CLIENT_SPACES_TOTAL_BYTES = savedTotal;
      for (const id of brainNodes) await dropNode(id);
      for (const s of Object.values(spaceOf)) {
        await m.systemDb.execute(sqlTag`delete from nodes where owner_id = ${s}`);
        await m.systemDb.execute(sqlTag`delete from spaces where id = ${s}`);
      }
      await m.systemDb.execute(
        sqlTag`delete from client_quota_refusals where login_id = any(${`{${logins.join(',')}}`}::uuid[])`,
      );
      await m.systemDb.execute(
        sqlTag`delete from auth.users where id = any(${`{${logins.join(',')}}`}::uuid[])`,
      );
      await m.closeDb();
      rmSync(root, { recursive: true, force: true });
    } finally {
      // Released only once this file's client bytes are gone.
      await releaseTotal();
    }
  });

  // ── Comment caps (I2) ───────────────────────────────────────────────────

  it('a client writes 100 comments a day across every thread; deleting never refunds', async () => {
    const C = spaceOf[c.cap]!;
    const talk = await page(c.cap, `${tag} cap talk`);
    await submit(c.cap, talk);
    const shared = await clientNote('cap shared');
    // 98 written earlier today (and 5 yesterday, which no longer count).
    await ledgerRows(c.cap, 98);
    await ledgerRows(c.cap, 5, '25 hours');
    const review = await as(c.cap, () =>
      sc.addMineComment(C, brain, talk, { loginId: c.cap, name: 'Cap' }, '99th, review talk'),
    );
    const thread = await ct.addClientThreadComment(
      brain,
      shared,
      { kind: 'client', loginId: c.cap, name: 'Cap' },
      '100th, client thread',
    );
    expect(thread).toBeTruthy();
    // The 101st, on either thread: refused.
    await expect(
      ct.addClientThreadComment(
        brain,
        shared,
        { kind: 'client', loginId: c.cap, name: 'Cap' },
        'x',
      ),
    ).rejects.toMatchObject({ reason: 'comment-cap' });
    await expect(
      as(c.cap, () => sc.addMineComment(C, brain, talk, { loginId: c.cap, name: 'Cap' }, 'x')),
    ).rejects.toMatchObject({ reason: 'comment-cap' });
    // Deleting both gives nothing back.
    expect(await as(c.cap, () => sc.deleteMineComment(C, talk, review.id))).toBe(true);
    expect(
      await ct.deleteClientThreadComment(
        brain,
        shared,
        { kind: 'client', loginId: c.cap },
        thread!.id,
      ),
    ).toBe(true);
    await expect(
      ct.addClientThreadComment(
        brain,
        shared,
        { kind: 'client', loginId: c.cap, name: 'Cap' },
        'x',
      ),
    ).rejects.toMatchObject({ reason: 'comment-cap' });
    // A member is never capped by the client's ledger.
    expect(
      await ct.addClientThreadComment(
        brain,
        shared,
        { kind: 'member', loginId: member, name: 'Mia' },
        'm',
      ),
    ).toBeTruthy();
    // Refusals are recorded; the ledger was trimmed of rows past two days
    // only (yesterday's stay: the cap no longer counts them).
    expect((await refusals(c.cap)).map((r) => r.reason)).toEqual([
      'comment-cap',
      'comment-cap',
      'comment-cap',
    ]);
    const { n } = await one<{ n: number }>(sqlTag`
      select count(*)::int as n from client_comment_ledger where login_id = ${c.cap}`);
    expect(n).toBe(105);
    // A day later the places are free again.
    await m.systemDb.execute(sqlTag`
      update client_comment_ledger set created_at = now() - interval '25 hours'
       where login_id = ${c.cap}`);
    expect(
      await ct.addClientThreadComment(
        brain,
        shared,
        { kind: 'client', loginId: c.cap, name: 'Cap' },
        'y',
      ),
    ).toBeTruthy();
  });

  it('the space role cannot erase or rewrite its ledger rows', async () => {
    const before = await one<{ n: number }>(sqlTag`
      select count(*)::int as n from client_comment_ledger where login_id = ${c.cap}`);
    await as(c.cap, () => m.db.execute(sqlTag`delete from client_comment_ledger`));
    await as(c.cap, () =>
      m.db.execute(sqlTag`update client_comment_ledger set created_at = now() - interval '9 days'`),
    );
    const seen = await as(c.cap, () =>
      m.db.execute(sqlTag`select count(*)::int as n from client_comment_ledger`),
    );
    expect((seen as unknown as { n: number }[])[0]!.n).toBe(before.n);
    const after = await one<{ n: number; old: number }>(sqlTag`
      select count(*)::int as n,
             count(*) filter (where created_at < now() - interval '8 days')::int as old
        from client_comment_ledger where login_id = ${c.cap}`);
    expect(after).toEqual({ n: before.n, old: 0 });
  });

  it('a thread holds at most 1000 comments, for a client and a member alike', async () => {
    const full = await clientNote('full thread');
    await seedComments(full, 1000, 'client');
    await expect(
      ct.addClientThreadComment(brain, full, { kind: 'client', loginId: c.full, name: 'F' }, 'x'),
    ).rejects.toMatchObject({ reason: 'thread-full' });
    await expect(
      ct.addClientThreadComment(brain, full, { kind: 'member', loginId: member, name: 'M' }, 'x'),
    ).rejects.toMatchObject({ reason: 'thread-full' });
    // One short of full: the 1000th goes, the next does not.
    const almost = await clientNote('almost full');
    await seedComments(almost, 999, 'client');
    expect(
      await ct.addClientThreadComment(
        brain,
        almost,
        { kind: 'member', loginId: member, name: 'M' },
        'x',
      ),
    ).toBeTruthy();
    await expect(
      ct.addClientThreadComment(brain, almost, { kind: 'client', loginId: c.full, name: 'F' }, 'x'),
    ).rejects.toMatchObject({ reason: 'thread-full' });
    // The review talk on a client's own item: the same cap.
    const talk = await page(c.full, `${tag} full talk`);
    await submit(c.full, talk);
    await seedComments(talk, 1000, 'review');
    await expect(
      as(c.full, () =>
        sc.addMineComment(spaceOf[c.full]!, brain, talk, { loginId: c.full, name: 'F' }, 'x'),
      ),
    ).rejects.toMatchObject({ reason: 'thread-full' });
    // A refused comment took no place of the day.
    const { n } = await one<{ n: number }>(sqlTag`
      select count(*)::int as n from client_comment_ledger where login_id = ${c.full}`);
    expect(n).toBe(0);
    expect((await refusals(c.full)).map((r) => r.reason)).toEqual([
      'thread-full',
      'thread-full',
      'thread-full',
    ]);
  });

  it('every thread read is paged: the newest 100, oldest first, then `before`', async () => {
    const node = await clientNote('paged');
    await seedComments(node, 250, 'client');
    const all = await nc.listNodeComments(brain, node);
    expect(all.length).toBe(250);
    const p1 = await nc.listNodeComments(brain, node, {});
    expect(p1.hasMore).toBe(true);
    expect(p1.rows.map((r) => r.id)).toEqual(all.slice(150).map((r) => r.id));
    const p2 = await nc.listNodeComments(brain, node, { before: p1.rows[0]!.createdAt });
    expect(p2.hasMore).toBe(true);
    expect(p2.rows.map((r) => r.id)).toEqual(all.slice(50, 150).map((r) => r.id));
    const p3 = await nc.listNodeComments(brain, node, { before: p2.rows[0]!.createdAt });
    expect(p3.hasMore).toBe(false);
    expect(p3.rows.map((r) => r.id)).toEqual(all.slice(0, 50).map((r) => r.id));
    // The client thread, as a client and as a member (human scopes).
    const asClient = await m.withHumanViewer('client', () => ct.listClientThread(brain, node, {}));
    expect(asClient?.hasMore).toBe(true);
    expect(asClient?.rows.map((r) => r.id)).toEqual(p1.rows.map((r) => r.id));
    const asMember = await m.withHumanViewer('team', () =>
      ct.listClientThread(brain, node, { before: p1.rows[0]!.createdAt }),
    );
    expect(asMember?.rows.map((r) => r.id)).toEqual(p2.rows.map((r) => r.id));
    // The review talk: the client's own read and the admin's.
    const talk = await page(c.page, `${tag} paged talk`);
    await submit(c.page, talk);
    await seedComments(talk, 101, 'review');
    const mine = await as(c.page, () => sc.listMineComments(spaceOf[c.page]!, talk, {}));
    expect([mine?.rows.length, mine?.hasMore]).toEqual([100, true]);
    const admins = await rv.listReviewComments(talk, {});
    expect([admins?.rows.length, admins?.hasMore]).toEqual([100, true]);
    const older = await rv.listReviewComments(talk, { before: admins!.rows[0]!.createdAt });
    expect([older?.rows.length, older?.hasMore]).toEqual([1, false]);
  });

  // ── Text counts toward storage (I3, I8) ─────────────────────────────────

  it('page and note text count in the space and the total, by one definition', async () => {
    const T = spaceOf[c.text]!;
    const note = (
      await as(c.text, () =>
        sp.createMineItem(T, { type: 'note', title: `${tag} note`, content: noise(40_000) }),
      )
    ).id;
    const pg = await page(c.text, `${tag} text page`);
    await as(c.text, () => sp.saveMinePage(T, pg, text(noise(30_000))));
    await as(c.text, () => sp.saveMineDraft(T, pg, text(noise(30_000))));
    const file = await fakeFile(c.text, 1000);
    const own = await as(c.text, () => sf.spaceStorageUsed(T));
    // About 100 KB of random base64 (pglz takes a quarter off at most),
    // plus the file.
    expect(own).toBeGreaterThan(70_000);
    const [row] = await exec<{ bytes: string }>(sqlTag`
      select bytes::text from mantle_client_space_usage() where space_id = ${T}`);
    expect(Number(row!.bytes)).toBe(own);
    expect(note && file).toBeTruthy();
  });

  it('the total calls no security-definer function per row (I8)', async () => {
    const rows = await exec<{ src: string }>(sqlTag`
      select prosrc as src from pg_proc
       where proname in ('mantle_client_space_usage', 'mantle_client_space_bytes')`);
    expect(rows.length).toBe(2);
    for (const r of rows) expect(r.src).not.toMatch(/mantle_client_space\s*\(/);
  });

  it('a text write that grows past the client’s 200 MB is refused; shrinking passes', async () => {
    const T = spaceOf[c.text]!;
    const note = (
      await as(c.text, () =>
        sp.createMineItem(T, { type: 'note', title: `${tag} grow`, content: 'short' }),
      )
    ).id;
    const pg = await page(c.text, `${tag} grow page`);
    const used = await as(c.text, () => sf.spaceStorageUsed(T));
    // The space sits 500 bytes over its limit.
    const big = await fakeFile(c.text, 200 * MB - used + 500);
    try {
      await expect(
        as(c.text, () => sp.updateMineItem(T, note, { content: noise(20_000) })),
      ).rejects.toMatchObject({ reason: 'quota', message: expect.stringMatching(/200 MB/) });
      await expect(
        as(c.text, () => sp.saveMineDraft(T, pg, text(noise(20_000)))),
      ).rejects.toMatchObject({ reason: 'quota' });
      await expect(
        as(c.text, () => sp.createMineItem(T, { type: 'note', title: 'x', content: noise(5000) })),
      ).rejects.toMatchObject({ reason: 'quota' });
      // Nothing of the refused writes stayed.
      const [n] = await exec<{ content: string }>(
        sqlTag`select data->>'content' as content from nodes where id = ${note}`,
      );
      expect(n!.content).toBe('short');
      // Cutting text down still works while over.
      await as(c.text, () => sp.updateMineItem(T, note, { content: 'x' }));
      // A member's space never counts text against a write.
      const M = spaceOf[member]!;
      const mNote = (
        await as(member, () =>
          sp.createMineItem(M, { type: 'note', title: `${tag} m`, content: 'a' }),
        )
      ).id;
      await as(member, () => sp.updateMineItem(M, mNote, { content: noise(20_000) }));
    } finally {
      await dropNode(big);
    }
    expect((await refusals(c.text)).map((r) => r.reason)).toEqual([
      'storage',
      'storage',
      'storage',
    ]);
  });

  it('a text write that takes all client spaces past the total is refused', async () => {
    const T = spaceOf[c.text]!;
    const note = (
      await as(c.text, () =>
        sp.createMineItem(T, { type: 'note', title: `${tag} total`, content: 'short' }),
      )
    ).id;
    // Already over (1 byte): a growing text write is refused. Not set from a
    // live sum, which other test files change while this runs.
    process.env.MANTLE_CLIENT_SPACES_TOTAL_BYTES = '1';
    try {
      await expect(
        as(c.text, () => sp.updateMineItem(T, note, { content: noise(20_000) })),
      ).rejects.toMatchObject({
        reason: 'quota',
        message: expect.stringMatching(/all clients|client uploads/),
      });
    } finally {
      delete process.env.MANTLE_CLIENT_SPACES_TOTAL_BYTES;
    }
    expect(
      await as(c.text, () => sp.updateMineItem(T, note, { content: noise(20_000) })),
    ).toBeTruthy();
  });

  it('a deleted client’s space keeps counting until its purge; a deleted member’s never does', async () => {
    const F = spaceOf[former]!;
    const FM = spaceOf[formerMember]!;
    const fPage = await page(former, `${tag} former page`);
    await fakeFile(former, 3 * MB);
    await as(formerMember, () =>
      sp.createMineItem(FM, { type: 'note', title: `${tag} fm`, content: 'x' }),
    );
    await m.systemDb.execute(sqlTag`
      insert into nodes (owner_id, type, title, path, data) values
        (${FM}, 'file', ${`${tag} fm.bin`}, 'space_files', '{"size_bytes": 7340032}'::jsonb)`);
    const held = await as(former, () => sf.spaceStorageUsed(F));
    await m.systemDb.execute(
      sqlTag`delete from auth.users where id in (${former}, ${formerMember})`,
    );
    const [s] = await exec<{ login_id: string | null }>(
      sqlTag`select login_id from spaces where id = ${F}`,
    );
    expect(s!.login_id).toBeNull();
    // Still counted (by space: other test files change the brain-wide sum).
    const rows = await exec<{ space_id: string; bytes: string }>(sqlTag`
      select space_id, bytes::text from mantle_client_space_usage()
       where space_id in (${F}, ${FM})`);
    expect(rows.map((r) => [r.space_id, Number(r.bytes)])).toEqual([[F, held]]);
    const admin = (await au.clientStorageRows()).find((r) => r.loginId === F);
    expect(admin).toMatchObject({ former: true, usedBytes: held, items: expect.any(Number) });
    expect(fPage).toBeTruthy();
  });

  // ── Races (I7, I11) ─────────────────────────────────────────────────────

  it('parallel creates at the last item place: exactly one passes', async () => {
    // One real page first (the space's pages folder exists), then 498 more.
    await page(c.items, `${tag} first`);
    await fakeItems(c.items, 498);
    const results = await Promise.allSettled(
      [1, 2, 3].map((i) => page(c.items, `${tag} race ${i}`)),
    );
    expect(results.filter((r) => r.status === 'fulfilled').length).toBe(1);
    for (const r of results.filter((x) => x.status === 'rejected')) {
      expect((r as PromiseRejectedResult).reason).toMatchObject({ reason: 'quota' });
    }
    const { n } = await one<{ n: number }>(sqlTag`
      select count(*)::int as n from nodes where owner_id = ${spaceOf[c.items]!} and type <> 'branch'`);
    expect(n).toBe(500);
  });

  it('two parallel submits at the last daily place: exactly one passes', async () => {
    const S = spaceOf[c.submits]!;
    await m.systemDb.execute(sqlTag`
      insert into space_submissions (space_id, node_id)
      select ${S}, gen_random_uuid() from generate_series(1, 9)`);
    const a = await page(c.submits, `${tag} a`);
    const b = await page(c.submits, `${tag} b`);
    const results = await Promise.allSettled([submit(c.submits, a), submit(c.submits, b)]);
    expect(results.map((r) => r.status).sort()).toEqual(['fulfilled', 'rejected']);
    const lost = results.find((r) => r.status === 'rejected') as PromiseRejectedResult;
    expect(lost.reason).toMatchObject({
      reason: 'quota',
      message: expect.stringMatching(/10 items a day/),
    });
    const { n } = await one<{ n: number }>(
      sqlTag`select count(*)::int as n from space_submissions where space_id = ${S}`,
    );
    expect(n).toBe(10);
  });

  it('parallel comments at the last place of the day: exactly one passes (I7)', async () => {
    // 99 places taken; three threads, so only the day's lock can hold it.
    await ledgerRows(c.raceCap, 99);
    const notes = await Promise.all([1, 2, 3].map((i) => clientNote(`race day ${i}`)));
    const results = await Promise.allSettled(
      notes.map((n) =>
        ct.addClientThreadComment(brain, n, { kind: 'client', loginId: c.raceCap, name: 'R' }, 'x'),
      ),
    );
    expect(results.filter((r) => r.status === 'fulfilled').length).toBe(1);
    for (const r of results.filter((x) => x.status === 'rejected')) {
      expect((r as PromiseRejectedResult).reason).toMatchObject({ reason: 'comment-cap' });
    }
    const { n } = await one<{ n: number }>(sqlTag`
      select count(*)::int as n from client_comment_ledger where login_id = ${c.raceCap}`);
    expect(n).toBe(100);
  });

  it('parallel comments at a thread’s last place: exactly one passes (I7)', async () => {
    // Three clients, each with room in its day: only the thread's lock holds it.
    const note = await clientNote('race thread');
    await seedComments(note, 999, 'client');
    const results = await Promise.allSettled(
      [c.raceT1, c.raceT2, c.raceT3].map((login) =>
        ct.addClientThreadComment(brain, note, { kind: 'client', loginId: login, name: 'T' }, 'x'),
      ),
    );
    expect(results.filter((r) => r.status === 'fulfilled').length).toBe(1);
    for (const r of results.filter((x) => x.status === 'rejected')) {
      expect((r as PromiseRejectedResult).reason).toMatchObject({ reason: 'thread-full' });
    }
    const { n } = await one<{ n: number }>(sqlTag`
      select count(*)::int as n from node_comments where node_id = ${note}`);
    expect(n).toBe(1000);
  });

  // The boundary is the live brain-wide sum plus 6 MB. The other file that
  // moves megabytes of client bytes waits on the file's 'client-total' lock,
  // and page text other files write moves it a few KB, so no retry: a
  // missing product lock fails it (both uploads pass).
  it('two clients’ parallel uploads at the last bytes of the total: exactly one passes', async () => {
    process.env.MANTLE_CLIENT_SPACES_TOTAL_BYTES = String((await usedBytes()) + 6 * MB);
    try {
      const results = await Promise.allSettled([
        upload(c.totalA, 4 * MB),
        upload(c.totalB, 4 * MB),
      ]);
      expect(results.map((r) => r.status).sort()).toEqual(['fulfilled', 'rejected']);
      const lost = results.find((r) => r.status === 'rejected') as PromiseRejectedResult;
      expect(lost.reason).toMatchObject({
        reason: 'quota',
        message: expect.stringMatching(/client uploads is full/),
      });
    } finally {
      delete process.env.MANTLE_CLIENT_SPACES_TOTAL_BYTES;
    }
    const reasons = [...(await refusals(c.totalA)), ...(await refusals(c.totalB))];
    expect(reasons.map((r) => r.reason)).toEqual(['total']);
  });

  // ── Give back holds the client limits (I7) ──────────────────────────────

  it('give back into a client’s full space is refused; with room it goes', async () => {
    const actor = { loginId: adminA, spaceId: spaceOf[adminA]! };
    const id = await page(c.back, `${tag} back`);
    await submit(c.back, id);
    await rv.takeOverReviewItem(id, actor);
    // While it is away the client fills the space to its 500 items.
    await fakeItems(c.back, 500);
    await expect(tk.giveBackTakenItem(brain, actor, id)).rejects.toMatchObject({
      reason: 'quota',
    });
    const [still] = await exec<{ owner_id: string; review_state: string }>(sqlTag`
      select n.owner_id, si.review_state from nodes n join space_items si on si.node_id = n.id
       where n.id = ${id}`);
    expect(still).toEqual({ owner_id: actor.spaceId, review_state: 'taken' });
    expect((await refusals(c.back)).map((r) => r.reason)).toEqual(['give-back']);
    // One place free: it goes back.
    await m.systemDb.execute(sqlTag`
      delete from nodes where id = (select id from nodes where owner_id = ${spaceOf[c.back]!}
                                      and title like ${`${tag} fake %`} limit 1)`);
    const res = await tk.giveBackTakenItem(brain, actor, id);
    expect(res.id).toBe(id);
  });

  it('give back is refused past the client’s 200 MB, and past the total', async () => {
    const actor = { loginId: adminA, spaceId: spaceOf[adminA]! };
    // The item limit is not this test's rule: make room first.
    await m.systemDb.execute(sqlTag`
      delete from nodes where owner_id = ${spaceOf[c.back]!} and title like ${`${tag} fake %`}`);
    const id = await page(c.back, `${tag} back bytes`);
    await submit(c.back, id);
    await rv.takeOverReviewItem(id, actor);
    const used = await as(c.back, () => sf.spaceStorageUsed(spaceOf[c.back]!));
    const big = await fakeFile(c.back, 200 * MB - used);
    try {
      await expect(tk.giveBackTakenItem(brain, actor, id)).rejects.toMatchObject({
        reason: 'quota',
      });
    } finally {
      await dropNode(big);
    }
    // A total the client spaces are already over (1 byte): other test files
    // change client bytes while this runs, so the total is not set from a
    // live sum; any give back that brings bytes back is refused.
    process.env.MANTLE_CLIENT_SPACES_TOTAL_BYTES = '1';
    try {
      await expect(tk.giveBackTakenItem(brain, actor, id)).rejects.toMatchObject({
        reason: 'quota',
      });
    } finally {
      delete process.env.MANTLE_CLIENT_SPACES_TOTAL_BYTES;
    }
    expect((await tk.giveBackTakenItem(brain, actor, id)).id).toBe(id);
  });

  // ── author_role never changes (0194) ────────────────────────────────────

  it('space_items.author_role never changes after insert, by any role', async () => {
    const id = await page(c.role, `${tag} role`);
    const role = async () =>
      (
        await one<{ r: string }>(
          sqlTag`select author_role as r from space_items where node_id = ${id}`,
        )
      ).r;
    expect(await role()).toBe('client');
    await m.systemDb.execute(
      sqlTag`update space_items set author_role = 'admin' where node_id = ${id}`,
    );
    expect(await role()).toBe('client');
    await as(c.role, () =>
      m.db.execute(sqlTag`update space_items set author_role = 'member' where node_id = ${id}`),
    );
    expect(await role()).toBe('client');
    // Nor when the login changes role later.
    await setRole(c.role, 'member');
    await m.systemDb.execute(
      sqlTag`update space_items set updated_at = now() where node_id = ${id}`,
    );
    expect(await role()).toBe('client');
    await setRole(c.role, 'client');
  });

  // ── Refusals and the admin reads (I5, U2) ───────────────────────────────

  it('the refusal record stays small: 7 days, 500 rows', async () => {
    await m.systemDb.execute(sqlTag`
      insert into client_quota_refusals (login_id, reason, created_at)
      select ${c.admin}, 'storage', now() - make_interval(secs => g)
        from generate_series(1, 600) g`);
    await m.systemDb.execute(sqlTag`
      insert into client_quota_refusals (login_id, reason, created_at)
      values (${c.admin}, 'items', now() - interval '8 days')`);
    await ql.recordClientQuotaRefusal(c.admin, 'total');
    const { n, old } = await one<{ n: number; old: number }>(sqlTag`
      select count(*)::int as n,
             count(*) filter (where created_at < now() - interval '7 days')::int as old
        from client_quota_refusals`);
    expect(n).toBeLessThanOrEqual(500);
    expect(old).toBe(0);
    const listed = await ql.listClientQuotaRefusals(50);
    expect(listed.length).toBe(50);
    expect(listed[0]).toMatchObject({ loginId: c.admin, reason: 'total' });
  });

  it('the admin lists the client threads clients wrote in, and deletes one client’s comments', async () => {
    const A = spaceOf[c.admin]!;
    const recent = await clientNote('activity recent');
    const quiet = await clientNote('activity members only');
    const say = (who: string, node: string, body: string) =>
      ct.addClientThreadComment(
        brain,
        node,
        { kind: 'client', loginId: who, name: `N ${who.slice(0, 4)}` },
        body,
      );
    await say(c.other, recent, 'first');
    await say(c.admin, recent, 'second');
    await ct.addClientThreadComment(
      brain,
      quiet,
      { kind: 'member', loginId: member, name: 'Mia' },
      'm',
    );
    const rows = await au.clientThreadActivity(brain, 7);
    const mineRow = rows.find((r) => r.nodeId === recent);
    expect(mineRow).toMatchObject({
      clientComments: 2,
      lastClientName: `N ${c.admin.slice(0, 4)}`,
      type: 'note',
    });
    expect(rows.find((r) => r.nodeId === quiet)).toBeUndefined();
    // Review talk of the same client, and an item that left client level.
    const talk = await page(c.admin, `${tag} admin talk`);
    await submit(c.admin, talk);
    await as(c.admin, () =>
      sc.addMineComment(A, brain, talk, { loginId: c.admin, name: 'x' }, 'r'),
    );
    const ledger = async () =>
      (
        await one<{ n: number }>(sqlTag`
        select count(*)::int as n from client_comment_ledger where login_id = ${c.admin}`)
      ).n;
    const places = await ledger();
    expect(await au.deleteClientComments(brain, c.admin)).toBe(2);
    const left = await exec<{ body: string }>(sqlTag`
      select body from node_comments where node_id in (${recent}, ${talk}) order by body`);
    expect(left.map((r) => r.body)).toEqual(['first']);
    // The day's places are not given back.
    expect(await ledger()).toBe(places);
    // Old comments fall out of the window.
    await m.systemDb.execute(sqlTag`
      update node_comments set created_at = now() - interval '10 days' where node_id = ${recent}`);
    expect(
      (await au.clientThreadActivity(brain, 7)).find((r) => r.nodeId === recent),
    ).toBeUndefined();
  });
});
