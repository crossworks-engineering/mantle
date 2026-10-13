/**
 * Workspaces W5b2 part B fix round 1, H1 (plan R2): an app run reads through
 * the APP, never the runner's whole login. The brokers call
 * appToolScope(level, runner, app) and withViewer(actsFor, fn); the
 * scope is the app's holders beyond Admin met with the runner's workspaces.
 * On a scratch database of its own. Checked:
 *  - an admin's run of a Team-held app: note_get on an Admin-only note is
 *    not found, note_list (the title search) never lists it; the Team note
 *    reads;
 *  - a member in Team and another workspace: a run of the Team app reads
 *    the Team note, never the other workspace's note (the member's own
 *    login reads both);
 *  - an app two workspaces beyond Admin hold reads nothing (no scope
 *    expresses "held by every holder" yet); a runner outside the holder
 *    reads nothing; a run at team rules with no brain holder ({ team:
 *    true }) reads Team only;
 *  - fix round 2, L1: an app with no row beyond Admin reads Team (and runs
 *    admin rules); an app whose only row beyond Admin is an archived
 *    workspace's reads nothing (and runs team rules); an id that is not an
 *    app reads nothing.
 *   MANTLE_TEST_DATABASE_URL=postgres://… pnpm vitest run packages/tools/src/app-run-scope.db.test.ts
 */
import { randomUUID } from 'node:crypto';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

const URL = process.env.MANTLE_TEST_DATABASE_URL;

describe.skipIf(!URL)('an app run reads through the app (R2, H1)', () => {
  type Db = typeof import('@mantle/db');
  let m: Db;
  let level: typeof import('./app-tool-level');
  let builtins: typeof import('./builtins');
  let content: typeof import('@mantle/content');
  let sqlTag: typeof import('drizzle-orm').sql;
  let scratch: { url: string; drop: () => Promise<void> } | undefined;
  const owner = randomUUID();
  const member = randomUUID();
  const outsider = randomUUID();
  const ids: Record<string, string> = {};
  let team = '';
  const other = randomUUID();
  const gone = randomUUID();

  const sys = (q: ReturnType<typeof sqlTag>) => m.systemDb.execute(q);
  /** The workspaces the current scope reads (none for system work). */
  const scopeWs = (): readonly string[] => {
    const s = m.currentScope();
    return s.kind === 'system' ? [] : s.ws;
  };
  const tool = (slug: string) => {
    const def = builtins.BUILTIN_TOOLS.find((t) => t.slug === slug);
    if (!def) throw new Error(`${slug} is not a builtin any more`);
    return def;
  };
  /** Run note_get and note_list as `login` running `app` at team rules. */
  const run = async (login: string, app: import('@mantle/db').AppRunFor) => {
    const scope = level.appToolScope('team', { loginId: login, name: 'Runner' }, app);
    return m.withViewer(scope.actsFor, async () => {
      const ctx = { ownerId: owner, surface: scope.surface } as Parameters<
        ReturnType<typeof tool>['handler']
      >[1];
      const get = async (key: string) =>
        (await tool('note_get').handler({ id: ids[key]! }, ctx)).ok;
      const list = await tool('note_list').handler({ query: 'h1note' }, ctx);
      const titles = list.ok
        ? (list.output as { title: string }[]).map((r) => r.title).sort()
        : ['<refused>'];
      return {
        ws: m.currentScope().kind === 'system' ? null : m.currentScope(),
        admin: await get('adminNote'),
        team: await get('teamNote'),
        other: await get('otherNote'),
        titles,
      };
    });
  };

  beforeAll(async () => {
    const ts = await import('@mantle/db/test-support');
    scratch = await ts.createMigratedScratchDatabase(URL!);
    process.env.DATABASE_URL = scratch.url;
    process.env.MANTLE_MASTER_KEY ??= 'mantle-viewer-test-key';
    m = await import('@mantle/db');
    level = await import('./app-tool-level');
    builtins = await import('./builtins');
    content = await import('@mantle/content');
    sqlTag = (await import('drizzle-orm')).sql;
    const email = (id: string) => `h1-${id.slice(0, 8)}@example.invalid`;
    await sys(sqlTag`insert into auth.users (id, email, password_hash, role, is_owner) values
      (${owner}, ${email(owner)}, 'x', 'admin', true),
      (${member}, ${email(member)}, 'x', 'member', false),
      (${outsider}, ${email(outsider)}, 'x', 'member', false)`);
    const node = async (key: string, type: string, path: string, audience: string) => {
      const id = randomUUID();
      await sys(sqlTag`insert into nodes (id, owner_id, type, title, path, audience)
        values (${id}, ${owner}, ${type}, ${`h1note ${key}`}, ${path}, ${audience})`);
      ids[key] = id;
    };
    await node('adminNote', 'note', 'notes', 'admin');
    await node('teamNote', 'note', 'notes', 'team');
    await node('otherNote', 'note', 'notes', 'admin');
    await node('teamApp', 'app', 'apps', 'team');
    await node('twoApp', 'app', 'apps', 'team');
    await node('adminApp', 'app', 'apps', 'admin');
    await node('archivedApp', 'app', 'apps', 'admin');
    for (const key of ['teamApp', 'twoApp', 'adminApp', 'archivedApp']) {
      await sys(sqlTag`insert into apps (node_id, manifest) values (${ids[key]!}, '{}'::jsonb)`);
    }
    await sys(sqlTag`select * from mantle_ws_migrate()`);
    const ws = (await sys(
      sqlTag`select (case when is_admin then 'admin' when name = 'Team' then 'team' end) as key, id::text as id from workspaces where owner_id = ${owner}`,
    )) as unknown as { key: string; id: string }[];
    team = ws.find((w) => w.key === 'team')!.id;
    // Another workspace: the member is in it, the owner is not. It holds
    // the other note and (with Team) the second app.
    await sys(sqlTag`insert into workspaces (id, owner_id, name, is_admin)
      values (${other}, ${owner}, 'Other', false)`);
    await sys(sqlTag`insert into workspace_users (workspace_id, login_id, moderator)
      values (${other}, ${member}, true)`);
    // The outsider leaves Team: in no holder of the app.
    await sys(sqlTag`delete from workspace_users where login_id = ${outsider}`);
    for (const key of ['otherNote', 'twoApp']) {
      await m.withHeads([ids[key]!], 'update', async (tx) => {
        await tx.execute(
          sqlTag`insert into item_grants (node_id, workspace_id) values (${ids[key]!}, ${other})`,
        );
      });
    }
    // An app held beyond Admin only by a workspace archived since (its row
    // stands for one an archive left behind).
    await sys(sqlTag`insert into workspaces (id, owner_id, name, is_admin)
      values (${gone}, ${owner}, 'Gone', false)`);
    await sys(sqlTag`insert into workspace_users (workspace_id, login_id, moderator)
      values (${gone}, ${member}, false)`);
    await m.withHeads([ids.archivedApp!], 'update', async (tx) => {
      await tx.execute(sqlTag`insert into item_grants (node_id, workspace_id)
        values (${ids.archivedApp!}, ${gone})`);
    });
    await sys(sqlTag`update workspaces set archived_at = now() where id = ${gone}`);
  }, 180_000);

  afterAll(async () => {
    await m?.closeDb();
    await scratch?.drop();
    // DROP DATABASE checkpoints: slow under a full suite.
  }, 60_000);

  it("an admin's run of a Team-held app never reads an Admin-only note", async () => {
    // The admin's own login reads it (Admin and Team).
    expect(await m.withViewer({ login: owner }, async () => scopeWs().length)).toBe(2);
    const out = await run(owner, { id: ids.teamApp! });
    expect(out.ws).toMatchObject({ kind: 'user', loginId: owner, ws: [team], modWs: [team] });
    expect(out.admin).toBe(false);
    expect(out.team).toBe(true);
    expect(out.titles).toEqual(['h1note teamNote']);
  });

  it("a member's run of a Team app never reads the member's other workspaces", async () => {
    const own = await m.withViewer({ login: member }, async () => [...scopeWs()].sort());
    expect(own).toEqual([team, other].sort());
    const out = await run(member, { id: ids.teamApp! });
    expect(out.ws).toMatchObject({ ws: [team] });
    expect(out.other).toBe(false);
    expect(out.admin).toBe(false);
    expect(out.team).toBe(true);
    expect(out.titles).toEqual(['h1note teamNote']);
  });

  it('two holders beyond Admin, or a runner outside the holder, read nothing', async () => {
    const two = await run(member, { id: ids.twoApp! });
    expect(two).toMatchObject({ ws: { ws: [] }, team: false, other: false, admin: false });
    expect(two.titles).toEqual([]);
    const out = await run(outsider, { id: ids.teamApp! });
    expect(out).toMatchObject({ ws: { ws: [] }, team: false, admin: false });
  });

  it('a run at team rules with no brain holder reads the Team workspace only', async () => {
    const out = await run(member, { team: true });
    expect(out.ws).toMatchObject({ ws: [team] });
    expect(out).toMatchObject({ team: true, other: false, admin: false });
  });

  it('L1: Admin alone reads Team; an archived holder or an id that is not an app reads nothing', async () => {
    const rules = async (key: string) => (await content.getAppRuntime(owner, ids[key]!))?.toolRules;
    // No row beyond Admin at all: team rules read Team, admin rules for an admin.
    const alone = await run(member, { id: ids.adminApp! });
    expect(alone.ws).toMatchObject({ ws: [team] });
    expect(alone).toMatchObject({ team: true, other: false, admin: false });
    expect(await rules('adminApp')).toBe('admin');
    // Held beyond Admin only by an archived workspace: no fallback to Team.
    const archived = await run(member, { id: ids.archivedApp! });
    expect(archived).toMatchObject({ ws: { ws: [] }, team: false, other: false, admin: false });
    expect(archived.titles).toEqual([]);
    expect(await rules('archivedApp')).toBe('team');
    expect(await rules('teamApp')).toBe('team');
    // A note's id (not an app), and an id that names nothing.
    for (const id of [ids.teamNote!, randomUUID()]) {
      const out = await run(member, { id });
      expect(out, id).toMatchObject({ ws: { ws: [] }, team: false, other: false, admin: false });
    }
  });
});
