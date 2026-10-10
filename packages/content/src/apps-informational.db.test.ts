/**
 * The informational switch on a real, migrated Postgres (workspaces W5b2
 * part B, fix round 1 M3): PATCH /api/apps/:id { dataReadOnly } goes through
 * updateAppMeta, which sets Write on the app's grants beyond Admin in the
 * transaction of the flag. On: Write off on every such grant (a row via a
 * folder becomes a grant set on the app, Write off, since the folder's
 * Write would come straight back). Off: Write on again on the grants set on
 * the app. Never the Admin row, an archived workspace or another app.
 *   MANTLE_TEST_DATABASE_URL=postgres://… pnpm vitest run packages/content/src/apps-informational.db.test.ts
 */
import { randomUUID } from 'node:crypto';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

const URL = process.env.MANTLE_TEST_DATABASE_URL;

describe.skipIf(!URL)('the informational switch writes the grants', () => {
  type Db = typeof import('@mantle/db');
  let m: Db;
  let ap: typeof import('./apps');
  let sqlTag: typeof import('drizzle-orm').sql;
  const tag = `appinfo-${randomUUID().slice(0, 8)}`;
  const label = `f${randomUUID().replace(/-/g, '').slice(0, 10)}`;
  // A brain of this test's own (not mantle_brain_id(): files run in
  // parallel), so no default home is written for it.
  const anchor = randomUUID();
  const ws = {
    admin: randomUUID(),
    team: randomUUID(),
    field: randomUUID(),
    gone: randomUUID(),
  };
  const ids = { a: randomUUID(), b: randomUUID(), other: randomUUID(), folder: randomUUID() };

  const grant = (node: string, wsId: string, write = false, home = false) =>
    m.withHeads([node], 'update', (tx) =>
      tx.execute(sqlTag`insert into item_grants (node_id, workspace_id, write, is_home)
        values (${node}, ${wsId}, ${write}, ${home})`),
    );

  type Row = { ws: string; write: boolean; via: string | null };
  const rowsOf = async (node: string): Promise<Map<string, Row>> => {
    const rows = (await m.systemDb.execute(sqlTag`
      select workspace_id::text as ws, write, via_folder_id::text as via
        from item_grants where node_id = ${node} and not excluded`)) as unknown as Row[];
    return new Map(rows.map((r) => [r.ws, r]));
  };
  const writeWs = async (node: string): Promise<string[]> => {
    const [r] = (await m.systemDb.execute(
      sqlTag`select write_ws::text[] as w from nodes where id = ${node}`,
    )) as unknown as { w: string[] }[];
    return [...(r?.w ?? [])].sort();
  };

  beforeAll(async () => {
    process.env.DATABASE_URL = URL;
    m = await import('@mantle/db');
    ap = await import('./apps');
    sqlTag = (await import('drizzle-orm')).sql;

    await m.systemDb.execute(sqlTag`
      insert into auth.users (id, email, password_hash, role, display_name)
      values (${anchor}, ${`${tag}-admin@example.invalid`}, 'x', 'admin', null)`);
    await m.systemDb.execute(
      sqlTag`insert into spaces (id, kind, login_id) values (${anchor}, 'brain', ${anchor})`,
    );
    await m.systemDb.execute(sqlTag`
      insert into workspaces (id, owner_id, name, is_admin, bridge_key) values
        (${ws.admin}, ${anchor}, ${`${tag} Admin`}, true, 'admin'),
        (${ws.team}, ${anchor}, ${`${tag} Team`}, false, 'team'),
        (${ws.field}, ${anchor}, ${`${tag} Field`}, false, null),
        (${ws.gone}, ${anchor}, ${`${tag} Gone`}, false, null)`);
    await m.systemDb.execute(sqlTag`
      insert into nodes (id, owner_id, type, title, path) values
        (${ids.a}, ${anchor}, 'app', ${`${tag} a`}, 'apps'),
        (${ids.other}, ${anchor}, 'app', ${`${tag} other`}, 'apps'),
        (${ids.folder}, ${anchor}, 'branch', ${`${tag} folder`}, ${`apps.${label}`})`);
    await grant(ids.folder, ws.admin, false, true);
    await grant(ids.folder, ws.field, true);
    // An app placed in the folder takes the folder's rows (S6).
    await m.withHeads([ids.folder], 'share', (tx) =>
      tx.execute(sqlTag`
        insert into nodes (id, owner_id, type, title, path)
        values (${ids.b}, ${anchor}, 'app', ${`${tag} b`}, ${`apps.${label}`})`),
    );
    await m.systemDb.execute(sqlTag`
      insert into apps (node_id, manifest) values
        (${ids.a}, '{}'::jsonb), (${ids.b}, '{}'::jsonb), (${ids.other}, '{}'::jsonb)`);
    await grant(ids.a, ws.admin, false, true);
    await grant(ids.a, ws.team, true);
    await grant(ids.a, ws.field, true);
    await grant(ids.a, ws.gone, true);
    await grant(ids.other, ws.admin, false, true);
    await grant(ids.other, ws.team, true);
    // Archived after its grant was written (an archive drops them; this row
    // stands for one that slipped past): never written by the switch.
    await m.systemDb.execute(
      sqlTag`update workspaces set archived_at = now() where id = ${ws.gone}`,
    );
  }, 60_000);

  afterAll(async () => {
    await m.systemDb.execute(sqlTag`delete from workspace_events where subject->>'node' in
      (${ids.a}, ${ids.b}, ${ids.other})`);
    await m.systemDb.execute(sqlTag`
      delete from item_grants where node_id in (select id from nodes where owner_id = ${anchor})`);
    await m.systemDb.execute(sqlTag`delete from nodes where owner_id = ${anchor}`);
    await m.systemDb.execute(sqlTag`delete from workspaces where owner_id = ${anchor}`);
    await m.systemDb.execute(sqlTag`delete from spaces where login_id = ${anchor}`);
    await m.systemDb.execute(sqlTag`delete from auth.users where id = ${anchor}`);
    await m.closeDb();
  }, 60_000);

  it('the fixture: hand rows with Write on, and a row via the folder', async () => {
    const b = await rowsOf(ids.b);
    expect(b.get(ws.field)).toMatchObject({ write: true, via: ids.folder });
    expect(await writeWs(ids.a)).toEqual([ws.team, ws.field, ws.gone].sort());
  });

  it('on: Write off on every grant beyond Admin, in the transaction of the flag', async () => {
    const app = await ap.updateAppMeta(anchor, ids.a, { dataReadOnly: true }, { actorId: anchor });
    expect(app?.dataReadOnly).toBe(true);
    const a = await rowsOf(ids.a);
    expect(a.get(ws.team)?.write).toBe(false);
    expect(a.get(ws.field)?.write).toBe(false);
    expect(a.get(ws.admin)?.write).toBe(false);
    // An archived workspace takes no write of any kind.
    expect(a.get(ws.gone)?.write).toBe(true);
    expect(await writeWs(ids.a)).toEqual([ws.gone]);
    // Another app is not touched.
    expect((await rowsOf(ids.other)).get(ws.team)?.write).toBe(true);
    // One event per changed grant, by the actor.
    const events = (await m.systemDb.execute(sqlTag`
      select workspace_id::text as ws, actor_id::text as actor, subject
        from workspace_events
       where action = 'grant.write' and subject->>'node' = ${ids.a}
       order by workspace_id`)) as unknown as Array<{
      ws: string;
      actor: string;
      subject: Record<string, unknown>;
    }>;
    expect(events.map((e) => e.ws).sort()).toEqual([ws.team, ws.field].sort());
    expect(events[0]).toMatchObject({
      actor: anchor,
      subject: { node: ids.a, write: false, informational: true },
    });
  });

  it('on: a row via a folder becomes a grant set on the app with Write off, and stays so', async () => {
    await ap.updateAppMeta(anchor, ids.b, { dataReadOnly: true }, { actorId: anchor });
    const b = await rowsOf(ids.b);
    expect(b.get(ws.field)).toMatchObject({ write: false, via: null });
    expect(await writeWs(ids.b)).toEqual([]);
    // A later change of the folder's grants does not bring Write back.
    await m.withSubtreeHeads(ids.folder, [], (tx) =>
      tx.execute(sqlTag`update item_grants set write = true
        where node_id = ${ids.folder} and workspace_id = ${ws.field}`),
    );
    expect((await rowsOf(ids.b)).get(ws.field)?.write).toBe(false);
  });

  it('off: Write on again on the grants set on the app, never on Admin', async () => {
    const app = await ap.updateAppMeta(anchor, ids.a, { dataReadOnly: false }, { actorId: anchor });
    expect(app?.dataReadOnly).toBe(false);
    const a = await rowsOf(ids.a);
    expect(a.get(ws.team)?.write).toBe(true);
    expect(a.get(ws.field)?.write).toBe(true);
    expect(a.get(ws.admin)?.write).toBe(false);
    expect(await writeWs(ids.a)).toEqual([ws.team, ws.field, ws.gone].sort());

    await ap.updateAppMeta(anchor, ids.b, { dataReadOnly: false });
    expect((await rowsOf(ids.b)).get(ws.field)?.write).toBe(true);
  });

  it('a metadata update that does not name the flag leaves the grants', async () => {
    await ap.updateAppMeta(anchor, ids.a, { dataReadOnly: true });
    await ap.updateAppMeta(anchor, ids.a, { icon: '🧾' });
    expect((await rowsOf(ids.a)).get(ws.team)?.write).toBe(false);
    await ap.updateAppMeta(anchor, ids.a, { dataReadOnly: false });
    expect((await rowsOf(ids.a)).get(ws.team)?.write).toBe(true);
  });
});
