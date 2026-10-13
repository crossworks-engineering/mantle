/**
 * Workspaces W5c (migrations 0263 and 0264).
 *
 * 0264, review states resolved without loss (plan 9.3): a scratch brain is
 * migrated up to 0263, switched onto workspaces (mantle_ws_migrate_locked),
 * and given one item in every review state; then 0264 and every later
 * migration run. Checked: each item's recorded home and grant flags, the
 * states resolved to draft with their review columns cleared (accepted,
 * sharing and the trash untouched), every row archived first, submissions
 * and bundles emptied, nothing written to nodes, apps or item_grants, the
 * switch guard clean, no extractor notify and the extract queue unchanged,
 * workspaces:check clean, and a second run changes nothing. A taken item
 * whose admin can no longer act on it gets Admin (not stranded); a disabled
 * admin's own team draft does not. A later run refreshes the grants from
 * live sharing and the trash. An accepted item whose author was erased
 * before 0264 keeps its brain home (Admin or Team) and gets no snapshot
 * copy: W6b copies an accepted item only into a private or Former user
 * workspace (the snapshot flag). A login deleted after 0264 leaves no
 * stranded home and no name: its private workspace becomes its Former user
 * workspace, and the names in its earlier events go too. A brain not on workspaces is archived and resolved by 0264 and
 * gets its homes when it switches later, one Former user workspace per
 * former user; a read given by hand since the switch does not stop 0264.
 *
 * 0263, the switch budget: mantle_ws_switch_budget() clamps and lengthens,
 * the deadline starts at mantle_ws_switch_off, the deadline error names the
 * time budget, and under a budget only the deadline ends the retries, with
 * a pause of at least 1 s between them.
 *   MANTLE_TEST_DATABASE_URL=postgres://… pnpm vitest run packages/db/src/workspaces-review-off.db.test.ts
 */
import { randomUUID } from 'node:crypto';
import postgres from 'postgres';
import { getTableConfig, type PgTable } from 'drizzle-orm/pg-core';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import {
  archiveSpaceItemBundles,
  archiveSpaceItems,
  archiveSpaceSubmissions,
} from './schema/archive/space-review';
import { formerUserWorkspaces, privateWorkspaces, spaceItemHomes } from './schema/space-item-homes';
import { createMigratedScratchDatabase, createScratchDatabaseBefore } from './test-support';
import {
  WORKSPACES_CHECK_SQL,
  parseWorkspacesCheck,
  workspacesCheckFindings,
} from './workspaces-check';

const URL = process.env.MANTLE_TEST_DATABASE_URL;
const BEFORE = '0264_workspaces_review_off';
// W6b (0267) moves the space items into the brain: these suites stop before it
// (workspaces-spaces-fold.db.test.ts picks up from here).
const FOLD = '0267_workspaces_spaces_fold';

type Sql = ReturnType<typeof postgres>;
type Home = {
  home: string;
  admin: boolean;
  team: boolean;
  write: boolean;
  state: string;
  sharing: string;
  role: string | null;
  snapshot: boolean;
};

/** The space id of a login's personal space. */
const spaceOf = async (sql: Sql, login: string) =>
  (
    await sql<
      { id: string }[]
    >`select id from spaces where kind = 'personal' and login_id = ${login}`
  )[0]!.id;

/** The counts of mantle_ws_review_homes_check() by metric. */
const reviewCheck = async (sql: Sql) =>
  Object.fromEntries(
    (
      await sql<{ metric: string; n: number }[]>`
      select metric, n::int as n from mantle_ws_review_homes_check()`
    ).map((r) => [r.metric, r.n]),
  );

/** Fingerprints of what 0264 must not write. */
const untouched = async (sql: Sql) =>
  (
    await sql<{ nodes: string; apps: string; grants: string; users: string }[]>`
      select (select count(*) || ':' || coalesce(sum(hashtext(concat_ws('|', id, owner_id, type, title,
                path, audience, updated_at, read_ws, write_ws, home_ws, data::text))), 0) from nodes) as nodes,
             (select count(*) || ':' || coalesce(sum(hashtext(row_to_json(a)::text)), 0) from apps a) as apps,
             (select count(*) || ':' || coalesce(sum(hashtext(row_to_json(g)::text)), 0) from item_grants g) as grants,
             (select count(*) || ':' || coalesce(sum(hashtext(row_to_json(u)::text)), 0) from auth.users u) as users`
  )[0]!;

describe.skipIf(!URL)('review states resolved without loss (0264)', () => {
  let scratch: Awaited<ReturnType<typeof createScratchDatabaseBefore>>;
  let sql: Sql;
  let listener: Sql;
  let m: typeof import('./index');
  const notified: string[] = [];
  const owner = randomUUID();
  const admin2 = randomUUID();
  const member = randomUUID();
  const gone = randomUUID();
  const disabled = randomUUID();
  const client = randomUUID();
  // Admins who took items and can no longer act on them (M1).
  const disAdmin = randomUUID();
  const goneAdmin = randomUUID();
  const demoted = randomUUID();
  const ids: Record<string, string> = {};
  const spaces: Record<string, string> = {};
  let goneSpace = '';
  let before: Awaited<ReturnType<typeof untouched>>;
  let queueBefore = 0;
  const archiveBefore = { items: 0, submissions: 0, bundles: 0 };
  let workspacesBefore = 0;
  const since = new Date(Date.now() - 86_400_000);

  const node = async (key: string, type: string, path: string, space: string) => {
    const id = randomUUID();
    await sql`insert into nodes (id, owner_id, type, title, path, audience)
      values (${id}, ${space}, ${type}::node_type, ${key}, ${path}::ltree, 'admin')`;
    ids[key] = id;
    return id;
  };
  /** A space item; the review columns as the review flows left them. */
  const item = async (
    key: string,
    author: string,
    state: string,
    sharing = 'private',
    extra: Partial<Record<'returned' | 'taken_by' | 'deleted' | 'accepted', string | boolean>> = {},
  ) => {
    await sql`insert into space_items (node_id, author_login_id, sharing, review_state,
        submitted_at, submitted_version, returned_note, reviewed_by, reviewed_at, accepted_at,
        taken_by, taken_at, taken_title, deleted_at)
      values (${ids[key]!}, ${author}, ${sharing}, ${state},
        ${state === 'submitted' || state === 'returned' || state === 'taken' ? new Date() : null},
        ${state === 'submitted' ? 3 : null},
        ${typeof extra.returned === 'string' ? extra.returned : null},
        ${state === 'returned' || state === 'accepted' ? owner : null},
        ${state === 'returned' || state === 'accepted' ? new Date() : null},
        ${state === 'accepted' ? new Date() : null},
        ${typeof extra.taken_by === 'string' ? extra.taken_by : null},
        ${state === 'taken' ? new Date() : null},
        ${state === 'taken' ? `${key} as the author named it` : null},
        ${extra.deleted ? new Date() : null})`;
  };
  const homes = async (): Promise<Record<string, Home>> => {
    const rows = await sql<(Home & { node: string })[]>`
      select h.node_id::text as node, h.home_workspace_id::text as home, h.grant_admin as admin,
             h.grant_team as team, h.write, h.state_before as state, h.sharing_before as sharing,
             h.author_role as role, h.snapshot
        from space_item_homes h`;
    const byId = Object.fromEntries(Object.entries(ids).map(([k, v]) => [v, k]));
    return Object.fromEntries(rows.map(({ node, ...h }) => [byId[node] ?? node, h]));
  };
  const privateOf = async (login: string) =>
    (
      await sql<{ id: string }[]>`select workspace_id::text as id from private_workspaces
        where login_id = ${login}`
    )[0]?.id;

  beforeAll(async () => {
    scratch = await createScratchDatabaseBefore(URL!, BEFORE);
    sql = postgres(scratch.url, { max: 3, prepare: false, onnotice: () => {} });
    await sql`insert into auth.users (id, email, password_hash, role, is_owner, display_name) values
      (${owner}, 'ro-o@example.invalid', 'x', 'admin', true, null),
      (${admin2}, 'ro-a@example.invalid', 'x', 'admin', false, 'Second admin'),
      (${member}, 'ro-m@example.invalid', 'x', 'member', false, 'Member One'),
      (${gone}, 'ro-g@example.invalid', 'x', 'member', false, null),
      (${disabled}, 'ro-d@example.invalid', 'x', 'member', false, null),
      (${disAdmin}, 'ro-da@example.invalid', 'x', 'admin', false, 'Disabled admin'),
      (${goneAdmin}, 'ro-ga@example.invalid', 'x', 'admin', false, null)`;
    // A fresh brain switched at boot (0261 and 0263), as a live box is
    // before 0264.
    const done = await sql<{ section: string }[]>`select * from mantle_ws_migrate_locked()`;
    expect(done.filter((r) => r.section === 'reach-fail')).toEqual([]);
    expect((await sql`select mantle_ws_skip_reason() as r`)[0]!.r).toBeNull();
    // A client set up by hand after the switch (21.9), and a login that is
    // no longer an admin (it took an item while it was one).
    await sql`insert into auth.users (id, email, password_hash, role) values
      (${client}, 'ro-c@example.invalid', 'x', 'client'),
      (${demoted}, 'ro-dm@example.invalid', 'x', 'member')`;
    for (const [k, v] of Object.entries({
      member,
      admin2,
      gone,
      disabled,
      client,
      disAdmin,
      goneAdmin,
      demoted,
    })) {
      spaces[k] = await spaceOf(sql, v);
    }
    goneSpace = spaces.gone!;

    // The member: every review state.
    await node('privDraft', 'page', 'pages', spaces.member!);
    await item('privDraft', member, 'draft');
    await node('teamDraft', 'note', 'notes', spaces.member!);
    await item('teamDraft', member, 'draft', 'team');
    await node('returned', 'page', 'pages', spaces.member!);
    await item('returned', member, 'returned', 'private', { returned: 'needs a source' });
    await node('teamReturned', 'page', 'pages', spaces.member!);
    await item('teamReturned', member, 'returned', 'team', { returned: 'almost' });
    await node('submitted', 'page', 'pages', spaces.member!);
    await item('submitted', member, 'submitted');
    // A submitted bundle: the root and a child page that renders in it.
    await node('bundleRoot', 'page', 'pages', spaces.member!);
    await item('bundleRoot', member, 'submitted');
    await node('bundleChild', 'page', 'pages', spaces.member!);
    await item('bundleChild', member, 'draft');
    await sql`insert into space_item_bundles (root_id, node_id, position) values
      (${ids.bundleRoot!}, ${ids.bundleRoot!}, 0), (${ids.bundleRoot!}, ${ids.bundleChild!}, 1)`;
    // A submitted team-shared app, with its app row.
    await node('teamApp', 'app', 'apps', spaces.member!);
    await sql`insert into apps (node_id, source) values (${ids.teamApp!}, '{"main":"x"}'::jsonb)`;
    await item('teamApp', member, 'submitted', 'team');
    // A trashed app shared with the team: it runs for no one.
    await node('trashedApp', 'app', 'apps', spaces.member!);
    await sql`insert into apps (node_id, source) values (${ids.trashedApp!}, '{}'::jsonb)`;
    await item('trashedApp', member, 'draft', 'team', { deleted: true });
    // Accepted: a brain item now, re-owned with its author kept.
    await node('accepted', 'page', 'pages', owner);
    await item('accepted', member, 'accepted');
    // Accepted, its author erased before 0264 archived it (no trace left):
    // no Former user workspace, it keeps the home it has in the brain.
    await node('acceptedNoAuthor', 'page', 'pages', owner);
    await sql`insert into space_items (node_id, author_login_id, sharing, review_state,
        reviewed_by, reviewed_at, accepted_at)
      values (${ids.acceptedNoAuthor!}, null, 'private', 'accepted', ${owner}, now(), now())`;
    // Taken over into the second admin's own space.
    await node('taken', 'page', 'pages', spaces.admin2!);
    await item('taken', member, 'taken', 'private', { taken_by: admin2 });
    await sql`insert into space_submissions (space_id, node_id) values
      (${spaces.member!}, ${ids.submitted!}), (${spaces.member!}, ${ids.bundleRoot!}),
      (${spaces.member!}, ${ids.teamApp!}), (${spaces.member!}, ${ids.taken!})`;
    // A login deleted with items left behind.
    await node('goneTeamDraft', 'page', 'pages', goneSpace);
    await item('goneTeamDraft', gone, 'draft', 'team');
    await node('goneSubmitted', 'page', 'pages', goneSpace);
    await item('goneSubmitted', gone, 'submitted');
    await node('gonePrivate', 'page', 'pages', goneSpace);
    await item('gonePrivate', gone, 'draft');
    // A disabled member's team-shared draft: left behind too.
    await node('disabledTeamDraft', 'page', 'pages', spaces.disabled!);
    await item('disabledTeamDraft', disabled, 'draft', 'team');
    // A client request, submitted.
    await node('clientRequest', 'page', 'pages', spaces.client!);
    await item('clientRequest', client, 'submitted');
    // Taken by admins who can no longer act on them: disabled, deleted, no
    // longer an admin (the old queue's "released" rule).
    await node('takenByDisabled', 'page', 'pages', spaces.disAdmin!);
    await item('takenByDisabled', member, 'taken', 'private', { taken_by: disAdmin });
    await node('takenByGone', 'page', 'pages', spaces.goneAdmin!);
    await item('takenByGone', member, 'taken', 'private', { taken_by: goneAdmin });
    await node('takenByDemoted', 'page', 'pages', spaces.demoted!);
    await item('takenByDemoted', member, 'taken', 'private', { taken_by: demoted });
    // A disabled admin's own team-shared draft: not left behind (L1).
    await node('disAdminTeamDraft', 'page', 'pages', spaces.disAdmin!);
    await item('disAdminTeamDraft', disAdmin, 'draft', 'team');
    await sql`update auth.users set disabled_at = now() where id in (${disabled}, ${disAdmin})`;
    await sql`delete from auth.users where id in (${gone}, ${goneAdmin})`;
    expect(
      (await sql`select login_id from spaces where id = ${goneSpace}`)[0]!.login_id,
    ).toBeNull();

    // The extract queue the boot drain would take, and an extractor listener.
    process.env.DATABASE_URL = scratch.url;
    process.env.MANTLE_MASTER_KEY ??= 'mantle-viewer-test-key';
    m = await import('./index');
    const queued = async () =>
      (
        await m.db
          .select({ id: m.nodes.id })
          .from(m.nodes)
          .where(m.unextractedNodeConds(owner, since))
      ).length;
    queueBefore = await queued();
    listener = postgres(scratch.url, { max: 1, prepare: false, onnotice: () => {} });
    await listener.listen('node_ingested', (p) => notified.push(p));

    before = await untouched(sql);
    const [c] = await sql<{ i: number; s: number; b: number; w: number }[]>`
      select (select count(*)::int from space_items) as i,
             (select count(*)::int from space_submissions) as s,
             (select count(*)::int from space_item_bundles) as b,
             (select count(*)::int from workspaces) as w`;
    archiveBefore.items = c!.i;
    archiveBefore.submissions = c!.s;
    archiveBefore.bundles = c!.b;
    workspacesBefore = c!.w;

    await scratch.migrateRest(FOLD);
    expect(await queued()).toBe(queueBefore);
  }, 240_000);

  afterAll(async () => {
    await listener?.end();
    await m?.closeDb();
    await sql?.end();
    await scratch?.drop();
  });

  it('records every home and the grants W6b writes (9.3)', async () => {
    const memberWs = await privateOf(member);
    const adminWs = await privateOf(admin2);
    const disabledWs = await privateOf(disabled);
    const clientWs = await privateOf(client);
    const disAdminWs = await privateOf(disAdmin);
    const demotedWs = await privateOf(demoted);
    // Deleted before 0264 archived anything: keyed by the personal space.
    const [former] = await sql<{ id: string }[]>`
      select workspace_id::text as id from former_user_workspaces where former_key = ${goneSpace}`;
    const [formerAdmin] = await sql<{ id: string }[]>`
      select workspace_id::text as id from former_user_workspaces
       where former_key = ${spaces.goneAdmin!}`;
    expect(
      [
        memberWs,
        adminWs,
        disabledWs,
        clientWs,
        disAdminWs,
        demotedWs,
        former?.id,
        formerAdmin?.id,
      ].every(Boolean),
    ).toBe(true);
    const h = await homes();
    const want = (
      home: string,
      admin: boolean,
      team: boolean,
      state: string,
      sharing: string,
      role: string | null,
      snapshot = false,
    ): Home => ({ home, admin, team, write: false, state, sharing, role, snapshot });
    // Its home in the brain now: its home grant, else the Admin workspace.
    const [kept] = await sql<{ id: string }[]>`
      select coalesce((select workspace_id::text from item_grants
                        where node_id = ${ids.acceptedNoAuthor!} and is_home),
                      (select id::text from workspaces where is_admin)) as id`;
    expect(h).toEqual({
      privDraft: want(memberWs!, false, false, 'draft', 'private', 'member'),
      teamDraft: want(memberWs!, false, true, 'draft', 'team', 'member'),
      returned: want(memberWs!, false, false, 'returned', 'private', 'member'),
      teamReturned: want(memberWs!, false, true, 'returned', 'team', 'member'),
      submitted: want(memberWs!, true, false, 'submitted', 'private', 'member'),
      bundleRoot: want(memberWs!, true, false, 'submitted', 'private', 'member'),
      // In a submitted bundle: counts as submitted.
      bundleChild: want(memberWs!, true, false, 'draft', 'private', 'member'),
      teamApp: want(memberWs!, true, true, 'submitted', 'team', 'member'),
      trashedApp: want(memberWs!, false, false, 'draft', 'team', 'member'),
      // Where the author's snapshot copy goes (S3).
      accepted: want(memberWs!, false, false, 'accepted', 'private', 'member', true),
      // No author left: its brain home, no shared per-brain Former user one,
      // and no snapshot copy (W6b RULE).
      acceptedNoAuthor: want(kept!.id, false, false, 'accepted', 'private', null),
      // In the admin's own space.
      taken: want(adminWs!, false, false, 'taken', 'private', 'member'),
      goneTeamDraft: want(former!.id, true, false, 'draft', 'team', 'member'),
      goneSubmitted: want(former!.id, true, false, 'submitted', 'private', 'member'),
      gonePrivate: want(former!.id, false, false, 'draft', 'private', 'member'),
      disabledTeamDraft: want(disabledWs!, true, false, 'draft', 'team', 'member'),
      clientRequest: want(clientWs!, true, true, 'submitted', 'private', 'client'),
      // Released (M1): its admin cannot act on it, so Admin gets it.
      takenByDisabled: want(disAdminWs!, true, false, 'taken', 'private', 'member'),
      takenByGone: want(formerAdmin!.id, true, false, 'taken', 'private', 'member'),
      takenByDemoted: want(demotedWs!, true, false, 'taken', 'private', 'member'),
      // A disabled admin's own team draft is not left behind (L1).
      disAdminTeamDraft: want(disAdminWs!, false, false, 'draft', 'team', 'admin'),
    });
  });

  it('makes private workspaces (the login alone, a Moderator) and a Former user one (no users)', async () => {
    const rows = await sql<
      {
        login: string;
        name: string;
        key: string | null;
        admin: boolean;
        by: string | null;
        users: { login: string; moderator: boolean }[];
      }[]
    >`
      select p.login_id::text as login, w.name, (case when w.is_admin then 'admin' when w.name = 'Team' then 'team' end) as key, w.is_admin as admin,
             w.created_by::text as by,
             (select coalesce(json_agg(json_build_object('login', u.login_id, 'moderator', u.moderator)), '[]')
                from workspace_users u where u.workspace_id = w.id) as users
        from private_workspaces p join workspaces w on w.id = p.workspace_id
       order by w.name`;
    expect(rows.map((r) => r.login).sort()).toEqual(
      [admin2, client, disabled, member, disAdmin, demoted].sort(),
    );
    for (const r of rows) {
      expect(r.name.endsWith(' (only you)')).toBe(true);
      expect(r).toMatchObject({ key: null, admin: false, by: r.login });
      expect(r.users).toEqual([{ login: r.login, moderator: true }]);
    }
    expect(rows.find((r) => r.login === member)!.name).toBe('Member One (only you)');
    // No display name: the email's local part.
    expect(rows.find((r) => r.login === disabled)!.name).toBe('ro-d (only you)');
    const former = await sql<{ name: string; users: number; key: string | null }[]>`
      select w.name, (case when w.is_admin then 'admin' when w.name = 'Team' then 'team' end) as key,
             (select count(*)::int from workspace_users u where u.workspace_id = w.id) as users
        from former_user_workspaces f join workspaces w on w.id = f.workspace_id`;
    // One per former user (L2): the deleted member's and the deleted admin's;
    // none for the accepted item with no author.
    expect(
      (
        await sql`select 1 from former_user_workspaces
                   where former_key = (select mantle_brain_id())`
      ).length,
    ).toBe(0);
    expect(former).toEqual([
      { name: 'Former user', key: null, users: 0 },
      { name: 'Former user', key: null, users: 0 },
    ]);
    const [n] = await sql<{ n: number }[]>`select count(*)::int as n from workspaces`;
    expect(n!.n).toBe(workspacesBefore + 8);
  });

  it('resolves the states, keeps accepted, sharing and the trash, and clears the review rows', async () => {
    const rows = await sql<
      {
        id: string;
        state: string;
        sharing: string;
        cleared: boolean;
        deleted: boolean;
        accepted: boolean;
      }[]
    >`
      select node_id::text as id, review_state as state, sharing,
             (submitted_at is null and submitted_version is null and returned_note is null
              and taken_by is null and taken_at is null and taken_root is null
              and taken_title is null) as cleared,
             deleted_at is not null as deleted,
             (accepted_at is not null and reviewed_by is not null) as accepted
        from space_items`;
    const byKey = Object.fromEntries(
      rows.map((r) => [Object.entries(ids).find(([, v]) => v === r.id)![0], r]),
    );
    for (const [k, r] of Object.entries(byKey)) {
      if (k.startsWith('accepted')) {
        expect(r).toMatchObject({ state: 'accepted', accepted: true });
      } else {
        expect(r, k).toMatchObject({ state: 'draft', cleared: true });
      }
    }
    expect(byKey.teamDraft!.sharing).toBe('team');
    expect(byKey.teamApp!.sharing).toBe('team');
    expect(byKey.trashedApp!.deleted).toBe(true);
    expect(Number((await sql`select count(*) as n from space_submissions`)[0]!.n)).toBe(0);
    expect(Number((await sql`select count(*) as n from space_item_bundles`)[0]!.n)).toBe(0);
  });

  it('archived every row first, review columns included', async () => {
    const [c] = await sql<{ i: number; s: number; b: number }[]>`
      select (select count(*)::int from archive_space_items) as i,
             (select count(*)::int from archive_space_submissions) as s,
             (select count(*)::int from archive_space_item_bundles) as b`;
    expect(c).toEqual({
      i: archiveBefore.items,
      s: archiveBefore.submissions,
      b: archiveBefore.bundles,
    });
    const [ret] = await sql<{ state: string; note: string }[]>`
      select review_state as state, returned_note as note from archive_space_items
       where node_id = ${ids.returned!}`;
    expect(ret).toEqual({ state: 'returned', note: 'needs a source' });
    const [tk] = await sql<{ state: string; by: string; title: string }[]>`
      select review_state as state, taken_by::text as by, taken_title as title
        from archive_space_items where node_id = ${ids.taken!}`;
    expect(tk).toEqual({ state: 'taken', by: admin2, title: 'taken as the author named it' });
  });

  it('writes no node, app, grant or login, and starts no LLM work', async () => {
    const after = await untouched(sql);
    expect(after.nodes).toBe(before.nodes);
    expect(after.apps).toBe(before.apps);
    expect(after.grants).toBe(before.grants);
    expect(after.users).toBe(before.users);
    const personalGrants = await sql`
      select 1 from item_grants g join nodes n on n.id = g.node_id
        join spaces s on s.id = n.owner_id and s.kind = 'personal'`;
    expect(personalGrants).toHaveLength(0);
    await new Promise((r) => setTimeout(r, 300));
    expect(notified).toEqual([]);
  });

  it('passes its check, the switch guard and workspaces:check', async () => {
    expect(await reviewCheck(sql)).toMatchObject({
      'space_items rows': archiveBefore.items,
      homes: archiveBefore.items,
      'items without a home': 0,
      'rows not archived': 0,
      'items still submitted, returned or taken': 0,
      'open submissions': 0,
      bundles: 0,
      'private workspaces': 6,
      'former user workspaces': 2,
      'homes with a snapshot copy': 1,
      'snapshot homes outside a private or Former user workspace': 0,
    });
    const guard = await sql.begin(
      (tx) => tx<{ section: string }[]>`select * from mantle_ws_switch_guard()`,
    );
    expect(guard.filter((r) => r.section === 'reach-fail')).toEqual([]);
    const [row] = await sql.unsafe(WORKSPACES_CHECK_SQL);
    const check = parseWorkspacesCheck(
      row as unknown as Parameters<typeof parseWorkspacesCheck>[0],
    );
    // The Former user workspace (no users) and the disabled login's
    // private workspace are not findings.
    expect(check.workspacesWithoutModerator).toBe(0);
    expect(workspacesCheckFindings(check)).toBe(0);
  });

  it('a second run changes nothing; a draft made later gets its home', async () => {
    const homesBefore = await homes();
    const fp = await untouched(sql);
    const rows = await sql<{ section: string; subject: string; n: number }[]>`
      select section, subject, n::int as n from mantle_ws_review_off()`;
    expect(rows.filter((r) => r.section !== 'proof' && r.n !== 0)).toEqual([]);
    expect(await homes()).toEqual(homesBefore);
    expect(await untouched(sql)).toEqual(fp);
    // A draft made after 0264 (until W6b members still make them): the next
    // run records it, in the private workspace already made.
    await node('later', 'note', 'notes', spaces.member!);
    await item('later', member, 'draft');
    const again = await sql<{ section: string; subject: string; n: number }[]>`
      select section, subject, n::int as n from mantle_ws_review_off()`;
    expect(again.find((r) => r.subject === 'private workspaces')!.n).toBe(0);
    expect((await homes()).later).toMatchObject({
      home: await privateOf(member),
      admin: false,
      team: false,
    });
  });

  it('a later run refreshes the grants from live sharing and the trash (M2)', async () => {
    const run = async () =>
      (
        await sql<{ subject: string; n: number }[]>`
          select subject, n::int as n from mantle_ws_review_off()`
      ).find((r) => r.subject === 'grants refreshed')!.n;
    const pick = async (k: string) => {
      const h = (await homes())[k]!;
      return { admin: h.admin, team: h.team, state: h.state, sharing: h.sharing };
    };
    // The member makes the submitted team app private (my_app_unshare).
    await sql`update space_items set sharing = 'private' where node_id = ${ids.teamApp!}`;
    expect(await run()).toBe(1);
    // Admin stays (it was submitted); Team goes. The record of before stays.
    expect(await pick('teamApp')).toEqual({
      admin: true,
      team: false,
      state: 'submitted',
      sharing: 'team',
    });
    // Then trashes it: no grants.
    await sql`update space_items set deleted_at = now() where node_id = ${ids.teamApp!}`;
    expect(await run()).toBe(1);
    expect(await pick('teamApp')).toMatchObject({ admin: false, team: false });
    // And brings it back, private (my-apps undelete).
    await sql`update space_items set deleted_at = null, sharing = 'private'
      where node_id = ${ids.teamApp!}`;
    expect(await run()).toBe(1);
    expect(await pick('teamApp')).toMatchObject({ admin: true, team: false });
    // An app made after 0264, shared with the team in the app.
    await node('laterApp', 'app', 'apps', spaces.member!);
    await sql`insert into apps (node_id, source) values (${ids.laterApp!}, '{}'::jsonb)`;
    await item('laterApp', member, 'draft');
    expect(await run()).toBe(0);
    expect(await pick('laterApp')).toMatchObject({ admin: false, team: false });
    await sql`update space_items set sharing = 'team' where node_id = ${ids.laterApp!}`;
    expect(await run()).toBe(1);
    expect(await pick('laterApp')).toMatchObject({ admin: false, team: true });
    // The trashed team app (trashed before 0264) brought back and shared.
    await sql`update space_items set deleted_at = null where node_id = ${ids.trashedApp!}`;
    expect(await run()).toBe(1);
    expect(await pick('trashedApp')).toMatchObject({ admin: false, team: true });
    // Nothing changed since: nothing refreshed.
    expect(await run()).toBe(0);
  });

  it('W6b makes a snapshot copy only into a private or Former user workspace', async () => {
    const run = async () =>
      (
        await sql<{ subject: string; n: number }[]>`
          select subject, n::int as n from mantle_ws_review_off()`
      ).find((r) => r.subject === 'snapshot flag set by the rule')!.n;
    // Only the accepted item homed in its author's private workspace.
    const flagged = await sql<{ id: string }[]>`
      select node_id::text as id from space_item_homes where snapshot`;
    expect(flagged.map((r) => r.id)).toEqual([ids.accepted]);
    // A hand edit that asks for a copy into the Admin workspace is undone by
    // the next run.
    await sql`update space_item_homes set snapshot = true
      where node_id = ${ids.acceptedNoAuthor!}`;
    expect(
      (await reviewCheck(sql))['snapshot homes outside a private or Former user workspace'],
    ).toBe(1);
    expect(await run()).toBe(1);
    expect((await homes()).acceptedNoAuthor!.snapshot).toBe(false);
    expect((await reviewCheck(sql))['homes with a snapshot copy']).toBe(1);
    // An item that was not accepted is never copied (the table refuses it).
    await expect(
      sql`update space_item_homes set snapshot = true where node_id = ${ids.privDraft!}`,
    ).rejects.toMatchObject({ code: '23514' });
    expect(await run()).toBe(0);
  });

  it('the drizzle schema of the new tables is the tables 0264 makes', async () => {
    const tables: [string, PgTable][] = [
      ['archive_space_items', archiveSpaceItems],
      ['archive_space_submissions', archiveSpaceSubmissions],
      ['archive_space_item_bundles', archiveSpaceItemBundles],
      ['private_workspaces', privateWorkspaces],
      ['former_user_workspaces', formerUserWorkspaces],
      ['space_item_homes', spaceItemHomes],
    ];
    const UDT: Record<string, string> = {
      uuid: 'uuid',
      text: 'text',
      integer: 'int4',
      boolean: 'bool',
      'timestamp with time zone': 'timestamptz',
    };
    for (const [name, table] of tables) {
      const config = getTableConfig(table);
      const pk = new Set(config.primaryKeys.flatMap((p) => p.columns.map((c) => c.name)));
      // The suite stops before 0267, which adds snapshot_node_id (W6b).
      const expected = config.columns
        .filter((c) => !(name === 'space_item_homes' && c.name === 'snapshot_node_id'))
        .map((c) => ({
          column: c.name,
          udt: UDT[c.getSQLType()] ?? c.getSQLType(),
          nullable: c.notNull || c.primary || pk.has(c.name) ? 'NO' : 'YES',
        }))
        .sort((a, b) => a.column.localeCompare(b.column));
      const actual = await sql<{ column: string; udt: string; nullable: string }[]>`
        select column_name as column, udt_name as udt, is_nullable as nullable
          from information_schema.columns
         where table_schema = 'public' and table_name = ${name}
         order by column_name`;
      expect([...actual], name).toEqual(expected);
    }
    // Each archive has its source's columns (name, type, NOT NULL), plus
    // archived_at.
    for (const source of ['space_items', 'space_submissions', 'space_item_bundles']) {
      const cols = (t: string) => sql<{ column: string; udt: string; nullable: string }[]>`
        select column_name as column, udt_name as udt, is_nullable as nullable
          from information_schema.columns
         where table_schema = 'public' and table_name = ${t} and column_name <> 'archived_at'
         order by column_name`;
      expect([...(await cols(`archive_${source}`))], source).toEqual([...(await cols(source))]);
    }
  });
});

// A brain NOT on workspaces when 0264 runs (clients present, 21.9): its
// review states are archived and resolved now; its homes are recorded when
// it is set up and switched (mantle_ws_migrate), from the archive.
describe.skipIf(!URL)('a brain not on workspaces gets its homes when it switches (0264)', () => {
  let scratch: Awaited<ReturnType<typeof createScratchDatabaseBefore>>;
  let sql: Sql;
  const owner = randomUUID();
  const member = randomUUID();
  const client = randomUUID();
  const ids: Record<string, string> = {};

  beforeAll(async () => {
    scratch = await createScratchDatabaseBefore(URL!, BEFORE);
    sql = postgres(scratch.url, { max: 2, prepare: false, onnotice: () => {} });
    await sql`insert into auth.users (id, email, password_hash, role, is_owner) values
      (${owner}, 'rn-o@example.invalid', 'x', 'admin', true),
      (${member}, 'rn-m@example.invalid', 'x', 'member', false),
      (${client}, 'rn-c@example.invalid', 'x', 'client', false)`;
    const space = await spaceOf(sql, member);
    for (const k of ['submitted', 'teamDraft']) {
      ids[k] = randomUUID();
      await sql`insert into nodes (id, owner_id, type, title, path, audience)
        values (${ids[k]!}, ${space}, 'page', ${k}, 'pages', 'admin')`;
    }
    await sql`insert into space_items (node_id, author_login_id, sharing, review_state, submitted_at)
      values (${ids.submitted!}, ${member}, 'private', 'submitted', now()),
             (${ids.teamDraft!}, ${member}, 'team', 'draft', null)`;
    await sql`insert into space_item_bundles (root_id, node_id, position)
      values (${ids.submitted!}, ${ids.submitted!}, 0)`;
    await sql`insert into space_submissions (space_id, node_id) values (${space}, ${ids.submitted!})`;
    expect((await sql`select mantle_ws_skip_reason() as r`)[0]!.r).toMatch(/^clients present/);
    await scratch.migrateRest(FOLD);
  }, 240_000);

  afterAll(async () => {
    await sql?.end();
    await scratch?.drop();
  });

  it('archives and resolves now, records no home and makes no workspace', async () => {
    expect(await reviewCheck(sql)).toMatchObject({
      'space_items rows': 2,
      homes: 0,
      'items without a home': 2,
      'archive rows: space_items': 2,
      'archive rows: space_submissions': 1,
      'archive rows: space_item_bundles': 1,
      'items still submitted, returned or taken': 0,
      'open submissions': 0,
      bundles: 0,
      'private workspaces': 0,
    });
    expect(Number((await sql`select count(*) as n from workspaces`)[0]!.n)).toBe(0);
  });

  it('records the homes from the archive when the brain switches', async () => {
    await sql`delete from auth.users where id = ${client}`;
    const rows = await sql<{ section: string }[]>`select * from mantle_ws_migrate_locked()`;
    expect(rows.filter((r) => r.section === 'reach-fail')).toEqual([]);
    expect(rows.some((r) => r.section.startsWith('review off'))).toBe(true);
    const h = await sql<{ id: string; admin: boolean; team: boolean; state: string }[]>`
      select node_id::text as id, grant_admin as admin, grant_team as team, state_before as state
        from space_item_homes order by state_before`;
    expect(h).toEqual([
      { id: ids.teamDraft, admin: false, team: true, state: 'draft' },
      // Resolved to draft by 0264; the archive still says submitted.
      { id: ids.submitted, admin: true, team: false, state: 'submitted' },
    ]);
    expect((await reviewCheck(sql))['items without a home']).toBe(0);
  });
});

// One "Former user" workspace per former user (L2): logins deleted after
// 0264 archived their items (a brain not on workspaces then) are keyed by
// their login id, so a member's accepted item and personal items share one
// workspace, and two former members get two.
describe.skipIf(!URL)('one Former user workspace per former user (0264)', () => {
  let scratch: Awaited<ReturnType<typeof createScratchDatabaseBefore>>;
  let sql: Sql;
  const owner = randomUUID();
  const memberA = randomUUID();
  const memberB = randomUUID();
  const client = randomUUID();
  const ids: Record<string, string> = {};

  beforeAll(async () => {
    scratch = await createScratchDatabaseBefore(URL!, BEFORE);
    sql = postgres(scratch.url, { max: 2, prepare: false, onnotice: () => {} });
    await sql`insert into auth.users (id, email, password_hash, role, is_owner) values
      (${owner}, 'rf-o@example.invalid', 'x', 'admin', true),
      (${memberA}, 'rf-a@example.invalid', 'x', 'member', false),
      (${memberB}, 'rf-b@example.invalid', 'x', 'member', false),
      (${client}, 'rf-c@example.invalid', 'x', 'client', false)`;
    for (const [login, tag] of [
      [memberA, 'A'],
      [memberB, 'B'],
    ] as const) {
      const space = await spaceOf(sql, login);
      for (const [k, where, state, sharing] of [
        [`draft${tag}`, space, 'draft', 'team'],
        [`accepted${tag}`, owner, 'accepted', 'private'],
      ] as const) {
        ids[k] = randomUUID();
        await sql`insert into nodes (id, owner_id, type, title, path, audience)
          values (${ids[k]!}, ${where}, 'page', ${k}, 'pages', 'admin')`;
        await sql`insert into space_items (node_id, author_login_id, sharing, review_state, accepted_at)
          values (${ids[k]!}, ${login}, ${sharing}, ${state},
                  ${state === 'accepted' ? new Date() : null})`;
      }
    }
    expect((await sql`select mantle_ws_skip_reason() as r`)[0]!.r).toMatch(/^clients present/);
    // 0264 archives the items while both logins still exist.
    await scratch.migrateRest(FOLD);
    await sql`delete from auth.users where id in (${memberA}, ${memberB}, ${client})`;
    await sql`select * from mantle_ws_migrate_locked()`;
  }, 240_000);

  afterAll(async () => {
    await sql?.end();
    await scratch?.drop();
  });

  it('keys each by the former login, accepted and personal items together', async () => {
    const formers = await sql<{ key: string; ws: string }[]>`
      select former_key::text as key, workspace_id::text as ws from former_user_workspaces`;
    expect(formers.map((f) => f.key).sort()).toEqual([memberA, memberB].sort());
    const wsOf = Object.fromEntries(formers.map((f) => [f.key, f.ws]));
    const h = await sql<{ id: string; home: string; admin: boolean; snapshot: boolean }[]>`
      select node_id::text as id, home_workspace_id::text as home, grant_admin as admin, snapshot
        from space_item_homes`;
    const homeOf = Object.fromEntries(h.map((r) => [r.id, r]));
    expect(homeOf[ids.draftA!]!.home).toBe(wsOf[memberA]);
    expect(homeOf[ids.acceptedA!]!.home).toBe(wsOf[memberA]);
    expect(homeOf[ids.draftB!]!.home).toBe(wsOf[memberB]);
    expect(homeOf[ids.acceptedB!]!.home).toBe(wsOf[memberB]);
    // A member's team draft whose login is gone: left behind, Admin.
    expect(homeOf[ids.draftA!]!.admin).toBe(true);
    expect(homeOf[ids.acceptedA!]!.admin).toBe(false);
    // The author's snapshot copy goes to its Former user workspace.
    expect(homeOf[ids.acceptedA!]!.snapshot).toBe(true);
    expect(homeOf[ids.draftA!]!.snapshot).toBe(false);
  });
});

// Homes are kept current: a member hard-deleted after 0264 recorded its
// homes takes its private_workspaces row with it (cascade). The next run
// turns its private workspace into its Former user workspace (keyed by its
// login id, renamed: no name left), and an item whose home is no longer a
// registered workspace moves to its former login's Former user workspace.
describe.skipIf(!URL)('a login deleted after 0264 leaves no stranded home (0264)', () => {
  let scratch: Awaited<ReturnType<typeof createScratchDatabaseBefore>>;
  let sql: Sql;
  const owner = randomUUID();
  const member = randomUUID();
  // A second member whose login already has a Former user workspace (a hand
  // edit): its orphan is renamed and archived, its items move there.
  const other = randomUUID();
  const ids: Record<string, string> = {};
  const privateWs: Record<string, string> = {};
  let handFormer = '';

  const homeOf = async () =>
    Object.fromEntries(
      (
        await sql<{ id: string; home: string; admin: boolean; team: boolean; snapshot: boolean }[]>`
          select node_id::text as id, home_workspace_id::text as home,
                 grant_admin as admin, grant_team as team, snapshot from space_item_homes`
      ).map((r) => [r.id, r]),
    );

  beforeAll(async () => {
    scratch = await createScratchDatabaseBefore(URL!, BEFORE);
    sql = postgres(scratch.url, { max: 2, prepare: false, onnotice: () => {} });
    await sql`insert into auth.users (id, email, password_hash, role, is_owner, display_name) values
      (${owner}, 'rd-o@example.invalid', 'x', 'admin', true, null),
      (${member}, 'rd-m@example.invalid', 'x', 'member', false, 'Leaver Name'),
      (${other}, 'rd-x@example.invalid', 'x', 'member', false, 'Other Leaver')`;
    await sql`select * from mantle_ws_migrate_locked()`;
    for (const [login, tag] of [
      [member, 'M'],
      [other, 'X'],
    ] as const) {
      const space = await spaceOf(sql, login);
      for (const [k, where, state, sharing] of [
        [`teamDraft${tag}`, space, 'draft', 'team'],
        [`privDraft${tag}`, space, 'draft', 'private'],
        [`accepted${tag}`, owner, 'accepted', 'private'],
      ] as const) {
        ids[k] = randomUUID();
        await sql`insert into nodes (id, owner_id, type, title, path, audience)
          values (${ids[k]!}, ${where}, 'page', ${k}, 'pages', 'admin')`;
        await sql`insert into space_items (node_id, author_login_id, sharing, review_state, accepted_at)
          values (${ids[k]!}, ${login}, ${sharing}, ${state},
                  ${state === 'accepted' ? new Date() : null})`;
      }
    }
    // 0264 records the homes in each member's private workspace.
    await scratch.migrateRest(FOLD);
    for (const login of [member, other]) {
      privateWs[login] = (
        await sql<{ id: string }[]>`
          select workspace_id::text as id from private_workspaces where login_id = ${login}`
      )[0]!.id;
    }
    expect((await sql`select name from workspaces where id = ${privateWs[member]!}`)[0]!.name).toBe(
      'Leaver Name (only you)',
    );
    // Each renames its private workspace (PATCH /api/workspaces/:id writes
    // a workspace.update event with the new name and description).
    for (const login of [member, other]) {
      await sql`insert into workspace_events (workspace_id, actor_id, action, subject)
        values (${privateWs[login]!}, ${login}, 'workspace.update',
                ${sql.json({ name: 'Leaver notes', description: 'What the leaver keeps' })})`;
      await sql`insert into workspace_events (workspace_id, actor_id, action, subject)
        values (${privateWs[login]!}, ${login}, 'workspace.update',
                ${sql.json({ name: 'Leaver notes 2', contactNodeId: null })})`;
    }
    handFormer = (
      await sql<{ id: string }[]>`
        insert into workspaces (owner_id, name) values (mantle_brain_id(), 'Former user')
        returning id::text as id`
    )[0]!.id;
    await sql`insert into former_user_workspaces (former_key, workspace_id)
      values (${other}, ${handFormer})`;
    // Both are hard-deleted after 0264, before W6b.
    await sql`delete from auth.users where id in (${member}, ${other})`;
    expect(
      (await sql`select 1 from private_workspaces where login_id in (${member}, ${other})`).length,
    ).toBe(0);
  }, 240_000);

  afterAll(async () => {
    await sql?.end();
    await scratch?.drop();
  });

  it('the next run makes the orphan the Former user workspace and moves stranded homes', async () => {
    const rows = await sql<{ subject: string; n: number }[]>`
      select subject, n::int as n from mantle_ws_review_off()`;
    const n = (subject: string) => rows.find((r) => r.subject === subject)!.n;
    expect(n('private workspaces of removed logins')).toBe(2);
    // The second member's items leave its orphan for its Former user one.
    expect(n('moved off a removed workspace')).toBe(3);
    expect(n('former user workspaces')).toBe(0);
    // The renames of both orphans (two events each) lose their names.
    expect(n('events of those workspaces')).toBe(4);

    const formers = Object.fromEntries(
      (
        await sql<{ key: string; ws: string }[]>`
          select former_key::text as key, workspace_id::text as ws from former_user_workspaces`
      ).map((f) => [f.key, f.ws]),
    );
    // Keyed by the login id: the member's own private workspace, taken over.
    expect(formers[member]).toBe(privateWs[member]);
    expect(formers[other]).toBe(handFormer);
    const h = await homeOf();
    for (const k of ['teamDraftM', 'privDraftM', 'acceptedM']) {
      expect(h[ids[k]!]!.home, k).toBe(privateWs[member]);
    }
    for (const k of ['teamDraftX', 'privDraftX', 'acceptedX']) {
      expect(h[ids[k]!]!.home, k).toBe(handFormer);
    }
    // Its login gone: the team draft is left behind, Admin gets it.
    expect(h[ids.teamDraftM!]).toMatchObject({ admin: true, team: false });
    expect(h[ids.acceptedM!]).toMatchObject({ admin: false, team: false });

    // No name left anywhere: both orphans are "Former user", no users, no
    // creator; the one the login had a workspace for already is archived.
    const ws = await sql<
      { id: string; name: string; users: number; by: string | null; archived: boolean }[]
    >`
      select w.id::text as id, w.name, w.created_by::text as by, w.archived_at is not null as archived,
             (select count(*)::int from workspace_users u where u.workspace_id = w.id) as users
        from workspaces w where w.id in (${privateWs[member]!}, ${privateWs[other]!})`;
    const byId = Object.fromEntries(ws.map((w) => [w.id, w]));
    expect(byId[privateWs[member]!]).toMatchObject({
      name: 'Former user',
      users: 0,
      by: null,
      archived: false,
    });
    expect(byId[privateWs[other]!]).toMatchObject({
      name: 'Former user',
      users: 0,
      by: null,
      archived: true,
    });
    const named = await sql`
      select 1 from workspaces where name ilike '%leaver%' or description ilike '%leaver%'`;
    expect(named).toHaveLength(0);
    // Nor in their events: the update events stay, without the name and
    // description; what else they said is kept.
    const events = await sql<{ action: string; subject: Record<string, unknown> }[]>`
      select action, subject from workspace_events
       where workspace_id in (${privateWs[member]!}, ${privateWs[other]!})
         and action = 'workspace.update'`;
    expect(events).toHaveLength(4);
    for (const e of events) {
      expect(e.subject).not.toHaveProperty('name');
      expect(e.subject).not.toHaveProperty('description');
    }
    expect(events.filter((e) => 'contactNodeId' in e.subject)).toHaveLength(2);
    expect(
      await sql`select 1 from workspace_events where subject::text ilike '%leaver%'`,
    ).toHaveLength(0);
    // The accepted items' snapshot copies follow them to Former user.
    expect(h[ids.acceptedM!]!.snapshot).toBe(true);
    expect(h[ids.acceptedX!]!.snapshot).toBe(true);
    expect(h[ids.teamDraftM!]!.snapshot).toBe(false);

    expect(await reviewCheck(sql)).toMatchObject({
      'items without a home': 0,
      'private workspaces': 0,
      'former user workspaces': 2,
    });
    const [row] = await sql.unsafe(WORKSPACES_CHECK_SQL);
    const check = parseWorkspacesCheck(
      row as unknown as Parameters<typeof parseWorkspacesCheck>[0],
    );
    expect(check.workspacesWithoutModerator).toBe(0);
    expect(workspacesCheckFindings(check)).toBe(0);
  });

  it('a run after that changes nothing', async () => {
    const before = await homeOf();
    const rows = await sql<{ section: string; subject: string; n: number }[]>`
      select section, subject, n::int as n from mantle_ws_review_off()`;
    expect(rows.filter((r) => r.section !== 'proof' && r.n !== 0)).toEqual([]);
    expect(await homeOf()).toEqual(before);
  });
});

// An accepted item with no trace of its author keeps the home it has in the
// brain, whichever workspace that is (here Team), and W6b makes no snapshot
// copy of it (W6b RULE: a copy goes only into a private or Former user
// workspace). Its own scratch brain: the Team home is given by hand after the
// switch, which the switch guard of the first suite would count as gained.
describe.skipIf(!URL)('an accepted item kept in Team gets no snapshot copy (0264)', () => {
  let scratch: Awaited<ReturnType<typeof createScratchDatabaseBefore>>;
  let sql: Sql;
  const owner = randomUUID();
  const member = randomUUID();
  const ids: Record<string, string> = {};
  let team = '';

  beforeAll(async () => {
    scratch = await createScratchDatabaseBefore(URL!, BEFORE);
    sql = postgres(scratch.url, { max: 2, prepare: false, onnotice: () => {} });
    await sql`insert into auth.users (id, email, password_hash, role, is_owner) values
      (${owner}, 'rt-o@example.invalid', 'x', 'admin', true),
      (${member}, 'rt-m@example.invalid', 'x', 'member', false)`;
    await sql`select * from mantle_ws_migrate_locked()`;
    team = (
      await sql<
        { id: string }[]
      >`select id::text as id from workspaces where name = 'Team' and not is_admin`
    )[0]!.id;
    for (const [k, author] of [
      ['teamKept', null],
      ['byMember', member],
    ] as const) {
      ids[k] = randomUUID();
      await sql`insert into nodes (id, owner_id, type, title, path, audience)
        values (${ids[k]!}, ${owner}, 'page', ${k}, 'pages', 'admin')`;
      await sql`insert into space_items (node_id, author_login_id, sharing, review_state,
          reviewed_by, reviewed_at, accepted_at)
        values (${ids[k]!}, ${author}, 'private', 'accepted', ${owner}, now(), now())`;
    }
    // Re-homed in Team the workspace way, before 0264.
    await sql.begin(async (tx) => {
      await tx`delete from item_grants where node_id = ${ids.teamKept!}`;
      await tx`insert into item_grants (node_id, workspace_id, is_home)
        values (${ids.teamKept!}, ${team}, true)`;
    });
    await scratch.migrateRest(FOLD);
  }, 240_000);

  afterAll(async () => {
    await sql?.end();
    await scratch?.drop();
  });

  it('keeps its Team home, and only the authored one is copied', async () => {
    const h = Object.fromEntries(
      (
        await sql<{ id: string; home: string; snapshot: boolean }[]>`
          select node_id::text as id, home_workspace_id::text as home, snapshot
            from space_item_homes`
      ).map((r) => [r.id, r]),
    );
    expect(h[ids.teamKept!]).toMatchObject({ home: team, snapshot: false });
    const [mine] = await sql<{ id: string }[]>`
      select workspace_id::text as id from private_workspaces where login_id = ${member}`;
    expect(h[ids.byMember!]).toMatchObject({ home: mine!.id, snapshot: true });
    expect(await reviewCheck(sql)).toMatchObject({
      'homes with a snapshot copy': 1,
      'snapshot homes outside a private or Former user workspace': 0,
      'former user workspaces': 0,
    });
    // A hand edit asking for a copy into Team is undone by the next run.
    await sql`update space_item_homes set snapshot = true where node_id = ${ids.teamKept!}`;
    const rows = await sql<{ subject: string; n: number }[]>`
      select subject, n::int as n from mantle_ws_review_off()`;
    expect(rows.find((r) => r.subject === 'snapshot flag set by the rule')!.n).toBe(1);
    expect(
      (await sql`select snapshot from space_item_homes where node_id = ${ids.teamKept!}`)[0]!
        .snapshot,
    ).toBe(false);
  });
});

// 0264 proves its own work (no grant and no item's reach changed). The
// switch guard compares the grants with the levels frozen at the switch, so
// a read an Admin user gave by hand since then counts as gained there: that
// must not stop 0264.
describe.skipIf(!URL)('a read given since the switch does not stop 0264', () => {
  let scratch: Awaited<ReturnType<typeof createScratchDatabaseBefore>>;
  let sql: Sql;
  const owner = randomUUID();
  const member = randomUUID();

  beforeAll(async () => {
    scratch = await createScratchDatabaseBefore(URL!, BEFORE);
    sql = postgres(scratch.url, { max: 2, prepare: false, onnotice: () => {} });
    await sql`insert into auth.users (id, email, password_hash, role, is_owner) values
      (${owner}, 'rg-o@example.invalid', 'x', 'admin', true),
      (${member}, 'rg-m@example.invalid', 'x', 'member', false)`;
    await sql`insert into nodes (id, owner_id, type, title, path, audience)
      values (${randomUUID()}, ${owner}, 'page', 'admin page', 'pages', 'admin')`;
    await sql`select * from mantle_ws_migrate_locked()`;
    // An Admin user adds the member to the Admin workspace.
    await sql`insert into workspace_users (workspace_id, login_id, moderator)
      select id, ${member}, false from workspaces where is_admin`;
    const err = await sql
      .begin((tx) => tx`select * from mantle_ws_switch_guard()`)
      .then(
        () => null,
        (e: { code?: string }) => e,
      );
    expect(err).toMatchObject({ code: '23514' });
  }, 240_000);

  afterAll(async () => {
    await sql?.end();
    await scratch?.drop();
  });

  it('migrates, and its own check is clean', async () => {
    await scratch.migrateRest(FOLD);
    expect(await reviewCheck(sql)).toMatchObject({
      'items without a home': 0,
      'rows not archived': 0,
      'items still submitted, returned or taken': 0,
    });
  });
});

// 0263: the switch budget.
describe.skipIf(!URL)('the switch budget starts at the switch (0263)', () => {
  let scratch: Awaited<ReturnType<typeof createMigratedScratchDatabase>>;
  let sql: Sql;
  const owner = randomUUID();

  beforeAll(async () => {
    scratch = await createMigratedScratchDatabase(URL!);
    sql = postgres(scratch.url, { max: 2, prepare: false, onnotice: () => {} });
    await sql`insert into auth.users (id, email, password_hash, role, is_owner)
      values (${owner}, 'sb-o@example.invalid', 'x', 'admin', true)`;
    await sql`select * from mantle_ws_migrate_locked()`;
    expect((await sql`select mantle_ws_skip_reason() as r`)[0]!.r).toBeNull();
  }, 240_000);

  afterAll(async () => {
    await sql?.end();
    await scratch?.drop();
  });

  const budget = async (asked: string | null) =>
    (
      await sql.begin(async (tx) => {
        if (asked !== null) await tx`select set_config('mantle.ws_switch_budget', ${asked}, true)`;
        return tx<{ s: number }[]>`select extract(epoch from mantle_ws_switch_budget())::int as s`;
      })
    )[0]!.s;

  it('mantle_ws_switch_budget(): 30 s, lengthened or shortened, 1 s to 1 h', async () => {
    expect(await budget(null)).toBe(30);
    expect(await budget('')).toBe(30);
    expect(await budget('10 minutes')).toBe(600);
    expect(await budget('3 seconds')).toBe(3);
    expect(await budget('5 hours')).toBe(3600);
    expect(await budget('garbage')).toBe(30);
    expect(await budget('0')).toBe(1);
    expect(await budget('-5 seconds')).toBe(1);
  });

  it('the deadline is set at mantle_ws_switch_off, not before', async () => {
    const left = await sql.begin(async (tx) => {
      await tx`select set_config('mantle.ws_switch_armed', '5 seconds', true)`;
      await tx`select pg_sleep(2)`;
      await tx`select mantle_ws_switch_off()`;
      return tx<{ s: number }[]>`
        select extract(epoch from current_setting('mantle.ws_switch_deadline')::timestamptz
                                  - clock_timestamp())::float8 as s`;
    });
    expect(left[0]!.s).toBeGreaterThan(4);
    expect(left[0]!.s).toBeLessThanOrEqual(5);
    // Not armed (a migration): no deadline, the 12-attempt path.
    const plain = await sql.begin(async (tx) => {
      await tx`select mantle_ws_switch_off()`;
      return tx<{ d: string | null }[]>`
        select nullif(current_setting('mantle.ws_switch_deadline', true), '') as d`;
    });
    expect(plain[0]!.d).toBeNull();
  });

  it('a switch past its deadline names the time budget (55P03)', async () => {
    const err = await sql
      .begin(async (tx) => {
        await tx`select set_config('mantle.ws_switch_armed', '7 seconds', true)`;
        await tx`select set_config('mantle.ws_switch_deadline',
                   (clock_timestamp() - interval '1 second')::text, true)`;
        return tx`select mantle_ws_ddl_retry(array['select 1'], 'the workspaces switch')`;
      })
      .then(
        () => null,
        (e: { code?: string; message?: string }) => e,
      );
    expect(err).toMatchObject({ code: '55P03' });
    expect(err!.message).toMatch(
      /the switch ran past its time budget \(7 s from the start of the switch\).*SET mantle\.ws_switch_budget/,
    );
  });

  // A statement busy for its first `busy` tries (lock_not_available), each
  // try counted on a sequence (not rolled back with the try).
  const busyFor = (seq: string, busy: number) =>
    `DO $d$ BEGIN IF nextval('public.${seq}') <= ${busy} THEN ` +
    `RAISE EXCEPTION 'busy' USING ERRCODE = 'lock_not_available'; END IF; END $d$`;

  it('under a budget only the deadline ends the retries, never faster than one try a second', async () => {
    await sql`create sequence if not exists public.ddl_tries_budget`;
    const started = Date.now();
    await sql.begin(async (tx) => {
      // The shortest pause asked: under a budget it is 1 s all the same, so
      // a budget of up to an hour cannot fire lock requests back to back.
      await tx`select set_config('mantle.ws_ddl_retry_pause', '0.01', true)`;
      await tx`select set_config('mantle.ws_switch_armed', '200 seconds', true)`;
      await tx`select set_config('mantle.ws_switch_deadline',
                 (clock_timestamp() + interval '200 seconds')::text, true)`;
      await tx`select mantle_ws_ddl_retry(array[${busyFor('ddl_tries_budget', 13)}::text], 'the workspaces switch')`;
    });
    const took = Date.now() - started;
    const [t] = await sql<
      { n: number }[]
    >`select last_value::int as n from public.ddl_tries_budget`;
    // 13 busy tries, then the one that ran: past the 12 of a migration.
    expect(t!.n).toBe(14);
    // 13 pauses of at least 1 s each.
    expect(took).toBeGreaterThanOrEqual(12_900);
  }, 60_000);

  it('with no budget (a migration) it still stops after 12 tries', async () => {
    await sql`create sequence if not exists public.ddl_tries_plain`;
    const err = await sql
      .begin(async (tx) => {
        await tx`select set_config('mantle.ws_ddl_retry_pause', '0.01', true)`;
        return tx`select mantle_ws_ddl_retry(array[${busyFor('ddl_tries_plain', 1000)}::text], 'a migration')`;
      })
      .then(
        () => null,
        (e: { code?: string; message?: string }) => e,
      );
    expect(err).toMatchObject({ code: '55P03' });
    expect(err!.message).toMatch(/stayed busy for 12 attempts/);
    const [t] = await sql<{ n: number }[]>`select last_value::int as n from public.ddl_tries_plain`;
    expect(t!.n).toBe(12);
  });
});
