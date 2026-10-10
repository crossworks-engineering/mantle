/**
 * The client-sourced write hold by TARGET, on grants (workspaces W5b2), on a
 * real, migrated Postgres: an item granted to a client's workspace after the
 * switch (its frozen level still admin) holds a client-marked turn's write
 * into it at /pending; so does an item an open link serves, and a file put
 * in a folder a client workspace reads. An item only Team holds runs.
 *   MANTLE_TEST_DATABASE_URL=postgres://… pnpm vitest run packages/tools/src/client-sourced-grants.db.test.ts
 */
import { randomUUID } from 'node:crypto';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

const URL = process.env.MANTLE_TEST_DATABASE_URL;

describe.skipIf(!URL)('client-sourced holds read the grants', () => {
  type Db = typeof import('@mantle/db');
  let m: Db;
  let admin: Parameters<Db['ensureViewerRoles']>[0];
  let rules: typeof import('./client-sourced-rules');
  let sqlTag: typeof import('drizzle-orm').sql;
  const owner = randomUUID();
  const client = randomUUID();
  const tag = `csg-${owner.slice(0, 8)}`;
  const ws = { admin: randomUUID(), team: randomUUID(), clients: randomUUID() };
  const ids = {
    teamNote: randomUUID(),
    clientNote: randomUUID(),
    linked: randomUUID(),
    served: randomUUID(),
    folder: randomUUID(),
  };
  const builtin = (slug: string) => ({ slug, handler: { kind: 'builtin', ref: slug } });
  const gate = (slug: string, input: Record<string, unknown>) =>
    rules.clientSourcedGate({
      ownerId: owner,
      tool: builtin(slug),
      input,
      isReadOnlyBuiltin: () => false,
    });
  const grant = (node: string, wsId: string) =>
    m.withHeads([node], 'update', async (tx) => {
      await tx.execute(
        sqlTag`insert into item_grants (node_id, workspace_id) values (${node}, ${wsId})`,
      );
    });

  beforeAll(async () => {
    process.env.DATABASE_URL = URL;
    process.env.MANTLE_MASTER_KEY ??= 'mantle-viewer-test-key';
    m = await import('@mantle/db');
    sqlTag = (await import('drizzle-orm')).sql;
    admin = (m.systemDb as unknown as { $client: typeof admin }).$client;
    rules = await import('./client-sourced-rules');
    const { setLoginRoleUnguarded } = await import('@mantle/db/test-support');
    await admin`insert into auth.users (id, email, password_hash, role) values
      (${owner}, ${`${tag}-o@example.invalid`}, 'x', 'admin'),
      (${client}, ${`${tag}-c@example.invalid`}, 'x', 'member')`;
    await setLoginRoleUnguarded(admin, client, 'client');
    await admin`insert into spaces (id, kind, login_id) values (${owner}, 'brain', ${owner})
                on conflict (id) do nothing`;
    await admin`insert into workspaces (id, owner_id, name, is_admin) values
      (${ws.admin}, ${owner}, 'Admin', true), (${ws.team}, ${owner}, 'Team', false),
      (${ws.clients}, ${owner}, 'Clients', false)`;
    await admin`insert into workspace_users (workspace_id, login_id, moderator) values
      (${ws.admin}, ${owner}, true), (${ws.clients}, ${client}, false)`;
    const rows: Array<[string, string, string]> = [
      [ids.teamNote, 'note', 'notes'],
      [ids.clientNote, 'note', 'notes'],
      [ids.linked, 'page', 'pages'],
      [ids.served, 'file', 'files'],
      [ids.folder, 'branch', `files.${tag.replace(/-/g, '_')}`],
    ];
    for (const [id, type, path] of rows) {
      await admin`insert into nodes (id, owner_id, type, title, path)
        values (${id}, ${owner}, ${type}::node_type, ${id}, ${path}::ltree)`;
    }
    await grant(ids.teamNote, ws.team);
    // Granted to the client's workspace after the switch: its level stays
    // admin (frozen), the grant is the truth.
    await grant(ids.clientNote, ws.clients);
    await grant(ids.folder, ws.clients);
    await admin`insert into shares (owner_id, node_id, node_type, token, settings)
      values (${owner}, ${ids.linked}, 'page', ${`${tag}-tok`},
              ${JSON.stringify({ served: [ids.served] })}::jsonb)`;
  }, 60_000);

  afterAll(async () => {
    await admin`delete from shares where owner_id = ${owner}`;
    await admin`delete from nodes where owner_id = ${owner}`;
    await admin`delete from workspace_users where workspace_id in (${ws.admin}, ${ws.team}, ${ws.clients})`;
    await admin`delete from workspaces where owner_id = ${owner}`;
    await admin`delete from spaces where login_id in (${owner}, ${client})`;
    await admin`delete from auth.users where id in (${owner}, ${client})`;
    await m.closeDb();
  });

  it('an item only Team holds runs', async () => {
    expect(await gate('note_update', { id: ids.teamNote, content: 'x' })).toEqual({ gate: false });
  });

  it("an item granted to a client's workspace waits, whatever its frozen level", async () => {
    const [lv] = await admin<{ a: string }[]>`select audience::text as a from nodes
                                              where id = ${ids.clientNote}`;
    expect(lv!.a).toBe('admin');
    expect(await gate('note_update', { id: ids.clientNote, content: 'x' })).toMatchObject({
      gate: true,
      why: expect.stringMatching(/clients or the public read/),
    });
  });

  it("an open link's item and what it serves wait", async () => {
    expect(await gate('note_update', { id: ids.linked, content: 'x' })).toMatchObject({
      gate: true,
    });
    expect(await gate('note_update', { id: ids.served, content: 'x' })).toMatchObject({
      gate: true,
    });
  });

  it('a file put in a folder a client workspace reads waits', async () => {
    const [f] = await admin<{ p: string }[]>`select path::text as p from nodes
                                             where id = ${ids.folder}`;
    expect(await gate('folder_create', { parent_path: f!.p, name: 'n' })).toMatchObject({
      gate: true,
      why: expect.stringMatching(/folder shared with clients/),
    });
    expect(await gate('folder_create', { parent_path: 'files', name: 'n' })).toEqual({
      gate: false,
    });
  });
});
