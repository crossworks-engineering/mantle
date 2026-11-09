/**
 * An app run reads with the RUNNER's own rights, as by hand (owner decision
 * 2026-11-09: apps follow the Pages rights model). Before, the scope was the
 * app's holders beyond Admin met with the runner's workspaces, and only when
 * exactly one holder existed: an app shared with a second workspace read
 * nothing. The brokers call appToolScope(level, runner) and
 * withViewer(actsFor, fn). On a scratch database of its own. Checked:
 *  - an app two workspaces beyond Admin hold: a member of both reads both
 *    (this failed before: the two-holder app read nothing);
 *  - a member of only one of them reads only that one, never Admin;
 *  - a member's run of a Team app reads the member's other workspace too,
 *    as the member's own login does;
 *  - an admin's run reads what the admin reads by hand (the tool set stays
 *    the team one for a Team-held app: toolRules);
 *  - a login in no workspace reads nothing; a link reads only what it
 *    serves (unchanged);
 *  - toolRules: Admin alone 'admin', any holder beyond Admin (an archived
 *    one too) 'team', whatever their number.
 *   MANTLE_TEST_DATABASE_URL=postgres://… pnpm test packages/tools/src/app-run-scope.db.test.ts
 */
import { randomUUID } from 'node:crypto';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

const URL = process.env.MANTLE_TEST_DATABASE_URL;

describe.skipIf(!URL)("an app run reads with the runner's own rights (2026-11-09)", () => {
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
  const single = randomUUID();
  const ids: Record<string, string> = {};
  let team = '';
  const other = randomUUID();
  const gone = randomUUID();

  const sys = (q: ReturnType<typeof sqlTag>) => m.systemDb.execute(q);
  const tool = (slug: string) => {
    const def = builtins.BUILTIN_TOOLS.find((t) => t.slug === slug);
    if (!def) throw new Error(`${slug} is not a builtin any more`);
    return def;
  };
  /** Run note_get and note_list as `login` running an app at team rules. */
  const run = async (login: string) => {
    const scope = level.appToolScope('team', { loginId: login, name: 'Runner' });
    expect(scope.actsFor).toEqual({ login, app: true });
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
    // Workspace table writes as the superuser: the app's pools only read them.
    const su = (q: ReturnType<typeof sqlTag>) => ts.superuserExec(scratch!.url, q);
    const email = (id: string) => `h1-${id.slice(0, 8)}@example.invalid`;
    await sys(sqlTag`insert into auth.users (id, email, password_hash, role, is_owner) values
      (${owner}, ${email(owner)}, 'x', 'admin', true),
      (${member}, ${email(member)}, 'x', 'member', false),
      (${outsider}, ${email(outsider)}, 'x', 'member', false),
      (${single}, ${email(single)}, 'x', 'member', false)`);
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
    await (await import('@mantle/db/test-support')).runWorkspacesSwitch();
    const ws = (await sys(
      sqlTag`select (case when is_admin then 'admin' when name = 'Team' then 'team' end) as key, id::text as id from workspaces where owner_id = ${owner}`,
    )) as unknown as { key: string; id: string }[];
    team = ws.find((w) => w.key === 'team')!.id;
    // Another workspace: the member is in it, the owner is not. It holds
    // the other note and (with Team) the second app.
    await su(sqlTag`insert into workspaces (id, owner_id, name, is_admin)
      values (${other}, ${owner}, 'Other', false)`);
    await su(sqlTag`insert into workspace_users (workspace_id, login_id, moderator)
      values (${other}, ${member}, true)`);
    // The outsider leaves Team: in no workspace at all. `single` stays in
    // Team only.
    await su(sqlTag`delete from workspace_users where login_id = ${outsider}`);
    for (const key of ['otherNote', 'twoApp']) {
      await m.withHeads([ids[key]!], 'update', async (tx) => {
        await tx.execute(
          sqlTag`insert into item_grants (node_id, workspace_id) values (${ids[key]!}, ${other})`,
        );
      });
    }
    // An app held beyond Admin only by a workspace archived since (its row
    // stands for one an archive left behind).
    await su(sqlTag`insert into workspaces (id, owner_id, name, is_admin)
      values (${gone}, ${owner}, 'Gone', false)`);
    await su(sqlTag`insert into workspace_users (workspace_id, login_id, moderator)
      values (${gone}, ${member}, false)`);
    await m.withHeads([ids.archivedApp!], 'update', async (tx) => {
      await tx.execute(sqlTag`insert into item_grants (node_id, workspace_id)
        values (${ids.archivedApp!}, ${gone})`);
    });
    await su(sqlTag`update workspaces set archived_at = now() where id = ${gone}`);
  }, 180_000);

  afterAll(async () => {
    await m?.closeDb();
    await scratch?.drop();
    // DROP DATABASE checkpoints: slow under a full suite.
  }, 60_000);

  it('an app two workspaces beyond Admin hold: a member of both reads both', async () => {
    // Before 2026-11-09 this run read nothing (two holders).
    const out = await run(member);
    expect([...(out.ws as { ws: readonly string[] }).ws].sort()).toEqual([team, other].sort());
    expect(out).toMatchObject({ team: true, other: true, admin: false });
    expect(out.titles).toEqual(['h1note otherNote', 'h1note teamNote']);
  });

  it('a member of only one of the two reads only that one', async () => {
    const out = await run(single);
    expect(out.ws).toMatchObject({ kind: 'user', loginId: single, ws: [team] });
    expect(out).toMatchObject({ team: true, other: false, admin: false });
    expect(out.titles).toEqual(['h1note teamNote']);
  });

  it("the run's scope is the login's own scope, as by hand", async () => {
    for (const login of [owner, member, single, outsider]) {
      const own = await m.withViewer({ login }, async () => m.currentScope());
      const app = await m.withViewer({ login, app: true }, async () => m.currentScope());
      expect(app, login).toEqual(own);
    }
  });

  it("inside the login's own request, an app run takes a fresh read-only scope, not the request's", async () => {
    // The owner broker runs in the Admin user's request, which writes and
    // reads drafts. A plain withViewer of the same login reuses it; an app
    // run must not: it reads published items, read only, as a member's does.
    const scope = await m.viewerScopeFor({ login: owner });
    const seen = await m.runInRequestSlot(
      async () => {
        if (!m.enterRequestScope(scope, { writes: true, drafts: true })) {
          throw new Error('the request scope was not entered');
        }
        const own = await m.withViewer({ login: owner }, async () => m.currentRequestMode());
        const app = await m.withViewer({ login: owner, app: true }, async () =>
          m.currentRequestMode(),
        );
        return { own, app };
      },
      { startsAs: m.loginActor(owner, 'rw') },
    );
    expect(seen.own).toMatchObject({ writes: true, drafts: true });
    expect(seen.app).toBeNull();
  });

  it("an admin's run reads what the admin reads by hand", async () => {
    const out = await run(owner);
    expect([...(out.ws as { ws: readonly string[] }).ws].length).toBe(2);
    // The other note is homed in Admin (granted to Other too): the admin
    // reads it by hand, so the run does.
    expect(out).toMatchObject({ admin: true, team: true, other: true });
  });

  it('a login in no workspace reads nothing; a link reads only what it serves', async () => {
    const out = await run(outsider);
    expect(out).toMatchObject({ ws: { ws: [] }, team: false, other: false, admin: false });
    expect(out.titles).toEqual([]);
    const linked = await m.withViewer({ link: { served: [ids.teamNote!] } }, async () =>
      m.currentScope(),
    );
    expect(linked).toMatchObject({ kind: 'link', ws: [], served: [ids.teamNote!] });
  });

  it('toolRules: Admin alone admin; any holder beyond Admin, whatever their number, team', async () => {
    const rules = async (key: string) => (await content.getAppRuntime(owner, ids[key]!))?.toolRules;
    expect(await rules('adminApp')).toBe('admin');
    expect(await rules('archivedApp')).toBe('team');
    expect(await rules('teamApp')).toBe('team');
    expect(await rules('twoApp')).toBe('team');
  });
});
