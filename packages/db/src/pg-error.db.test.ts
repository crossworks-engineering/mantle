/**
 * What a duplicate insert really throws, on a real, migrated Postgres. The
 * unit test (pg-error.test.ts) fakes the shape; this pins it, so a drizzle
 * upgrade that changes the wrapping fails here first.
 *   MANTLE_TEST_DATABASE_URL=postgres://… pnpm vitest run packages/db/src/pg-error.db.test.ts
 */
import { randomUUID } from 'node:crypto';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

const URL = process.env.MANTLE_TEST_DATABASE_URL;

describe.skipIf(!URL)('a duplicate insert', () => {
  type Db = typeof import('./index');
  type Admin = Parameters<Db['ensureViewerRoles']>[0];
  let m: Db;
  let admin: Admin;
  const id = randomUUID();
  const email = `pgerr${id.slice(0, 8)}@example.invalid`;

  beforeAll(async () => {
    process.env.DATABASE_URL = URL;
    process.env.MANTLE_MASTER_KEY ??= 'mantle-viewer-test-key';
    m = await import('./index');
    admin = (m.systemDb as unknown as { $client: Admin }).$client;
    await admin`insert into auth.users (id, email, password_hash, role)
      values (${id}, ${email}, 'x', 'member')`;
  }, 60_000);

  afterAll(async () => {
    if (!admin) return;
    await admin`delete from spaces where login_id = ${id}`;
    await admin`delete from auth.users where id = ${id}`;
  });

  async function caught(p: Promise<unknown>): Promise<unknown> {
    try {
      await p;
    } catch (err) {
      return err;
    }
    throw new Error('expected the insert to fail');
  }

  it('through the drizzle query builder: code on the cause, not the top', async () => {
    const err = await caught(
      m.systemDb
        .insert(m.authUsers)
        .values({ id: randomUUID(), email, passwordHash: 'x', role: 'member' }),
    );
    const e = err as Error & {
      code?: unknown;
      cause?: { code?: unknown; constraint_name?: unknown };
    };
    expect(e.constructor.name).toBe('DrizzleQueryError');
    expect(e.message.startsWith('Failed query:')).toBe(true);
    expect(e.message).not.toContain('duplicate key');
    expect(e.code).toBeUndefined();
    expect(e.cause?.code).toBe('23505');
    expect(e.cause?.constraint_name).toBe('users_email_key');
    expect(m.pgErrorCode(err)).toBe('23505');
    expect(m.pgConstraint(err)).toBe('users_email_key');
    expect(m.isUniqueViolation(err)).toBe(true);
  });

  it('inside a drizzle transaction: the same wrapping', async () => {
    const err = await caught(
      m.systemDb.transaction(async (tx) => {
        await tx
          .insert(m.authUsers)
          .values({ id: randomUUID(), email, passwordHash: 'x', role: 'member' });
      }),
    );
    expect((err as { code?: unknown }).code).toBeUndefined();
    expect(m.isUniqueViolation(err)).toBe(true);
  });

  it('through a raw postgres-js query: code on the top', async () => {
    const err = await caught(
      admin`insert into auth.users (id, email, password_hash, role)
        values (${randomUUID()}, ${email}, 'x', 'member')`,
    );
    expect((err as { code?: unknown }).code).toBe('23505');
    expect(m.isUniqueViolation(err)).toBe(true);
  });
});
