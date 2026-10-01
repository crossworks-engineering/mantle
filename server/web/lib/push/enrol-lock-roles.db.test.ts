/**
 * The row locks of a push enrol and a token refresh (`select … for share`)
 * under database roles that are NOT a superuser. Postgres grants FOR SHARE
 * only to a role that may also UPDATE the table, so the lock depends on the
 * role the app connects as:
 *
 *   - an app role with the ordinary table rights (read and write, not a
 *     superuser, not the owner): the enrol takes its lock and lands, and a
 *     device enrolled with a rotated token is bound to the successor;
 *   - a role that may only SELECT (the shape of a read-only brain, such as
 *     the public demo): the lock is a refused write (isWriteRefused), so an
 *     enrol and a refresh fail cleanly there and write nothing.
 *
 * On a real migrated Postgres:
 *
 *   MANTLE_TEST_DATABASE_URL=postgres://… pnpm vitest run server/web/lib/push/enrol-lock-roles.db.test.ts
 */
import { randomUUID } from 'node:crypto';
import postgres from 'postgres';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

const URL_ADMIN = process.env.MANTLE_TEST_DATABASE_URL;

/** A GRANT or REVOKE on a table's ACL fails with "tuple concurrently
 *  updated" when another test file changes the same ACL at that moment (the
 *  files run in parallel on one database). Try again a few times. */
async function aclChange(run: () => Promise<unknown>): Promise<void> {
  for (let i = 0; ; i++) {
    try {
      await run();
      return;
    } catch (err) {
      if (i >= 5 || !/tuple concurrently updated/.test(String(err))) throw err;
      await new Promise((r) => setTimeout(r, 100 * (i + 1)));
    }
  }
}

describe.skipIf(!URL_ADMIN)('enrol and refresh locks under a role that is not a superuser', () => {
  let admin: ReturnType<typeof postgres>;
  let reader: ReturnType<typeof postgres>;
  let m: typeof import('@mantle/db');
  let store: typeof import('./store');
  const tag = `elr${randomUUID().slice(0, 8)}`;
  const writer = `${tag}_app`;
  const readOnly = `${tag}_ro`;
  const login = randomUUID();
  const live = randomUUID();
  const rotated = randomUUID();
  const successor = randomUUID();
  let savedUrl: string | undefined;

  const roleUrl = (role: string) => {
    const u = new URL(URL_ADMIN!);
    u.username = role;
    u.password = tag;
    return u.toString();
  };

  beforeAll(async () => {
    admin = postgres(URL_ADMIN!, { max: 1, onnotice: () => {} });
    await admin`insert into auth.users (id, email, password_hash, role)
                values (${login}, ${`${tag}@example.invalid`}, 'x', 'member')`;
    await admin`insert into mobile_tokens (id, user_id, label, expires_at)
                values (${live}, ${login}, ${tag}, now() + interval '1 day'),
                       (${successor}, ${login}, ${tag}, now() + interval '1 day')`;
    await admin`insert into mobile_tokens (id, user_id, label, expires_at, revoked_at, rotated_to)
                values (${rotated}, ${login}, ${tag}, now() + interval '1 day', now(), ${successor})`;

    // The app role: reads and writes the tables, owns none, no superuser.
    // The read-only role: SELECT only (the read-only brain's connection).
    // Only the three tables the locks touch, so this file changes few ACLs.
    const tables = 'public.mobile_tokens, public.push_subscriptions, auth.users';
    await admin.unsafe(`create role ${writer} login nosuperuser password '${tag}'`);
    await admin.unsafe(`create role ${readOnly} login nosuperuser password '${tag}'`);
    for (const stmt of [
      `grant usage on schema public, auth to ${writer}, ${readOnly}`,
      `grant select, insert, update, delete on ${tables} to ${writer}`,
      `grant select on ${tables} to ${readOnly}`,
    ]) {
      await aclChange(() => admin.unsafe(stmt));
    }

    savedUrl = process.env.DATABASE_URL;
    process.env.DATABASE_URL = roleUrl(writer);
    process.env.MANTLE_MASTER_KEY ??= 'mantle-viewer-test-key';
    m = await import('@mantle/db');
    store = await import('./store');
    reader = postgres(roleUrl(readOnly), { max: 1, onnotice: () => {} });
  }, 60_000);

  afterAll(async () => {
    await m?.closeDb();
    await reader?.end({ timeout: 5 });
    if (savedUrl === undefined) delete process.env.DATABASE_URL;
    else process.env.DATABASE_URL = savedUrl;
    if (!admin) return;
    await admin`delete from push_subscriptions where login_id = ${login}`;
    await admin`delete from mobile_tokens where user_id = ${login}`;
    await admin`delete from auth.users where id = ${login}`;
    for (const role of [writer, readOnly]) {
      await aclChange(() => admin.unsafe(`drop owned by ${role}`));
      await admin.unsafe(`drop role if exists ${role}`);
    }
    await admin.end({ timeout: 5 });
  });

  it('the app connection is no superuser (the control)', async () => {
    const { sql } = await import('drizzle-orm');
    const rows = (await m.db.execute(
      sql`select current_user as name, rolsuper from pg_roles where rolname = current_user`,
    )) as unknown as Array<{ name: string; rolsuper: boolean }>;
    expect(rows[0]).toEqual({ name: writer, rolsuper: false });
  });

  it('an enrol takes its lock and lands, on the live token', async () => {
    const res = await store.insertSubscription({
      ownerId: login,
      loginId: login,
      tokenId: live,
      routingToken: `${tag}-live`,
      publicKey: 'pk',
      platform: 'ios',
    });
    expect(res.dropped).toEqual([]);
    const [row] = await admin`select token_id from push_subscriptions where id = ${res.id}`;
    expect(row!.token_id).toBe(live);
  });

  it('an enrol with a rotated token is bound to the successor', async () => {
    const res = await store.insertSubscription({
      ownerId: login,
      loginId: login,
      tokenId: rotated,
      routingToken: `${tag}-rotated`,
      publicKey: 'pk',
      platform: 'android',
    });
    const [row] = await admin`select token_id from push_subscriptions where id = ${res.id}`;
    expect(row!.token_id).toBe(successor);
  });

  it("the refresh's lock on the login row is granted", async () => {
    const { sql } = await import('drizzle-orm');
    const locked = await m.db.transaction(
      async (tx) =>
        (await tx.execute(
          sql`select session_epoch as epoch from auth.users where id = ${login} for share`,
        )) as unknown as Array<{ epoch: number }>,
    );
    expect(locked).toHaveLength(1);
  });

  it('a SELECT-only role is refused both locks as a write, and writes nothing', async () => {
    const before =
      await admin`select count(*)::int as n from push_subscriptions where login_id = ${login}`;
    for (const stmt of [
      reader`select revoked_at from mobile_tokens where id = ${live} for share`,
      reader`select session_epoch from auth.users where id = ${login} for share`,
    ]) {
      const err = await stmt.then(
        () => null,
        (e: unknown) => e,
      );
      expect(err).not.toBeNull();
      expect(m.isWriteRefused(err)).toBe(true);
    }
    const after =
      await admin`select count(*)::int as n from push_subscriptions where login_id = ${login}`;
    expect(after[0]!.n).toBe(before[0]!.n);
  });
});
