/**
 * The client-sourced write hold by TARGET, on grants (workspaces W5b2), on a
 * real, migrated Postgres: an item an open link serves holds a client-marked
 * turn's write into it at /pending. An item only Team holds runs, and so
 * does a folder made at a kind's root. (An item or a folder a client
 * workspace holds is not seeded: a workspace has no client user since W8a,
 * there being no client login.)
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
  /** The builtins' own policies: each write declares its client-sourced
   *  rule there (A5 step 6d), as the tool loop reads it. */
  let policies: typeof import('./tool-policy');
  let sqlTag: typeof import('drizzle-orm').sql;
  const owner = randomUUID();
  const tag = `csg-${owner.slice(0, 8)}`;
  const ws = { admin: randomUUID(), team: randomUUID() };
  const ids = {
    teamNote: randomUUID(),
    linked: randomUUID(),
    served: randomUUID(),
  };
  const builtin = (slug: string) => ({ slug, handler: { kind: 'builtin', ref: slug } });
  const gate = (slug: string, input: Record<string, unknown>) =>
    rules.clientSourcedGate({
      ownerId: owner,
      tool: builtin(slug),
      input,
      policyOf: (s) => policies.builtinPolicy(s),
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
    await import('./registry');
    policies = await import('./tool-policy');
    await admin`insert into auth.users (id, email, password_hash, role) values
      (${owner}, ${`${tag}-o@example.invalid`}, 'x', 'admin')`;
    await admin`insert into spaces (id, kind, login_id) values (${owner}, 'brain', ${owner})
                on conflict (id) do nothing`;
    await admin`insert into workspaces (id, owner_id, name, is_admin) values
      (${ws.admin}, ${owner}, 'Admin', true), (${ws.team}, ${owner}, 'Team', false)`;
    await admin`insert into workspace_users (workspace_id, login_id, moderator) values
      (${ws.admin}, ${owner}, true)`;
    const rows: Array<[string, string, string]> = [
      [ids.teamNote, 'note', 'notes'],
      [ids.linked, 'page', 'pages'],
      [ids.served, 'file', 'files'],
    ];
    for (const [id, type, path] of rows) {
      await admin`insert into nodes (id, owner_id, type, title, path)
        values (${id}, ${owner}, ${type}::node_type, ${id}, ${path}::ltree)`;
    }
    await grant(ids.teamNote, ws.team);
    await admin`insert into shares (owner_id, node_id, node_type, token, settings)
      values (${owner}, ${ids.linked}, 'page', ${`${tag}-tok`},
              ${JSON.stringify({ served: [ids.served] })}::jsonb)`;
  }, 60_000);

  afterAll(async () => {
    await admin`delete from shares where owner_id = ${owner}`;
    await admin`delete from nodes where owner_id = ${owner}`;
    await admin`delete from item_grants where workspace_id in (${ws.admin}, ${ws.team})`;
    await admin`delete from workspaces where owner_id = ${owner}`;
    await admin`delete from spaces where login_id = ${owner}`;
    await admin`delete from auth.users where id = ${owner}`;
    await m.closeDb();
  });

  it('an item only Team holds runs', async () => {
    expect(await gate('note_update', { id: ids.teamNote, content: 'x' })).toEqual({ gate: false });
  });

  it("an open link's item and what it serves wait", async () => {
    expect(await gate('note_update', { id: ids.linked, content: 'x' })).toMatchObject({
      gate: true,
    });
    expect(await gate('note_update', { id: ids.served, content: 'x' })).toMatchObject({
      gate: true,
    });
  });

  it('a folder made at a kind root runs', async () => {
    expect(await gate('folder_create', { parent_path: 'files', name: 'n' })).toEqual({
      gate: false,
    });
  });
});
