/**
 * Secrets as a workspace kind (0400, plan page 0f5ce59b part S2), on a
 * migrated scratch brain on workspaces with the edit check on (as on a
 * box), every call in a login's own write scope, as the routes run it:
 *
 *  - a Moderator of W makes a secret in W; a user of W lists it and reveals
 *    its value; a login outside W finds nothing and reveals nothing;
 *  - a user of W without Write may not change it or delete it; the
 *    Moderator replaces its note, and the reader reveals the new one;
 *  - a Write grant to another workspace lets its user change the value;
 *  - an Admin user who is not in W reads nothing of it (management is not
 *    reading), and a secret made in Admin stays Admin's alone;
 *  - the metadata never carries a value.
 *
 *   MANTLE_TEST_DATABASE_URL=postgres://… pnpm test packages/content/src/secrets.db.test.ts
 */
import { randomUUID } from 'node:crypto';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';

const URL = process.env.MANTLE_TEST_DATABASE_URL;

// The seal itself is @mantle/crypto's (its own tests). Here a stand-in that
// keeps the bytes readable, so the test keeps the lane's shared master key:
// the viewer roles' passwords come from it, cluster-wide, and a 32-byte key
// of its own would lock every other file of the lane out.
vi.mock('@mantle/crypto', async (importOriginal) => ({
  ...(await importOriginal<Record<string, unknown>>()),
  seal: (plain: string, aad: string) => ({
    ciphertext: Buffer.from(JSON.stringify({ aad, plain })),
    keyVersion: 1,
  }),
  open: (ciphertext: Buffer, aad: string) => {
    const box = JSON.parse(ciphertext.toString()) as { aad: string; plain: string };
    if (box.aad !== aad) throw new Error('sealed for another row');
    return box.plain;
  },
}));

describe.skipIf(!URL)('secrets: a workspace kind (0400)', () => {
  type Ts = typeof import('@mantle/db/test-support');
  let ts: Ts;
  let scratch: Awaited<ReturnType<Ts['createMigratedScratchDatabase']>> | undefined;
  let m: typeof import('@mantle/db');
  let s: typeof import('./secrets');
  let sqlTag: typeof import('drizzle-orm').sql;
  let su: (q: ReturnType<typeof import('drizzle-orm').sql>) => Promise<unknown[]>;

  const tag = `sc${randomUUID().replace(/-/g, '').slice(0, 8)}`;
  const owner = randomUUID();
  const MOD = randomUUID(); // Moderator of W
  const USER = randomUUID(); // a user of W, no Moderator
  const OUT = randomUUID(); // in O only
  const W = randomUUID();
  const O = randomUUID();
  let shared = '';

  /** Run `fn` as `who`, in a write request's scope (as its routes do). */
  const as = async <T>(who: string, fn: () => Promise<T>): Promise<T> => {
    const scope = await m.loginScopeFor(who);
    return m.runInRequestSlot(async () => {
      m.enterRequestScope(scope, { writes: true, drafts: false });
      return fn();
    });
  };
  /** As `who`, making in workspace `ws`. */
  const makeIn = <T>(who: string, ws: string, fn: () => Promise<T>) =>
    as(who, () => m.withCreateHome({ createWs: ws, privateWs: null }, fn));

  const ids = async (who: string) => (await as(who, () => s.listSecrets(owner))).map((r) => r.id);

  beforeAll(async () => {
    ts = await import('@mantle/db/test-support');
    // Both checks on, as on a box (as a3b-store-brokers.db.test.ts): a
    // change the scope may not make is refused by the database, not only by
    // the route's item check.
    process.env.MANTLE_ACTOR_CHECK = 'on';
    process.env.MANTLE_TEST_EDIT_CHECK = 'on';
    scratch = await ts.createMigratedScratchDatabase(URL!);
    process.env.DATABASE_URL = scratch.url;
    process.env.MANTLE_MASTER_KEY ??= 'mantle-viewer-test-key';
    m = await import('@mantle/db');
    s = await import('./secrets');
    sqlTag = (await import('drizzle-orm')).sql;
    await ts.ensureTestViewerRoles(URL!, process.env.MANTLE_MASTER_KEY);
    su = (q) => ts.superuserExec(scratch!.url, q);
    await su(sqlTag`insert into auth.users (id, email, password_hash, role, is_owner, display_name)
      values (${owner}, ${`${tag}-o@example.invalid`}, 'x', 'admin', true, 'Olive Owner')`);
    await ts.runWorkspacesSwitch(scratch.url);
    await su(sqlTag`insert into auth.users (id, email, password_hash, role, display_name) values
      (${MOD}, ${`${tag}-m@example.invalid`}, 'x', 'member', 'Mo'),
      (${USER}, ${`${tag}-u@example.invalid`}, 'x', 'member', 'Una'),
      (${OUT}, ${`${tag}-x@example.invalid`}, 'x', 'member', 'Xan')`);
    await su(sqlTag`insert into workspaces (id, owner_id, name) values
      (${W}, ${owner}, ${`${tag} W`}), (${O}, ${owner}, ${`${tag} O`})`);
    await su(sqlTag`delete from workspace_users where login_id in (${MOD}, ${USER}, ${OUT})`);
    await su(sqlTag`insert into workspace_users (workspace_id, login_id, moderator) values
      (${W}, ${MOD}, true), (${W}, ${USER}, false), (${O}, ${OUT}, true)`);
  }, 240_000);

  afterAll(async () => {
    await m?.closeDb();
    await scratch?.drop();
  });

  it('a Moderator makes a secret in W; a user of W lists and reveals it; an outsider finds nothing', async () => {
    const row = await makeIn(MOD, W, () =>
      s.createSecret(owner, {
        title: `${tag} deploy env`,
        description: 'the staging deploy settings',
        kind: 'env',
        tags: ['deploy'],
        note: 'API_TOKEN=one-two-three\nREGION=north',
        fields: [{ label: 'user', value: 'deployer' }],
      }),
    );
    shared = row.id;
    expect(row).toMatchObject({ kind: 'env', hasNote: true, fieldCount: 1 });
    // The metadata never carries a value.
    expect(JSON.stringify(row)).not.toContain('one-two-three');
    expect(JSON.stringify(row)).not.toContain('deployer');

    expect(await ids(USER)).toContain(shared);
    const seen = await as(USER, () => s.revealSecret(owner, shared));
    expect(seen?.payload).toEqual({
      note: 'API_TOKEN=one-two-three\nREGION=north',
      fields: [{ label: 'user', value: 'deployer' }],
    });

    expect(await ids(OUT)).not.toContain(shared);
    expect(await as(OUT, () => s.getSecretMetadata(owner, shared))).toBeNull();
    expect(await as(OUT, () => s.revealSecret(owner, shared))).toBeNull();
  });

  it('a user of W without Write changes and deletes nothing; the Moderator replaces the note', async () => {
    await expect(
      as(USER, () => s.updateSecret(owner, shared, { note: 'stolen' })),
    ).rejects.toThrow();
    await expect(as(USER, () => s.deleteSecret(owner, shared))).rejects.toThrow();
    // Nothing changed.
    expect((await as(USER, () => s.revealSecret(owner, shared)))?.payload.note).toBe(
      'API_TOKEN=one-two-three\nREGION=north',
    );

    // The note alone: the fields are kept.
    await as(MOD, () => s.updateSecret(owner, shared, { note: 'API_TOKEN=four' }));
    expect((await as(USER, () => s.revealSecret(owner, shared)))?.payload).toEqual({
      note: 'API_TOKEN=four',
      fields: [{ label: 'user', value: 'deployer' }],
    });
    // An outsider's change finds nothing.
    expect(await as(OUT, () => s.updateSecret(owner, shared, { note: 'x' }))).toBeNull();
    expect(await as(OUT, () => s.deleteSecret(owner, shared))).toBe(false);
  });

  it('a Write grant to O lets its user change the value, not delete it', async () => {
    // The grant with the item's head held, in one statement (both ids are
    // this test's own uuids).
    await su(
      sqlTag.raw(`do $$ begin
        perform mantle_lock_heads(array['${shared}']::uuid[], 'update');
        insert into item_grants (node_id, workspace_id, is_home, write)
          values ('${shared}', '${O}', false, true);
      end $$`),
    );
    expect(await ids(OUT)).toContain(shared);
    await as(OUT, () =>
      s.updateSecret(owner, shared, { fields: [{ label: 'user', value: 'ops' }] }),
    );
    expect((await as(USER, () => s.revealSecret(owner, shared)))?.payload).toEqual({
      note: 'API_TOKEN=four',
      fields: [{ label: 'user', value: 'ops' }],
    });
  });

  it('an Admin user not in W reads nothing of it; a secret made in Admin stays Admin’s', async () => {
    expect(await ids(owner)).not.toContain(shared);
    expect(await as(owner, () => s.revealSecret(owner, shared))).toBeNull();
    const [admin] = (await su(
      sqlTag`select id::text as id from workspaces where owner_id = ${owner} and is_admin limit 1`,
    )) as { id: string }[];
    const adminSecret = await makeIn(owner, admin!.id, () =>
      s.createSecret(owner, {
        title: `${tag} admin only`,
        description: '',
        kind: 'password',
        tags: [],
        note: '',
        fields: [{ label: 'password', value: 'hunter2' }],
      }),
    );
    expect((await as(owner, () => s.revealSecret(owner, adminSecret.id)))?.payload.fields).toEqual([
      { label: 'password', value: 'hunter2' },
    ]);
    for (const who of [MOD, USER, OUT]) {
      expect(await ids(who)).not.toContain(adminSecret.id);
      expect(await as(who, () => s.revealSecret(owner, adminSecret.id))).toBeNull();
    }
  });

  it('the Moderator of its home deletes it, and its sealed row goes with it', async () => {
    expect(await as(MOD, () => s.deleteSecret(owner, shared))).toBe(true);
    const rows = (await su(
      sqlTag`select count(*)::int as n from secrets where node_id = ${shared}`,
    )) as { n: number }[];
    expect(rows[0]!.n).toBe(0);
    expect(await ids(USER)).not.toContain(shared);
  });
});
