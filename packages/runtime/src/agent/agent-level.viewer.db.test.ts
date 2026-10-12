/**
 * Helpers and tool groups with no level (workspaces W5b2, W7b, W8c), on a
 * real, migrated Postgres. Agents and tool groups once carried a level and
 * the level roles read them by it; the level engine is gone, so what is left
 * to assert:
 *
 *  - a helper (an agent with no workspace) run inside a scope runs in that
 *    scope, never wider: a scope with no workspace reads none of the pages;
 *  - system work resolves every group an agent holds (no level cap).
 *
 * Seeds its own agents, groups and two pages on the shared anchor (the
 * frozen audience columns are still written, so a stray read of them would
 * show), and removes them after.
 *   MANTLE_TEST_DATABASE_URL=postgres://… pnpm vitest run packages/runtime/src/agent/agent-level.viewer.db.test.ts
 */
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

const URL = process.env.MANTLE_TEST_DATABASE_URL;

describe.skipIf(!URL)('helpers and tool groups carry no level', () => {
  type Db = typeof import('@mantle/db');
  type Admin = Parameters<Db['ensureViewerRoles']>[0];
  let m: Db;
  let admin: Admin;
  let sqlTag: typeof import('drizzle-orm').sql;
  let anchor = '';
  const tag = `agentlvl${crypto.randomUUID().slice(0, 8)}`;
  const LEVELS = ['admin', 'team', 'client', 'public'] as const;
  const agentSlug = (l: string) => `${tag}-agent-${l}`;
  const groupSlug = (l: string) => `${tag}-group-${l}`;
  const page = { client: crypto.randomUUID(), public: crypto.randomUUID() };

  beforeAll(async () => {
    process.env.DATABASE_URL = URL;
    process.env.MANTLE_MASTER_KEY ??= 'mantle-viewer-test-key';
    m = await import('@mantle/db');
    sqlTag = (await import('drizzle-orm')).sql;
    const { ensureTestAnchor } = await import('@mantle/db/test-support');
    admin = (m.systemDb as unknown as { $client: Admin }).$client;
    await m.ensureViewerRoles(admin, process.env.MANTLE_MASTER_KEY);
    anchor = await ensureTestAnchor(admin);
    for (const l of LEVELS) {
      await admin`insert into tool_groups (owner_id, slug, name, tool_slugs, audience)
        values (${anchor}, ${groupSlug(l)}, ${tag}, ${[`${tag}-tool-${l}`]}, ${l})`;
      await admin`insert into agents (owner_id, slug, name, model, provider, system_prompt,
                                      tool_group_slugs, audience)
        values (${anchor}, ${agentSlug(l)}, ${tag}, 'fake/model', 'local', 'x',
                ${[groupSlug(l)]}, ${l})`;
    }
    await admin`insert into nodes (id, owner_id, type, title, path, audience) values
      (${page.client}, ${anchor}, 'page', ${`${tag} client`}, 'pages', 'client'),
      (${page.public}, ${anchor}, 'page', ${`${tag} public`}, 'pages', 'public')`;
  }, 60_000);

  afterAll(async () => {
    if (!admin) return;
    await admin`delete from traces where agent_id in (select id from agents where slug like ${`${tag}-%`})`;
    await admin`delete from agents where slug like ${`${tag}-%`}`;
    await admin`delete from tool_groups where slug like ${`${tag}-%`}`;
    await admin`delete from nodes where id in (${page.client}, ${page.public})`;
    await m?.closeDb();
  });

  const readPages = () =>
    m.db.execute(
      sqlTag`select id from nodes where id in (${page.client}, ${page.public})`,
    ) as unknown as Promise<{ id: string }[]>;

  it('a helper under a scope with no workspace runs in that scope and reads 0 items', async () => {
    // W5b2 (R6): an agent on no workspace runs in the caller's workspace
    // scope, never wider. The pages' old public and client marks give it
    // nothing.
    const { withAgentViewer } = await import('./agent-viewer');
    const inScope = await m.withViewer({ agent: null }, async () => ({
      outer: m.currentScope(),
      inner: await withAgentViewer({}, async () => ({
        scope: m.currentScope(),
        read: await readPages(),
      })),
    }));
    expect(inScope.inner).toEqual({ scope: inScope.outer, read: [] });
  });

  it('W7b: no level cap on groups: system work gets every group an agent holds', async () => {
    const { resolveAgentToolGroups } = await import('./skills');
    const both = [groupSlug('client'), groupSlug('public')];
    expect(await resolveAgentToolGroups(anchor, both)).toEqual([
      `${tag}-tool-client`,
      `${tag}-tool-public`,
    ]);
  });
});
