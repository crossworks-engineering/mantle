/**
 * workspaces:check (plan 7.8, W5b2): on a clean scratch brain every count is
 * 0; each kind of drift planted is counted, and only that kind. Each plant
 * runs in a transaction that is rolled back, so the plants do not add up.
 * The runner itself reads in a READ ONLY transaction.
 *   MANTLE_TEST_DATABASE_URL=postgres://… pnpm vitest run packages/db/src/workspaces-check.db.test.ts
 */
import { randomUUID } from 'node:crypto';
import postgres from 'postgres';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createMigratedScratchDatabase } from './test-support';
import {
  WORKSPACES_CHECK_SQL,
  parseWorkspacesCheck,
  workspacesCheckFindings,
  type WorkspacesCheck,
} from './workspaces-check';

const URL = process.env.MANTLE_TEST_DATABASE_URL;

const CLEAN: WorkspacesCheck = {
  migrated: true,
  grantDrift: 0,
  orphanGrants: 0,
  itemsWithoutHome: 0,
  workspacesWithoutModerator: 0,
  adminWithoutModerator: 0,
  assistantsNotInOneWorkspace: 0,
  linksWithoutServed: 0,
  linksServedInUse: false,
};

describe.skipIf(!URL)('workspaces:check (plan 7.8)', () => {
  let scratch: Awaited<ReturnType<typeof createMigratedScratchDatabase>>;
  let sql: ReturnType<typeof postgres>;
  const owner = randomUUID();
  const member = randomUUID();
  const persona = randomUUID();
  const ids: Record<string, string> = {};
  let admin = '';
  let team = '';

  const node = async (key: string, type: string, path: string, levels = '') => {
    const id = randomUUID();
    // Levels are only read by the one-time migration (fixtures before it).
    const [aud, share, inh] = levels.split(',');
    await sql`insert into nodes (id, owner_id, type, title, path, audience, share_level, inherited_level)
      values (${id}, ${owner}, ${type}::node_type, ${key}, ${path}::ltree,
              ${aud || 'admin'}, ${share || null}, ${inh || null})`;
    ids[key] = id;
    return id;
  };
  const counts = async (q: postgres.Sql | postgres.TransactionSql) =>
    parseWorkspacesCheck((await q.unsafe(WORKSPACES_CHECK_SQL))[0] as never);
  /** Plant something, count, roll back. */
  const planted = async (plant: (tx: postgres.TransactionSql) => Promise<unknown>) => {
    let got: WorkspacesCheck | undefined;
    await sql
      .begin(async (tx) => {
        await plant(tx);
        got = await counts(tx);
        throw new Error('roll back');
      })
      .catch((err: Error) => {
        if (err.message !== 'roll back') throw err;
      });
    return got!;
  };

  beforeAll(async () => {
    scratch = await createMigratedScratchDatabase(URL!);
    sql = postgres(scratch.url, { max: 2, prepare: false, onnotice: () => {} });
    await sql`insert into auth.users (id, email, password_hash, role, is_owner) values
      (${owner}, 'o@example.invalid', 'x', 'admin', true),
      (${member}, 'm@example.invalid', 'x', 'member', false)`;
    await node('page', 'page', 'pages', 'team');
    await node('folder', 'branch', 'pages.shared', 'team,team');
    await node('inFolder', 'page', 'pages.shared', 'admin,,team');
    await node('app', 'app', 'apps', 'team');
    await node('contact', 'contact', 'contacts');
    await sql`insert into agents (id, owner_id, slug, name, role, audience, model, system_prompt)
      values (${persona}, ${owner}, 'persona', 'persona', 'responder', 'admin', 'm', 'p')`;
    const done = await sql<{ section: string }[]>`select * from mantle_ws_migrate()`;
    expect(done.filter((r) => r.section === 'reach-fail')).toEqual([]);
    const ws = await sql<{ id: string; key: string }[]>`
      select id::text as id, (case when is_admin then 'admin' when name = 'Team' then 'team' end) as key from workspaces`;
    admin = ws.find((w) => w.key === 'admin')!.id;
    team = ws.find((w) => w.key === 'team')!.id;
  }, 180_000);

  afterAll(async () => {
    const m = await import('./index').catch(() => null);
    await m?.closeDb().catch(() => {});
    await sql?.end();
    await scratch?.drop();
  });

  it('a clean brain reports 0 everywhere, read only', async () => {
    let got: WorkspacesCheck | undefined;
    await sql.begin('read only', async (tx) => {
      got = await counts(tx);
    });
    expect(got).toEqual(CLEAN);
    expect(workspacesCheckFindings(got!)).toBe(0);
    // The fixture is what the counts claim: a derived row and an attached
    // assistant are there to be checked.
    const [d] = await sql<{ via: string | null }[]>`
      select via_folder_id::text as via from item_grants
       where node_id = ${ids.inFolder!} and workspace_id = ${team}`;
    expect(d!.via).toBe(ids.folder);
    const [a] = await sql<{ ws: string | null }[]>`
      select workspace_id::text as ws from agents where id = ${persona}`;
    expect(a!.ws).toBe(admin);
  });

  it('counts grant drift: derived columns that differ from the grants', async () => {
    const got = await planted(async (tx) => {
      await tx`select set_config('mantle.acl_internal', 'on', true)`;
      await tx`update nodes set read_ws = '{}' where id = ${ids.page!}`;
    });
    expect(got).toEqual({ ...CLEAN, grantDrift: 1 });
    expect(workspacesCheckFindings(got)).toBe(1);
  });

  it('counts orphan grants: a folder row its folder no longer gives, or from another folder', async () => {
    // The folder's Team row goes past the propagation: the item keeps a
    // derived row nothing gives.
    const stale = await planted(async (tx) => {
      await tx`select set_config('mantle.acl_internal', 'on', true)`;
      await tx`delete from item_grants where node_id = ${ids.folder!} and workspace_id = ${team}`;
    });
    expect(stale).toEqual({ ...CLEAN, orphanGrants: 1 });
    // A row marked as from a folder that is not the item's folder.
    const elsewhere = await planted(async (tx) => {
      const other = randomUUID();
      await tx`insert into nodes (id, owner_id, type, title, path)
        values (${other}, ${owner}, 'branch', 'other', 'pages.other'::ltree)`;
      await tx`insert into item_grants (node_id, workspace_id, write)
        values (${other}, ${team}, false)`;
      await tx`select set_config('mantle.acl_internal', 'on', true)`;
      await tx`update item_grants set via_folder_id = ${other}
                where node_id = ${ids.inFolder!} and workspace_id = ${team}`;
    });
    expect(elsewhere).toEqual({ ...CLEAN, orphanGrants: 1 });
  });

  it('counts brain items without a home', async () => {
    const got = await planted(async (tx) => {
      await tx`select mantle_lock_heads(array[${ids.page!}::uuid], 'update')`;
      await tx`delete from item_grants where node_id = ${ids.page!}`;
    });
    expect(got).toEqual({ ...CLEAN, itemsWithoutHome: 1 });
  });

  it('counts workspaces without a Moderator who can sign in, Admin on its own', async () => {
    const got = await planted(async (tx) => {
      // No users at all: counted. Admin users moderate the second one.
      await tx`insert into workspaces (owner_id, name) values (${owner}, 'Empty')`;
      const [led] = await tx<{ id: string }[]>`
        insert into workspaces (owner_id, name, admin_moderated)
        values (${owner}, 'Led', true) returning id`;
      await tx`insert into workspace_users (workspace_id, login_id, moderator)
        values (${led!.id}, ${owner}, false)`;
    });
    expect(got).toEqual({ ...CLEAN, workspacesWithoutModerator: 1 });
    // The owner disabled: Admin has no Moderator who can sign in; Team still
    // has the member.
    const adminLess = await planted(async (tx) => {
      await tx`update auth.users set disabled_at = now() where id = ${owner}`;
    });
    expect(adminLess).toEqual({
      ...CLEAN,
      workspacesWithoutModerator: 1,
      adminWithoutModerator: 1,
    });
    expect(workspacesCheckFindings(adminLess)).toBe(1);
  });

  it('counts assistants not in exactly one workspace', async () => {
    const got = await planted(async (tx) => {
      await tx`update agents set workspace_id = null where id = ${persona}`;
    });
    expect(got).toEqual({ ...CLEAN, assistantsNotInOneWorkspace: 1 });
  });

  it('counts open links without a served key, as a finding once the key is in use', async () => {
    const link = (tx: postgres.TransactionSql, id: string, type: string, settings: object) =>
      tx`insert into shares (token, owner_id, node_id, node_type, settings)
         values (${randomUUID()}, ${owner}, ${id}, ${type}::node_type, ${tx.json(settings as never)})`;
    const before = await planted(async (tx) => {
      await link(tx, ids.page!, 'page', {});
      // Revoked and contact links are not open links.
      await tx`insert into shares (token, owner_id, node_id, node_type, revoked_at)
        values (${randomUUID()}, ${owner}, ${ids.app!}, 'app', now())`;
    });
    expect(before).toEqual({ ...CLEAN, linksWithoutServed: 1 });
    expect(workspacesCheckFindings(before)).toBe(0);
    const after = await planted(async (tx) => {
      await link(tx, ids.page!, 'page', {});
      await link(tx, ids.inFolder!, 'page', { served: true });
    });
    expect(after).toEqual({ ...CLEAN, linksWithoutServed: 1, linksServedInUse: true });
    expect(workspacesCheckFindings(after)).toBe(1);
  });

  it('the runner reads through the app pool in a read-only transaction', async () => {
    process.env.DATABASE_URL = scratch.url;
    process.env.MANTLE_MASTER_KEY ??= 'mantle-viewer-test-key';
    const { runWorkspacesCheck } = await import('./workspaces-check');
    expect(await runWorkspacesCheck()).toEqual(CLEAN);
  });
});
