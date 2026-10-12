/**
 * Workspaces W5b2 (plan R6, S2, T4): withViewer is a shim over a workspace
 * scope, on a scratch database of its own. Checked:
 *
 *  - a login reads the union of its live workspaces, on the workspace role,
 *    never a level role; taken out of Team it reads nothing of Team's (the
 *    frozen level no longer counts); a disabled login reads nothing;
 *  - an assistant reads its own workspace; one on no workspace, nothing;
 *  - a public link reads no workspace and carries its served list;
 *  - system work runs outside it (W8c: no 'admin' argument); nested in the
 *    same scope it runs as is, in another one it is refused; inside,
 *    currentScope() never says system, and no level scope is exported;
 *  - the human level-role path (withHumanViewer, withTeamDrafts) is gone
 *    (W5c): nothing exports it and no scope sets the human flag.
 * The static half (every caller names whom it acts for) is
 * eslint-rules/viewer-shim-sweep.test.ts.
 *   MANTLE_TEST_DATABASE_URL=postgres://… pnpm vitest run packages/db/src/viewer-shim.db.test.ts
 */
import { randomUUID } from 'node:crypto';
import { sql } from 'drizzle-orm';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createMigratedScratchDatabase } from './test-support';

const URL = process.env.MANTLE_TEST_DATABASE_URL;

describe.skipIf(!URL)('the withViewer shim (W5b2, R6)', () => {
  let scratch: Awaited<ReturnType<typeof createMigratedScratchDatabase>>;
  let m: typeof import('./index');
  const owner = randomUUID();
  const member = randomUUID();
  const gone = randomUUID();
  const disabled = randomUUID();
  const ids: Record<string, string> = {};
  let team = '';

  const sys = async <T>(q: ReturnType<typeof sql>): Promise<T[]> =>
    (await m.systemDb.execute(q)) as unknown as T[];
  const node = async (key: string, audience: string) => {
    const id = randomUUID();
    await sys(sql`insert into nodes (id, owner_id, type, title, path, audience)
      values (${id}, ${owner}, 'page', ${key}, 'pages', ${audience})`);
    ids[key] = id;
  };
  /** The page titles the current scope reads, sorted. */
  const titles = async () =>
    (
      (await m.db.execute(
        sql`select title from nodes where type = 'page' order by title`,
      )) as unknown as { title: string }[]
    ).map((r) => r.title);

  beforeAll(async () => {
    scratch = await createMigratedScratchDatabase(URL!);
    process.env.DATABASE_URL = scratch.url;
    process.env.MANTLE_MASTER_KEY ??= 'mantle-viewer-test-key';
    m = await import('./index');
    const email = (id: string) => `v-${id.slice(0, 8)}@example.invalid`;
    await sys(sql`insert into auth.users (id, email, password_hash, role, is_owner) values
      (${owner}, ${email(owner)}, 'x', 'admin', true),
      (${member}, ${email(member)}, 'x', 'member', false),
      (${gone}, ${email(gone)}, 'x', 'member', false),
      (${disabled}, ${email(disabled)}, 'x', 'member', false)`);
    await node('adminPage', 'admin');
    await node('teamPage', 'team');
    const agentId = randomUUID();
    await sys(sql`insert into agents (id, owner_id, slug, name, role, audience, model, system_prompt)
      values (${agentId}, ${owner}, 'team-responder', 'Team', 'custom'::agent_role, 'team', 'm', 'p')`);
    ids.agent = agentId;
    const helperId = randomUUID();
    await sys(sql`insert into agents (id, owner_id, slug, name, role, audience, model, system_prompt)
      values (${helperId}, ${owner}, 'helper', 'Helper', 'custom'::agent_role, 'team', 'm', 'p')`);
    ids.helper = helperId;
    await sys(sql`select * from mantle_ws_migrate()`);
    const ws = await sys<{ key: string; id: string }>(
      sql`select bridge_key as key, id::text as id from workspaces where owner_id = ${owner}`,
    );
    team = ws.find((w) => w.key === 'team')!.id;
    await sys(sql`update agents set workspace_id = ${team} where id = ${agentId}`);
    // `gone` leaves Team (a Moderator removed it); `disabled` is disabled.
    await sys(sql`delete from workspace_users where login_id = ${gone}`);
    await sys(sql`update auth.users set disabled_at = now() where id = ${disabled}`);
  }, 180_000);

  afterAll(async () => {
    await m?.closeDb();
    await scratch?.drop();
  });

  it('a login reads its workspaces on the workspace role, never a level role', async () => {
    const out = await m.withViewer({ login: member }, async () => {
      const [r] = (await m.db.execute(sql`select current_user as u`)) as unknown as {
        u: string;
      }[];
      return { role: r!.u, scope: m.currentScope(), titles: await titles() };
    });
    expect(out.role).toBe('mantle_view_user');
    expect(out.scope).toMatchObject({ kind: 'user', loginId: member, ws: [team], modWs: [team] });
    expect(out.titles).toEqual(['teamPage']);
    // The level is only "not system": a client call for the same login
    // reads the same.
    expect(await m.withViewer({ login: member }, titles)).toEqual(['teamPage']);
    // The owner (Admin and Team) reads both.
    expect(await m.withViewer({ login: owner }, titles)).toEqual(['adminPage', 'teamPage']);
  });

  it('a login out of Team, or disabled, reads nothing (the frozen level does not count)', async () => {
    expect(await m.withViewer({ login: gone }, titles)).toEqual([]);
    expect(await m.withViewer({ login: disabled }, titles)).toEqual([]);
    const s = await m.viewerScopeFor({ login: gone });
    expect(s.ws).toEqual([]);
  });

  it('an assistant reads its workspace; one on no workspace reads nothing', async () => {
    const out = await m.withViewer({ agent: ids.agent! }, async () => ({
      scope: m.currentScope(),
      titles: await titles(),
    }));
    expect(out.scope).toMatchObject({ kind: 'assistant', loginId: null, ws: [team], modWs: [] });
    expect(out.titles).toEqual(['teamPage']);
    expect(await m.withViewer({ agent: ids.helper! }, titles)).toEqual([]);
    expect(await m.withViewer({ agent: null }, titles)).toEqual([]);
  });

  it('a public link reads no workspace and carries its served list', async () => {
    const out = await m.withViewer(
      { link: { served: [ids.teamPage!.toUpperCase(), 'not-a-uuid'] } },
      async () => ({ scope: m.currentScope(), titles: await titles() }),
    );
    expect(out.scope).toMatchObject({ kind: 'link', ws: [], served: [ids.teamPage] });
    expect(out.titles).toEqual([]);
  });

  it('system work is outside any scope; nesting keeps the scope or is refused; no level scope', async () => {
    // System work no longer goes through withViewer (its level argument went
    // in W8c): the caller runs fn itself.
    expect(m.currentScope().kind).toBe('system');
    expect(await titles()).toEqual(['adminPage', 'teamPage']);
    const nested = await m.withViewer({ login: member }, () =>
      m.withViewer({ login: member }, titles),
    );
    expect(nested).toEqual(['teamPage']);
    await expect(
      m.withViewer({ login: member }, () => m.withViewer({ login: owner }, titles)),
    ).rejects.toThrow(/another workspace scope/);
    await m.withViewer({ login: member }, async () => {
      expect(m.currentScope().kind).not.toBe('system');
    });
    // The level scope is gone (W8c): nothing exports a way into it.
    for (const name of [
      'levelOfScope',
      'currentViewerLevel',
      'inLevelScope',
      'ScopeLevelError',
      'runInLevelRoleForTest',
    ]) {
      expect(Object.keys(m), name).not.toContain(name);
    }
  });

  it('the human level-role path is gone (W5c): nothing exports it, no scope sets the flag', async () => {
    // withHumanViewer and withTeamDrafts (team drafts, client requests) were
    // the last way onto a level role with the human flag; no caller is left.
    for (const name of ['withHumanViewer', 'withTeamDrafts']) {
      expect(Object.keys(m), name).not.toContain(name);
    }
    const human = sql`select coalesce(current_setting('mantle.human', true), '') as h`;
    const flagIn = async () => ((await m.db.execute(human)) as unknown as { h: string }[])[0]!.h;
    // A member's request reads in its workspace scope, never as a human on
    // the team role; nor does an assistant's.
    expect(await m.withViewer({ login: member }, flagIn)).not.toBe('on');
    expect(await m.withViewer({ agent: ids.agent! }, flagIn)).not.toBe('on');
  });
});
