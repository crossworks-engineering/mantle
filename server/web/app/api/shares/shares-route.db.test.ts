/**
 * The share routes on the served list (workspaces plan 8.1, decision 12,
 * R7), through the real routes on a scratch brain the workspaces migration
 * made live (only the owner session is stood in; its actor varies):
 *
 *  - who may open, change or close a link: a user who may edit the item
 *    (`mayLink`); an item the caller cannot read is 404, one it reads but
 *    may not edit 403 `forbidden`;
 *  - POST { nodeId, serve } and PATCH { serve }: each id ADDED must be named
 *    or embedded by the item (a folder link: sit in the folder) and
 *    editable by the caller; an id the caller cannot read is 404; ids the
 *    link already serves are kept without a check; a refusal changes
 *    nothing;
 *  - DELETE: also an Admin user with the 'users' area, on any link;
 *  - a link changes no level and no grant (a frozen client item gets one
 *    like any other);
 *  - the 0262 fill: a live open link on an item frozen at client is retired
 *    and marked, every other live open link gets its list, once.
 *
 *   MANTLE_TEST_DATABASE_URL=postgres://… pnpm vitest run shares-route.db.test
 */
import { randomUUID } from 'node:crypto';
import { sql } from 'drizzle-orm';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import { appAnswerOf } from '@/server/test-support';

const URL = process.env.MANTLE_TEST_DATABASE_URL;

const h = vi.hoisted(() => ({ user: null as unknown }));

vi.mock('@/lib/auth', async (importOriginal) => ({
  ...(await importOriginal<Record<string, unknown>>()),
  getOwnerOr401: vi.fn(async () => h.user),
  // The reader a converted handler calls (A4 step 3b): the same stand-in.
  ownerCaller: vi.fn(() => h.user),
}));

type Json = Record<string, any>;

describe.skipIf(!URL)('the share routes on the served list', () => {
  type Ts = typeof import('@mantle/db/test-support');
  let scratch: Awaited<ReturnType<Ts['createMigratedScratchDatabase']>> | undefined;
  let m: typeof import('@mantle/db');
  let create: typeof import('./route');
  const owner = randomUUID(); // the anchor
  // A second admin login: a plain user (no Moderator) of Admin, P and Q,
  // in no way a user of R.
  const adm2 = randomUUID();
  const P = randomUUID();
  const Q = randomUUID();
  const R = randomUUID();
  const id = {
    page: randomUUID(),
    img: randomUUID(),
    stray: randomUUID(),
    pPage: randomUUID(), // homed in P
    pImg: randomUUID(), // homed in R, embedded in pPage
    rNote: randomUUID(), // homed in R
    folder: randomUUID(),
    inFolder: randomUUID(),
    outside: randomUUID(),
    client: randomUUID(), // frozen at client
    oldClient: randomUUID(), // frozen at client, an old live link
    oldPublic: randomUUID(), // frozen at public, an old link with no list
  };
  const folderPath = `files.sr_${owner.slice(0, 8)}`;

  const x = async <T>(q: ReturnType<typeof sql>): Promise<T[]> =>
    (await m.systemDb.execute(q)) as unknown as T[];
  /** A fixture write to the four workspace tables, as the superuser: the
   *  app pools only read them under the runtime role. */
  const su = async <T>(q: ReturnType<typeof sql>): Promise<T[]> =>
    (await import('@mantle/db/test-support')).superuserExec<T>(scratch!.url, q);
  const email = (who: string) => `w5b2b-${who}-${owner.slice(0, 8)}@example.invalid`;
  const as = (login: string) => {
    h.user = { id: owner, email: email('x'), actor: { id: login, email: email('x') } };
  };
  // The app's answer: a link refusal thrown by the route answers by its row
  // in the one table (A10 part 2 fix round 1, L7).
  const call = async (res: Response | Promise<Response>) => {
    const r = await appAnswerOf(res);
    return { status: r.status, body: (await r.json()) as Json };
  };
  const post = (body: unknown) =>
    call(
      create.POST(
        new Request('http://brain.test/api/shares', {
          method: 'POST',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify(body),
        }),
      ),
    );
  // A change or a close of a link asks its rule in the login's scope (plan
  // v3.2 S6 c2: shareItemRefusal, the gate's check before), so these go
  // through the full pipeline (runRoute): the gate enters the scope, as
  // for a client's request.
  const viaGate = async (method: string, shareId: string, body?: unknown) => {
    const { runRoute } = await import('@/server/run-route');
    const login = (h.user as { actor: { id: string } }).actor.id;
    const res = await runRoute(login, method, `/api/shares/${shareId}`, body);
    return { status: res.status, body: (await res.json()) as Json };
  };
  const patch = (shareId: string, body: unknown) => viaGate('PATCH', shareId, body);
  const del = (shareId: string) => viaGate('DELETE', shareId);
  const servedOf = async (nodeId: string) =>
    (
      await x<{ s: unknown }>(sql`select settings->'served' as s from shares
        where node_id = ${nodeId} and revoked_at is null and contact_id is null`)
    )[0]?.s;
  const levelOf = async (nodeId: string) =>
    (await x<{ a: string }>(sql`select audience::text as a from nodes where id = ${nodeId}`))[0]!.a;
  const node = async (nid: string, type: string, title: string, path: string, audience = 'admin') =>
    x(sql`insert into nodes (id, owner_id, type, title, path, audience, data)
          values (${nid}, ${owner}, ${type}::node_type, ${title}, ${path}::ltree, ${audience}, '{}'::jsonb)`);
  /** Home `nid` in workspace `ws` by hand (setup only). */
  const homeIn = async (nid: string, ws: string) => {
    await m.withHeads([nid], 'update', async (tx) => {
      await tx.execute(sql`delete from item_grants where node_id = ${nid}`);
      await tx.execute(sql`insert into item_grants (node_id, workspace_id, is_home)
                           values (${nid}, ${ws}, true)
                           on conflict (node_id, workspace_id)
                           do update set is_home = true, via_folder_id = null, excluded = false`);
    });
  };
  const grant = async (nid: string, ws: string, write: boolean) => {
    await m.withHeads([nid], 'update', async (tx) => {
      await tx.execute(sql`insert into item_grants (node_id, workspace_id, write)
                           values (${nid}, ${ws}, ${write})
                           on conflict (node_id, workspace_id) do update set write = ${write}`);
    });
  };

  beforeAll(async () => {
    const ts: Ts = await import('@mantle/db/test-support');
    scratch = await ts.createMigratedScratchDatabase(URL!);
    process.env.DATABASE_URL = scratch.url;
    process.env.MANTLE_MASTER_KEY ??= 'mantle-viewer-test-key';
    m = await import('@mantle/db');
    create = await import('./route');
    await x(sql`insert into auth.users (id, email, password_hash, is_owner, role, display_name) values
      (${owner}, ${email('owner')}, 'x', true, 'admin', 'Olive Owner'),
      (${adm2}, ${email('adm2')}, 'x', false, 'admin', 'Ada Admin')`);
    await x(sql`insert into spaces (id, kind, login_id) values (${owner}, 'brain', ${owner})
      on conflict (id) do nothing`);
    await (await import('@mantle/db/test-support')).runWorkspacesSwitch();
    // Links made before W5b2: no list yet (the fill test below).
    await node(id.oldClient, 'note', 'old client note', 'notes', 'client');
    await node(id.oldPublic, 'note', 'old public note', 'notes', 'public');
    await x(sql`insert into shares (owner_id, node_id, node_type, token) values
      (${owner}, ${id.oldClient}, 'note', ${`${owner}-oc`}),
      (${owner}, ${id.oldPublic}, 'note', ${`${owner}-op`})`);
    await su(sql`insert into workspaces (id, owner_id, name) values
      (${P}, ${owner}, 'Proj'), (${Q}, ${owner}, 'Quay'), (${R}, ${owner}, 'Reef')`);
    await su(sql`insert into workspace_users (workspace_id, login_id, moderator) values
      (${P}, ${owner}, true), (${P}, ${adm2}, false),
      (${Q}, ${owner}, true), (${Q}, ${adm2}, false), (${R}, ${owner}, true)`);
    // adm2 in Admin, as a plain user (the migration may have made it one).
    await su(sql`insert into workspace_users (workspace_id, login_id, moderator)
                select id, ${adm2}, false from workspaces where owner_id = ${owner} and is_admin
                on conflict (workspace_id, login_id) do update set moderator = false`);

    await node(id.page, 'page', 'A page', 'pages');
    await node(id.img, 'file', 'img.png', 'files');
    await node(id.stray, 'file', 'stray.png', 'files');
    await node(id.pPage, 'page', 'A P page', 'pages');
    await node(id.pImg, 'file', 'p-img.png', 'files');
    await node(id.folder, 'branch', 'shared', folderPath);
    await node(id.inFolder, 'file', 'in.txt', folderPath);
    await node(id.outside, 'file', 'out.txt', 'files');
    await node(id.client, 'note', 'client note', 'notes', 'client');
    const docOf = (img: string) =>
      JSON.stringify({ type: 'doc', content: [{ type: 'image', attrs: { nodeId: img } }] });
    await x(sql`insert into pages (node_id, doc, doc_text) values
      (${id.page}, ${docOf(id.img)}::jsonb, ''), (${id.pPage}, ${docOf(id.pImg)}::jsonb, '')`);
    await node(id.rNote, 'note', 'An R note', 'notes');
    await homeIn(id.pPage, P);
    await homeIn(id.pImg, R);
    await homeIn(id.rNote, R);
  }, 180_000);

  afterAll(async () => {
    await m?.closeDb();
    await scratch?.drop();
  });

  it('0262: retires a live link on a client item, gives the others their list, once', async () => {
    // The 0262 fill, as the migration ran it: as the superuser (the runtime
    // role, arch A9, may not run it; the app never calls it).
    const steps = await (
      await import('@mantle/db/test-support')
    ).superuserExec<{ step: string; n: number }>(
      scratch!.url,
      'select * from mantle_link_served_fill()',
    );
    expect(steps.map((s) => [s.step, Number(s.n)])).toEqual([
      ['open links on client items, retired', 1],
      ['open links given a served list', 1],
    ]);
    const [oc] = await x<{ revoked: boolean; retired: string | null }>(sql`
      select revoked_at is not null as revoked, settings->>'retired' as retired
        from shares where node_id = ${id.oldClient}`);
    expect(oc).toEqual({ revoked: true, retired: 'client' });
    expect(await servedOf(id.oldPublic)).toEqual([]);
    const again = await (
      await import('@mantle/db/test-support')
    ).superuserExec<{ n: number }>(scratch!.url, 'select * from mantle_link_served_fill()');
    expect(again.map((s) => Number(s.n))).toEqual([0, 0]);
  });

  it('POST opens a link with its list; a link changes no level', async () => {
    as(owner);
    const before = await levelOf(id.page);
    const res = await post({ nodeId: id.page, serve: [id.img] });
    expect(res.status).toBe(200);
    expect(res.body.share).toMatchObject({ mode: 'public', served: [id.img] });
    expect(res.body.share.path).toMatch(/^\/s\//);
    expect(res.body).not.toHaveProperty('alsoLowered');
    expect(await levelOf(id.page)).toBe(before);
    expect(await levelOf(id.img)).toBe('admin');
    // Idempotent: the same link, the list untouched without `serve`.
    const again = await post({ nodeId: id.page });
    expect(again.body.share.id).toBe(res.body.share.id);
    expect(again.body.share.served).toEqual([id.img]);
  });

  it('POST refuses a serve id the item does not embed (403) or the caller cannot read (404), changing nothing', async () => {
    as(owner);
    const stray = await post({ nodeId: id.page, serve: [id.img, id.stray] });
    expect(stray.status).toBe(403);
    expect(stray.body.code).toBe('forbidden');
    const ghost = await post({ nodeId: id.page, serve: [randomUUID()] });
    expect(ghost.status).toBe(404);
    expect(ghost.body.code).toBe('not_found');
    expect(await servedOf(id.page)).toEqual([id.img]);
  });

  it('a frozen client item gets a link like any other; nothing about levels', async () => {
    as(owner);
    const res = await post({ nodeId: id.client });
    expect(res.status).toBe(200);
    expect(await levelOf(id.client)).toBe('client');
  });

  it('who may link: 404 for an item the caller cannot read, 403 for one it may not edit', async () => {
    as(adm2);
    // Homed in R: adm2 is in no workspace that reads it.
    const ghost = await post({ nodeId: id.rNote });
    expect(ghost.status).toBe(404);
    expect(ghost.body.code).toBe('not_found');
    // Homed in Admin, where adm2 is a plain user: reads, may not edit.
    expect((await post({ nodeId: id.page })).status).toBe(403);
    // Homed in P, where adm2 is a plain user too.
    const ro = await post({ nodeId: id.pPage });
    expect(ro.status).toBe(403);
    expect(ro.body.code).toBe('forbidden');
    // A Write grant to Q (adm2 is a plain user there too) lets adm2 edit
    // it, so link it.
    await grant(id.pPage, Q, true);
    const rw = await post({ nodeId: id.pPage });
    expect(rw.status).toBe(200);
    // The image it embeds is homed in R: adm2 cannot read it, so 404.
    expect((await post({ nodeId: id.pPage, serve: [id.pImg] })).status).toBe(404);
    // Read only in Q: 403. Written in Q: served.
    await grant(id.pImg, Q, false);
    expect((await post({ nodeId: id.pPage, serve: [id.pImg] })).status).toBe(403);
    await grant(id.pImg, Q, true);
    const ok = await post({ nodeId: id.pPage, serve: [id.pImg] });
    expect(ok.status).toBe(200);
    expect(ok.body.share.served).toEqual([id.pImg]);
  });

  it('PATCH replaces the list; kept ids are not checked again, added ones are', async () => {
    as(owner);
    const link = (await post({ nodeId: id.page })).body.share as Json;
    // An id the item does not embed, already on the list (as 0262 may leave
    // one): kept without a check.
    await x(sql`update shares set settings = jsonb_build_object('served', jsonb_build_array(${id.img}::text, ${id.stray}::text))
                 where id = ${link.id}`);
    const keep = await patch(link.id, { serve: [id.stray] });
    expect(keep.status).toBe(200);
    expect(keep.body).toEqual({ ok: true, served: [id.stray] });
    // Adding it back after it left is adding: refused.
    await patch(link.id, { serve: [] });
    expect((await patch(link.id, { serve: [id.stray] })).status).toBe(403);
    expect((await patch(link.id, { serve: [id.img] })).body.served).toEqual([id.img]);
    // The item itself never goes on its own list.
    expect((await patch(link.id, { serve: [id.page, id.img] })).body.served).toEqual([id.img]);
    // Not a link of this brain, or not a uuid list: refused.
    expect((await patch(randomUUID(), { serve: [] })).status).toBe(404);
    expect((await patch(link.id, { serve: ['nope'] })).status).toBe(400);
  });

  it('a folder link serves only what sits in the folder', async () => {
    as(owner);
    const ok = await post({ nodeId: id.folder, serve: [id.inFolder] });
    expect(ok.status).toBe(200);
    const out = await patch(ok.body.share.id, { serve: [id.inFolder, id.outside] });
    expect(out.status).toBe(403);
    expect(out.body.error).toMatch(/inside the folder/);
  });

  const adm2Areas = (areas: Record<string, boolean>) =>
    su(sql`update workspace_users set limits = ${JSON.stringify({ areas })}::jsonb
           where login_id = ${adm2}
             and workspace_id = (select id from workspaces where owner_id = ${owner} and is_admin)`);

  it('DELETE: only someone who may edit the item closes its link; a second close is ok false', async () => {
    as(owner);
    const link = (await post({ nodeId: id.page })).body.share as Json;
    // adm2 reads it (a user of Admin) but may not edit it, and its limits
    // switch the users area off.
    await adm2Areas({ users: false });
    try {
      as(adm2);
      expect((await del(link.id)).status).toBe(403);
    } finally {
      await adm2Areas({});
    }
    as(owner);
    const before = await levelOf(id.page);
    expect(await del(link.id)).toEqual({ status: 200, body: { ok: true } });
    expect(await del(link.id)).toEqual({ status: 200, body: { ok: false } });
    expect(await levelOf(id.page)).toBe(before);
  });

  it('DELETE: an Admin user with the users area revokes any link, even one it cannot read', async () => {
    as(owner);
    // Homed in R: adm2 reads it nowhere (it may not link it: 404).
    const link = (await post({ nodeId: id.rNote })).body.share as Json;
    await adm2Areas({ users: false });
    try {
      as(adm2);
      const refused = await del(link.id);
      // The gate's 404 on main, now the handler's (shareItemRefusal).
      expect(refused).toEqual({ status: 404, body: { ok: false, error: 'not found' } });
    } finally {
      await adm2Areas({});
    }
    as(adm2);
    expect(await del(link.id)).toEqual({ status: 200, body: { ok: true } });
    const [row] = await x<{ revoked: boolean }>(
      sql`select revoked_at is not null as revoked from shares where id = ${link.id}`,
    );
    expect(row?.revoked).toBe(true);
    // Another area does not stand in for it.
    as(owner);
    const again = (await post({ nodeId: id.page })).body.share as Json;
    await adm2Areas({ users: false, settings: true });
    try {
      as(adm2);
      expect((await del(again.id)).status).toBe(403);
    } finally {
      await adm2Areas({});
    }
    as(owner);
    expect((await del(again.id)).body).toEqual({ ok: true });
  });
});
