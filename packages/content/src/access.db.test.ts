/**
 * Agent and tool-group levels against a real, migrated Postgres (member
 * logins Phase 0b; kept until W7), and the plain unshare of workspaces W5b2:
 * revoking a link changes no level and no grant. Brain items have no level
 * any more, so nothing here sets one. Seeds its own owner and rows and
 * removes them.
 *   MANTLE_TEST_DATABASE_URL=postgres://… pnpm vitest run packages/content/src/access.db.test.ts
 */
import { randomUUID } from 'node:crypto';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

const URL = process.env.MANTLE_TEST_DATABASE_URL;

describe.skipIf(!URL)('agent and tool-group levels, and the plain unshare, on Postgres', () => {
  type Db = typeof import('@mantle/db');
  type Access = typeof import('./access');
  let m: Db;
  let a: Access;
  let sqlTag: typeof import('drizzle-orm').sql;
  const owner = randomUUID();
  const ids = { note: randomUUID(), agent: randomUUID() };
  const tag = `access-test-${owner.slice(0, 8)}`;

  const accessOf = async (id: string) =>
    (
      (await m.db.execute(
        sqlTag`select audience, read_ws::text as read_ws from nodes where id = ${id}`,
      )) as unknown as { audience: string; read_ws: string }[]
    )[0]!;

  beforeAll(async () => {
    process.env.DATABASE_URL = URL;
    m = await import('@mantle/db');
    a = await import('./access');
    sqlTag = (await import('drizzle-orm')).sql;
    await m.db.execute(sqlTag`
      insert into auth.users (id, email, password_hash, role) values (${owner}, ${`${tag}@example.invalid`}, 'x', 'admin')`);
    // Items belong to a space (0165): this test's own owner is a brain row.
    await m.db.execute(sqlTag`
      insert into spaces (id, kind, login_id) values (${owner}, 'brain', ${owner})`);
    await m.db.execute(sqlTag`
      insert into nodes (id, owner_id, type, title, path) values
        (${ids.note}, ${owner}, 'note', 'n', 'notes')`);
    await m.db.execute(sqlTag`
      insert into tool_groups (owner_id, slug, name, audience) values
        (${owner}, ${`${tag}-admin`}, 'admin group', 'admin'),
        (${owner}, ${`${tag}-team`}, 'team group', 'team')`);
    await m.db.execute(sqlTag`
      insert into agents (id, owner_id, slug, name, model, system_prompt, tool_group_slugs)
      values (${ids.agent}, ${owner}, ${`${tag}-agent`}, 'A', 'm', 'p',
              ${`{${tag}-admin,${tag}-team}`}::text[])`);
  }, 60_000);

  afterAll(async () => {
    await m.db.execute(sqlTag`delete from agents where owner_id = ${owner}`);
    await m.db.execute(sqlTag`delete from tool_groups where owner_id = ${owner}`);
    await m.db.execute(sqlTag`delete from shares where owner_id = ${owner}`);
    await m.db.execute(sqlTag`delete from nodes where owner_id = ${owner}`);
    await m.db.execute(sqlTag`delete from spaces where id = ${owner} or login_id = ${owner}`);
    await m.db.execute(sqlTag`delete from auth.users where id = ${owner}`);
    await m.closeDb();
  });

  it('unshare is a plain revoke: no level, no grant changes', async () => {
    const shareId = randomUUID();
    await m.db.execute(sqlTag`
      insert into shares (id, owner_id, node_id, node_type, token)
      values (${shareId}, ${owner}, ${ids.note}, 'note', ${`${tag}-tok`})`);
    const before = await accessOf(ids.note);
    await expect(a.unshareItem(owner, shareId)).resolves.toEqual({ revoked: true });
    const [row] = (await m.db.execute(
      sqlTag`select revoked_at is not null as revoked from shares where id = ${shareId}`,
    )) as unknown as { revoked: boolean }[];
    expect(row?.revoked).toBe(true);
    expect(await accessOf(ids.note)).toEqual(before);
    // Already gone, or another owner's: nothing to revoke.
    await expect(a.unshareItem(owner, shareId)).resolves.toEqual({ revoked: false });
    await expect(a.unshareItem(randomUUID(), shareId)).resolves.toEqual({ revoked: false });
  });

  it('an agent cannot be lowered while it holds a group above the new level', async () => {
    await expect(a.setAgentAudience(owner, ids.agent, 'team')).rejects.toMatchObject({
      code: 'group_above_agent',
    });
    await m.db.execute(
      sqlTag`update agents set tool_group_slugs = ${`{${tag}-team}`}::text[] where id = ${ids.agent}`,
    );
    await expect(a.setAgentAudience(owner, ids.agent, 'team')).resolves.toMatchObject({
      audience: 'team',
    });
    // The Team settings card reads the new level back by slug.
    await expect(a.getAgentAccess(owner, `${tag}-agent`)).resolves.toEqual({
      slug: `${tag}-agent`,
      name: 'A',
      audience: 'team',
      enabled: true,
    });
    await expect(a.getAgentAccess(owner, `${tag}-missing`)).resolves.toBeNull();
  });

  it('a tool group cannot be raised above an agent that holds it', async () => {
    await expect(a.setToolGroupAudience(owner, `${tag}-team`, 'admin')).rejects.toMatchObject({
      code: 'group_above_agent',
    });
    await expect(a.setToolGroupAudience(owner, `${tag}-team`, 'client')).resolves.toMatchObject({
      audience: 'client',
    });
  });

  it('client and public are siblings: a client agent holds no public group, a public agent no client group', async () => {
    // State from the tests above: the agent is at team and holds the `-team`
    // group, which now sits at client.
    await m.db.execute(sqlTag`
      insert into tool_groups (owner_id, slug, name, audience) values
        (${owner}, ${`${tag}-public`}, 'public group', 'public')`);
    await m.db.execute(
      sqlTag`update agents set tool_group_slugs = ${`{${tag}-team,${tag}-public}`}::text[] where id = ${ids.agent}`,
    );
    // A team agent reads public, so it may hold both.
    await expect(
      a.agentGrantProblems(owner, 'team', [`${tag}-team`, `${tag}-public`]),
    ).resolves.toEqual([]);
    // A client agent does not read public items: the public group is refused.
    await expect(a.setAgentAudience(owner, ids.agent, 'client')).rejects.toMatchObject({
      code: 'group_above_agent',
    });
    await m.db.execute(
      sqlTag`update agents set tool_group_slugs = ${`{${tag}-team}`}::text[] where id = ${ids.agent}`,
    );
    await expect(a.setAgentAudience(owner, ids.agent, 'client')).resolves.toMatchObject({
      audience: 'client',
    });
    // Its client group cannot move to public under it either.
    await expect(a.setToolGroupAudience(owner, `${tag}-team`, 'public')).rejects.toMatchObject({
      code: 'group_above_agent',
    });
  });

  it('dropGroupsAbove lowers the agent and takes the groups above the new level off it', async () => {
    // State from the tests above: `-admin` at admin, `-team` at client,
    // `-public` at public. A new agent at admin holds all three.
    const id = randomUUID();
    const held = [`${tag}-admin`, `${tag}-team`, `${tag}-public`];
    await m.db.execute(sqlTag`
      insert into agents (id, owner_id, slug, name, model, system_prompt, tool_group_slugs)
      values (${id}, ${owner}, ${`${tag}-agent2`}, 'B', 'm', 'p', ${`{${held.join(',')}}`}::text[])`);
    const groupsOf = async () =>
      (
        (await m.db.execute(
          sqlTag`select audience, tool_group_slugs from agents where id = ${id}`,
        )) as unknown as { audience: string; tool_group_slugs: string[] }[]
      )[0]!;

    // Without it: refused, nothing changes, and the refusal names the fix.
    const refusal = await a.setAgentAudience(owner, id, 'client').catch((e: Error) => e);
    expect(refusal).toMatchObject({ code: 'group_above_agent' });
    expect((refusal as Error).message).toContain(`'${tag}-admin' is admin-level`);
    expect((refusal as Error).message).toContain(`agent '${tag}-agent2'`);
    expect((refusal as Error).message).toContain('dropGroupsAbove: true');
    expect(await groupsOf()).toEqual({ audience: 'admin', tool_group_slugs: held });

    // With it: one call. A client agent reads neither admin nor public.
    await expect(
      a.setAgentAudience(owner, id, 'client', { dropGroupsAbove: true }),
    ).resolves.toMatchObject({
      audience: 'client',
      removedGroups: [`${tag}-admin`, `${tag}-public`],
    });
    expect(await groupsOf()).toEqual({ audience: 'client', tool_group_slugs: [`${tag}-team`] });

    // Raising never touches the groups, with or without the option.
    await expect(
      a.setAgentAudience(owner, id, 'admin', { dropGroupsAbove: true }),
    ).resolves.toMatchObject({ audience: 'admin', removedGroups: [] });
    expect(await groupsOf()).toEqual({ audience: 'admin', tool_group_slugs: [`${tag}-team`] });
  });
});
