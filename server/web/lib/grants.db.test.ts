/**
 * The Grant Access panel's API (W5b2 part A), through the real routes on a
 * scratch brain the workspaces migration made live (the session is stood
 * in). The level bridge is off (0261): grants are the only truth.
 *
 *  - reading: 404 for an item or workspace the caller may not see (never
 *    403); rows of other workspaces only for an Admin user or a manager;
 *    the home's name hidden from a non-user of it;
 *  - the rows of items made today are plain grants, free to change; the
 *    levels are frozen;
 *  - who may grant: home Moderator AND target Moderator to add, restore,
 *    hand and switch Write on; either one to remove and switch Write off;
 *    the home row is never removed; an Admin-only kind stays in Admin;
 *  - folders: the confirm, the preview counts, derived rows, "Removed
 *    here" and Restore, "Change here", the size limit;
 *  - apps: a new holder needs the confirm; the preview's app counts;
 *  - moves: home to home (the derived row made the home loses its folder
 *    mark, the old folder logged), keep readable, the preview; items into
 *    a folder (S6), with the confirm;
 *  - embeds: "Grant these too", and the pairs skipped;
 *  - every write took its heads first (no new heads_check_misses).
 *
 *   MANTLE_TEST_DATABASE_URL=postgres://… pnpm vitest run server/web/lib/grants.db.test.ts
 */
import { randomUUID } from 'node:crypto';
import { sql } from 'drizzle-orm';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';

const URL = process.env.MANTLE_TEST_DATABASE_URL;

const h = vi.hoisted(() => ({ res: null as unknown }));

vi.mock('@/lib/auth', async (importOriginal) => ({
  ...(await importOriginal<Record<string, unknown>>()),
  getLoginOr401: vi.fn(async () => h.res),
}));
vi.mock('@/lib/audit', () => ({
  auditFireAndForget: () => undefined,
  requestMetaFrom: () => ({}),
  requestMeta: async () => ({ ip: null, userAgent: null }),
}));

type Json = Record<string, any>;

describe.skipIf(!URL)('grants (W5b2 part A)', () => {
  type Ts = typeof import('@mantle/db/test-support');
  let scratch: Awaited<ReturnType<Ts['createMigratedScratchDatabase']>> | undefined;
  let m: typeof import('@mantle/db');
  let g: typeof import('@/lib/grants');
  const owner = randomUUID(); // the anchor, an admin
  const mem = randomUUID(); // a member: Moderator of P, plain user of Q
  const mem2 = randomUUID(); // a member: Moderator of Q and R
  const mem3 = randomUUID(); // a member in no workspace of ours
  let admin = '';
  let team = '';
  const P = randomUUID();
  const Q = randomUUID();
  const R = randomUUID();

  const x = async <T>(q: ReturnType<typeof sql>): Promise<T[]> =>
    (await m.systemDb.execute(q)) as unknown as T[];
  const email = (id: string, who: string) => `w5b2-${who}-${id.slice(0, 8)}@example.invalid`;

  const as = async (id: string) => {
    const [r] = await x<{ role: string; email: string }>(
      sql`select role, email from auth.users where id = ${id}`,
    );
    const user = {
      id: owner,
      email: r!.email,
      actor: { id, email: r!.email, displayName: null, isOwner: id === owner },
    };
    h.res =
      r!.role === 'admin'
        ? { kind: 'admin', loginId: id, email: r!.email, user }
        : { kind: 'member', loginId: id, email: r!.email, member: { anchorId: owner } };
  };
  const req = (method: string, body?: unknown, q = '') =>
    new Request(`http://x/api/grants${q}`, {
      method,
      headers: { 'content-type': 'application/json' },
      ...(body === undefined ? {} : { body: JSON.stringify(body) }),
    });
  const call = async (res: Response | Promise<Response>) => {
    const r = await res;
    return { status: r.status, body: (await r.json()) as Json };
  };
  const p = <T extends Json>(v: T) => ({ params: Promise.resolve(v) });

  const routes = async () => ({
    one: await import('@/app/api/grants/[nodeId]/route'),
    row: await import('@/app/api/grants/[nodeId]/[wsId]/route'),
    restore: await import('@/app/api/grants/[nodeId]/[wsId]/restore/route'),
    hand: await import('@/app/api/grants/[nodeId]/[wsId]/hand/route'),
    embeds: await import('@/app/api/grants/[nodeId]/embeds/route'),
    preview: await import('@/app/api/grants/[nodeId]/preview/route'),
    move: await import('@/app/api/grants/move/route'),
    movePreview: await import('@/app/api/grants/move/preview/route'),
  });
  let r: Awaited<ReturnType<typeof routes>>;

  const get = (id: string) => call(r.one.GET(req('GET'), p({ nodeId: id })));
  const add = (id: string, wsId: string, more: Json = {}) =>
    call(r.one.POST(req('POST', { wsId, ...more }), p({ nodeId: id })));
  const patch = (id: string, wsId: string, write: boolean, confirm?: boolean) =>
    call(r.row.PATCH(req('PATCH', { write, confirm }), p({ nodeId: id, wsId })));
  const del = (id: string, wsId: string, confirm = false) =>
    call(
      r.row.DELETE(req('DELETE', undefined, confirm ? '?confirm=1' : ''), p({ nodeId: id, wsId })),
    );
  const restore = (id: string, wsId: string, confirm = false) =>
    call(
      r.restore.POST(req('POST', undefined, confirm ? '?confirm=1' : ''), p({ nodeId: id, wsId })),
    );
  const hand = (id: string, wsId: string) =>
    call(r.hand.POST(req('POST'), p({ nodeId: id, wsId })));
  const preview = (id: string, q: string) =>
    call(r.preview.GET(req('GET', undefined, `?${q}`), p({ nodeId: id })));

  /** The item's grant rows, straight from the table. */
  const rowsOf = async (id: string) =>
    x<{ ws: string; write: boolean; is_home: boolean; via: string | null; excluded: boolean }>(
      sql`select workspace_id::text as ws, write, is_home, via_folder_id::text as via, excluded
            from item_grants where node_id = ${id} order by workspace_id`,
    );
  const readWs = async (id: string) =>
    (await x<{ r: string[] }>(sql`select read_ws::text[] as r from nodes where id = ${id}`))[0]!.r;
  const misses = async () =>
    (await x<{ n: number }>(sql`select count(*)::int as n from heads_check_misses`))[0]!.n;

  /** A node the brain makes (homed in Admin by default, 0261). */
  const node = async (type: string, title: string, path: string, id = randomUUID()) => {
    await x(sql`insert into nodes (id, owner_id, type, title, path)
                values (${id}, ${owner}, ${type}::node_type, ${title}, ${path}::ltree)`);
    return id;
  };
  /** Home `id` in workspace `ws` by hand (an item that was moved there).
   *  Setup only. */
  const homeIn = async (id: string, ws: string) => {
    await m.withHeads([id], 'update', async (tx) => {
      await tx.execute(sql`delete from item_grants where node_id = ${id}`);
      // The delete re-derives the item from its folder: take that row over.
      await tx.execute(sql`insert into item_grants (node_id, workspace_id, is_home)
                           values (${id}, ${ws}, true)
                           on conflict (node_id, workspace_id)
                           do update set is_home = true, via_folder_id = null, excluded = false`);
    });
  };

  beforeAll(async () => {
    const ts: Ts = await import('@mantle/db/test-support');
    scratch = await ts.createMigratedScratchDatabase(URL!);
    process.env.DATABASE_URL = scratch.url;
    process.env.MANTLE_MASTER_KEY ??= 'mantle-viewer-test-key';
    process.env.SESSION_SECRET ??= 'grants-db-test-secret-at-least-32-characters';
    m = await import('@mantle/db');
    g = await import('@/lib/grants');
    await x(sql`insert into auth.users (id, email, password_hash, is_owner, role, display_name) values
      (${owner}, ${email(owner, 'owner')}, 'x', true, 'admin', 'Olive Owner'),
      (${mem}, ${email(mem, 'mem')}, 'x', false, 'member', 'Mia Member'),
      (${mem2}, ${email(mem2, 'mem')}, 'x', false, 'member', 'Max Member'),
      (${mem3}, ${email(mem3, 'mem')}, 'x', false, 'member', 'Moe Member')`);
    await x(sql`insert into spaces (id, kind, login_id) values (${owner}, 'brain', ${owner})
      on conflict (id) do nothing`);
    await x(sql`select * from mantle_ws_migrate()`);
    const ws = await x<{ id: string; key: string }>(sql`
      select id::text as id, (case when is_admin then 'admin' when name = 'Team' then 'team' end) as key from workspaces where owner_id = ${owner}`);
    team = ws.find((w) => w.key === 'team')!.id;
    admin = ws.find((w) => w.key === 'admin')!.id;
    await x(sql`insert into workspaces (id, owner_id, name) values
      (${P}, ${owner}, 'Proj'), (${Q}, ${owner}, 'Quay'), (${R}, ${owner}, 'Reef')`);
    await x(sql`insert into workspace_users (workspace_id, login_id, moderator) values
      (${P}, ${owner}, true), (${P}, ${mem}, true),
      (${Q}, ${owner}, true), (${Q}, ${mem2}, true), (${Q}, ${mem}, false),
      (${R}, ${mem2}, true)`);
    r = await routes();
  }, 180_000);

  afterAll(async () => {
    await m?.closeDb();
    await scratch?.drop();
  });

  it('reads: 404 never 403; rows by who may see them; a new item has its home only', async () => {
    const note = await node('note', 'a new note', 'notes');
    await as(owner);
    const own = await get(note);
    expect(own.status).toBe(200);
    expect(own.body.home).toEqual({ wsId: admin, name: 'Admin' });
    expect(own.body.mayManage).toBe(true);
    // The default home and nothing else: no Team row, decided or not.
    expect(own.body.rows.map((x: Json) => [x.wsId, x.isHome])).toEqual([[admin, true]]);
    expect(await rowsOf(note)).toEqual([
      { ws: admin, write: false, is_home: true, via: null, excluded: false },
    ]);
    // Addable: every Moderator workspace of the owner it is not in, Team
    // included.
    expect(own.body.addable.map((w: Json) => w.name)).toEqual(['Proj', 'Quay', 'Team']);
    expect(own.body.item).toEqual({ id: note, title: 'a new note', type: 'note' });
    expect(own.body.hasLink).toBe(false);
    expect(own.body.link).toBeNull();

    // A member reads nothing of an Admin-only item: 404, as for a missing
    // one and a bad id.
    await as(mem);
    expect((await get(note)).status).toBe(404);
    expect((await get(randomUUID())).status).toBe(404);
    expect((await get('nope')).status).toBe(404);
    expect((await add(note, P)).status).toBe(404);
    expect((await del(note, admin)).status).toBe(404);

    // A P-homed item granted to Q: mem2 (Q only) sees its Q row, not P's
    // row, and not the home's name.
    const pnote = await node('note', 'a P note', 'notes');
    await homeIn(pnote, P);
    await as(owner);
    expect((await add(pnote, Q)).status).toBe(200);
    await as(mem2);
    const q = await get(pnote);
    expect(q.status).toBe(200);
    // A home the caller may not name is not identified either (audit L4).
    expect(q.body.home).toEqual({ wsId: null, name: null });
    expect(q.body.rows.map((x: Json) => x.wsId)).toEqual([Q]);
    expect(q.body.mayManage).toBe(false);
    expect(q.body.addable).toEqual([]);
    // A workspace mem2 is not in answers 404 there.
    expect((await patch(pnote, P, true)).status).toBe(404);
  });

  it('rows of items made today are plain grants: Team added, Write, removed, home moved', async () => {
    const page = await node('page', 'a page', 'pages');
    // The levels are frozen: grants decide.
    await expect(
      x(sql`update nodes set audience = 'team' where id = ${page}`),
    ).rejects.toMatchObject({ cause: { code: '55000' } });
    expect((await rowsOf(page)).map((x) => x.ws)).toEqual([admin]);
    await as(owner);
    const before = await misses();
    expect((await add(page, team)).status).toBe(200);
    expect((await readWs(page)).sort()).toEqual([admin, team].sort());
    expect((await patch(page, team, true)).status).toBe(200);
    expect((await rowsOf(page)).find((x) => x.ws === team)).toMatchObject({
      write: true,
      is_home: false,
    });
    expect((await del(page, team)).status).toBe(200);
    expect(await readWs(page)).toEqual([admin]);
    // No row the panel cannot change.
    expect(
      (await x<{ n: number }>(sql`select count(*)::int as n from item_grants where bridge`))[0]!.n,
    ).toBe(0);
    // The home moves like any other.
    const moved = await call(r.move.POST(req('POST', { nodeIds: [page], toWorkspaceId: P })));
    expect(moved.body).toMatchObject({ moved: 1, failed: [] });
    expect((await rowsOf(page)).find((x) => x.is_home)!.ws).toBe(P);
    expect(await misses()).toBe(before);
  });

  it('who may: add and Write on need both Moderators; remove and Write off either', async () => {
    const it1 = await node('note', 'rules', 'notes');
    await homeIn(it1, P);
    const before = await misses();
    // mem moderates P (the home) but is a plain user of Q: no add there.
    await as(mem);
    expect((await add(it1, Q)).body.code).toBe('forbidden');
    // R: mem is not in it, and is not an Admin user: 404.
    expect((await add(it1, R)).status).toBe(404);
    // mem2 moderates Q but not the home: no add.
    await as(mem2);
    expect((await get(it1)).status).toBe(404);
    // The owner moderates both.
    await as(owner);
    const added = await add(it1, Q);
    expect(added.status).toBe(200);
    expect(added.body.rows.map((x: Json) => x.name)).toEqual(['Proj', 'Quay']);
    expect((await add(it1, Q)).body.code).toBe('already_granted');
    // Write on: mem (home Moderator only) may not; the owner may.
    await as(mem);
    expect((await patch(it1, Q, true)).body.code).toBe('forbidden');
    await as(owner);
    expect((await patch(it1, Q, true)).status).toBe(200);
    // Write off: either Moderator.
    await as(mem2);
    expect((await patch(it1, Q, false)).status).toBe(200);
    // The home's own Write: the home Moderator.
    await as(mem);
    expect((await patch(it1, P, true)).status).toBe(200);
    expect((await rowsOf(it1)).find((x) => x.ws === P)!.write).toBe(true);
    // The home row is never removed.
    expect((await del(it1, P)).body.code).toBe('home_row');
    // mem2 (Moderator of Q only) removes it from Q, and then no longer
    // reads it.
    await as(mem2);
    expect(await del(it1, Q)).toEqual({ status: 200, body: { visible: false } });
    expect((await rowsOf(it1)).map((x) => x.ws)).toEqual([P]);
    expect((await del(it1, Q)).status).toBe(404);
    // An Admin-only kind stays in Admin.
    const contact = await node('contact', 'Someone', 'contacts');
    await as(owner);
    expect((await add(contact, P)).body.code).toBe('kind_not_allowed');
    expect(await misses()).toBe(before);
    // Every change is logged on the workspace it touched.
    const ev = await x<{ action: string }>(
      sql`select action from workspace_events
           where workspace_id = ${Q} and subject->>'node' = ${it1} order by at`,
    );
    expect(ev.map((e) => e.action)).toEqual([
      'grant.add',
      'grant.write',
      'grant.write',
      'grant.remove',
    ]);
  });

  it('folders: confirm, preview, derived rows, Removed here, Restore, Change here', async () => {
    const F = await node('branch', 'F', 'notes.f1');
    const G = await node('branch', 'G', 'notes.f1.g1');
    const c1 = await node('note', 'c1', 'notes.f1');
    const c2 = await node('note', 'c2', 'notes.f1');
    const c3 = await node('note', 'c3', 'notes.f1.g1');
    for (const id of [F, G, c1, c2, c3]) await homeIn(id, P);
    const before = await misses();
    await as(owner);
    // The preview: F and the four items inside it gain Q.
    const pv = await preview(F, `add=${Q}`);
    expect(pv.body).toEqual({ gain: 5, gainApps: 0, lose: 0, total: 5, hidden: 0, tooBig: false });
    // No confirm: refused, nothing written.
    expect((await add(F, Q)).body.code).toBe('confirm_required');
    expect(await rowsOf(c1)).toHaveLength(1);
    expect((await add(F, Q, { confirm: true })).status).toBe(200);
    for (const [id, via] of [
      [G, F],
      [c1, F],
      [c2, F],
      [c3, G],
    ] as const) {
      expect((await rowsOf(id)).find((x) => x.ws === Q)!.via).toBe(via);
    }
    // c1's panel: via folder F.
    const c1p = await get(c1);
    expect(c1p.body.rows.find((x: Json) => x.wsId === Q).viaFolder).toEqual({ id: F, title: 'F' });
    // A derived row: PATCH says derived_row; DELETE writes "Removed here".
    expect((await patch(c1, Q, true)).body.code).toBe('derived_row');
    const rm = await del(c1, Q);
    expect(rm.status).toBe(200);
    expect(rm.body.rows.find((x: Json) => x.wsId === Q)).toMatchObject({
      excluded: true,
      viaFolder: { id: F, title: 'F' },
    });
    expect(await readWs(c1)).toEqual([P]);
    // Restore: the folder's row comes back.
    expect((await restore(c1, Q)).status).toBe(200);
    expect((await rowsOf(c1)).find((x) => x.ws === Q)).toMatchObject({ via: F, excluded: false });
    expect((await restore(c1, Q)).body.code).toBe('not_excluded');
    // Change here: c2's row becomes its own.
    expect((await hand(c2, Q)).status).toBe(200);
    expect((await rowsOf(c2)).find((x) => x.ws === Q)!.via).toBeNull();
    expect((await hand(c2, Q)).body.code).toBe('not_derived');
    // Remove Q from F: F, G, c1 and c3 lose it; c2 keeps its own.
    expect((await preview(F, `remove=${Q}`)).body).toMatchObject({ gain: 0, lose: 4 });
    expect((await del(F, Q)).body.code).toBe('confirm_required');
    expect((await del(F, Q, true)).status).toBe(200);
    for (const id of [F, G, c1, c3]) expect(await readWs(id)).toEqual([P]);
    expect((await readWs(c2)).sort()).toEqual([P, Q].sort());
    // A hand row whose folder still grants: removing it writes "Removed
    // here", else the folder would bring it straight back.
    // R: the owner sees it (an Admin user) but does not moderate it.
    expect((await add(F, R, { confirm: true })).body.code).toBe('forbidden');
    expect((await add(F, Q, { confirm: true })).status).toBe(200);
    expect((await del(c2, Q)).status).toBe(200);
    expect((await rowsOf(c2)).find((x) => x.ws === Q)!.excluded).toBe(true);
    expect(await misses()).toBe(before);
  });

  it('folders: the size limit', async () => {
    const big = await node('branch', 'Big', 'notes.big');
    await node('note', 'b1', 'notes.big');
    await node('note', 'b2', 'notes.big');
    await homeIn(big, P);
    await as(owner);
    g.FOLDER_GRANT_LIMIT.max = 2;
    try {
      expect((await preview(big, `add=${Q}`)).body.tooBig).toBe(true);
      expect((await add(big, Q, { confirm: true })).body.code).toBe('too_big');
    } finally {
      g.FOLDER_GRANT_LIMIT.max = 50_000;
    }
    expect((await rowsOf(big)).map((x) => x.ws)).toEqual([P]);
  });

  it('apps: a new holder needs the confirm; the preview counts what it would see', async () => {
    const app = await node('app', 'An app', 'apps');
    await x(sql`insert into apps (node_id) values (${app})`);
    await homeIn(app, P);
    await as(owner);
    const pv = await preview(app, `add=${Q}`);
    expect(pv.body).toEqual({
      gain: 1,
      gainApps: 1,
      lose: 0,
      total: 1,
      hidden: 0,
      tooBig: false,
      app: { rows: null, exportedTables: 0 },
    });
    expect((await add(app, Q)).body.code).toBe('confirm_required');
    const ok = await add(app, Q, { confirm: true });
    expect(ok.status).toBe(200);
    expect(ok.body.app).toEqual({ mcpAccess: false });
  });

  it('move home to home: the folder mark goes, the old folder is logged; keep readable', async () => {
    const F = await node('branch', 'MF', 'notes.mf');
    const item = await node('note', 'mover', 'notes.mf');
    await homeIn(F, P);
    await homeIn(item, P);
    await as(owner);
    expect((await add(F, Q, { confirm: true })).status).toBe(200);
    expect((await rowsOf(item)).find((x) => x.ws === Q)!.via).toBe(F);
    const pv = await call(r.movePreview.POST(req('POST', { nodeIds: [item], toWorkspaceId: Q })));
    // F still gives P (its home row passes as a plain grant, S6): P stays.
    expect(pv.body).toEqual({ alsoVisibleTo: [], removedFrom: [] });
    // mem moderates P but not Q.
    await as(mem);
    expect(
      (await call(r.move.POST(req('POST', { nodeIds: [item], toWorkspaceId: Q })))).body.code,
    ).toBe('forbidden');
    await as(owner);
    const before = await misses();
    const done = await call(r.move.POST(req('POST', { nodeIds: [item], toWorkspaceId: Q })));
    expect(done.body).toEqual({ moved: 1, failed: [] });
    // Q's derived row became the home: no folder mark (the CHECK).
    const after = await rowsOf(item);
    expect(after.find((x) => x.ws === Q)).toEqual({
      ws: Q,
      write: false,
      is_home: true,
      via: null,
      excluded: false,
    });
    expect(after.find((x) => x.ws === P)).toMatchObject({ is_home: false, via: F });
    const ev = await x<{ subject: Json }>(
      sql`select subject from workspace_events
           where workspace_id = ${Q} and action = 'grant.move' and subject->>'node' = ${item}`,
    );
    expect(ev[0]!.subject).toMatchObject({ from: P, to: Q, viaFolder: F });
    expect(
      (await call(r.move.POST(req('POST', { nodeIds: [item], toWorkspaceId: Q })))).body,
    ).toMatchObject({ moved: 0 });
    // Back to P, keeping it readable in Q.
    const back = await call(
      r.move.POST(req('POST', { nodeIds: [item], toWorkspaceId: P, keepReadableIn: Q })),
    );
    expect(back.body).toEqual({ moved: 1, failed: [] });
    const kept = await rowsOf(item);
    expect(kept.find((x) => x.ws === P)).toMatchObject({ is_home: true, via: null });
    expect(kept.find((x) => x.ws === Q)).toMatchObject({ is_home: false, via: null, write: false });
    // A home kept elsewhere than the old home is refused.
    expect(
      (
        await call(
          r.move.POST(req('POST', { nodeIds: [item], toWorkspaceId: Q, keepReadableIn: R })),
        )
      ).body.failed,
    ).toHaveLength(1);
    expect(await misses()).toBe(before);
  });

  it('move into a folder: edit the folder, manage the item, confirm what it adds (S6)', async () => {
    const F = await node('branch', 'SF', 'notes.sf');
    const item = await node('note', 'placed', 'notes');
    await homeIn(F, P);
    await homeIn(item, P);
    await as(owner);
    expect((await add(F, Q, { confirm: true })).status).toBe(200);
    const pv = await call(r.movePreview.POST(req('POST', { nodeIds: [item], toFolderId: F })));
    expect(pv.body).toEqual({ alsoVisibleTo: [{ wsId: Q, name: 'Quay' }], removedFrom: [] });
    // mem2 can edit nothing of P: the item is not even visible.
    await as(mem2);
    expect((await call(r.move.POST(req('POST', { nodeIds: [item], toFolderId: F })))).status).toBe(
      404,
    );
    await as(mem);
    expect(
      (await call(r.move.POST(req('POST', { nodeIds: [item], toFolderId: F })))).body.code,
    ).toBe('confirm_required');
    const done = await call(
      r.move.POST(req('POST', { nodeIds: [item], toFolderId: F, confirm: true })),
    );
    expect(done.body).toEqual({ moved: 1, failed: [] });
    expect((await rowsOf(item)).find((x) => x.ws === Q)!.via).toBe(F);
    // Mixed kinds and folders are refused.
    const pg = await node('page', 'a page', 'pages');
    await homeIn(pg, P);
    expect(
      (await call(r.move.POST(req('POST', { nodeIds: [item, pg], toFolderId: null })))).body.code,
    ).toBe('mixed_kinds');
  });

  it('embeds: Grant these too, and the pairs it skips', async () => {
    const pg = await node('page', 'host', 'pages');
    const e1 = await node('file', 'mine.png', 'files');
    const e2 = await node('file', 'theirs.png', 'files');
    await homeIn(pg, P);
    await homeIn(e1, P);
    await homeIn(e2, Q);
    // e2 is readable in P too, but managed in Q only.
    await m.withHeads([e2], 'update', async (tx) => {
      await tx.execute(sql`insert into item_grants (node_id, workspace_id) values (${e2}, ${P})`);
    });
    await x(sql`insert into node_embeds (from_id, to_id) values (${pg}, ${e1}), (${pg}, ${e2})`);
    await as(mem);
    // mem moderates P (the host's home) and is a plain user of Q.
    expect((await get(pg)).body.embedsNotGranted).toEqual([]);
    await as(owner);
    expect((await add(pg, Q)).status).toBe(200);
    await as(mem);
    const panel = await get(pg);
    expect(panel.body.embedsNotGranted).toEqual([{ nodeId: e1, title: 'mine.png', kind: 'file' }]);
    const res = await call(r.embeds.POST(req('POST', { wsIds: [Q] }), p({ nodeId: pg })));
    // mem is not a Moderator of Q: skipped.
    expect(res.body.skipped).toEqual([{ nodeId: e1, wsId: Q, code: 'forbidden' }]);
    await as(owner);
    const ok = await call(r.embeds.POST(req('POST', { wsIds: [Q] }), p({ nodeId: pg })));
    expect(ok.body.skipped).toEqual([]);
    expect(ok.body.embedsNotGranted).toEqual([]);
    expect((await readWs(e1)).sort()).toEqual([P, Q].sort());
    // A workspace the host is not in: refused.
    const bad = await call(r.embeds.POST(req('POST', { wsIds: [R] }), p({ nodeId: pg })));
    expect(bad.body.code).toBe('invalid');
    // One mem cannot see at all: 404.
    await as(mem);
    expect((await call(r.embeds.POST(req('POST', { wsIds: [R] }), p({ nodeId: pg })))).status).toBe(
      404,
    );
  });

  it('the open link: its served list, and what the caller may serve', async () => {
    const pg = await node('page', 'link host', 'pages');
    const e1 = await node('file', 'served.png', 'files');
    const e2 = await node('file', 'not mine.png', 'files');
    await homeIn(pg, P);
    await homeIn(e1, P);
    await homeIn(e2, Q);
    await x(sql`insert into node_embeds (from_id, to_id) values (${pg}, ${e1}), (${pg}, ${e2})`);
    // mem moderates P (it may edit the page and e1) and is a plain user of
    // Q (it reads e2 nowhere it may edit): only e1 is offered.
    await as(mem);
    const before = await get(pg);
    expect(before.body.mayLink).toBe(true);
    expect(before.body.link).toBeNull();
    expect(before.body.serveCandidates).toEqual([
      { nodeId: e1, title: 'served.png', kind: 'file' },
    ]);
    const token = `tok-${randomUUID()}`;
    await x(sql`insert into shares (owner_id, node_id, node_type, token, settings)
                values (${owner}, ${pg}, 'page', ${token}, ${JSON.stringify({ served: [e1] })}::jsonb)`);
    const after = await get(pg);
    expect(after.body.link).toMatchObject({
      path: `/s/${token}`,
      served: [{ nodeId: e1, title: 'served.png' }],
    });

    // Decision 12: an embed added to a page that already has a link is not
    // served until someone ticks it; the panel offers it, unticked.
    const e3 = await node('file', 'added later.png', 'files');
    await homeIn(e3, P);
    await x(sql`insert into node_embeds (from_id, to_id) values (${pg}, ${e3})`);
    const later = await get(pg);
    expect(later.body.serveCandidates).toEqual([
      { nodeId: e3, title: 'added later.png', kind: 'file' },
      { nodeId: e1, title: 'served.png', kind: 'file' },
    ]);
    expect(later.body.link.served).toEqual([{ nodeId: e1, title: 'served.png' }]);
    const [held] = await x<{ s: unknown }>(
      sql`select settings->'served' as s from shares where token = ${token}`,
    );
    expect(held!.s).toEqual([e1]);

    // A served item the caller cannot read is named by id only.
    const e4 = await node('file', 'reef only.png', 'files');
    await homeIn(e4, R);
    await x(sql`update shares set settings = ${JSON.stringify({ served: [e1, e4] })}::jsonb
                 where token = ${token}`);
    expect((await get(pg)).body.link.served).toEqual([
      { nodeId: e1, title: 'served.png' },
      { nodeId: e4, title: null },
    ]);
    // A caller who reads the page (Q, Write off) but may not edit it sees
    // neither.
    await m.withHeads([pg], 'update', async (tx) => {
      await tx.execute(sql`insert into item_grants (node_id, workspace_id) values (${pg}, ${Q})`);
    });
    await as(mem2);
    const other = await get(pg);
    expect(other.status).toBe(200);
    expect(other.body.mayLink).toBe(false);
    expect(other.body.link).toBeNull();
    expect(other.body.serveCandidates).toEqual([]);
    await x(sql`delete from shares where token = ${token}`);
  });

  it('a folder link offers the items the caller may edit, counted before the cap', async () => {
    const path = `files.sv_${randomUUID().slice(0, 8)}`;
    const folder = await node('branch', 'serve cap', path);
    await homeIn(folder, Q);
    // 500 items it may not edit sort first by id (homed in P, where mem2 is
    // nobody; the folder's Q row passes on with Write off), then one it may.
    const head = `00000000-${randomUUID().slice(9, 24)}`;
    const low = Array.from({ length: 500 }, (_, i) => `${head}${String(i).padStart(12, '0')}`);
    const high = `ffffffff-${randomUUID().slice(9)}`;
    await m.withHeads([folder], 'share', async (tx) => {
      await tx.execute(sql`insert into nodes (id, owner_id, type, title, path)
        select x.id, ${owner}, 'file', 'not editable', ${path}::ltree
          from unnest(${`{${low.join(',')}}`}::uuid[]) as x(id)`);
      await tx.execute(sql`insert into nodes (id, owner_id, type, title, path)
        values (${high}, ${owner}, 'file', 'editable', ${path}::ltree)`);
    });
    await m.withHeads(low, 'update', async (tx) => {
      await tx.execute(
        sql`delete from item_grants where node_id = any (${`{${low.join(',')}}`}::uuid[])`,
      );
      await tx.execute(sql`insert into item_grants (node_id, workspace_id, is_home)
        select x.id, ${P}, true from unnest(${`{${low.join(',')}}`}::uuid[]) as x(id)
        on conflict (node_id, workspace_id)
        do update set is_home = true, via_folder_id = null, excluded = false`);
    });
    await as(mem2);
    const res = await get(folder);
    expect(res.body.mayLink).toBe(true);
    expect(res.body.serveCandidates).toEqual([{ nodeId: high, title: 'editable', kind: 'file' }]);
  });

  it('a member in none of the workspaces reads nothing', async () => {
    const it2 = await node('note', 'p only', 'notes');
    await homeIn(it2, P);
    await as(mem3);
    expect((await get(it2)).status).toBe(404);
    expect((await preview(it2, `add=${P}`)).status).toBe(404);
    expect(
      (await call(r.movePreview.POST(req('POST', { nodeIds: [it2], toWorkspaceId: P })))).status,
    ).toBe(404);
  });

  it('part A fix round 1: rules before counts, preview rules, placesInto, the guard', async () => {
    const F = await node('branch', 'AF', 'notes.af');
    const G = await node('branch', 'AG', 'notes.af.ag');
    const c1 = await node('note', 'a1', 'notes.af.ag');
    const hiddenItem = await node('note', 'r only', 'notes.af');
    const app = await node('app', 'An app inside', 'notes.af');
    await x(sql`insert into apps (node_id) values (${app})`);
    for (const id of [F, G, c1, app]) await homeIn(id, P);
    await homeIn(hiddenItem, R);
    await as(owner);
    expect((await add(F, Q, { confirm: true })).status).toBe(200);
    // mem2 reads F (via Q) but does not manage it. The R item is taken out
    // of what F passes on, so only R (nobody here but mem2) reads it.
    await m.withHeads([hiddenItem], 'update', async (tx) => {
      await tx.execute(sql`update item_grants set excluded = true, write = false, via_folder_id = null
                            where node_id = ${hiddenItem} and workspace_id in (${P}, ${Q})`);
    });

    // M1: a caller who may not make the change learns no count: forbidden
    // before confirm_required and before too_big.
    await as(mem2);
    const noConfirm = await add(F, R);
    expect(noConfirm.body.code).toBe('forbidden');
    expect(noConfirm.body.error).not.toMatch(/\d/);
    g.FOLDER_GRANT_LIMIT.max = 1;
    try {
      expect((await add(F, R, { confirm: true })).body.code).toBe('forbidden');
      // Through a move: the failed entry is the rule, not a count.
      const mv = await call(r.move.POST(req('POST', { nodeIds: [F], toWorkspaceId: R })));
      expect(mv.body.moved).toBe(0);
      expect(mv.body.failed[0].error).not.toMatch(/\d/);
      expect(mv.body.failed[0].error).toMatch(/Moderator/);
      // L1: "Change here" on a folder is held to the size limit too.
      await as(owner);
      expect((await hand(G, Q)).body.code).toBe('too_big');
    } finally {
      g.FOLDER_GRANT_LIMIT.max = 50_000;
    }
    expect((await rowsOf(G)).find((x) => x.ws === Q)!.via).toBe(F);

    // M2: preview add = home Moderator AND target Moderator; remove = either.
    await as(mem);
    expect((await preview(F, `add=${Q}`)).body.code).toBe('forbidden');
    expect((await preview(F, `remove=${Q}`)).status).toBe(200);
    await as(mem2);
    expect((await preview(F, `add=${R}`)).body.code).toBe('forbidden');
    expect((await preview(F, `remove=${Q}`)).status).toBe(200);
    // The honest total, with what the caller cannot open said (M2), and the
    // apps among the gains (L2).
    await as(owner);
    const pv = await preview(F, `add=${admin}`);
    expect(pv.body).toMatchObject({ total: 5, hidden: 1, gainApps: 1 });

    // M3: the move preview applies the move's rules first.
    await as(mem2);
    const mp = await call(r.movePreview.POST(req('POST', { nodeIds: [c1], toWorkspaceId: R })));
    expect(mp.body.code).toBe('forbidden');
    const fp = await call(r.movePreview.POST(req('POST', { nodeIds: [c1], toFolderId: null })));
    expect(fp.body.code).toBe('forbidden');

    // M4: placesInto for a caller who may add items to the folder.
    await as(owner);
    expect((await get(F)).body.placesInto).toEqual([
      { wsId: P, name: 'Proj' },
      { wsId: Q, name: 'Quay' },
    ]);
    await as(mem2);
    expect((await get(F)).body.placesInto).toBeUndefined();

    // L3: the tree move runs the guard under each item's heads; a refusal
    // there moves nothing and is reported.
    const tree = await import('@mantle/content/tree');
    const before = await x<{ path: string }>(
      sql`select path::text as path from nodes where id = ${c1}`,
    );
    const res = await tree.moveTreeItems(owner, 'notes', [c1], null, {
      confirm: true,
      guard: async () => {
        throw new Error('refused under the heads');
      },
    });
    expect(res).toEqual({ moved: 0, failed: [{ id: c1, error: 'refused under the heads' }] });
    expect(await x(sql`select path::text as path from nodes where id = ${c1}`)).toEqual(before);
  });

  it('a Team add on an item made today is a plain grant', async () => {
    const note = await node('note', 'made today, no team row', 'notes');
    await as(owner);
    const res = await add(note, team);
    expect(res.status).toBe(200);
    expect(await rowsOf(note)).toEqual(
      [
        { ws: admin, write: false, is_home: true, via: null, excluded: false },
        { ws: team, write: false, is_home: false, via: null, excluded: false },
      ].sort((a, b) => (a.ws < b.ws ? -1 : 1)),
    );
  });
});
