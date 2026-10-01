/**
 * "Needs you" (migration 0186) on a real, migrated Postgres: the owner-level
 * `needs_you_changed` event fires, once per transaction and with the brain's
 * owner id, when a member submits, recalls, when an admin returns, accepts,
 * takes over, gives back, discards, when a login's deactivation changes what
 * waits, and when a team request opens or closes; a save, a share, a board
 * edit or an untagged task never fire it. The count comes from count
 * queries that agree with the Review queue and the Requests list, with no
 * cap. The trigger functions only notify (cost-safety: no write, no job).
 *
 * It runs on a scratch database of its own: the event names the brain, not
 * the writer, so on the shared test database other files' submits would be
 * indistinguishable from this file's, and "nothing fired" could not be
 * proved.
 *   MANTLE_TEST_DATABASE_URL=postgres://… pnpm vitest run packages/content/src/needs-you.viewer.db.test.ts
 */
import { randomUUID } from 'node:crypto';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

const URL = process.env.MANTLE_TEST_DATABASE_URL;
const CHANNEL = 'needs_you_changed';

describe.skipIf(!URL)('needs you: the live event and the counts', () => {
  type Db = typeof import('@mantle/db');
  let m: Db;
  let sp: typeof import('./member-space');
  let rv: typeof import('./member-review');
  let tk: typeof import('./member-takeover');
  let ny: typeof import('./needs-you');
  let tr: typeof import('./team-requests');
  let ts: typeof import('@mantle/db/test-support');
  let sqlTag: typeof import('drizzle-orm').sql;
  let scratch: { url: string; drop: () => Promise<void> } | undefined;
  let unlisten: (() => Promise<void>) | undefined;
  const events: string[] = [];
  const tag = `nyou-${randomUUID().slice(0, 8)}`;
  const anchor = randomUUID();
  const adminA = randomUUID();
  const member = randomUUID();
  const member2 = randomUUID();
  const spaceOf: Record<string, string> = {};
  const root = mkdtempSync(path.join(tmpdir(), 'mantle-needs-you-'));

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
      seen: (s) => {
        sentinel = s;
        return events.includes(s);
      },
    });
    return sentinel;
  };
  /** What `fn` sent on the channel: drained before (a step before it may
   *  still be arriving) and after (notifications arrive in commit order, so
   *  once the barrier's sentinel is here, everything `fn` committed is). */
  const sent = async (fn: () => Promise<unknown>): Promise<string[]> => {
    await drain();
    events.length = 0;
    await fn();
    const sentinel = await drain();
    return events.filter((e) => e !== sentinel);
  };

  const newPage = async (login: string, title: string) => {
    const s = spaceOf[login]!;
    const id = (await as(login, () => sp.createMineItem(s, { type: 'page', title }))).id;
    expect((await as(login, () => sp.saveMinePage(s, id, say(`${title} words`)))).ok).toBe(true);
    return id;
  };
  const submit = (login: string, id: string) => as(login, () => sp.submitItem(spaceOf[login]!, id));
  const addRequest = async (title: string, status = 'open', tags = ['team-request']) => {
    const id = randomUUID();
    await m.systemDb.execute(sqlTag`
      insert into nodes (id, owner_id, type, title, path, tags, data) values
        (${id}, ${anchor}, 'task', ${title}, 'tasks',
         ${sqlTag`array[${sqlTag.join(
           tags.map((t) => sqlTag`${t}`),
           sqlTag`, `,
         )}]::text[]`},
         ${JSON.stringify({ status, teamRequest: { loginId: member, contactName: 'Mia Member' } })}::jsonb)`);
    return id;
  };
  const setStatus = (id: string, status: string) =>
    m.systemDb.execute(sqlTag`
      update nodes set data = jsonb_set(data, '{status}', to_jsonb(${status}::text)) where id = ${id}`);

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
    ny = await import('./needs-you');
    tr = await import('./team-requests');
    sqlTag = (await import('drizzle-orm')).sql;
    const admin = (m.systemDb as unknown as { $client: Parameters<Db['ensureViewerRoles']>[0] })
      .$client;
    await m.ensureViewerRoles(admin, process.env.MANTLE_MASTER_KEY);
    const sub = await admin.listen(CHANNEL, (p: string) => events.push(p));
    unlisten = () => sub.unlisten();

    // This database is ours alone: the anchor is the brain.
    await m.systemDb.execute(sqlTag`
      insert into auth.users (id, email, password_hash, role, display_name, is_owner) values
        (${anchor}, ${`${tag}-anchor@example.invalid`}, 'x', 'admin', null, true)`);
    await m.systemDb.execute(sqlTag`
      insert into auth.users (id, email, password_hash, role, display_name) values
        (${adminA}, ${`${tag}-a@example.invalid`}, 'x', 'admin', null),
        (${member}, ${`${tag}-m@example.invalid`}, 'x', 'member', 'Mia Member'),
        (${member2}, ${`${tag}-n@example.invalid`}, 'x', 'member', 'Noah')`);
    // An owner login gets its brain space from the auth.users trigger; make
    // sure it is there.
    await m.systemDb.execute(sqlTag`
      insert into spaces (id, kind, login_id) values (${anchor}, 'brain', ${anchor})
      on conflict (id) do nothing`);
    const rows = await exec<{ id: string; login_id: string }>(sqlTag`
      select id, login_id from spaces where kind = 'personal'
        and login_id in (${adminA}, ${member}, ${member2})`);
    for (const r of rows) spaceOf[r.login_id] = r.id;
  }, 180_000);

  afterAll(async () => {
    await unlisten?.();
    await m?.closeDb();
    await scratch?.drop();
    rmSync(root, { recursive: true, force: true });
  }, 120_000);

  let pageId: string;

  it('a new item, a save and a share wake nobody', async () => {
    expect(
      await sent(async () => {
        pageId = await newPage(member, `${tag} spec`);
        await as(member, () => sp.setSharing(spaceOf[member]!, pageId, 'team'));
        await as(member, () => sp.setSharing(spaceOf[member]!, pageId, 'private'));
      }),
    ).toEqual([]);
    expect((await ny.loadNeedsYou(anchor)).total).toBe(0);
  });

  it('Submit wakes the admins once, and the count and the newest item follow', async () => {
    expect(await sent(() => submit(member, pageId))).toEqual([anchor]);
    const n = await ny.loadNeedsYou(anchor);
    expect(n.review).toMatchObject({ submitted: 1, leftBehind: 0 });
    expect(n.review.newest).toMatchObject({ id: pageId, title: `${tag} spec`, from: 'Mia Member' });
    expect(Object.keys(n.review.newest!).sort()).toEqual(['at', 'from', 'id', 'title']);
    expect(n.total).toBe(1);
  });

  it('Recall wakes them; the count drops', async () => {
    expect(await sent(() => as(member, () => sp.recallItem(spaceOf[member]!, pageId)))).toEqual([
      anchor,
    ]);
    expect((await ny.loadNeedsYou(anchor)).review).toEqual({
      submitted: 0,
      leftBehind: 0,
      newest: null,
    });
  });

  it('Return wakes them', async () => {
    await submit(member, pageId);
    expect(await sent(() => rv.returnReviewItem(pageId, { loginId: adminA }, 'Add dates'))).toEqual(
      [anchor],
    );
    expect((await ny.loadNeedsYou(anchor)).review.submitted).toBe(0);
  });

  it('Take over wakes them (and leaves the queue), Give back wakes them', async () => {
    await submit(member, pageId);
    expect(await sent(() => rv.takeOverReviewItem(pageId, actorA()))).toEqual([anchor]);
    expect((await ny.loadNeedsYou(anchor)).review.submitted).toBe(0);
    expect(await sent(() => tk.giveBackTakenItem(anchor, actorA(), pageId, 'Over to you'))).toEqual(
      [anchor],
    );
  });

  it('a taken item whose admin is deactivated comes back, with an event', async () => {
    await submit(member, pageId);
    await rv.takeOverReviewItem(pageId, actorA());
    expect(
      await sent(() =>
        m.systemDb.execute(sqlTag`update auth.users set disabled_at = now() where id = ${adminA}`),
      ),
    ).toEqual([anchor]);
    expect((await ny.loadNeedsYou(anchor)).review.submitted).toBe(1);
    expect(
      await sent(() =>
        m.systemDb.execute(sqlTag`update auth.users set disabled_at = null where id = ${adminA}`),
      ),
    ).toEqual([anchor]);
    expect((await ny.loadNeedsYou(anchor)).review.submitted).toBe(0);
    await tk.giveBackTakenItem(anchor, actorA(), pageId, 'Back');
  });

  it('Accept wakes them once', async () => {
    await submit(member, pageId);
    expect(await sent(() => rv.acceptReviewItem(anchor, pageId, { loginId: adminA }))).toEqual([
      anchor,
    ]);
    expect((await ny.loadNeedsYou(anchor)).review.submitted).toBe(0);
  });

  it('a deactivated member’s shared items are left behind (event); Discard and Accept clear them (events)', async () => {
    const left = await newPage(member2, `${tag} left`);
    const kept = await newPage(member2, `${tag} kept`);
    await as(member2, () => sp.setSharing(spaceOf[member2]!, left, 'team'));
    await as(member2, () => sp.setSharing(spaceOf[member2]!, kept, 'team'));
    expect(
      await sent(() =>
        m.systemDb.execute(sqlTag`update auth.users set disabled_at = now() where id = ${member2}`),
      ),
    ).toEqual([anchor]);
    expect((await ny.loadNeedsYou(anchor)).review).toMatchObject({ submitted: 0, leftBehind: 2 });
    expect(await sent(() => rv.discardLeftBehind(left))).toEqual([anchor]);
    expect((await ny.loadNeedsYou(anchor)).review.leftBehind).toBe(1);
    // A left-behind item is a draft until accepted: Accept still wakes them.
    expect(await sent(() => rv.acceptReviewItem(anchor, kept, { loginId: adminA }))).toEqual([
      anchor,
    ]);
    expect((await ny.loadNeedsYou(anchor)).review.leftBehind).toBe(0);
  });

  it('team requests: opened, done and reopened, deleted; edits and untagged tasks do not fire', async () => {
    let req = '';
    expect(await sent(async () => (req = await addRequest(`${tag} fix the date`)))).toEqual([
      anchor,
    ]);
    const n = await ny.loadNeedsYou(anchor);
    expect(n.requests).toEqual({
      open: 1,
      newest: { id: req, title: `${tag} fix the date`, from: 'Mia Member', at: expect.any(String) },
    });
    expect(
      await sent(() =>
        m.systemDb.execute(sqlTag`update nodes set title = ${`${tag} fix it`} where id = ${req}`),
      ),
    ).toEqual([]);
    expect(await sent(() => setStatus(req, 'in_progress'))).toEqual([]);
    expect(await sent(() => setStatus(req, 'done'))).toEqual([anchor]);
    expect((await ny.loadNeedsYou(anchor)).requests.open).toBe(0);
    expect(await sent(() => setStatus(req, 'open'))).toEqual([anchor]);
    expect(await sent(() => addRequest(`${tag} plain task`, 'open', ['todo']))).toEqual([]);
    expect(
      await sent(() => m.systemDb.execute(sqlTag`delete from nodes where id = ${req}`)),
    ).toEqual([anchor]);
  });

  it('one transaction wakes each listener once; the count has no cap', async () => {
    const ids: string[] = [];
    for (let i = 0; i < 105; i++) ids.push(await addRequest(`${tag} bulk ${i}`));
    expect(await tr.countOpenTeamRequests(anchor)).toBe(105);
    expect((await tr.listTeamRequests(anchor, { status: 'open' })).length).toBe(100);
    expect((await ny.loadNeedsYou(anchor)).requests.open).toBe(105);
    expect(
      await sent(() =>
        m.systemDb.execute(sqlTag`update nodes set data = jsonb_set(data, '{status}', '"done"')
                                   where owner_id = ${anchor} and title like ${`${tag} bulk %`}`),
      ),
    ).toEqual([anchor]);
    expect(await tr.countOpenTeamRequests(anchor)).toBe(0);
  });

  it('the count agrees with the Review queue on one snapshot', async () => {
    // A mix: one submitted, one left behind (member2 is still deactivated).
    const a = await newPage(member, `${tag} a`);
    await submit(member, a);
    const b = await newPage(member, `${tag} b`);
    await as(member, () => sp.setSharing(spaceOf[member]!, b, 'team'));
    await m.systemDb.execute(
      sqlTag`update auth.users set disabled_at = null where id = ${member2}`,
    );
    const c = await newPage(member2, `${tag} c`);
    await as(member2, () => sp.setSharing(spaceOf[member2]!, c, 'team'));
    await m.systemDb.execute(
      sqlTag`update auth.users set disabled_at = now() where id = ${member2}`,
    );
    await m.systemDb.transaction(async (tx) => {
      await tx.execute(sqlTag`set transaction isolation level repeatable read`);
      const queue = await rv.listReviewQueue(tx);
      expect(await rv.countReviewQueue(tx)).toEqual(queue.counts);
      expect(queue.counts).toEqual({ submitted: 1, leftBehind: 1 });
    });
  });

  it('the trigger functions only notify: no write, no job, nothing an LLM could follow', async () => {
    const fns = await exec<{ proname: string; src: string; secdef: boolean }>(sqlTag`
      select proname, prosrc as src, prosecdef as secdef from pg_proc
       where proname in ('mantle_notify_needs_you', 'mantle_notify_needs_you_request')`);
    expect(fns.map((f) => f.proname).sort()).toEqual([
      'mantle_notify_needs_you',
      'mantle_notify_needs_you_request',
    ]);
    for (const f of fns) {
      expect(f.src).toMatch(/pg_notify\('needs_you_changed'/);
      expect(f.src).not.toMatch(
        /insert\s+into|update\s+\S+\s+set|delete\s+from|pgboss|perform\s+(?!pg_notify)/i,
      );
    }
    // And nothing else in the database listens on the channel's behalf:
    // only these two functions mention it.
    const [other] = await exec<{ n: number }>(sqlTag`
      select count(*)::int as n from pg_proc
       where prosrc like '%needs_you_changed%'
         and proname not in ('mantle_notify_needs_you', 'mantle_notify_needs_you_request')`);
    expect(other!.n).toBe(0);
  });
});
