/**
 * A CLIENT's own space on a real, migrated Postgres (client logins C5, plan
 * section 9 and test 16), on real client logins and their real spaces:
 *
 *  - the client limits: 20 MB a file (a member's same file passes), 200 MB a
 *    client, 50 MB uploaded a day (the upload ledger), 500 items (a member's
 *    500th passes), and one total for ALL client spaces of the brain (other
 *    clients' rows count);
 *  - the submit caps: 10 submissions in 24 hours (Recall and Submit again
 *    still counts), 50 waiting for review (an item a reviewer took over
 *    counts); a member is never capped;
 *  - the review talk in a client's space: the client reads a reviewer's
 *    review comment and its own, never a member's comment, a team-scope
 *    comment or another client's; a client writes only as itself, review
 *    scope only; a reviewer's Return reaches the client's own row;
 *  - cost-safety: nothing a client does in their space is announced to the
 *    extractor; Accept announces each moved item exactly once, at team by
 *    default.
 *
 * Big sizes are FAKE: a small spooled upload with a large `size`, and
 * `size_bytes` / ledger rows written by the admin pool, never real bytes.
 * Every fixture a leak test hides is written with the same scope as an
 * allowed one, so only the rule under test hides it.
 *
 * The file holds the 'client-total' test lock from its first fixture to the
 * end of its cleanup: it writes and removes hundreds of fake client MB, and
 * its total test reads the brain-wide client bytes, which another file that
 * does the same (client-abuse) must not move half-way. A per-test lock left
 * that file's unlocked 200 MB fixtures free to land between this test's
 * reads (expected 0 to be >= 10 MB, 2026-10-02).
 *   MANTLE_TEST_DATABASE_URL=postgres://… pnpm vitest run packages/content/src/client-space-c5.viewer.db.test.ts
 */
import { randomUUID } from 'node:crypto';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { Readable } from 'node:stream';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { holdTestLock, notifyBarrier } from '@mantle/db/test-support';

const URL = process.env.MANTLE_TEST_DATABASE_URL;
const MB = 1024 * 1024;

describe.skipIf(!URL)('a client’s own space: limits, caps, review talk, cost-safety', () => {
  type Db = typeof import('@mantle/db');
  let m: Db;
  let sp: typeof import('./member-space');
  let sf: typeof import('./member-space-files');
  let sc: typeof import('./member-space-comments');
  let rv: typeof import('./member-review');
  let ma: typeof import('./member-accepted');
  let tk: typeof import('./member-takeover');
  let lim: typeof import('./space-limits');
  let fp: typeof import('@mantle/files');
  let sqlTag: typeof import('drizzle-orm').sql;
  let unlisten: () => Promise<void>;
  const announced: string[] = [];
  const tag = `c5space-${randomUUID().slice(0, 8)}`;
  // A brain of this test's own: Accept makes its root folders, and review
  // comments are stored with a brain's id.
  const anchor = randomUUID();
  const adminA = randomUUID();
  const member = randomUUID();
  // One client login per rule, so no test's rows count in another's.
  const c = {
    file: randomUUID(),
    storage: randomUUID(),
    daily: randomUUID(),
    items: randomUUID(),
    total: randomUUID(),
    other: randomUUID(),
    submits: randomUUID(),
    open: randomUUID(),
    talk: randomUUID(),
    otherTalk: randomUUID(),
    cost: randomUUID(),
  };
  const clients = Object.values(c);
  const logins = [adminA, member, ...clients];
  const spaceOf: Record<string, string> = {};
  const root = mkdtempSync(path.join(tmpdir(), 'mantle-c5space-'));
  let releaseTotal: () => Promise<void> = async () => {};

  const as = <T>(login: string, fn: () => Promise<T>) =>
    m.withSpace({ spaceId: spaceOf[login]!, loginId: login }, fn);
  const exec = async <T>(q: ReturnType<typeof sqlTag>) =>
    (await m.systemDb.execute(q)) as unknown as T[];
  /** A small real spool that claims `size` bytes (never a real big file). */
  const spool = async (size?: number) => {
    const s = await fp.spoolUpload(Readable.from([Buffer.from('BYTES')]), {
      maxBytes: sf.SPACE_FILE_MAX_BYTES,
      dir: fp.spaceSpoolDir(),
    });
    return size === undefined ? s : { ...s, size };
  };
  const upload = async (login: string, size?: number, filename = 'f.txt') =>
    as(login, async () =>
      sf.createMineFile(spaceOf[login]!, { filename, spooled: await spool(size) }),
    );
  /** `n` fake notes in a space, written by the admin pool. */
  const fakeItems = (login: string, n: number) =>
    m.systemDb.execute(sqlTag`
      insert into nodes (owner_id, type, title, path)
      select ${spaceOf[login]!}, 'note', ${`${tag} fake `} || g, 'notes'
        from generate_series(1, ${n}) g`);
  /** A fake file row of `bytes` in a space (no bytes on disk). */
  const fakeFile = async (login: string, bytes: number) => {
    const id = randomUUID();
    await m.systemDb.execute(sqlTag`
      insert into nodes (id, owner_id, type, title, path, data) values
        (${id}, ${spaceOf[login]!}, 'file', ${`${tag} big.bin`}, 'space_files',
         ${JSON.stringify({ filename: 'big.bin', size_bytes: bytes, storage: 'space' })}::jsonb)`);
    return id;
  };
  const page = async (login: string, title: string) =>
    (await as(login, () => sp.createMineItem(spaceOf[login]!, { type: 'page', title }))).id;
  const submit = (login: string, id: string) => as(login, () => sp.submitItem(spaceOf[login]!, id));
  const recall = (login: string, id: string) => as(login, () => sp.recallItem(spaceOf[login]!, id));
  const text = (t: string, extra: unknown[] = []) => ({
    type: 'doc',
    content: [...extra, { type: 'paragraph', content: [{ type: 'text', text: t }] }],
  });
  /** Every node_ingested notification committed so far has arrived. */
  const settle = () =>
    notifyBarrier(
      (m.systemDb as unknown as { $client: Parameters<typeof notifyBarrier>[0] }).$client,
      'node_ingested',
      { seen: (s) => announced.includes(s) },
    );

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
    rv = await import('./member-review');
    ma = await import('./member-accepted');
    tk = await import('./member-takeover');
    lim = await import('./space-limits');
    fp = await import('@mantle/files');
    sqlTag = (await import('drizzle-orm')).sql;
    const admin = (m.systemDb as unknown as { $client: Parameters<Db['ensureViewerRoles']>[0] })
      .$client;
    await m.ensureViewerRoles(admin, process.env.MANTLE_MASTER_KEY);
    const sub = await admin.listen('node_ingested', (id: string) => announced.push(id));
    unlisten = () => sub.unlisten();

    await m.systemDb.execute(sqlTag`
      insert into auth.users (id, email, password_hash, role, display_name) values
        (${anchor}, ${`${tag}-anchor@example.invalid`}, 'x', 'admin', null),
        (${adminA}, ${`${tag}-a@example.invalid`}, 'x', 'admin', 'Staff Person'),
        (${member}, ${`${tag}-m@example.invalid`}, 'x', 'member', 'Mia Member')`);
    for (const [name, id] of Object.entries(c)) {
      await m.systemDb.execute(sqlTag`
        insert into auth.users (id, email, password_hash, role, display_name) values
          (${id}, ${`${tag}-${name}@example.invalid`}, 'x', 'client', ${`Client ${name}`})`);
    }
    await m.systemDb.execute(sqlTag`
      insert into spaces (id, kind, login_id) values (${anchor}, 'brain', ${anchor})`);
    const rows = await exec<{ id: string; login_id: string }>(sqlTag`
      select id, login_id from spaces where kind = 'personal'
        and login_id = any(${`{${logins.join(',')}}`}::uuid[])`);
    for (const r of rows) spaceOf[r.login_id] = r.id;
  }, 60_000);

  afterAll(async () => {
    try {
      await unlisten();
      const spaces = Object.values(spaceOf);
      for (const s of [...spaces, anchor]) {
        await m.systemDb.execute(sqlTag`delete from nodes where owner_id = ${s}`);
      }
      await m.systemDb.execute(
        sqlTag`delete from spaces where login_id = any(${`{${[...logins, anchor].join(',')}}`}::uuid[])`,
      );
      await m.systemDb.execute(
        sqlTag`delete from auth.users where id = any(${`{${[...logins, anchor].join(',')}}`}::uuid[])`,
      );
      await m.closeDb();
      rmSync(root, { recursive: true, force: true });
    } finally {
      // Released only once this file's client bytes are gone.
      await releaseTotal();
    }
  });

  it('every login got its personal space; a client’s runs at client with the client limits', async () => {
    expect(Object.keys(spaceOf).sort()).toEqual([...logins].sort());
    expect(await as(c.file, async () => lim.spaceLimits())).toEqual(lim.CLIENT_SPACE_LIMITS);
    expect(await as(member, async () => lim.spaceLimits())).toEqual(lim.MEMBER_SPACE_LIMITS);
    expect(await as(c.file, () => sf.spaceUploadHeadroom(spaceOf[c.file]!))).toBe(20 * MB);
    expect(await as(member, () => sf.spaceUploadHeadroom(spaceOf[member]!))).toBe(100 * MB);
  });

  // ── Limits ──────────────────────────────────────────────────────────────

  it('refuses a client file over 20 MB; a member’s same file passes', async () => {
    await expect(upload(c.file, 21 * MB)).rejects.toMatchObject({
      reason: 'quota',
      message: expect.stringMatching(/at most 20 MB/),
    });
    const ok = await upload(member, 21 * MB);
    expect(ok).toBeTruthy();
    // At the ceiling it passes for the client too.
    expect(await upload(c.file, 20 * MB)).toBeTruthy();
  });

  it('refuses a client’s upload past 200 MB held', async () => {
    await fakeFile(c.storage, 195 * MB);
    expect(await as(c.storage, () => sf.spaceUploadHeadroom(spaceOf[c.storage]!))).toBe(5 * MB);
    await expect(upload(c.storage, 10 * MB)).rejects.toMatchObject({
      reason: 'quota',
      message: expect.stringMatching(/space is full \(200 MB\)/),
    });
    expect(await upload(c.storage, 4 * MB)).toBeTruthy();
  });

  it('refuses a client’s upload past 50 MB in a day, from the upload ledger', async () => {
    // Uploaded (and deleted since) today: the ledger keeps it.
    await m.systemDb.execute(sqlTag`
      insert into space_uploads (space_id, bytes) values (${spaceOf[c.daily]!}, ${45 * MB})`);
    expect(await as(c.daily, () => sf.spaceUploadHeadroom(spaceOf[c.daily]!))).toBe(5 * MB);
    await expect(upload(c.daily, 10 * MB)).rejects.toMatchObject({
      reason: 'quota',
      message: expect.stringMatching(/50 MB a day/),
    });
    expect(await upload(c.daily, 4 * MB)).toBeTruthy();
    // Yesterday's uploads do not count.
    await m.systemDb.execute(sqlTag`
      update space_uploads set created_at = now() - interval '25 hours'
       where space_id = ${spaceOf[c.daily]!}`);
    expect(await upload(c.daily, 10 * MB)).toBeTruthy();
  });

  it('holds a client to 500 items; a member’s 501st passes', async () => {
    await fakeItems(c.items, 499);
    expect(await page(c.items, `${tag} 500th`)).toBeTruthy();
    await expect(page(c.items, `${tag} 501st`)).rejects.toMatchObject({
      reason: 'quota',
      message: expect.stringMatching(/500 items/),
    });
    await expect(upload(c.items, 1024)).rejects.toMatchObject({ reason: 'quota' });
    await fakeItems(member, 500);
    expect(await page(member, `${tag} member 501st`)).toBeTruthy();
  });

  it('holds all client spaces to one total; other clients’ rows count, a member’s do not', async () => {
    // The total is set from what client spaces hold now, and ANOTHER client
    // holds 30 MB of it. The other file that writes megabytes of client rows
    // (client-abuse) waits on the file's 'client-total' lock. Page text other
    // files write moves it a few KB, so headroom is checked within 1 MB; the
    // 30 MB of the other client is what the test proves.
    const usedNow = async () =>
      Number(
        (await exec<{ n: string }>(sqlTag`select mantle_client_space_bytes()::text as n`))[0]!.n,
      );
    const big = await fakeFile(c.other, 30 * MB);
    process.env.MANTLE_CLIENT_SPACES_TOTAL_BYTES = String((await usedNow()) + 5 * MB);
    const headroom = () => as(c.total, () => sf.spaceUploadHeadroom(spaceOf[c.total]!));
    try {
      const h = await headroom();
      expect(h).toBeGreaterThan(4 * MB);
      expect(h).toBeLessThanOrEqual(6 * MB);
      await expect(upload(c.total, 10 * MB)).rejects.toMatchObject({
        reason: 'quota',
        message: expect.stringMatching(/storage for client uploads is full/),
      });
      // A member's space is not a client's: the total never holds it.
      expect(await upload(member, 10 * MB)).toBeTruthy();
      // The other client's 30 MB counted: without it there is room again.
      await m.systemDb.execute(sqlTag`delete from nodes where id = ${big}`);
      expect(await headroom()).toBeGreaterThanOrEqual(10 * MB);
      expect(await upload(c.total, 10 * MB)).toBeTruthy();
    } finally {
      delete process.env.MANTLE_CLIENT_SPACES_TOTAL_BYTES;
      await m.systemDb.execute(sqlTag`delete from nodes where id = ${big}`);
    }
  });

  // ── Submit caps ─────────────────────────────────────────────────────────

  it('refuses the 11th submission in 24 hours; Recall and Submit again still counts', async () => {
    const ids: string[] = [];
    for (let i = 0; i < 10; i++) ids.push(await page(c.submits, `${tag} s${i}`));
    for (const id of ids.slice(0, 9)) await submit(c.submits, id);
    // The 10th: submitted, recalled for a fix, submitted again = the 11th.
    const last = ids[9]!;
    await submit(c.submits, last);
    await recall(c.submits, last);
    await expect(submit(c.submits, last)).rejects.toMatchObject({
      reason: 'quota',
      message: expect.stringMatching(/10 items a day/),
    });
    const [n] = await exec<{ n: number }>(
      sqlTag`select count(*)::int as n from space_submissions where space_id = ${spaceOf[c.submits]!}`,
    );
    expect(n?.n).toBe(10);
    // A day later it goes.
    await m.systemDb.execute(sqlTag`
      update space_submissions set created_at = now() - interval '25 hours'
       where space_id = ${spaceOf[c.submits]!}`);
    expect((await submit(c.submits, last)).reviewState).toBe('submitted');
  });

  it('refuses the 51st open submission, counting an item a reviewer took over', async () => {
    const actor = { loginId: adminA, spaceId: spaceOf[adminA]! };
    const taken = await page(c.open, `${tag} taken`);
    await submit(c.open, taken);
    await rv.takeOverReviewItem(taken, actor);
    // 48 more waiting (written by the admin pool: the day cap is not this
    // test's rule), the taken one, then the 50th and the 51st.
    await fakeItems(c.open, 48);
    await m.systemDb.execute(sqlTag`
      insert into space_items (node_id, author_login_id, review_state, submitted_at)
      select n.id, ${c.open}, 'submitted', now() from nodes n
       where n.owner_id = ${spaceOf[c.open]!} and n.title like ${`${tag} fake %`}`);
    const fiftieth = await page(c.open, `${tag} 50th`);
    expect((await submit(c.open, fiftieth)).reviewState).toBe('submitted');
    const fiftyFirst = await page(c.open, `${tag} 51st`);
    await expect(submit(c.open, fiftyFirst)).rejects.toMatchObject({
      reason: 'quota',
      message: expect.stringMatching(/50 items waiting/),
    });
    // The item goes back to the author: one place is free again.
    await tk.giveBackTakenItem(anchor, actor, taken, 'Back to you.');
    expect((await submit(c.open, fiftyFirst)).reviewState).toBe('submitted');
  });

  it('never caps a member: 11 submissions a day and 50 waiting pass', async () => {
    await m.systemDb.execute(sqlTag`
      insert into space_items (node_id, author_login_id, review_state, submitted_at)
      select n.id, ${member}, 'submitted', now() from nodes n
       where n.owner_id = ${spaceOf[member]!} and n.title like ${`${tag} fake %`}
       limit 50`);
    for (let i = 0; i < 11; i++) {
      const id = await page(member, `${tag} member s${i}`);
      expect((await submit(member, id)).reviewState).toBe('submitted');
    }
  });

  // ── The review talk in a client's space ─────────────────────────────────

  let talkPage = '';
  const commentRow = (id: string, kind: string, login: string, scope: string) => sqlTag`
    insert into node_comments (id, owner_id, node_id, author_kind, login_id, author_name, body, thread_scope)
    values (${id}, ${anchor}, ${talkPage}, ${kind}, ${login}, ${`${kind} name`}, ${`${kind} ${scope}`}, ${scope})`;

  it('a client reads a reviewer’s review comment and its own, nothing else', async () => {
    talkPage = await page(c.talk, `${tag} talk`);
    await submit(c.talk, talkPage);
    const reviewer = randomUUID();
    const byMember = randomUUID();
    const teamScope = randomUUID();
    const byOtherClient = randomUUID();
    // Allowed: a reviewer's review talk. Hidden, each by one rule only: a
    // member's review comment (author kind), a reviewer's TEAM comment
    // (scope), another client's review comment (login).
    await m.systemDb.execute(commentRow(reviewer, 'owner', adminA, 'review'));
    await m.systemDb.execute(commentRow(byMember, 'member', member, 'review'));
    await m.systemDb.execute(commentRow(teamScope, 'owner', adminA, 'team'));
    await m.systemDb.execute(commentRow(byOtherClient, 'client', c.otherTalk, 'review'));
    const own = await as(c.talk, () =>
      sc.addMineComment(
        spaceOf[c.talk]!,
        anchor,
        talkPage,
        { loginId: c.talk, name: 'Client talk' },
        'When will it be ready?',
      ),
    );
    expect(own).toMatchObject({ authorKind: 'client', threadScope: 'review', loginId: c.talk });
    const seen = await as(c.talk, () => sc.listMineComments(spaceOf[c.talk]!, talkPage));
    expect(seen?.map((r) => r.id).sort()).toEqual([reviewer, own.id].sort());
    // The reviewer reads every comment on the item (the admin pool).
    const all = await exec<{ id: string }>(
      sqlTag`select id from node_comments where node_id = ${talkPage}`,
    );
    expect(all.length).toBe(5);
  });

  it('a client writes only as itself, review scope only (row security)', async () => {
    /** The insert's SQLSTATE: 42501 = refused by row security. */
    const insert = (kind: string, scope: string, login = c.talk) =>
      as(c.talk, () =>
        m.db.insert(m.nodeComments).values({
          ownerId: anchor,
          nodeId: talkPage,
          authorKind: kind as 'client',
          loginId: login,
          authorName: 'x',
          body: 'x',
          threadScope: scope as 'review',
        }),
      ).then(
        () => 'ok',
        (err: { cause?: { code?: string } }) => err.cause?.code ?? String(err),
      );
    expect(await insert('member', 'review')).toBe('42501');
    expect(await insert('client', 'team')).toBe('42501');
    expect(await insert('owner', 'review')).toBe('42501');
    expect(await insert('client', 'review', c.otherTalk)).toBe('42501');
    // The control: as itself, review scope.
    expect(await insert('client', 'review')).toBe('ok');
  });

  it('a reviewer’s Return reaches the client’s own row, with the note; the talk closes', async () => {
    await rv.returnReviewItem(talkPage, { loginId: adminA }, 'Say which site.');
    const row = await as(c.talk, () => sp.getMineRow(spaceOf[c.talk]!, talkPage));
    expect(row).toMatchObject({ reviewState: 'returned', returnedNote: 'Say which site.' });
    const listed = await as(c.talk, () =>
      sp.listMine(spaceOf[c.talk]!, { reviewStates: ['returned'] }),
    );
    expect(listed.items.map((i) => [i.id, i.returnedNote])).toEqual([
      [talkPage, 'Say which site.'],
    ]);
    await expect(
      as(c.talk, () =>
        sc.addMineComment(
          spaceOf[c.talk]!,
          anchor,
          talkPage,
          { loginId: c.talk, name: 'x' },
          'more',
        ),
      ),
    ).rejects.toMatchObject({ reason: 'not-shared' });
  });

  // ── Cost-safety (plan section 9, test 16) ───────────────────────────────

  it('nothing a client does in their space is announced; Accept announces each item once, at team', async () => {
    const C = spaceOf[c.cost]!;
    const pageId = await page(c.cost, `${tag} cost page`);
    const noteId = (
      await as(c.cost, () =>
        sp.createMineItem(C, { type: 'note', title: `${tag} cost note`, content: 'hello' }),
      )
    ).id;
    await as(c.cost, () => sp.updateMineItem(C, noteId, { content: 'hello again' }));
    const fileId = await upload(c.cost, undefined, 'plan.png');
    const saved = await as(c.cost, () =>
      sp.saveMinePage(
        C,
        pageId,
        text('see the plan', [{ type: 'image', attrs: { nodeId: fileId } }]),
      ),
    );
    expect(saved.ok).toBe(true);
    await submit(c.cost, pageId);
    await recall(c.cost, pageId);
    await submit(c.cost, pageId);
    await as(c.cost, () =>
      sc.addMineComment(C, anchor, pageId, { loginId: c.cost, name: 'Cost' }, 'Ready.'),
    );
    await settle();
    const ours = [pageId, noteId, fileId];
    expect(announced.filter((id) => ours.includes(id))).toEqual([]);

    const res = await rv.acceptReviewItem(anchor, pageId, { loginId: adminA });
    expect(res.audience).toBe('team');
    const [node] = await exec<{ audience: string; owner_id: string }>(
      sqlTag`select audience, owner_id from nodes where id = ${pageId}`,
    );
    expect(node).toEqual({ audience: 'team', owner_id: anchor });
    const moved = res.moved.map((b) => b.id).sort();
    expect(moved).toEqual([pageId, fileId].sort());
    await settle();
    for (const id of moved) expect(announced.filter((a) => a === id).length, id).toBe(1);
    // The note never moved, and was never announced.
    expect(announced).not.toContain(noteId);

    // The author reads it as accepted, with no level; their accepted file's
    // bytes stay readable (the client files route's fallback).
    const item = await ma.getClientAcceptedItem(anchor, c.cost, pageId);
    expect(item).toMatchObject({ id: pageId, type: 'page' });
    expect(item).not.toHaveProperty('audience');
    expect(await ma.getClientAcceptedItem(anchor, c.talk, pageId)).toBeNull();
    expect(await ma.acceptedFileReadable(anchor, c.cost, fileId)).toBe(true);
    expect(await ma.acceptedFileReadable(anchor, c.talk, fileId)).toBe(false);
    const list = await ma.listAccepted(anchor, c.cost, { kinds: ['page', 'note', 'file'] });
    expect(list.items.map((r) => r.id).sort()).toEqual([pageId, fileId].sort());
  });
});
