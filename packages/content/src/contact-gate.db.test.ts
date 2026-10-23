/**
 * The email gates and the brain's logins on a real, migrated Postgres: an
 * active STAFF login's address (admin or member) is allowed like a contact
 * (users are contacts in user form, 2026-09-26); a disabled login's is not.
 * A contact's address passes too, inbound (the contact gate) and outbound
 * (contactEmails, the email_send allowlist), while loginEmails names only
 * the active logins. There is no client login since 0272. Seeds a brain and
 * logins of its own, removes them.
 *   MANTLE_TEST_DATABASE_URL=postgres://… pnpm vitest run packages/content/src/contact-gate.db.test.ts
 */
import { randomUUID } from 'node:crypto';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { asSuperuser } from '@mantle/db/test-support';

const URL = process.env.MANTLE_TEST_DATABASE_URL;

describe.skipIf(!URL)('email gates and the brain logins', () => {
  type Db = typeof import('@mantle/db');
  let m: Db;
  let sqlTag: typeof import('drizzle-orm').sql;
  const tag = randomUUID().slice(0, 8);
  const owner = randomUUID();
  const active = randomUUID();
  const disabled = randomUUID();
  const contactNode = randomUUID();
  const activeEmail = `active-${tag}@example.invalid`;
  const disabledEmail = `gone-${tag}@example.invalid`;
  const contactEmail = `known-${tag}@example.invalid`;
  const logins = [active, disabled];

  beforeAll(async () => {
    process.env.DATABASE_URL = URL;
    m = await import('@mantle/db');
    sqlTag = (await import('drizzle-orm')).sql;
    await asSuperuser()(sqlTag`
      insert into auth.users (id, email, password_hash, role, disabled_at) values
        (${owner}, ${`owner-${tag}@example.invalid`}, 'x', 'admin', null),
        (${active}, ${activeEmail}, 'x', 'member', null),
        (${disabled}, ${disabledEmail}, 'x', 'member', now())`);
    await m.systemDb.execute(
      sqlTag`insert into spaces (id, kind, login_id) values (${owner}, 'brain', ${owner})`,
    );
    // A contact of the brain that is no login.
    await m.systemDb.execute(sqlTag`
      insert into nodes (id, owner_id, type, title, path, data) values
        (${contactNode}, ${owner}, 'contact', 'Known contact', 'contacts',
         ${JSON.stringify({ emails: [contactEmail] })}::jsonb)`);
  }, 60_000);

  afterAll(async () => {
    await m.systemDb.execute(sqlTag`delete from nodes where owner_id = ${owner}`);
    for (const id of [...logins, owner]) {
      await m.systemDb.execute(sqlTag`delete from spaces where login_id = ${id}`);
      await m.systemDb.execute(sqlTag`delete from auth.users where id = ${id}`);
    }
    await m.closeDb();
  });

  it('allows an active staff login, not a disabled one, and not a stranger', async () => {
    const { loadContactGate } = await import('./contact-gate');
    const gate = await loadContactGate(owner);
    expect(gate.allows(activeEmail.toUpperCase())).toBe(true);
    expect(gate.allows(disabledEmail)).toBe(false);
    expect(gate.allows(`stranger-${tag}@example.invalid`)).toBe(false);
  });

  it('inbound: a contact passes the gate', async () => {
    const { loadContactGate } = await import('./contact-gate');
    const gate = await loadContactGate(owner);
    expect(gate.allows(contactEmail)).toBe(true);
  });

  it('outbound: loginEmails names the active logins only; contactEmails has the contact', async () => {
    const { loginEmails, contactEmails } = await import('./contacts');
    const staff = await loginEmails();
    expect(staff).toContain(activeEmail);
    expect(staff).not.toContain(disabledEmail);
    expect(staff).not.toContain(contactEmail);
    const contacts = await contactEmails(owner);
    expect(contacts).toContain(contactEmail);
  });
});
