/**
 * The informational switch on a real, migrated Postgres (workspaces W5b2
 * part B, fix round 2, H-b; contract change 36, which reverses 35d):
 * PATCH /api/apps/:id { dataReadOnly } goes through updateAppMeta and
 * changes NO grant. apps.data_read_only is an AND inside the member write
 * rule (memberWritesSql): while it is on nobody beyond Admin writes the
 * app's data, whatever the grants' Write says; off, the grants' Write
 * decides. Checked:
 *  - off on an app that was never informational changes nothing (no grant,
 *    no event);
 *  - a public app (its Team row has Write off) switched on then off does
 *    not give Team Write;
 *  - on blocks a workspace whose grant has Write on (its member runs the
 *    app read only), and off gives the write back, with the grant untouched
 *    throughout.
 *   MANTLE_TEST_DATABASE_URL=postgres://… pnpm vitest run packages/content/src/apps-informational.db.test.ts
 */
import { randomUUID } from 'node:crypto';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

const URL = process.env.MANTLE_TEST_DATABASE_URL;

describe.skipIf(!URL)('the informational switch writes no grant (contract 36)', () => {
  type Db = typeof import('@mantle/db');
  let m: Db;
  let ap: typeof import('./apps');
  let ma: typeof import('./member-apps');
  let sqlTag: typeof import('drizzle-orm').sql;
  const tag = `appinfo-${randomUUID().slice(0, 8)}`;
  // A brain of this test's own (not mantle_brain_id(): files run in
  // parallel), so no default home is written for it.
  const anchor = randomUUID();
  const member = randomUUID();
  const ws = { admin: randomUUID(), team: randomUUID(), field: randomUUID() };
  const ids = { plain: randomUUID(), pub: randomUUID(), field: randomUUID() };
  const green = JSON.stringify({
    storageKey: 'apps/x.js',
    sha256: 'x',
    builtAt: '2026-10-11T00:00:00Z',
    esbuildVersion: '0',
    bytes: 1,
    ok: true,
  });

  const grant = (node: string, wsId: string, write = false, home = false) =>
    m.withHeads([node], 'update', (tx) =>
      tx.execute(sqlTag`insert into item_grants (node_id, workspace_id, write, is_home)
        values (${node}, ${wsId}, ${write}, ${home})`),
    );

  /** A fixture write to the workspace tables, as the superuser: the app's
   *  pools only read them. */
  const su = async (q: ReturnType<typeof sqlTag>) =>
    (await import('@mantle/db/test-support')).superuserExec(URL!, q);

  type Row = { ws: string; write: boolean; via: string | null; home: boolean };
  /** Every row of the node, excluded included, in a stable order. */
  const rowsOf = async (node: string): Promise<Row[]> =>
    (await m.systemDb.execute(sqlTag`
      select workspace_id::text as ws, write, via_folder_id::text as via, is_home as home
        from item_grants where node_id = ${node} order by workspace_id`)) as unknown as Row[];
  const writeWs = async (node: string): Promise<string[]> => {
    const [r] = (await m.systemDb.execute(
      sqlTag`select write_ws::text[] as w from nodes where id = ${node}`,
    )) as unknown as { w: string[] }[];
    return [...(r?.w ?? [])].sort();
  };
  const events = async (node: string): Promise<number> => {
    const [r] = (await m.systemDb.execute(sqlTag`
      select count(*)::int as n from workspace_events
       where subject->>'node' = ${node}`)) as unknown as { n: number }[];
    return r?.n ?? 0;
  };
  const inWs = <T>(wsId: string, fn: () => Promise<T>) =>
    m.withScope({ kind: 'user', loginId: member, ws: [wsId], modWs: [] }, fn);
  /** The member runs `app` in workspace `wsId`: may they write its data? */
  const writable = async (wsId: string, app: string): Promise<boolean | null> => {
    const run = await inWs(wsId, () => ma.getMemberRunnableApp(anchor, app));
    return run ? ma.memberMayWriteAppData(run) : null;
  };
  /** The R or R/W pill of the member's launcher card. */
  const pill = async (wsId: string, app: string) =>
    (await inWs(wsId, () => ma.listMemberApps(anchor))).find((c) => c.id === app)?.dataAccess ??
    null;
  const setInformational = async (app: string, on: boolean) => {
    const out = await ap.updateAppMeta(anchor, app, { dataReadOnly: on });
    expect(out?.dataReadOnly).toBe(on);
  };

  beforeAll(async () => {
    process.env.DATABASE_URL = URL;
    // ONE key for every viewer DB test: roles are cluster-wide (28P01).
    process.env.MANTLE_MASTER_KEY ??= 'mantle-viewer-test-key';
    m = await import('@mantle/db');
    ap = await import('./apps');
    ma = await import('./member-apps');
    sqlTag = (await import('drizzle-orm')).sql;
    const admin = (m.systemDb as unknown as { $client: Parameters<Db['ensureViewerRoles']>[0] })
      .$client;
    await m.ensureViewerRoles(admin, process.env.MANTLE_MASTER_KEY);

    await m.systemDb.execute(sqlTag`
      insert into auth.users (id, email, password_hash, role, display_name) values
        (${anchor}, ${`${tag}-admin@example.invalid`}, 'x', 'admin', null),
        (${member}, ${`${tag}-pat@example.invalid`}, 'x', 'member', 'Pat Member')`);
    await m.systemDb.execute(
      sqlTag`insert into spaces (id, kind, login_id) values (${anchor}, 'brain', ${anchor})`,
    );
    await su(sqlTag`
      insert into workspaces (id, owner_id, name, is_admin, bridge_key) values
        (${ws.admin}, ${anchor}, ${`${tag} Admin`}, true, 'admin'),
        (${ws.team}, ${anchor}, ${`${tag} Team`}, false, null),
        (${ws.field}, ${anchor}, ${`${tag} Field`}, false, null)`);
    await m.systemDb.execute(sqlTag`
      insert into nodes (id, owner_id, type, title, path, audience) values
        (${ids.plain}, ${anchor}, 'app', ${`${tag} plain`}, 'apps', 'team'),
        (${ids.pub}, ${anchor}, 'app', ${`${tag} public`}, 'apps', 'public'),
        (${ids.field}, ${anchor}, 'app', ${`${tag} field`}, 'apps', 'team')`);
    await m.systemDb.execute(sqlTag`
      insert into apps (node_id, manifest, published_build) values
        (${ids.plain}, '{}'::jsonb, ${green}::jsonb),
        (${ids.pub}, '{}'::jsonb, ${green}::jsonb),
        (${ids.field}, '{}'::jsonb, ${green}::jsonb)`);
    for (const id of Object.values(ids)) await grant(id, ws.admin, false, true);
    // A never-informational app: Team and Field write it.
    await grant(ids.plain, ws.team, true);
    await grant(ids.plain, ws.field, true);
    // A public app: its Team row has Write off (0261 step d).
    await grant(ids.pub, ws.team, false);
    // An app Field holds with Write on.
    await grant(ids.field, ws.field, true);
  }, 60_000);

  afterAll(async () => {
    await su(sqlTag`delete from workspace_events where subject->>'node' in
      (${ids.plain}, ${ids.pub}, ${ids.field})`);
    await m.systemDb.execute(sqlTag`
      delete from item_grants where node_id in (select id from nodes where owner_id = ${anchor})`);
    await m.systemDb.execute(sqlTag`delete from nodes where owner_id = ${anchor}`);
    await su(sqlTag`delete from workspaces where owner_id = ${anchor}`);
    await m.systemDb.execute(sqlTag`delete from spaces where login_id in (${anchor}, ${member})`);
    await m.systemDb.execute(sqlTag`delete from auth.users where id in (${anchor}, ${member})`);
    await m.closeDb();
  }, 60_000);

  it('off on an app that was never informational changes nothing', async () => {
    const before = await rowsOf(ids.plain);
    expect(await writeWs(ids.plain)).toEqual([ws.team, ws.field].sort());
    await setInformational(ids.plain, false);
    expect(await rowsOf(ids.plain)).toEqual(before);
    expect(await writeWs(ids.plain)).toEqual([ws.team, ws.field].sort());
    expect(await events(ids.plain)).toBe(0);
    expect(await writable(ws.team, ids.plain)).toBe(true);
    expect(await writable(ws.field, ids.plain)).toBe(true);
  });

  it('a public app switched on then off does not give Team Write', async () => {
    const before = await rowsOf(ids.pub);
    expect(before.find((r) => r.ws === ws.team)?.write).toBe(false);
    expect(await writable(ws.team, ids.pub)).toBe(false);
    await setInformational(ids.pub, true);
    expect(await rowsOf(ids.pub)).toEqual(before);
    await setInformational(ids.pub, false);
    expect(await rowsOf(ids.pub)).toEqual(before);
    expect(await writeWs(ids.pub)).toEqual([]);
    expect(await writable(ws.team, ids.pub)).toBe(false);
    expect(await events(ids.pub)).toBe(0);
  });

  it('on blocks a workspace whose grant has Write on; off gives it back; the grant stays', async () => {
    const before = await rowsOf(ids.field);
    expect(await writable(ws.field, ids.field)).toBe(true);
    expect(await pill(ws.field, ids.field)).toBe('read_write');

    await setInformational(ids.field, true);
    expect(await rowsOf(ids.field)).toEqual(before);
    expect(await writeWs(ids.field)).toEqual([ws.field]);
    // The grant says Write; the flag wins.
    expect(await writable(ws.field, ids.field)).toBe(false);
    expect(await pill(ws.field, ids.field)).toBe('read');
    // A metadata update that does not name the flag leaves it on.
    await ap.updateAppMeta(anchor, ids.field, { icon: '🧾' });
    expect(await writable(ws.field, ids.field)).toBe(false);

    await setInformational(ids.field, false);
    expect(await rowsOf(ids.field)).toEqual(before);
    expect(await writable(ws.field, ids.field)).toBe(true);
    expect(await events(ids.field)).toBe(0);
  });
});
