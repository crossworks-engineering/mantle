/**
 * The inbound email gate on a real, migrated Postgres: an active login's
 * address is allowed like a contact (users are contacts in user form,
 * 2026-09-26); a disabled login's is not. Seeds its own logins, removes them.
 *   MANTLE_TEST_DATABASE_URL=postgres://… pnpm vitest run packages/content/src/contact-gate.db.test.ts
 */
import { randomUUID } from 'node:crypto';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

const URL = process.env.MANTLE_TEST_DATABASE_URL;

describe.skipIf(!URL)('inbound email gate and the brain users', () => {
  type Db = typeof import('@mantle/db');
  let m: Db;
  let sqlTag: typeof import('drizzle-orm').sql;
  const tag = randomUUID().slice(0, 8);
  const active = randomUUID();
  const disabled = randomUUID();
  const activeEmail = `active-${tag}@example.invalid`;
  const disabledEmail = `gone-${tag}@example.invalid`;

  beforeAll(async () => {
    process.env.DATABASE_URL = URL;
    m = await import('@mantle/db');
    sqlTag = (await import('drizzle-orm')).sql;
    await m.systemDb.execute(sqlTag`
      insert into auth.users (id, email, password_hash, role, disabled_at) values
        (${active}, ${activeEmail}, 'x', 'member', null),
        (${disabled}, ${disabledEmail}, 'x', 'member', now())`);
  });

  afterAll(async () => {
    await m.systemDb.execute(sqlTag`delete from spaces where login_id in (${active}, ${disabled})`);
    await m.systemDb.execute(sqlTag`delete from auth.users where id in (${active}, ${disabled})`);
    await m.closeDb();
  });

  it('allows an active login, not a disabled one, and not a stranger', async () => {
    const { loadContactGate } = await import('./contact-gate');
    const gate = await loadContactGate(randomUUID());
    expect(gate.allows(activeEmail.toUpperCase())).toBe(true);
    expect(gate.allows(disabledEmail)).toBe(false);
    expect(gate.allows(`stranger-${tag}@example.invalid`)).toBe(false);
  });
});
