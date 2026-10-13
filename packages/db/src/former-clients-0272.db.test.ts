/**
 * 0272 (workspaces W8a fix round 1, H1): a former client stays one, on
 * scratch databases migrated to just before 0272.
 *
 *  - a brain NOT on workspaces that had a client login is still skipped
 *    after 0272 (its client is a disabled member row now): the boot step
 *    (mantle_ws_migrate_locked) does not switch it, and nobody is added to
 *    a workspace (owner rule 21.9). A manual switch that says the clients
 *    were set up by hand (mantle.ws_former_clients = 'reviewed') goes
 *    ahead, and the bridge still gives the former client no row; nor does
 *    its spaces fold give it a private workspace: its draft goes to its
 *    Former user workspace (W8a fix round 2);
 *  - on a brain ALREADY on workspaces, every workspace row of a client
 *    login is archived (archive_client_workspace_users) and removed, with a
 *    workspace event each; a member's rows stay; a later role change (the
 *    login bridge) gives the former client nothing; its private workspace
 *    row is archived (archive_client_private_workspaces) and removed, and
 *    the migration itself renames that workspace "Former user", scrubs the
 *    name and description from its events and registers it (W8a leftover,
 *    closed in W8d; done in the migration since the W8 integration, as a
 *    migrated box never runs the review homes again); a second run changes
 *    nothing.
 *   MANTLE_TEST_DATABASE_URL=postgres://… pnpm vitest run packages/db/src/former-clients-0272.db.test.ts
 */
import { randomUUID } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import postgres from 'postgres';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createScratchDatabaseBefore } from './test-support';

const URL = process.env.MANTLE_TEST_DATABASE_URL;
const TAG = '0272_workspaces_logins_carry_nothing';

/** Run 0272 on `sql`, in one transaction, as migrate.ts does. */
async function run0272(sql: postgres.Sql): Promise<void> {
  const file = readFileSync(
    join(dirname(fileURLToPath(import.meta.url)), '..', 'migrations', `${TAG}.sql`),
    'utf8',
  );
  const statements = file
    .split('--> statement-breakpoint')
    .map((x) => x.trim())
    .filter(Boolean);
  await sql.begin(async (tx) => {
    for (const stmt of statements) await tx.unsafe(stmt);
  });
}

describe.skipIf(!URL)('0272: a brain not on workspaces that had a client', () => {
  let scratch: Awaited<ReturnType<typeof createScratchDatabaseBefore>>;
  let sql: ReturnType<typeof postgres>;
  const owner = randomUUID();
  const member = randomUUID();
  const client = randomUUID();
  // A draft in the client's personal space and one in the member's (W8a fix
  // round 2): the spaces fold of a manual switch homes them.
  const clientDraft = randomUUID();
  const memberDraft = randomUUID();

  const rowsOf = async (login: string) =>
    (
      await sql<{ key: string | null }[]>`
        select (case when w.is_admin then 'admin' when w.name = 'Team' then 'team' end) as key from workspace_users u
          join workspaces w on w.id = u.workspace_id
         where u.login_id = ${login} order by 1`
    ).map((r) => r.key);

  beforeAll(async () => {
    scratch = await createScratchDatabaseBefore(URL!, TAG);
    sql = postgres(scratch.url, { max: 2, prepare: false, onnotice: () => {} });
    await sql`insert into auth.users (id, email, password_hash, role, is_owner) values
      (${owner}, 'fc1-o@example.invalid', 'x', 'admin', true),
      (${member}, 'fc1-m@example.invalid', 'x', 'member', false),
      (${client}, 'fc1-c@example.invalid', 'x', 'client', false)`;
    await sql`insert into nodes (id, owner_id, type, title, path, audience)
      values (${randomUUID()}, ${owner}, 'page', 'fc1 team', 'pages', 'team')`;
    for (const [id, login] of [
      [clientDraft, client],
      [memberDraft, member],
    ] as const) {
      const [space] = await sql<{ id: string }[]>`
        select id::text as id from spaces where kind = 'personal' and login_id = ${login}`;
      await sql`insert into nodes (id, owner_id, type, title, path, audience)
        values (${id}, ${space!.id}, 'page', 'fc1 draft', 'pages', 'admin')`;
      await sql`insert into space_items (node_id, author_login_id, sharing, review_state)
        values (${id}, ${login}, 'private', 'draft')`;
    }
    // Before 0272 the box is skipped for its client login.
    expect((await sql`select mantle_ws_skip_reason() as r`)[0]!.r).toMatch(/^clients present/);
    await run0272(sql);
  }, 240_000);

  afterAll(async () => {
    await sql?.end();
    await scratch?.drop();
  });

  it('is still skipped at boot after 0272, and nobody is added to a workspace', async () => {
    // The client is a disabled member row now: only the archive says it
    // was a client.
    const [c] = await sql<{ role: string; disabled: boolean }[]>`
      select role, disabled_at is not null as disabled from auth.users where id = ${client}`;
    expect(c).toEqual({ role: 'member', disabled: true });
    expect((await sql`select mantle_ws_skip_reason() as r`)[0]!.r).toBe(
      'clients present: 1 client login(s), 0 client-level item(s)',
    );
    const rows = await sql<{ section: string; subject: string }[]>`
      select * from mantle_ws_migrate_locked()`;
    expect(rows.map((r) => [r.section, r.subject])).toEqual([
      ['skip', 'clients present: 1 client login(s), 0 client-level item(s)'],
    ]);
    expect(Number((await sql`select count(*) as n from workspaces`)[0]!.n)).toBe(0);
    expect(await rowsOf(client)).toEqual([]);
  });

  it('a deleted former client still counts: the brain had one', async () => {
    const other = randomUUID();
    await sql`insert into archive_client_logins (login_id, email, created_at, session_epoch)
      values (${other}, 'fc1-gone@example.invalid', now(), 0)`;
    try {
      expect((await sql`select mantle_ws_skip_reason() as r`)[0]!.r).toBe(
        'clients present: 2 client login(s), 0 client-level item(s)',
      );
    } finally {
      await sql`delete from archive_client_logins where login_id = ${other}`;
    }
  });

  it('a manual switch after the hand setup goes ahead; the former client gets no row', async () => {
    const rows = await sql.begin(async (tx) => {
      await tx`set local mantle.ws_former_clients = 'reviewed'`;
      return tx<{ section: string }[]>`select * from mantle_ws_migrate_locked()`;
    });
    expect(rows.filter((r) => r.section === 'skip' || r.section === 'reach-fail')).toEqual([]);
    expect((await sql`select mantle_ws_skip_reason() as r`)[0]!.r).toBeNull();
    expect(await rowsOf(owner)).toEqual(expect.arrayContaining(['admin', 'team']));
    expect(await rowsOf(member)).toContain('team');
    expect(await rowsOf(member)).not.toContain('admin');
    expect(await rowsOf(client)).toEqual([]);
  }, 60_000);

  it("homes the former client's draft in its Former user workspace, never a private one", async () => {
    // Runs after the manual switch above.
    const homeOf = async (id: string) =>
      (
        await sql<{ owner: string; home: string | null }[]>`
          select owner_id::text as owner, home_ws::text as home from nodes where id = ${id}`
      )[0]!;
    const draft = await homeOf(clientDraft);
    expect(draft.owner).toBe(owner);
    const [former] = await sql<{ ws: string; users: number }[]>`
      select f.workspace_id::text as ws,
             (select count(*)::int from workspace_users u where u.workspace_id = f.workspace_id) as users
        from former_user_workspaces f where f.former_key = ${client}`;
    expect(former).toBeDefined();
    expect(draft.home).toBe(former!.ws);
    expect(former!.users).toBe(0);
    expect(await sql`select 1 from private_workspaces where login_id = ${client}`).toHaveLength(0);
    // The member is homed as before (control): its own private workspace.
    const [own] = await sql<{ ws: string }[]>`
      select workspace_id::text as ws from private_workspaces where login_id = ${member}`;
    expect((await homeOf(memberDraft)).home).toBe(own!.ws);
    // The app's private workspace function makes none for a former client,
    // even were it enabled again.
    await sql`update auth.users set disabled_at = null where id = ${client}`;
    try {
      const [made] = await sql<{ ws: string | null }[]>`
        select mantle_ws_private_workspace(${client}::uuid)::text as ws`;
      expect(made!.ws).toBeNull();
    } finally {
      await sql`update auth.users set disabled_at = now() where id = ${client}`;
    }
    expect(await rowsOf(client)).toEqual([]);
  });
});

describe.skipIf(!URL)('0272: a brain already on workspaces with a client in a workspace', () => {
  let scratch: Awaited<ReturnType<typeof createScratchDatabaseBefore>>;
  let sql: ReturnType<typeof postgres>;
  const owner = randomUUID();
  const member = randomUUID();
  const client = randomUUID();
  const ws = { team: '', ops: '', own: '' };
  let memberOwn: { ws: string; name: string }[] = [];

  const rowsOf = async (login: string) =>
    (
      await sql<{ ws: string; moderator: boolean }[]>`
        select workspace_id::text as ws, moderator from workspace_users
         where login_id = ${login} order by 1`
    ).map((r) => [r.ws, r.moderator]);
  const snapshot = async () => ({
    users: await sql`select workspace_id::text, login_id::text, moderator from workspace_users
                      order by 1, 2`,
    archived: await sql`select workspace_id::text, login_id::text, moderator
                          from archive_client_workspace_users order by 1, 2`,
    privateRows: await sql`select login_id::text, workspace_id::text from private_workspaces
                            order by 1`,
    privateArchived: await sql`select login_id::text, workspace_id::text
                                 from archive_client_private_workspaces order by 1`,
    events: await sql`select count(*)::int as n from workspace_events`,
    former: await sql`select former_key::text, workspace_id::text from former_user_workspaces
                       order by 1`,
    names: await sql`select id::text, name, archived_at is null as live from workspaces
                      order by 1`,
  });

  beforeAll(async () => {
    scratch = await createScratchDatabaseBefore(URL!, TAG);
    sql = postgres(scratch.url, { max: 2, prepare: false, onnotice: () => {} });
    await sql`insert into auth.users (id, email, password_hash, role, is_owner) values
      (${owner}, 'fc2-o@example.invalid', 'x', 'admin', true),
      (${member}, 'fc2-m@example.invalid', 'x', 'member', false)`;
    await sql`select * from mantle_ws_migrate_locked()`;
    expect((await sql`select mantle_ws_skip_reason() as r`)[0]!.r).toBeNull();
    ws.team = String(
      (
        await sql`select id::text as id from workspaces
                  where owner_id = ${owner} and name = 'Team' and not is_admin`
      )[0]!.id,
    );
    ws.ops = String(
      (
        await sql`insert into workspaces (owner_id, name) values (${owner}, 'Ops')
                  returning id::text as id`
      )[0]!.id,
    );
    // A client login made after the switch, then put in two workspaces by
    // hand (a Moderator of Ops), and the member in Ops too.
    await sql`insert into auth.users (id, email, password_hash, role, is_owner)
      values (${client}, 'fc2-c@example.invalid', 'x', 'client', false)`;
    await sql`insert into workspace_users (workspace_id, login_id, moderator) values
      (${ws.team}, ${client}, false), (${ws.ops}, ${client}, true), (${ws.ops}, ${member}, false)
      on conflict (workspace_id, login_id) do nothing`;
    // The client's own private workspace, as the review homes make one (its
    // row and the event that names its login).
    ws.own = String(
      (
        await sql`insert into workspaces (owner_id, name) values (${owner}, 'fc2 (only you)')
                  returning id::text as id`
      )[0]!.id,
    );
    await sql`insert into private_workspaces (login_id, workspace_id) values (${client}, ${ws.own})`;
    await sql`insert into workspace_events (workspace_id, actor_id, action, subject)
      values (${ws.own}, null, 'review_off.private', ${sql.json({ login: client })}),
             (${ws.own}, ${client}, 'workspace.update',
              ${sql.json({ name: 'fc2 own name', description: 'fc2 own words', note: 'kept' })})`;
    // The member's own private workspace (control): 0272 leaves it alone.
    const [memberWs] = await sql<{ id: string }[]>`
      insert into workspaces (owner_id, name) values (${owner}, 'fc2m (only you)')
      returning id::text as id`;
    await sql`insert into private_workspaces (login_id, workspace_id)
      values (${member}, ${memberWs!.id}) on conflict (login_id) do nothing`;
    memberOwn = await sql<{ ws: string; name: string }[]>`
      select p.workspace_id::text as ws, w.name from private_workspaces p
        join workspaces w on w.id = p.workspace_id
       where p.login_id = ${member}`;
    expect(memberOwn).toHaveLength(1);
    await run0272(sql);
  }, 240_000);

  afterAll(async () => {
    await sql?.end();
    await scratch?.drop();
  });

  it("archives and removes every workspace row of the former client; a member's stay", async () => {
    expect(await rowsOf(client)).toEqual([]);
    const archived = await sql<{ ws: string; moderator: boolean }[]>`
      select workspace_id::text as ws, moderator from archive_client_workspace_users
       where login_id = ${client} order by 1`;
    expect(new Map(archived.map((r) => [r.ws, r.moderator]))).toEqual(
      new Map([
        [ws.team, false],
        [ws.ops, true],
      ]),
    );
    const events = await sql<{ ws: string }[]>`
      select workspace_id::text as ws from workspace_events
       where action = 'former_client.removed' and subject->>'login' = ${client} order by 1`;
    expect(events.map((e) => e.ws).sort()).toEqual([ws.team, ws.ops].sort());
    const mine = new Map((await rowsOf(member)).map(([w, m]) => [w, m]));
    expect(mine.get(ws.team)).toBe(true);
    expect(mine.get(ws.ops)).toBe(false);
    // The brain stays on workspaces.
    expect((await sql`select mantle_ws_skip_reason() as r`)[0]!.r).toBeNull();
  });

  it("archives and removes the former client's private workspace row, and the migration makes it Former user", async () => {
    expect(await sql`select 1 from private_workspaces where login_id = ${client}`).toHaveLength(0);
    const [arch] = await sql<{ ws: string }[]>`
      select workspace_id::text as ws from archive_client_private_workspaces
       where login_id = ${client}`;
    expect(arch?.ws).toBe(ws.own);
    // No review homes run here (W8 integration): the migration did it.
    const [w] = await sql<{ name: string; archived: boolean }[]>`
      select name, archived_at is not null as archived from workspaces where id = ${ws.own}`;
    expect(w).toEqual({ name: 'Former user', archived: false });
    const [f] = await sql<{ key: string }[]>`
      select former_key::text as key from former_user_workspaces where workspace_id = ${ws.own}`;
    expect(f?.key).toBe(client);
    // Its events keep no name or description it was given; the rest stays.
    const subjects = await sql<{ action: string; subject: Record<string, unknown> }[]>`
      select action, subject from workspace_events where workspace_id = ${ws.own} order by id`;
    expect(subjects.some((e) => 'name' in e.subject || 'description' in e.subject)).toBe(false);
    expect(subjects.find((e) => e.action === 'workspace.update')?.subject).toEqual({
      note: 'kept',
    });
    expect(subjects.filter((e) => e.action === 'review_off.former')).toHaveLength(1);
    // The member's private workspace rows are untouched (control): the same
    // row, the same name, live, and no Former user.
    expect(
      await sql<{ ws: string; name: string }[]>`
        select p.workspace_id::text as ws, w.name from private_workspaces p
          join workspaces w on w.id = p.workspace_id and w.archived_at is null
         where p.login_id = ${member}`,
    ).toEqual(memberOwn);
    expect(
      await sql`select 1 from former_user_workspaces where workspace_id = ${memberOwn[0]!.ws}`,
    ).toHaveLength(0);
    expect(
      await sql`select 1 from archive_client_private_workspaces where login_id = ${member}`,
    ).toHaveLength(0);
  }, 120_000);

  it('the login bridge gives the former client nothing, whatever its role', async () => {
    await sql`update auth.users set role = 'admin' where id = ${client}`;
    try {
      await sql`select mantle_bridge_login(${client}::uuid)`;
      expect(await rowsOf(client)).toEqual([]);
    } finally {
      await sql`update auth.users set role = 'member' where id = ${client}`;
    }
    // A member who never was a client is bridged as before (control).
    await sql`delete from workspace_users where workspace_id = ${ws.team} and login_id = ${member}`;
    await sql`select mantle_bridge_login(${member}::uuid)`;
    expect(new Map((await rowsOf(member)).map(([w, m]) => [w, m])).get(ws.team)).toBe(true);
  });

  it('a second run changes nothing', async () => {
    const before = await snapshot();
    await run0272(sql);
    expect(await snapshot()).toEqual(before);
  }, 120_000);
});
