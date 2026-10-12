/**
 * The audit fix A27 (migration 0189) on a real, migrated Postgres:
 * mantle_brain_id() runs for the viewer pool's role and for no other role
 * (EXECUTE revoked from PUBLIC). Since W8c that is the workspace role
 * alone: the level roles and the space role are retired and hold no right
 * (0273). Their reads of the embedding config and the profiles (the rest of
 * A27) went with them.
 *   MANTLE_TEST_DATABASE_URL=postgres://… pnpm vitest run packages/db/src/client-level-fixes.db.test.ts
 */
import { randomUUID } from 'node:crypto';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

const URL = process.env.MANTLE_TEST_DATABASE_URL;

describe.skipIf(!URL)('mantle_brain_id() after the audit fixes', () => {
  type Db = typeof import('./index');
  type Admin = Parameters<Db['ensureViewerRoles']>[0];
  let m: Db;
  let admin: Admin;
  let sqlTag: typeof import('drizzle-orm').sql;
  let anchor = '';
  const tag = `clfix${randomUUID().slice(0, 8)}`;
  const probeRole = `mantle_probe_${tag}`;

  beforeAll(async () => {
    process.env.DATABASE_URL = URL;
    process.env.MANTLE_MASTER_KEY ??= 'mantle-viewer-test-key';
    m = await import('./index');
    sqlTag = (await import('drizzle-orm')).sql;
    const { ensureTestAnchor } = await import('./test-support');
    admin = (m.systemDb as unknown as { $client: Admin }).$client;
    await m.ensureViewerRoles(admin, process.env.MANTLE_MASTER_KEY);
    anchor = await ensureTestAnchor(admin);
    await admin.unsafe(`create role "${probeRole}" nologin`);
  }, 60_000);

  afterAll(async () => {
    if (!admin) return;
    await admin.unsafe(`drop role if exists "${probeRole}"`);
    await m?.closeDb();
  });

  it('EXECUTE for the workspace role only (A27, W8c)', async () => {
    const can = async (role: string) =>
      (
        await admin<{ ok: boolean }[]>`
          select has_function_privilege(${role}, 'public.mantle_brain_id()', 'EXECUTE') as ok`
      )[0]!.ok;
    expect(await can('mantle_view_user'), 'mantle_view_user').toBe(true);
    for (const role of [
      'mantle_view_team',
      'mantle_view_client',
      'mantle_view_public',
      'mantle_view_space',
    ]) {
      expect(await can(role), `${role} (retired)`).toBe(false);
    }
    expect(await can(probeRole), 'a role with no grant').toBe(false);
    // And it still resolves in a workspace scope.
    const scope = { kind: 'assistant' as const, loginId: null, ws: [randomUUID()], modWs: [] };
    const [brain] = (await m.withTurnScope(scope, () =>
      m.db.execute(sqlTag`select mantle_brain_id() as id`),
    )) as unknown as { id: string }[];
    expect(brain!.id).toBe(anchor);
  });
});
