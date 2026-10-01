/**
 * The two writes on the sign-in read path are best effort on a database that
 * refuses writes (a read-only brain, such as the public demo): stamping a
 * device token as used, and making a login's missing personal space. Run as
 * a role that may only SELECT, on a real migrated Postgres: neither fails
 * the request, and neither writes.
 *
 *   MANTLE_TEST_DATABASE_URL=postgres://… pnpm vitest run server/web/lib/auth/login-row-readonly.db.test.ts
 */
import { randomUUID } from 'node:crypto';
import postgres from 'postgres';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

const URL_ADMIN = process.env.MANTLE_TEST_DATABASE_URL;

describe.skipIf(!URL_ADMIN)('sign-in reads on a database that refuses writes', () => {
  let admin: ReturnType<typeof postgres>;
  let m: typeof import('@mantle/db');
  let rows: typeof import('./login-row');
  const tag = `rolr${randomUUID().slice(0, 8)}`;
  const role = `${tag}_ro`;
  const withSpace = randomUUID();
  const noSpace = randomUUID();
  const jti = randomUUID();
  let savedUrl: string | undefined;

  beforeAll(async () => {
    admin = postgres(URL_ADMIN!, { max: 1, onnotice: () => {} });
    for (const id of [withSpace, noSpace]) {
      await admin`insert into auth.users (id, email, password_hash, role)
                  values (${id}, ${`${tag}-${id.slice(0, 8)}@example.invalid`}, 'x', 'member')`;
    }
    // A login whose personal space is missing (a row from before 0165).
    await admin`delete from spaces where login_id = ${noSpace}`;
    await admin`insert into mobile_tokens (id, user_id, label, expires_at)
                values (${jti}, ${withSpace}, ${tag}, now() + interval '1 day')`;
    // A role that may read everything and write nothing.
    // BYPASSRLS: what is under test is the refused write, not the row rules.
    await admin.unsafe(`create role ${role} login bypassrls password '${tag}'`);
    await admin.unsafe(`grant usage on schema public, auth to ${role}`);
    await admin.unsafe(`grant select on all tables in schema public to ${role}`);
    await admin.unsafe(`grant select on all tables in schema auth to ${role}`);

    const u = new URL(URL_ADMIN!);
    u.username = role;
    u.password = tag;
    savedUrl = process.env.DATABASE_URL;
    process.env.DATABASE_URL = u.toString();
    process.env.MANTLE_MASTER_KEY ??= 'mantle-viewer-test-key';
    m = await import('@mantle/db');
    rows = await import('./login-row');
  }, 60_000);

  afterAll(async () => {
    await m?.closeDb();
    if (savedUrl === undefined) delete process.env.DATABASE_URL;
    else process.env.DATABASE_URL = savedUrl;
    if (!admin) return;
    await admin.unsafe(`drop owned by ${role}`);
    await admin.unsafe(`drop role if exists ${role}`);
    await admin`delete from mobile_tokens where id = ${jti}`;
    await admin`delete from spaces where login_id in ${admin([withSpace, noSpace])}`;
    await admin`delete from auth.users where id in ${admin([withSpace, noSpace])}`;
    await admin.end({ timeout: 5 });
  });

  it('the role really is refused a write (the control)', async () => {
    const { sql } = await import('drizzle-orm');
    await expect(
      m.db.execute(sql`update mobile_tokens set label = 'x' where id = ${jti}`),
    ).rejects.toSatisfy((err: unknown) => m.isWriteRefused(err));
  });

  it('reads a device token and a login, and stamping the token does not fail', async () => {
    expect(await rows.loadBearerToken(jti)).toMatchObject({ userId: withSpace, revokedAt: null });
    expect((await rows.loadLoginRow(withSpace))?.role).toBe('member');
    await expect(rows.touchBearerToken(jti)).resolves.toBeUndefined();
    const [tok] = await admin`select last_used_at from mobile_tokens where id = ${jti}`;
    expect(tok!.last_used_at).toBeNull();
  });

  it('answers a login own space when it has one, and no space when it cannot be made', async () => {
    const [space] = await admin`select id from spaces
                                where login_id = ${withSpace} and kind = 'personal'`;
    expect(await rows.loadPersonalSpaceId(withSpace)).toBe(space!.id);
    await expect(rows.loadPersonalSpaceId(noSpace)).resolves.toBeNull();
    const made = await admin`select id from spaces where login_id = ${noSpace}`;
    expect(made).toHaveLength(0);
  });
});
