/**
 * Workspaces W6b (migration 0267): personal spaces fold into the brain.
 *
 * A scratch brain is migrated up to 0265 (W5c and W6a done), switched onto
 * workspaces, and given personal items made since 0264 (no home recorded
 * yet): drafts, a team-shared draft, a submitted page, a folder with a page
 * in it whose path a brain folder already has, a page whose slug the brain
 * already has, a team-shared app with its database row, its history and its
 * access log, a trashed app (private only, marked trashedBeforeFold),
 * files under space_files, a deleted login's
 * team-shared draft (left behind), the kind roots, and an accepted item.
 * Then 0267 and every later migration run. Checked: every item in the brain
 * with exactly the grants its home row names, names made unique and the
 * subtree with its folder, files moved to files with their bytes named by
 * data.space_file, app rows moved with their owner (storage paths kept),
 * the kind roots left empty, space_items emptied and archived, the spaces
 * archived, no login gaining a read, every author reaching its items, the
 * extract queue unchanged, no extractor notify, and a second run moving
 * nothing.
 *   MANTLE_TEST_DATABASE_URL=postgres://… pnpm vitest run packages/db/src/workspaces-spaces-fold.db.test.ts
 */
import { randomUUID } from 'node:crypto';
import postgres from 'postgres';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createScratchDatabaseBefore } from './test-support';
import {
  WORKSPACES_CHECK_SQL,
  parseWorkspacesCheck,
  workspacesCheckFindings,
} from './workspaces-check';

const URL = process.env.MANTLE_TEST_DATABASE_URL;
const FOLD = '0267_workspaces_spaces_fold';

type Sql = ReturnType<typeof postgres>;

describe.skipIf(!URL)('personal spaces fold into the brain (0267)', () => {
  let scratch: Awaited<ReturnType<typeof createScratchDatabaseBefore>>;
  let sql: Sql;
  let listener: Sql;
  let m: typeof import('./index');
  const notified: string[] = [];
  const owner = randomUUID();
  const admin2 = randomUUID();
  const member = randomUUID();
  const mate = randomUUID();
  const gone = randomUUID();
  const arch = randomUUID(); // a member whose private workspace was archived
  let archWs = '';
  const kept = randomUUID(); // a member whose item's home is an archived kept workspace
  let keptWs = '';
  const ids: Record<string, string> = {};
  const spaces: Record<string, string> = {};
  let queueBefore = 0;
  let personalSpaces = 0;
  const since = new Date(Date.now() - 86_400_000);

  const node = async (
    key: string,
    type: string,
    path: string,
    space: string,
    extra: { slug?: string; data?: Record<string, unknown> } = {},
  ) => {
    const id = randomUUID();
    await sql`insert into nodes (id, owner_id, type, title, path, audience, slug, data)
      values (${id}, ${space}, ${type}::node_type, ${key}, ${path}::ltree, 'admin',
              ${extra.slug ?? null}, ${sql.json((extra.data ?? {}) as never)})`;
    ids[key] = id;
    return id;
  };
  const item = async (
    key: string,
    author: string,
    state: string,
    sharing = 'private',
    deleted = false,
  ) =>
    sql`insert into space_items (node_id, author_login_id, sharing, review_state, submitted_at,
          reviewed_by, reviewed_at, accepted_at, deleted_at)
        values (${ids[key]!}, ${author}, ${sharing}, ${state},
          ${state === 'submitted' ? new Date() : null},
          ${state === 'accepted' ? owner : null}, ${state === 'accepted' ? new Date() : null},
          ${state === 'accepted' ? new Date() : null}, ${deleted ? new Date() : null})`;
  const ws = async (where: string) =>
    (await sql.unsafe<{ id: string }[]>(`select id::text as id from workspaces where ${where}`))[0]!
      .id;
  const privateOf = async (login: string) =>
    (
      await sql<{ id: string }[]>`select workspace_id::text as id from private_workspaces
        where login_id = ${login}`
    )[0]?.id;
  const row = async (key: string) =>
    (
      await sql<
        {
          owner: string;
          path: string;
          slug: string | null;
          read: string[];
          write: string[];
          home: string | null;
          data: Record<string, unknown>;
        }[]
      >`select owner_id::text as owner, path::text as path, slug, read_ws::text[] as read,
               write_ws::text[] as write, home_ws::text as home, data
          from nodes where id = ${ids[key]!}`
    )[0]!;
  /** What a login reads of the given nodes through its workspaces. */
  const reads = async (login: string, keys: string[]) =>
    (
      await sql<{ id: string }[]>`
        select n.id::text as id from nodes n
         where n.id = any(${keys.map((k) => ids[k]!)}::uuid[])
           and exists (select 1 from workspace_users wu join workspaces w on w.id = wu.workspace_id
                        where wu.login_id = ${login} and w.archived_at is null
                          and wu.workspace_id = any(n.read_ws))`
    )
      .map((r) => Object.entries(ids).find(([, v]) => v === r.id)![0])
      .sort();

  beforeAll(async () => {
    scratch = await createScratchDatabaseBefore(URL!, FOLD);
    sql = postgres(scratch.url, { max: 3, prepare: false, onnotice: () => {} });
    await sql`insert into auth.users (id, email, password_hash, role, is_owner, display_name) values
      (${owner}, 'sf-o@example.invalid', 'x', 'admin', true, null),
      (${admin2}, 'sf-a@example.invalid', 'x', 'admin', false, 'Second admin'),
      (${member}, 'sf-m@example.invalid', 'x', 'member', false, 'Member One'),
      (${mate}, 'sf-t@example.invalid', 'x', 'member', false, 'Teammate'),
      (${gone}, 'sf-g@example.invalid', 'x', 'member', false, null),
      (${arch}, 'sf-r@example.invalid', 'x', 'member', false, 'Archived One'),
      (${kept}, 'sf-k@example.invalid', 'x', 'member', false, 'Kept One')`;
    const done = await sql<{ section: string }[]>`select * from mantle_ws_migrate_locked()`;
    expect(done.filter((r) => r.section === 'reach-fail')).toEqual([]);
    for (const [k, v] of Object.entries({ member, gone, admin2, arch, kept })) {
      spaces[k] = (
        await sql<
          { id: string }[]
        >`select id from spaces where kind = 'personal' and login_id = ${v}`
      )[0]!.id;
    }

    // The brain's own rows a member's names clash with.
    await node('brainFolder', 'branch', 'pages.projects', owner);
    await node('brainPage', 'page', 'pages', owner, { slug: 'meeting-notes' });
    // A brain file whose name the member's file has (ignoring case): the
    // member's takes a suffix, its data.filename with it (fix round 1, H1).
    await node('brainFile', 'file', 'files', owner, {
      slug: 'Report.PDF',
      data: { filename: 'Report.PDF' },
    });
    // A member whose private workspace was archived before the fold (fix
    // round 1): the fold un-archives it rather than fail its proof.
    archWs = (
      await sql<{ id: string }[]>`insert into workspaces (owner_id, name, description, created_by)
        values (${owner}, 'Archived One (only you)', 'x', ${arch}) returning id::text as id`
    )[0]!.id;
    await sql`insert into workspace_users (workspace_id, login_id, moderator) values (${archWs}, ${arch}, true)`;
    await sql`insert into private_workspaces (login_id, workspace_id) values (${arch}, ${archWs})`;
    await sql`update workspaces set archived_at = now() where id = ${archWs}`;
    await node('archDraft', 'page', 'pages', spaces.arch!);
    await item('archDraft', arch, 'draft');
    // A live member (no private workspace) whose item's recorded home is an
    // archived workspace the brain keeps (a Former user workspace): it stays
    // archived; only an author's own private workspace is un-archived (fix
    // round 2, L-2).
    keptWs = (
      await sql<{ id: string }[]>`insert into workspaces (owner_id, name, description)
        values (${owner}, 'Former user', 'x') returning id::text as id`
    )[0]!.id;
    await sql`insert into former_user_workspaces (former_key, workspace_id)
      values (${randomUUID()}, ${keptWs})`;
    await sql`update workspaces set archived_at = now() where id = ${keptWs}`;
    await node('keptDraft', 'page', 'pages', spaces.kept!);
    await item('keptDraft', kept, 'draft');
    await sql`insert into space_item_homes (node_id, home_workspace_id, state_before, sharing_before)
      values (${ids.keptDraft!}, ${keptWs}, 'draft', 'private')`;

    // The member's space: kind roots, drafts, a folder that clashes, files.
    await node('rootPages', 'branch', 'pages', spaces.member!);
    await node('rootFiles', 'branch', 'space_files', spaces.member!);
    await node('privDraft', 'page', 'pages', spaces.member!);
    await item('privDraft', member, 'draft');
    await node('teamDraft', 'note', 'notes', spaces.member!);
    await item('teamDraft', member, 'draft', 'team');
    await node('submitted', 'page', 'pages', spaces.member!);
    await item('submitted', member, 'submitted');
    await node('folder', 'branch', 'pages.projects', spaces.member!);
    await node('inFolder', 'page', 'pages.projects', spaces.member!);
    await item('inFolder', member, 'draft');
    await node('subFolder', 'branch', 'pages.projects.q4', spaces.member!);
    await node('inSub', 'page', 'pages.projects.q4', spaces.member!);
    await item('inSub', member, 'draft');
    await node('sameSlug', 'page', 'pages', spaces.member!, { slug: 'meeting-notes' });
    await item('sameSlug', member, 'draft');
    await node('file', 'file', 'space_files', spaces.member!, {
      slug: 'report.pdf',
      data: { filename: 'report.pdf' },
    });
    await item('file', member, 'draft');
    await node('fileFolder', 'branch', 'space_files.docs', spaces.member!);
    await node('fileInFolder', 'file', 'space_files.docs', spaces.member!, {
      slug: 'a.txt',
      data: { filename: 'a.txt' },
    });
    await item('fileInFolder', member, 'draft');
    // A team-shared app with its database, its history and its access log.
    await node('teamApp', 'app', 'apps', spaces.member!);
    await sql`insert into apps (node_id, source) values (${ids.teamApp!}, '{"main":"x"}'::jsonb)`;
    await item('teamApp', member, 'draft', 'team');
    await sql`insert into app_databases (owner_id, app_node_id, storage_path)
      values (${spaces.member!}, ${ids.teamApp!}, ${`/data/app-dbs/${spaces.member!}/${ids.teamApp!}.sqlite`})`;
    await sql`insert into node_snapshots (owner_id, node_id, node_kind, seq, trigger, actor)
      values (${spaces.member!}, ${ids.teamApp!}, 'app', 1, 'manual', 'member')`;
    // A trashed app shared with the team: it runs for no one.
    await node('trashedApp', 'app', 'apps', spaces.member!);
    await sql`insert into apps (node_id, source) values (${ids.trashedApp!}, '{}'::jsonb)`;
    await item('trashedApp', member, 'draft', 'team', true);
    // Accepted: a brain item already; its author's snapshot copy is the app's.
    await node('accepted', 'page', 'pages', owner);
    await item('accepted', member, 'accepted');
    // A deleted login's team-shared draft (left behind: Admin) and a folder.
    await node('goneTeamDraft', 'page', 'pages', spaces.gone!);
    await item('goneTeamDraft', gone, 'draft', 'team');
    await node('goneFolder', 'branch', 'notes.old', spaces.gone!);
    await sql`delete from auth.users where id = ${gone}`;
    // An admin's own folder, no items: its private workspace is made.
    await node('adminFolder', 'branch', 'draw.mine', spaces.admin2!);

    personalSpaces = Number(
      (await sql`select count(*)::int as n from spaces where kind = 'personal'`)[0]!.n,
    );
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

    await scratch.migrateRest();
    expect(await queued()).toBe(queueBefore);
  }, 240_000);

  afterAll(async () => {
    await listener?.end();
    await m?.closeDb();
    await sql?.end();
    await scratch?.drop();
  });

  it('moves every item into the brain with exactly the grants its home names', async () => {
    const admin = await ws('is_admin');
    const team = await ws(`name = 'Team' and not is_admin`);
    const mine = (await privateOf(member))!;
    const [former] = await sql<{ id: string }[]>`
      select workspace_id::text as id from former_user_workspaces where former_key = ${spaces.gone!}`;
    expect(mine && former?.id).toBeTruthy();
    const want: Record<string, string[]> = {
      privDraft: [mine],
      teamDraft: [mine, team],
      submitted: [mine, admin],
      folder: [mine],
      inFolder: [mine],
      subFolder: [mine],
      inSub: [mine],
      sameSlug: [mine],
      file: [mine],
      fileFolder: [mine],
      fileInFolder: [mine],
      teamApp: [mine, team],
      trashedApp: [mine],
      goneTeamDraft: [former!.id, admin],
      goneFolder: [former!.id],
      archDraft: [archWs],
    };
    for (const [k, read] of Object.entries(want)) {
      const r = await row(k);
      expect({ k, owner: r.owner, read: [...r.read].sort(), write: r.write, home: r.home }).toEqual(
        {
          k,
          owner,
          read: [...read].sort(),
          write: [],
          home: read[0],
        },
      );
    }
    // Only the home row is the home; Admin and Team are plain grants.
    const homes = await sql<{ n: number }[]>`
      select count(*)::int as n from item_grants
       where node_id = any(${Object.keys(want).map((k) => ids[k]!)}::uuid[]) and is_home`;
    expect(homes[0]!.n).toBe(Object.keys(want).length);
    // The admin's empty folder has a private workspace now.
    expect((await row('adminFolder')).home).toBe(await privateOf(admin2));
  });

  it('makes names unique: the folder and its subtree, the slug, files to files', async () => {
    const folder = await row('folder');
    expect(folder.path).toMatch(/^pages\.projects_[0-9a-f]{6}$/);
    expect((await row('inFolder')).path).toBe(folder.path);
    expect((await row('subFolder')).path).toBe(`${folder.path}.q4`);
    expect((await row('inSub')).path).toBe(`${folder.path}.q4`);
    expect((await row('sameSlug')).slug).toMatch(/^meeting-notes-[0-9a-f]{6}$/);
    expect((await row('brainPage')).slug).toBe('meeting-notes');
    expect((await row('brainFolder')).path).toBe('pages.projects');
    const file = await row('file');
    expect(file.path).toBe('files');
    expect(file.data.space_file).toBe(spaces.member);
    // Its name was the brain file's, ignoring case: a suffix, the slug and
    // data.filename the same (fix round 1, H1); the brain file untouched.
    expect(file.slug).toMatch(/^report-[0-9a-f]{6}\.pdf$/);
    expect(file.data.filename).toBe(file.slug);
    expect((await row('brainFile')).data.filename).toBe('Report.PDF');
    const [frec] = await sql<{ old: string; neu: string }[]>`
      select old_slug as old, new_slug as neu from space_fold_items where node_id = ${ids.file!}`;
    expect(frec).toEqual({ old: 'report.pdf', neu: file.slug });
    expect((await row('fileInFolder')).data.filename).toBe('a.txt');
    expect((await row('fileFolder')).path).toBe('files.docs');
    expect((await row('fileInFolder')).path).toBe('files.docs');
    const rec = await sql<{ n: number }[]>`
      select count(*)::int as n from space_fold_items where old_path <> new_path or old_slug is distinct from new_slug`;
    // folder, inFolder, subFolder, inSub (path), sameSlug (slug), the files
    // and their folder (space_files to files).
    expect(rec[0]!.n).toBe(8);
  });

  it('moves an app with its rows; its data paths are kept; nothing removed', async () => {
    const [db] = await sql<{ owner: string; path: string }[]>`
      select owner_id::text as owner, storage_path as path from app_databases where app_node_id = ${ids.teamApp!}`;
    expect(db).toEqual({
      owner,
      path: `/data/app-dbs/${spaces.member!}/${ids.teamApp!}.sqlite`,
    });
    const [snap] = await sql<{ owner: string }[]>`
      select owner_id::text as owner from node_snapshots where node_id = ${ids.teamApp!}`;
    expect(snap!.owner).toBe(owner);
    const apps = await sql<{ n: number }[]>`
      select count(*)::int as n from apps where node_id in (${ids.teamApp!}, ${ids.trashedApp!})`;
    expect(apps[0]!.n).toBe(2);
    const [trashed] = await sql<{ deleted: Date | null; sharing: string }[]>`
      select deleted_at as deleted, sharing from space_fold_items where node_id = ${ids.trashedApp!}`;
    expect(trashed!.deleted).not.toBeNull();
    expect(trashed!.sharing).toBe('team');
    // The owner's decision (W6b): a trashed app goes to its author's private
    // workspace only, live, marked so the author finds it and may delete it;
    // nothing of it is removed.
    const t = await row('trashedApp');
    expect(t.read).toEqual([await privateOf(member)]);
    expect(t.home).toBe(await privateOf(member));
    expect(t.data.trashedBeforeFold).toBe(true);
    expect(typeof t.data.trashedAt).toBe('string');
    expect((await row('teamApp')).data.trashedBeforeFold).toBeUndefined();
  });

  it('un-archives the archived private workspace of a live author (fix round 1)', async () => {
    const [w] = await sql<{ archived: Date | null }[]>`
      select archived_at as archived from workspaces where id = ${archWs}`;
    expect(w!.archived).toBeNull();
    const ev = await sql<{ n: number }[]>`
      select count(*)::int as n from workspace_events
       where workspace_id = ${archWs} and action = 'spaces_fold.unarchived'`;
    expect(ev[0]!.n).toBe(1);
    expect(await reads(arch, ['archDraft'])).toEqual(['archDraft']);
  });

  it('never un-archives a kept workspace: the author’s item leaves it for its own (fix round 2, L-2)', async () => {
    const [w] = await sql<{ archived: Date | null }[]>`
      select archived_at as archived from workspaces where id = ${keptWs}`;
    expect(w!.archived).not.toBeNull();
    const ev = await sql<{ n: number }[]>`
      select count(*)::int as n from workspace_events
       where workspace_id = ${keptWs} and action = 'spaces_fold.unarchived'`;
    expect(ev[0]!.n).toBe(0);
    const mine = await privateOf(kept);
    expect(mine).toBeTruthy();
    const r = await row('keptDraft');
    expect({ home: r.home, read: r.read }).toEqual({ home: mine, read: [mine] });
    expect(await reads(kept, ['keptDraft'])).toEqual(['keptDraft']);
  });

  it('leaves no item in a space, archives the spaces, keeps only the accepted rows', async () => {
    const check = Object.fromEntries(
      (
        await sql<
          { metric: string; n: number }[]
        >`select metric, n::int as n from mantle_ws_spaces_fold_check()`
      ).map((r) => [r.metric, r.n]),
    );
    expect(check).toMatchObject({
      'items left in a personal space': 0,
      'kind roots left in a personal space': 2,
      'kind roots left with children': 0,
      'space_items rows other than accepted': 0,
      'accepted rows kept (the author read path until its snapshot copy)': 1,
      'items moved': 18,
      'folded files sharing a name in their folder': 0,
      'moved items without their home': 0,
      'snapshot copies wanted': 1,
      'snapshot copies made': 0,
      'archive rows: spaces': personalSpaces,
      'personal spaces not archived': 0,
    });
    const archived = await sql<{ n: number }[]>`
      select count(*)::int as n from archive_space_items
       where node_id = any(${[ids.privDraft!, ids.accepted!, ids.teamApp!]}::uuid[])`;
    expect(archived[0]!.n).toBe(3);
    // The accepted item stays where it is in the brain.
    expect((await row('accepted')).owner).toBe(owner);
  });

  it('no login reads more than before; every author reaches its items', async () => {
    const all = Object.keys(ids).filter(
      (k) =>
        !['brainFolder', 'brainPage', 'brainFile', 'accepted', 'archDraft', 'keptDraft'].includes(
          k,
        ),
    );
    // The teammate: the team-shared drafts only.
    expect(await reads(mate, all)).toEqual(['teamApp', 'teamDraft']);
    // An Admin user: submitted, left behind, and the team-shared ones (it
    // moderates Team).
    const adminReads = await reads(owner, all);
    expect(adminReads).toEqual(expect.arrayContaining(['goneTeamDraft', 'submitted']));
    expect(adminReads).not.toContain('privDraft');
    expect(adminReads).not.toContain('trashedApp');
    expect(adminReads).not.toContain('file');
    // The member: every item of its space.
    const memberKeys = all.filter(
      (k) => !['goneTeamDraft', 'goneFolder', 'adminFolder', 'rootPages', 'rootFiles'].includes(k),
    );
    expect(await reads(member, memberKeys)).toEqual([...memberKeys].sort());
  });

  it('starts no LLM work: no notify, the queue unchanged, items stamped', async () => {
    expect(notified).toEqual([]);
    const stamped = await row('privDraft');
    expect((stamped.data.extract_skipped as { reason: string }).reason).toBe('spaces_fold');
    expect((await row('folder')).data.extract_skipped).toBeUndefined();
  });

  it('is clean for workspaces:check, and a second run moves nothing', async () => {
    const [r] = await sql.unsafe(WORKSPACES_CHECK_SQL);
    const check = parseWorkspacesCheck(r as unknown as Parameters<typeof parseWorkspacesCheck>[0]);
    expect(workspacesCheckFindings(check)).toBe(0);
    const again = await sql<{ section: string; subject: string; metric: string; n: number }[]>`
      select section, subject, metric, n::int as n from mantle_ws_spaces_fold()`;
    expect(again.find((x) => x.subject === 'personal rows')!.n).toBe(0);
    expect(again.find((x) => x.subject === 'items')!.n).toBe(0);
  });
});
