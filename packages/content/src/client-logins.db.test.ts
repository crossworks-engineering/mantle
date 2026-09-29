/**
 * Client logins and sign-in links (client logins C2) on a real, migrated
 * Postgres: nothing is made until "What clients see" is acknowledged, and
 * again once a new item goes to client; a client login is made with role
 * client and the hash it is given; a link is one use, 72 hours, stored only
 * as a hash, checked against the client's email, revoked by a newer link or
 * by the admin, and dead for a disabled login or one that is not a client.
 * Seeds a brain of its own and removes it.
 *   MANTLE_TEST_DATABASE_URL=postgres://… pnpm vitest run packages/content/src/client-logins.db.test.ts
 */
import { createHash, randomUUID } from 'node:crypto';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

const URL = process.env.MANTLE_TEST_DATABASE_URL;
const HOUR = 60 * 60 * 1000;

describe.skipIf(!URL)('client logins and sign-in links', () => {
  type Db = typeof import('@mantle/db');
  let m: Db;
  let c: typeof import('./client-logins');
  let report: typeof import('./client-report');
  let sqlTag: typeof import('drizzle-orm').sql;
  const owner = randomUUID();
  const member = randomUUID();
  const contact = randomUUID();
  const clientItem = randomUUID();
  const lateItem = randomUUID();
  const tag = `clogin-${owner.slice(0, 8)}`;
  const email = (s: string) => `${tag}-${s}@example.invalid`;
  const made: string[] = [];
  const exec = (q: ReturnType<typeof sqlTag>) => m.systemDb.execute(q);
  const rows = async <T>(q: ReturnType<typeof sqlTag>) => (await exec(q)) as unknown as T[];

  const newClient = async (name: string) => {
    const row = await c.createClientLogin(owner, {
      email: email(name),
      unusablePasswordHash: `unusable-${name}`,
      createdBy: owner,
    });
    made.push(row.id);
    return row;
  };

  beforeAll(async () => {
    process.env.DATABASE_URL = URL;
    m = await import('@mantle/db');
    c = await import('./client-logins');
    report = await import('./client-report');
    sqlTag = (await import('drizzle-orm')).sql;
    await exec(sqlTag`
      insert into auth.users (id, email, password_hash, role) values
        (${owner}, ${email('owner')}, 'x', 'admin'),
        (${member}, ${email('member')}, 'x', 'member')`);
    await exec(
      sqlTag`insert into spaces (id, kind, login_id) values (${owner}, 'brain', ${owner})`,
    );
    await exec(sqlTag`
      insert into nodes (id, owner_id, type, title, path, audience, data) values
        (${clientItem}, ${owner}, 'note', 'For the client', 'notes', 'client', '{}'::jsonb),
        (${contact}, ${owner}, 'contact', 'Carla Client', 'contacts', 'admin',
         ${JSON.stringify({ emails: [email('carla')] })}::jsonb)`);
  });

  afterAll(async () => {
    await exec(sqlTag`delete from client_report_acks where owner_id = ${owner}`);
    await exec(sqlTag`delete from nodes where owner_id = ${owner}`);
    for (const id of [...made, member, owner]) {
      await exec(sqlTag`delete from spaces where login_id = ${id}`);
      await exec(sqlTag`delete from auth.users where id = ${id}`);
    }
    await m.closeDb();
  });

  it('refuses to add a client before "What clients see" is acknowledged', async () => {
    await expect(newClient('early')).rejects.toMatchObject({ reason: 'report-not-acknowledged' });
    const [n] = await rows<{ n: number }>(
      sqlTag`select count(*)::int as n from auth.users where email = ${email('early')}`,
    );
    expect(n!.n).toBe(0);
  });

  it('makes a CLIENT login with the given hash once the report is acknowledged', async () => {
    await report.acknowledgeClientReport(owner, owner, [clientItem]);
    const row = await newClient('ada');
    expect(row).toMatchObject({ email: email('ada'), disabled: false, openLink: null });
    const [u] = await rows<{ role: string; password_hash: string; is_owner: boolean }>(
      sqlTag`select role, password_hash, is_owner from auth.users where id = ${row.id}`,
    );
    expect(u).toEqual({ role: 'client', password_hash: 'unusable-ada', is_owner: false });
    // Every login gets its personal space (0165), which the client session needs.
    const [s] = await rows<{ n: number }>(
      sqlTag`select count(*)::int as n from spaces where login_id = ${row.id} and kind = 'personal'`,
    );
    expect(s!.n).toBe(1);
  });

  it('takes the email and name from a contact, once', async () => {
    const row = await c.createClientLogin(owner, {
      contactId: contact,
      unusablePasswordHash: 'x',
      createdBy: owner,
    });
    made.push(row.id);
    expect(row).toMatchObject({
      email: email('carla'),
      displayName: 'Carla Client',
      contactId: contact,
    });
    await expect(
      c.createClientLogin(owner, {
        contactId: contact,
        unusablePasswordHash: 'x',
        createdBy: owner,
      }),
    ).rejects.toMatchObject({ reason: 'contact-has-login' });
    await expect(
      c.createClientLogin(owner, {
        contactId: randomUUID(),
        unusablePasswordHash: 'x',
        createdBy: owner,
      }),
    ).rejects.toMatchObject({ reason: 'contact-not-found' });
  });

  it('refuses an email a login already has, in any case', async () => {
    await expect(
      c.createClientLogin(owner, {
        email: email('member').toUpperCase(),
        unusablePasswordHash: 'x',
        createdBy: owner,
      }),
    ).rejects.toMatchObject({ reason: 'email-has-login' });
  });

  it('issues a link stored only as its hash, 72 hours, and lists it without the code', async () => {
    const ada = (await c.listClientLogins(owner)).find((r) => r.email === email('ada'))!;
    const now = new Date();
    const { link, code } = await c.issueClientSigninLink(owner, ada.id, owner, now);
    expect(code).toHaveLength(16);
    expect(new Date(link.expiresAt).getTime() - now.getTime()).toBe(72 * HOUR);
    const [stored] = await rows<{ code_hash: string; kind: string; created_by: string }>(
      sqlTag`select code_hash, kind, created_by from client_signin_codes where id = ${link.id}`,
    );
    expect(stored).toEqual({
      code_hash: createHash('sha256').update(code, 'utf8').digest('hex'),
      kind: 'admin_link',
      created_by: owner,
    });
    const listed = (await c.listClientLogins(owner)).find((r) => r.id === ada.id)!;
    expect(listed.openLink).toEqual(link);
    expect(JSON.stringify(listed)).not.toContain(code);
    expect(c.clientSigninLinkPath(code)).toBe(`/client-signin?code=${code}`);
  });

  it('redeems once, only with the login email (any case), and records the use', async () => {
    const row = await newClient('once');
    const { code, link } = await c.issueClientSigninLink(owner, row.id, owner);
    expect(await c.redeemClientSigninLink({ code, email: email('ada') })).toBeNull();
    expect(await c.redeemClientSigninLink({ code, email: '' })).toBeNull();
    const ok = await c.redeemClientSigninLink({ code, email: ` ${email('once').toUpperCase()} ` });
    expect(ok).toMatchObject({ loginId: row.id, ownerId: owner, linkId: link.id, sessionEpoch: 0 });
    expect(await c.redeemClientSigninLink({ code, email: email('once') })).toBeNull();
    const listed = (await c.listClientLogins(owner)).find((r) => r.id === row.id)!;
    expect(listed.openLink).toBeNull();
    expect(listed.lastLinkUsedAt).not.toBeNull();
    expect(listed.lastLoginAt).not.toBeNull();
  });

  it('refuses an expired link (after 72 hours)', async () => {
    const row = await newClient('late');
    const now = new Date();
    const { code } = await c.issueClientSigninLink(owner, row.id, owner, now);
    const after = new Date(now.getTime() + 72 * HOUR + 1000);
    expect(await c.redeemClientSigninLink({ code, email: email('late') }, after)).toBeNull();
    const before = new Date(now.getTime() + 71 * HOUR);
    expect(await c.redeemClientSigninLink({ code, email: email('late') }, before)).not.toBeNull();
  });

  it('a newer link revokes the older one; the admin can revoke the open one', async () => {
    const row = await newClient('twice');
    const first = await c.issueClientSigninLink(owner, row.id, owner);
    const second = await c.issueClientSigninLink(owner, row.id, owner);
    expect(await c.redeemClientSigninLink({ code: first.code, email: email('twice') })).toBeNull();
    expect(await c.revokeClientSigninLink(owner, row.id)).toBe(true);
    expect(await c.revokeClientSigninLink(owner, row.id)).toBe(false);
    expect(await c.redeemClientSigninLink({ code: second.code, email: email('twice') })).toBeNull();
  });

  it('refuses a link for a disabled client, and issues none for it or a member', async () => {
    const row = await newClient('gone');
    const { code } = await c.issueClientSigninLink(owner, row.id, owner);
    await exec(sqlTag`update auth.users set disabled_at = now() where id = ${row.id}`);
    expect(await c.redeemClientSigninLink({ code, email: email('gone') })).toBeNull();
    await expect(c.issueClientSigninLink(owner, row.id, owner)).rejects.toMatchObject({
      reason: 'not-a-client',
    });
    await expect(c.issueClientSigninLink(owner, member, owner)).rejects.toMatchObject({
      reason: 'not-a-client',
    });
  });

  it('refuses a link whose login is no longer a client', async () => {
    const row = await newClient('moved');
    const { code } = await c.issueClientSigninLink(owner, row.id, owner);
    await exec(sqlTag`update auth.users set role = 'member' where id = ${row.id}`);
    expect(await c.redeemClientSigninLink({ code, email: email('moved') })).toBeNull();
    expect((await c.listClientLogins(owner)).map((r) => r.id)).not.toContain(row.id);
    made.splice(made.indexOf(row.id), 1);
    await exec(sqlTag`delete from spaces where login_id = ${row.id}`);
    await exec(sqlTag`delete from auth.users where id = ${row.id}`);
  });

  it('asks again once a new item goes to client: no new client, no new link', async () => {
    const ada = (await c.listClientLogins(owner)).find((r) => r.email === email('ada'))!;
    await exec(sqlTag`
      insert into nodes (id, owner_id, type, title, path, audience, data)
      values (${lateItem}, ${owner}, 'note', 'Later for clients', 'notes', 'client', '{}'::jsonb)`);
    await expect(newClient('after')).rejects.toMatchObject({ reason: 'report-not-acknowledged' });
    await expect(c.issueClientSigninLink(owner, ada.id, owner)).rejects.toMatchObject({
      reason: 'report-not-acknowledged',
    });
    await report.acknowledgeClientReport(owner, owner, [clientItem, lateItem]);
    const { code } = await c.issueClientSigninLink(owner, ada.id, owner);
    expect(code).toHaveLength(16);
  });

  it('lists client logins only, never a member or an admin', async () => {
    const ids = (await c.listClientLogins(owner)).map((r) => r.id);
    expect(ids).not.toContain(member);
    expect(ids).not.toContain(owner);
    for (const id of made) expect(ids).toContain(id);
  });

  it('deleting a login deletes its links', async () => {
    const row = await newClient('deleted');
    const { link } = await c.issueClientSigninLink(owner, row.id, owner);
    await exec(sqlTag`delete from spaces where login_id = ${row.id}`);
    await exec(sqlTag`delete from auth.users where id = ${row.id}`);
    const left = await rows(sqlTag`select 1 from client_signin_codes where id = ${link.id}`);
    expect(left).toHaveLength(0);
  });
});
