/**
 * The Default Model tools (control_default_model_get / _set) on a migrated
 * scratch brain on workspaces, each call in the caller's own scope as an
 * MCP call runs: an Admin user who is not the anchor sets it with one of
 * the brain's provider keys, and it lands on the ANCHOR's row (a brain
 * key); a key of another service, a missing key and a member are refused
 * and nothing changes; a deleted key reads as `key-missing`; clear clears.
 * No answer carries a key value.
 *
 *   MANTLE_TEST_DATABASE_URL=postgres://… pnpm test packages/tools/src/fleet-default-model.db.test.ts
 */
import { randomUUID } from 'node:crypto';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';

const URL = process.env.MANTLE_TEST_DATABASE_URL;

describe.skipIf(!URL)('the Default Model tools, in the caller scope', () => {
  type Ts = typeof import('@mantle/db/test-support');
  let scratch: Awaited<ReturnType<Ts['createMigratedScratchDatabase']>> | undefined;
  let m: typeof import('@mantle/db');
  let tools: typeof import('./builtins-control');
  let keys: typeof import('@mantle/api-keys');
  let sqlTag: typeof import('drizzle-orm').sql;
  let su: (q: ReturnType<typeof import('drizzle-orm').sql>) => Promise<unknown[]>;

  const tag = `dm${randomUUID().replace(/-/g, '').slice(0, 8)}`;
  const owner = randomUUID();
  const adminB = randomUUID();
  const memberA = randomUUID();
  const W = randomUUID();
  // Test values only: never a real key.
  const OR_VALUE = `sk-or-v1-${tag}-not-a-real-key-0001`;
  const ANT_VALUE = `sk-ant-${tag}-not-a-real-key-0002`;
  let orKey = '';
  let orKey2 = '';
  let antKey = '';

  type Reply = { ok: boolean; output?: Record<string, unknown>; error?: string };
  const call = (slug: string, loginId: string, input: Record<string, unknown> = {}) =>
    m.withViewer({ login: loginId }, () =>
      tools.CONTROL_TOOLS.find((t) => t.slug === slug)!.handler(input, {
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
        sqlTag`select preferences->'fleetDefaultModel' as v from profiles where user_id = ${id}`,
      )) as { v: unknown }[]
    )[0]?.v ?? null;

  beforeAll(async () => {
    vi.stubEnv('MANTLE_IS_CONTROL_CENTER', 'on');
    const ts: Ts = await import('@mantle/db/test-support');
    scratch = await ts.createMigratedScratchDatabase(URL!);
    process.env.DATABASE_URL = scratch.url;
    process.env.MANTLE_MASTER_KEY ??= 'mantle-viewer-test-key';
    m = await import('@mantle/db');
    tools = await import('./builtins-control');
    keys = await import('@mantle/api-keys');
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
    await m.withViewer({ login: owner }, async () => {
      orKey = (await keys.setApiKey(owner, 'openrouter', 'default', OR_VALUE)).id;
      orKey2 = (await keys.setApiKey(owner, 'openrouter', 'work', OR_VALUE)).id;
      antKey = (await keys.setApiKey(owner, 'anthropic', 'default', ANT_VALUE)).id;
    });
  }, 180_000);

  afterAll(async () => {
    vi.unstubAllEnvs();
    await m?.closeDb();
    await scratch?.drop();
  }, 120_000);

  it('nothing is set on a fresh brain; the choices list the provider keys', async () => {
    const res = await call('control_default_model_get', adminB);
    expect(res.ok).toBe(true);
    expect(res.output).toMatchObject({ provider: null, key: null, problem: null });
    const choices = res.output!.choices as { provider: string; keys: { id: string }[] }[];
    expect(
      choices
        .find((c) => c.provider === 'openrouter')!
        .keys.map((k) => k.id)
        .sort(),
    ).toEqual([orKey, orKey2].sort());
    expect(JSON.stringify(res.output)).not.toContain(OR_VALUE);
    expect(JSON.stringify(res.output)).not.toContain(ANT_VALUE);
  });

  it('a member is refused, and nothing is written', async () => {
    const res = await call('control_default_model_set', memberA, {
      provider: 'openrouter',
      keyId: orKey,
    });
    expect(res.ok).toBe(false);
    expect(await stored(owner)).toBeNull();
    expect(await stored(memberA)).toBeNull();
  });

  it("an Admin user sets it; it lands on the anchor's row, not its own", async () => {
    const res = await call('control_default_model_set', adminB, {
      provider: 'openrouter',
      keyId: orKey2,
    });
    expect(res).toMatchObject({
      ok: true,
      output: { provider: 'openrouter', key: { id: orKey2 }, problem: null },
    });
    expect(await stored(owner)).toEqual({ provider: 'openrouter', keyId: orKey2 });
    expect(await stored(adminB)).toBeNull();
    expect(JSON.stringify(res.output)).not.toContain(OR_VALUE);
  });

  it('a key of another service and a missing key are refused, and it stays', async () => {
    const other = await call('control_default_model_set', adminB, {
      provider: 'openrouter',
      keyId: antKey,
    });
    expect(other).toMatchObject({
      ok: false,
      error: expect.stringContaining('not a provider key for openrouter'),
    });
    const missing = await call('control_default_model_set', adminB, {
      provider: 'openrouter',
      keyId: randomUUID(),
    });
    expect(missing).toMatchObject({ ok: false, error: expect.stringContaining('not found') });
    expect(await stored(owner)).toEqual({ provider: 'openrouter', keyId: orKey2 });
  });

  it('a deleted key reads as key-missing', async () => {
    await m.withViewer({ login: owner }, () => keys.deleteApiKey(owner, orKey2));
    const res = await call('control_default_model_get', adminB);
    expect(res.output).toMatchObject({ provider: 'openrouter', key: null, problem: 'key-missing' });
  });

  it('clear clears it', async () => {
    const res = await call('control_default_model_set', adminB, { clear: true });
    expect(res).toMatchObject({ ok: true, output: { provider: null, key: null } });
    expect(await stored(owner)).toBeNull();
  });
});
