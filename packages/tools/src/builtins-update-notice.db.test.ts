/**
 * update_notice_on / update_notice_off on a migrated scratch brain on
 * workspaces, each call in the caller's own scope as an MCP call runs: an
 * Admin user who is not the anchor switches the notice, and it lands on the
 * ANCHOR's row (a brain key), where the public read finds it with no login;
 * off clears it; the caller's own row never holds it; a member is refused
 * and nothing is written. The handlers are called directly, so a member's
 * refusal here is areaSystem's own check; the dispatch gate's refusal of
 * the same callers is pinned by the MCP surface snapshots.
 *
 *   MANTLE_TEST_DATABASE_URL=postgres://… pnpm vitest run packages/tools/src/builtins-update-notice.db.test.ts
 */
import { randomUUID } from 'node:crypto';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

const URL = process.env.MANTLE_TEST_DATABASE_URL;

describe.skipIf(!URL)('the update notice tools, in the caller scope', () => {
  type Ts = typeof import('@mantle/db/test-support');
  let scratch: Awaited<ReturnType<Ts['createMigratedScratchDatabase']>> | undefined;
  let m: typeof import('@mantle/db');
  let tools: typeof import('./builtins-update-notice');
  let content: typeof import('@mantle/content');
  let sqlTag: typeof import('drizzle-orm').sql;
  let su: (q: ReturnType<typeof import('drizzle-orm').sql>) => Promise<unknown[]>;

  const tag = `un${randomUUID().replace(/-/g, '').slice(0, 8)}`;
  const owner = randomUUID();
  const adminB = randomUUID();
  const memberA = randomUUID();
  const W = randomUUID();

  type Reply = { ok: boolean; output?: { on: boolean; until: string | null }; error?: string };
  const call = (slug: string, loginId: string) =>
    m.withViewer({ login: loginId }, () =>
      tools.UPDATE_NOTICE_TOOLS.find((t) => t.slug === slug)!.handler({}, {
        ownerId: owner,
        surface: {
          kind: 'owner',
          via: 'mcp',
          loginId,
          mcp: { via: 'key', write: true, keyId: 'k' },
        },
      } as never),
    ) as Promise<Reply>;
  const stored = async (id: string) =>
    (
      (await su(
        sqlTag`select preferences->'updateNotice' as v from profiles where user_id = ${id}`,
      )) as { v: unknown }[]
    )[0]?.v ?? null;

  beforeAll(async () => {
    const ts: Ts = await import('@mantle/db/test-support');
    scratch = await ts.createMigratedScratchDatabase(URL!);
    process.env.DATABASE_URL = scratch.url;
    process.env.MANTLE_MASTER_KEY ??= 'mantle-viewer-test-key';
    m = await import('@mantle/db');
    tools = await import('./builtins-update-notice');
    content = await import('@mantle/content');
    sqlTag = (await import('drizzle-orm')).sql;
    await ts.ensureTestViewerRoles(URL!, process.env.MANTLE_MASTER_KEY);
    su = (q) => ts.superuserExec(scratch!.url, q);

    await su(sqlTag`insert into auth.users (id, email, password_hash, role, is_owner, display_name)
      values (${owner}, ${`${tag}-o@example.invalid`}, 'x', 'admin', true, 'Olive Owner')`);
    await ts.runWorkspacesSwitch(scratch.url);
    await su(sqlTag`insert into auth.users (id, email, password_hash, role, display_name) values
      (${adminB}, ${`${tag}-b@example.invalid`}, 'x', 'admin', 'Bea Admin'),
      (${memberA}, ${`${tag}-a@example.invalid`}, 'x', 'member', 'Ann')`);
    const [adminWs] = (await su(
      sqlTag`select id::text as id from workspaces where is_admin and archived_at is null limit 1`,
    )) as { id: string }[];
    await su(sqlTag`insert into workspace_users (workspace_id, login_id) values (${adminWs!.id}, ${adminB})
      on conflict do nothing`);
    await su(
      sqlTag`insert into workspaces (id, owner_id, name) values (${W}, ${owner}, ${`${tag} W`})`,
    );
    await su(sqlTag`delete from workspace_users where login_id = ${memberA}`);
    await su(
      sqlTag`insert into workspace_users (workspace_id, login_id) values (${W}, ${memberA})`,
    );
  }, 180_000);

  afterAll(async () => {
    await m?.closeDb();
    await scratch?.drop();
  }, 120_000);

  it('nothing is stored on a fresh brain', async () => {
    expect(await content.readUpdateNotice()).toBeUndefined();
  });

  it('a member is refused, and nothing is written', async () => {
    const res = await call('update_notice_on', memberA);
    expect(res.ok).toBe(false);
    expect(await stored(owner)).toBeNull();
    expect(await stored(memberA)).toBeNull();
  });

  it("an Admin user switches it on; it lands on the anchor's row, not its own", async () => {
    const res = await call('update_notice_on', adminB);
    expect(res).toMatchObject({ ok: true, output: { on: true } });
    const notice = await content.readUpdateNotice();
    expect(notice).toBeDefined();
    expect(await stored(owner)).toEqual(notice);
    expect(await stored(adminB)).toBeNull();
  });

  it('a member cannot switch it off either', async () => {
    expect((await call('update_notice_off', memberA)).ok).toBe(false);
    expect(await content.readUpdateNotice()).toBeDefined();
  });

  it('off clears it', async () => {
    const res = await call('update_notice_off', adminB);
    expect(res).toEqual({ ok: true, output: expect.objectContaining({ on: false, until: null }) });
    expect(await content.readUpdateNotice()).toBeUndefined();
    expect(await stored(owner)).toBeNull();
  });
});
