/**
 * The my-space tools on a real migrated Postgres (member logins Phase 2,
 * plan 2e "on behalf of"): a team turn for member A reads A's personal items
 * and nothing else; no member on the surface means nothing at all.
 *   MANTLE_TEST_DATABASE_URL=postgres://… pnpm vitest run packages/tools/src/builtins-my-space.viewer.db.test.ts
 */
import { randomUUID } from 'node:crypto';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { ToolHandlerContext } from './types';

const URL = process.env.MANTLE_TEST_DATABASE_URL;

describe.skipIf(!URL)('my-space tools (on behalf of the member)', () => {
  type Db = typeof import('@mantle/db');
  type Content = typeof import('@mantle/content');
  type Tools = typeof import('./builtins-my-space');
  let m: Db;
  let c: Content;
  let t: Tools;
  let sqlTag: typeof import('drizzle-orm').sql;
  const tag = `myspace-${randomUUID().slice(0, 8)}`;
  const loginA = randomUUID();
  const loginB = randomUUID();
  let spaceA: string;
  let spaceB: string;
  let pageA: string;
  let noteB: string;

  const ctxFor = (loginId?: string): ToolHandlerContext => ({
    ownerId: randomUUID(),
    ...(loginId ? { surface: { kind: 'team', loginId } } : {}),
  });
  // Tools run inside the team-level loop.
  const call = (tool: 'my_items_list' | 'my_item_open', input: object, loginId?: string) =>
    m.withViewer('team', () => t[tool].handler(input as Record<string, unknown>, ctxFor(loginId)));

  beforeAll(async () => {
    process.env.DATABASE_URL = URL;
    process.env.MANTLE_MASTER_KEY ??= 'mantle-viewer-test-key';
    m = await import('@mantle/db');
    c = await import('@mantle/content');
    t = await import('./builtins-my-space');
    sqlTag = (await import('drizzle-orm')).sql;
    const admin = (m.systemDb as unknown as { $client: Parameters<Db['ensureViewerRoles']>[0] })
      .$client;
    await m.ensureViewerRoles(admin, process.env.MANTLE_MASTER_KEY);
    await m.systemDb.execute(sqlTag`
      insert into auth.users (id, email, password_hash, role) values
        (${loginA}, ${`${tag}-a@example.invalid`}, 'x', 'member'),
        (${loginB}, ${`${tag}-b@example.invalid`}, 'x', 'member')`);
    const rows = (await m.systemDb.execute(sqlTag`
      select id, login_id from spaces where kind = 'personal'
        and login_id in (${loginA}, ${loginB})`)) as unknown as {
      id: string;
      login_id: string;
    }[];
    spaceA = rows.find((r) => r.login_id === loginA)!.id;
    spaceB = rows.find((r) => r.login_id === loginB)!.id;
    const asA = { spaceId: spaceA, loginId: loginA };
    const asB = { spaceId: spaceB, loginId: loginB };
    pageA = (
      await m.withSpace(asA, () => c.createMineItem(spaceA, { type: 'page', title: `${tag} plan` }))
    ).id;
    await m.withSpace(asA, () =>
      c.saveMinePage(spaceA, pageA, {
        type: 'doc',
        content: [{ type: 'paragraph', content: [{ type: 'text', text: 'the private plan' }] }],
      }),
    );
    noteB = (
      await m.withSpace(asB, () =>
        c.createMineItem(spaceB, { type: 'note', title: `${tag} b note`, content: 'b secret' }),
      )
    ).id;
    // Even shared with the team, B's item is not A's: the tools never show it.
    await m.withSpace(asB, () => c.setSharing(spaceB, noteB, 'team'));
  });

  afterAll(async () => {
    await m.systemDb.execute(sqlTag`delete from nodes where owner_id in (${spaceA}, ${spaceB})`);
    await m.systemDb.execute(sqlTag`delete from spaces where login_id in (${loginA}, ${loginB})`);
    await m.systemDb.execute(sqlTag`delete from auth.users where id in (${loginA}, ${loginB})`);
    await m.closeDb();
  });

  it('lists and opens the member’s own items', async () => {
    const list = await call('my_items_list', { q: tag }, loginA);
    expect(list.ok).toBe(true);
    const items = (list.ok ? (list.output as { items: { id: string }[] }).items : []).map(
      (i) => i.id,
    );
    expect(items).toEqual([pageA]);
    const open = await call('my_item_open', { id: pageA }, loginA);
    expect(open.ok && JSON.stringify(open.output)).toContain('the private plan');
  });

  it('never opens another member’s item, shared or not', async () => {
    const open = await call('my_item_open', { id: noteB }, loginA);
    expect(open.ok).toBe(false);
  });

  it('finds nothing without a member on the surface (owner turns, heartbeats, MCP)', async () => {
    expect((await call('my_items_list', {})).ok).toBe(false);
    expect((await call('my_item_open', { id: pageA })).ok).toBe(false);
  });
});
