/**
 * Present canvases on Postgres (migrations 0331, 0332): create under the
 * `present` root with its text and head facts, a save that is live at once
 * with the `rev` etag, the last ten versions kept, the quiet-period rule (a
 * text change marks the canvas due, a colour change does not, the flush
 * announces once and clears it), and a delete that takes the sidecar and its
 * versions. Seeds its own owner on random ids; removes it.
 *   MANTLE_TEST_DATABASE_URL=postgres://… pnpm vitest run packages/content/src/presents.db.test.ts
 */
import { randomUUID } from 'node:crypto';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { asSuperuser } from '@mantle/db/test-support';

const URL = process.env.MANTLE_TEST_DATABASE_URL;

const canvas = (title: string, body: string, colour = 'red') => `<!doctype html>
<html>
  <head>
    <title>${title}</title>
    <meta name="description" content="A test canvas." />
    <meta name="canvas:size" content="1280x720" />
    <style>h1 { color: ${colour} }</style>
  </head>
  <body><h1 class="p-6">${body}</h1>
    <script type="module">import * as d3 from 'd3'; d3.select('h1');</script>
  </body>
</html>`;

describe.skipIf(!URL)('present canvases on Postgres', () => {
  type Db = typeof import('@mantle/db');
  let m: Db;
  let admin: Parameters<Db['ensureViewerRoles']>[0];
  let presents: typeof import('./presents');
  const owner = randomUUID();
  const tag = owner.slice(0, 8);

  /** A raw fixture write of the test's own, as the superuser and
   *  system(test), never through the app's pool: on the runtime role (arch
   *  A9, `pnpm test:runtime-role`, what a fresh box runs) that pool may not
   *  run the operator's setter (mantle_operator_actor) nor write a login's
   *  role, and another file may have raised the box's actor check. */
  const su = asSuperuser(URL);

  beforeAll(async () => {
    process.env.DATABASE_URL = URL;
    process.env.MANTLE_MASTER_KEY ??= 'mantle-viewer-test-key';
    m = await import('@mantle/db');
    admin = (m.systemDb as unknown as { $client: typeof admin }).$client;
    presents = await import('./presents');
    await su`insert into auth.users (id, email, password_hash, role) values
      (${owner}, ${`pr-${tag}@example.invalid`}, 'x', 'admin')`;
    await su`insert into spaces (id, kind, login_id) values (${owner}, 'brain', ${owner})`;
  }, 60_000);

  afterAll(async () => {
    if (!admin) return;
    await su`delete from nodes where owner_id = ${owner}`;
    await su`delete from spaces where login_id = ${owner}`;
    await su`delete from auth.users where id = ${owner}`;
    await m.closeDb();
  });

  it('creates a canvas under the present root, titled by its head, with its text', async () => {
    const p = await presents.createPresent(owner, {
      source: canvas(`${tag} Feed`, 'Pumps P-301A/B'),
      css: '.p-6{padding:1.5rem}',
    });
    expect(p.title).toBe(`${tag} Feed`);
    expect(p.rev).toBe(1);
    expect(p.meta).toEqual({
      size: { w: 1280, h: 720 },
      theme: 'follow',
      libs: ['d3'],
      scripts: [],
      posterAt: null,
    });
    const [row] = await admin<{ path: string; type: string; text: string; css: string }[]>`
      select n.path::text as path, n.type::text as type, p.source_text as text, p.css
        from nodes n join presents p on p.node_id = n.id where n.id = ${p.id}`;
    expect(row).toMatchObject({ path: 'present', type: 'present', css: '.p-6{padding:1.5rem}' });
    expect(row!.text).toContain('Pumps P-301A/B');
    expect(row!.text).not.toContain('d3.select');
    // The root folder was made once, as a branch.
    const [root] = await admin<{ n: number }[]>`
      select count(*)::int as n from nodes
       where owner_id = ${owner} and type = 'branch' and path = 'present'`;
    expect(root!.n).toBe(1);
    const frame = await presents.getPresentFrame(owner, p.id);
    expect(frame?.css).toBe('.p-6{padding:1.5rem}');
  });

  it('a save is live at once; a stale rev is refused with the current one', async () => {
    const p = await presents.createPresent(owner, { source: canvas(`${tag} Live`, 'one') });
    const saved = await presents.savePresentSource(owner, p.id, {
      source: canvas(`${tag} Live`, 'two'),
      css: '',
      ifRev: 1,
    });
    expect(saved.ok && saved.present.rev).toBe(2);
    expect((await presents.getPresent(owner, p.id))?.source).toContain('two');
    const stale = await presents.savePresentSource(owner, p.id, {
      source: canvas(`${tag} Live`, 'three'),
      css: '',
      ifRev: 1,
    });
    expect(stale).toEqual({ ok: false, conflict: true, rev: 2 });
    expect((await presents.getPresent(owner, p.id))?.source).toContain('two');
  });

  it('keeps the last ten versions of the source', async () => {
    const p = await presents.createPresent(owner, { source: canvas(`${tag} Many`, 'v1') });
    for (let i = 2; i <= 13; i++) {
      await presents.savePresentSource(owner, p.id, {
        source: canvas(`${tag} Many`, `v${i}`),
        css: '',
      });
    }
    const revs = await presents.listPresentRevisions(owner, p.id);
    expect(revs?.map((r) => r.rev)).toEqual([13, 12, 11, 10, 9, 8, 7, 6, 5, 4]);
  });

  it('a text change waits for the quiet period, a colour change costs nothing, the flush announces once', async () => {
    const p = await presents.createPresent(owner, { source: canvas(`${tag} Quiet`, 'start') });
    const due = async () => {
      const at = (
        await admin<{ due: Date | string | null }[]>`
          select index_due_at as due from presents where node_id = ${p.id}`
      )[0]!.due;
      return at === null ? null : new Date(at);
    };
    expect(await due()).toBeNull();

    // A colour: the text is the same, nothing waits.
    await presents.savePresentSource(owner, p.id, {
      source: canvas(`${tag} Quiet`, 'start', 'blue'),
      css: '',
    });
    expect(await due()).toBeNull();

    // New words: due a quiet period ahead.
    const before = Date.now();
    await presents.savePresentSource(owner, p.id, {
      source: canvas(`${tag} Quiet`, 'new words'),
      css: '',
    });
    const first = await due();
    expect(first!.getTime()).toBeGreaterThanOrEqual(
      before + presents.PRESENT_INDEX_QUIET_MS - 1000,
    );

    // Not due yet: the flush leaves it.
    expect(await presents.flushDuePresentIndex()).toBe(0);
    expect(await due()).not.toBeNull();

    // Once past due, one flush announces it and clears the mark; a second
    // flush finds nothing.
    await su`update presents set index_due_at = now() - interval '1 second' where node_id = ${p.id}`;
    const announced = await presents.flushDuePresentIndex();
    expect(announced).toBeGreaterThanOrEqual(1);
    expect(await due()).toBeNull();
    const [node] = await admin<{ work: string | null }[]>`
      select data->>'index_work' as work from nodes where id = ${p.id}`;
    expect(node!.work).toBe('extract');
  });

  it("keeps the author's summary, writes the flush's in the announcing transaction, and never the flush's over the author's (J9)", async () => {
    const key = 'published' + '_summary';
    const kept = async (id: string) =>
      (
        await admin<
          { s: { text: string; source: string; hash: string } | null; work: string | null }[]
        >`
          select data->${key} as s, data->>'index_work' as work from nodes where id = ${id}`
      )[0]!;
    const pastDue = (id: string) =>
      su`update presents set index_due_at = now() - interval '1 second' where node_id = ${id}`;

    // An author's summary at create, kept as written.
    const a = await presents.createPresent(owner, {
      source: canvas(`${tag} Authored`, 'x'),
      summary: '  The feed pump P&ID\n for operators. ',
    });
    expect((await kept(a.id)).s).toMatchObject({
      text: 'The feed pump P&ID for operators.',
      source: 'author',
    });

    // The flush asks its hook; the hook's summary lands with the 'extract'
    // reset, and survives that reset (it is not a summary key).
    const b = await presents.createPresent(owner, { source: canvas(`${tag} Made`, 'y') });
    await pastDue(b.id);
    const asked: string[] = [];
    const n = await presents.flushDuePresentIndex(25, async (c) => {
      asked.push(c.id);
      // The flush is brain-wide: answer for this test's canvas only.
      return c.id === b.id
        ? m.newPublishedSummary('A made summary.', 'publish', 'h1', 'cheap-model')
        : null;
    });
    expect(n).toBeGreaterThanOrEqual(1);
    expect(asked).toContain(b.id);
    expect(await kept(b.id)).toMatchObject({
      s: { text: 'A made summary.', source: 'publish' },
      work: 'extract',
    });

    // An author's summary set later replaces it and marks the canvas due;
    // the same text again writes nothing.
    expect(await presents.setPresentSummary(owner, b.id, 'Mine now.')).toBe(true);
    expect((await kept(b.id)).s).toMatchObject({ text: 'Mine now.', source: 'author' });
    expect(await presents.setPresentSummary(owner, b.id, 'Mine now.')).toBe(false);
    const [due] = await admin<{ due: unknown }[]>`
      select index_due_at as due from presents where node_id = ${b.id}`;
    expect(due!.due).not.toBeNull();

    // A generated summary arriving after it never lands over it.
    await pastDue(b.id);
    await presents.flushDuePresentIndex(25, async (c) =>
      c.id === b.id
        ? m.newPublishedSummary('Generated late.', 'publish', 'h2', 'cheap-model')
        : null,
    );
    expect((await kept(b.id)).s).toMatchObject({ text: 'Mine now.', source: 'author' });
  });

  it('a canvas whose flush fails goes to the back; the next one is announced (the re-audit N4)', async () => {
    const stuck = await presents.createPresent(owner, { source: canvas(`${tag} Stuck`, 'a') });
    const next = await presents.createPresent(owner, { source: canvas(`${tag} Next`, 'b') });
    await su`update presents set index_due_at = case node_id
      when ${stuck.id}::uuid then now() - interval '2 minutes'
      else now() - interval '1 minute' end
      where node_id in (${stuck.id}, ${next.id})`;
    const dueOf = async (id: string) =>
      (
        await admin<{ due: Date | string | null }[]>`
          select index_due_at as due from presents where node_id = ${id}`
      )[0]!.due;
    // A save holds the stuck canvas's row past the flush's lock wait.
    let release!: () => void;
    const held = new Promise<void>((r) => (release = r));
    let locked!: () => void;
    const isLocked = new Promise<void>((r) => (locked = r));
    const holder = admin.begin(async (tx) => {
      await tx`select 1 from presents where node_id = ${stuck.id} for update`;
      locked();
      await held;
    });
    await isLocked;
    const announced = await presents.flushDuePresentIndex(1).then(async (first) => {
      // One row a tick: the stuck one (oldest) fails and is passed over...
      expect(first).toBe(0);
      // ...so the next tick reaches the other.
      return presents.flushDuePresentIndex(1);
    });
    release();
    await holder;
    expect(announced).toBe(1);
    expect(await dueOf(next.id)).toBeNull();
    // The stuck one keeps its mark, passed over for a while, not lost.
    expect(await dueOf(stuck.id)).not.toBeNull();
    await presents.flushDuePresentIndex();
    expect(await dueOf(stuck.id)).not.toBeNull();
  }, 30_000);

  it('a poster is kept only at the rev it shows, and is no content change', async () => {
    const p = await presents.createPresent(owner, { source: canvas(`${tag} Poster`, 'one') });
    const png = Buffer.from([0x89, 0x50, 0x4e, 0x47, 1, 2, 3]);
    const work = async () =>
      (
        await admin<{ work: string | null; due: unknown }[]>`
          select n.data->>'index_work' as work, p.index_due_at as due
            from nodes n join presents p on p.node_id = n.id where n.id = ${p.id}`
      )[0]!;
    // The poster is read raw: nothing in the app reads it back yet.
    const poster = async () => {
      const [row] = await admin<{ png: Buffer | null; current: boolean }[]>`
        select poster_png as png, poster_rev = rev as current
          from presents where node_id = ${p.id}`;
      return row?.png ? { png: row.png, current: row.current } : null;
    };
    const before = await work();
    expect(await presents.setPresentPoster(owner, p.id, png, 1)).toBe(true);
    const got = await poster();
    expect(got?.current).toBe(true);
    expect(Buffer.compare(got!.png, png)).toBe(0);
    expect((await presents.getPresent(owner, p.id))?.hasPoster).toBe(true);
    // Nothing to index: the poster is a cache.
    expect(await work()).toEqual(before);

    // A save moves the rev on: the old poster is no longer current, and a
    // render of the old rev cannot stamp itself current.
    await presents.savePresentSource(owner, p.id, {
      source: canvas(`${tag} Poster`, 'two'),
      css: '',
    });
    expect((await poster())?.current).toBe(false);
    expect(await presents.setPresentPoster(owner, p.id, png, 1)).toBe(false);
    expect(await presents.setPresentPoster(owner, p.id, png, 2)).toBe(true);
    expect((await poster())?.current).toBe(true);

    // Another owner's canvas is not this owner's to stamp.
    expect(await presents.setPresentPoster(randomUUID(), p.id, png, 2)).toBe(false);
  });

  it('a name given by hand stays through saves that keep the head title', async () => {
    const p = await presents.createPresent(owner, { source: canvas(`${tag} Head`, 'one') });
    await presents.updatePresent(owner, p.id, { title: `${tag} By hand` });
    const kept = await presents.savePresentSource(owner, p.id, {
      source: canvas(`${tag} Head`, 'two'),
      css: '',
    });
    expect(kept.ok && kept.present.title).toBe(`${tag} By hand`);
    // A new <title> is a rename the canvas asks for.
    const renamed = await presents.savePresentSource(owner, p.id, {
      source: canvas(`${tag} New head`, 'two'),
      css: '',
    });
    expect(renamed.ok && renamed.present.title).toBe(`${tag} New head`);
  });

  it('reads back a kept version by rev', async () => {
    const p = await presents.createPresent(owner, { source: canvas(`${tag} Back`, 'first') });
    await presents.savePresentSource(owner, p.id, {
      source: canvas(`${tag} Back`, 'second'),
      css: '',
    });
    expect(await presents.getPresentRevisionSource(owner, p.id, 1)).toContain('first');
    expect(await presents.getPresentRevisionSource(owner, p.id, 9)).toBeNull();
    expect(await presents.getPresentRevisionSource(randomUUID(), p.id, 1)).toBeNull();
  });

  it('refuses a source over the size limit', async () => {
    const big = canvas(`${tag} Big`, 'x'.repeat(1_000_100));
    await expect(presents.createPresent(owner, { source: big })).rejects.toThrow(/over 1 MB/);
  });

  it('a delete takes the canvas, its sidecar and its versions', async () => {
    const p = await presents.createPresent(owner, { source: canvas(`${tag} Gone`, 'bye') });
    expect(await presents.deletePresent(owner, p.id)).toBe(true);
    const [left] = await admin<{ n: number }[]>`
      select (select count(*) from presents where node_id = ${p.id})
           + (select count(*) from present_revisions where node_id = ${p.id}) as n`;
    expect(Number(left!.n)).toBe(0);
    expect(await presents.getPresent(owner, p.id)).toBeNull();
  });

  it('on the runtime role (what a fresh box runs): creates, edits and deletes a canvas through the app pool', async () => {
    // The app's own pool, the one every write below goes through: under
    // `pnpm test:runtime-role` it logs in as mantle_runtime (arch A9),
    // which owns nothing and runs only its allowlist of functions.
    const [who] = await admin<{ user: string; su: boolean }[]>`
      select current_user::text as user, (select rolsuper from pg_roles where rolname = current_user) as su`;
    if (m.runtimeRoleOn()) expect(who).toEqual({ user: m.RUNTIME_ROLE, su: false });

    const p = await presents.createPresent(owner, { source: canvas(`${tag} Runtime`, 'one') });
    const saved = await presents.savePresentSource(owner, p.id, {
      source: canvas(`${tag} Runtime`, 'two'),
      css: '.p-6{padding:1.5rem}',
      ifRev: 1,
    });
    expect(saved.ok && saved.present.rev).toBe(2);
    await presents.updatePresent(owner, p.id, { title: `${tag} Runtime renamed` });
    const got = await presents.getPresent(owner, p.id);
    expect(got?.title).toBe(`${tag} Runtime renamed`);
    expect(got?.source).toContain('two');
    expect((await presents.listPresentRevisions(owner, p.id))?.map((r) => r.rev)).toEqual([2, 1]);

    expect(await presents.deletePresent(owner, p.id)).toBe(true);
    const [left] = await admin<{ n: number }[]>`
      select (select count(*) from nodes where id = ${p.id})
           + (select count(*) from presents where node_id = ${p.id})
           + (select count(*) from present_revisions where node_id = ${p.id}) as n`;
    expect(Number(left!.n)).toBe(0);
  });
});
