/**
 * Member logins Phase 6 stage 3 on a real, migrated Postgres: a team contact
 * that became a member login gets its old portal history linked to the
 * login. Migration 0175's backfill (re-run here on seeded rows: it only fills
 * NULLs, so it is idempotent) links the contact's team_access_log rows and
 * member node_comments; rows of other contacts, of a contact with no linked
 * login, and rows already naming a login are untouched. The invite redeem
 * does the same for the contact it redeems, in its transaction. And
 * listTeamAccess filters by login and returns it.
 * Seeds its own brain row, logins and contacts, removes them.
 *   MANTLE_TEST_DATABASE_URL=postgres://… pnpm vitest run packages/content/src/member-history-links.db.test.ts
 */
import { randomUUID } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

const URL = process.env.MANTLE_TEST_DATABASE_URL;

type Row = Record<string, unknown>;

const MIGRATION = join(__dirname, '..', '..', 'db', 'migrations', '0175_member_history_links.sql');

describe.skipIf(!URL)('member history links (0175 and the invite redeem)', () => {
  let m: typeof import('@mantle/db');
  let inv: typeof import('./member-invites');
  let log: typeof import('./team-access-log');
  let admin: Parameters<typeof m.ensureViewerRoles>[0];
  const tag = `hist-${randomUUID().slice(0, 8)}`;
  const anchor = randomUUID();
  const adminLogin = randomUUID();
  const c = {
    ana: randomUUID(), // has one member login
    bo: randomUUID(), // no login
    // Two member logins used to make a contact ambiguous for 0175. Since 0181
    // a contact links to one login at most, so cy's logins are not linked to
    // it at all: its rows stay untouched, as the ambiguous ones did.
    cy: randomUUID(),
    dee: randomUUID(), // redeemed through an invite in this test
  };
  const logins = {
    ana: randomUUID(),
    cy1: randomUUID(),
    cy2: randomUUID(),
    solo: randomUUID(), // a member with no contact, named in detail.login_id
    other: randomUUID(), // a login a row already names
  };
  const task = randomUUID();
  const email = (who: string) => `${who}-${tag}@example.invalid`;

  const logLogins = async (contactId: string) =>
    (
      await admin<Row[]>`select login_id from team_access_log
                          where owner_id = ${anchor} and contact_id = ${contactId}
                          order by created_at, id`
    ).map((r) => r.login_id);
  const commentLogins = async (contactId: string) =>
    (
      await admin<Row[]>`select author_kind, login_id from node_comments
                          where node_id = ${task} and contact_id = ${contactId}
                          order by created_at, id`
    ).map((r) => [r.author_kind, r.login_id]);
  /** 0175's backfill statements, as the file has them. The DDL already ran
   *  in `db:migrate`; re-running it would take table locks other suites on
   *  the same database may hold. */
  const runBackfill = async () => {
    const statements = readFileSync(MIGRATION, 'utf8')
      .split('--> statement-breakpoint')
      .filter((stmt) => /^UPDATE /m.test(stmt));
    expect(statements).toHaveLength(3);
    for (const stmt of statements) await admin.unsafe(stmt);
  };

  beforeAll(async () => {
    process.env.DATABASE_URL = URL;
    process.env.MANTLE_MASTER_KEY ??= 'mantle-viewer-test-key';
    m = await import('@mantle/db');
    admin = (m.systemDb as unknown as { $client: typeof admin }).$client;
    inv = await import('./member-invites');
    log = await import('./team-access-log');
    await admin`insert into auth.users (id, email, password_hash, role) values
      (${anchor}, ${email('anchor')}, 'x', 'admin'),
      (${adminLogin}, ${email('admin')}, 'x', 'admin')`;
    await admin`insert into spaces (id, kind, login_id) values (${anchor}, 'brain', ${anchor})`;
    const data = (who: string) => JSON.stringify({ emails: [email(who)] });
    await admin`insert into nodes (id, owner_id, type, title, path, data) values
      (${c.ana}, ${anchor}, 'contact', 'Ana', 'contacts', ${data('ana')}::jsonb),
      (${c.bo}, ${anchor}, 'contact', 'Bo', 'contacts', ${data('bo')}::jsonb),
      (${c.cy}, ${anchor}, 'contact', 'Cy', 'contacts', ${data('cy')}::jsonb),
      (${c.dee}, ${anchor}, 'contact', 'Dee', 'contacts', ${data('dee')}::jsonb),
      (${task}, ${anchor}, 'task', 'a task', 'tasks', '{}'::jsonb)`;
    await admin`insert into auth.users (id, email, password_hash, role, contact_id) values
      (${logins.ana}, ${email('ana-login')}, 'x', 'member', ${c.ana}),
      (${logins.cy1}, ${email('cy1')}, 'x', 'member', null),
      (${logins.cy2}, ${email('cy2')}, 'x', 'member', null),
      (${logins.solo}, ${email('solo')}, 'x', 'member', null),
      (${logins.other}, ${email('other')}, 'x', 'member', null)`;
    // Portal history: events per contact, one of Ana's already naming a login
    // (never overwritten), and a member login's own events by detail.
    await admin`insert into team_access_log (owner_id, contact_id, login_id, kind, detail, created_at) values
      (${anchor}, ${c.ana}, null, 'auth', '{}'::jsonb, now() - interval '5 minutes'),
      (${anchor}, ${c.ana}, null, 'turn', '{}'::jsonb, now() - interval '4 minutes'),
      (${anchor}, ${c.ana}, ${logins.other}, 'api', '{}'::jsonb, now() - interval '3 minutes'),
      (${anchor}, ${c.bo}, null, 'auth', '{}'::jsonb, now() - interval '5 minutes'),
      (${anchor}, ${c.cy}, null, 'auth', '{}'::jsonb, now() - interval '5 minutes'),
      (${anchor}, ${c.dee}, null, 'auth', '{}'::jsonb, now() - interval '5 minutes'),
      (${anchor}, null, null, 'turn', ${JSON.stringify({ login_id: logins.solo })}::jsonb, now()),
      (${anchor}, null, null, 'denied', '{"login_id":"not-a-uuid"}'::jsonb, now())`;
    await admin`insert into node_comments (owner_id, node_id, author_kind, contact_id, login_id, author_name, body, created_at) values
      (${anchor}, ${task}, 'member', ${c.ana}, null, 'Ana', 'from the portal', now() - interval '2 minutes'),
      (${anchor}, ${task}, 'owner', ${c.ana}, null, 'Boss', 'not a member comment', now() - interval '1 minute'),
      (${anchor}, ${task}, 'member', ${c.bo}, null, 'Bo', 'no login', now()),
      (${anchor}, ${task}, 'member', ${c.cy}, null, 'Cy', 'ambiguous', now()),
      (${anchor}, ${task}, 'member', ${c.dee}, null, 'Dee', 'before the invite', now())`;
  }, 60_000);

  afterAll(async () => {
    if (!admin) return;
    const rows = await admin<Row[]>`select id from auth.users where email like ${`%${tag}%`}`;
    const ids = rows.map((r) => r.id as string);
    await admin`delete from member_invites where owner_id = ${anchor}`;
    await admin`delete from team_access_log where owner_id = ${anchor}`;
    await admin`delete from node_comments where owner_id = ${anchor}`;
    await admin`delete from nodes where owner_id = ${anchor}`;
    if (ids.length) {
      await admin`delete from spaces where login_id in ${admin(ids as never)}`;
      await admin`delete from spaces where id = ${anchor}`;
      await admin`delete from auth.users where id in ${admin(ids as never)}`;
    }
    await m.closeDb();
  });

  it('0175 links a contact with one member login, and nothing else', async () => {
    await runBackfill();
    expect(await logLogins(c.ana)).toEqual([logins.ana, logins.ana, logins.other]);
    expect(await commentLogins(c.ana)).toEqual([
      ['member', logins.ana],
      ['owner', null],
    ]);
    // No linked login: untouched.
    expect(await logLogins(c.bo)).toEqual([null]);
    expect(await logLogins(c.cy)).toEqual([null]);
    expect(await commentLogins(c.bo)).toEqual([['member', null]]);
    expect(await commentLogins(c.cy)).toEqual([['member', null]]);
    // A member login's own events named it in detail.login_id.
    const own = await admin<Row[]>`select kind, login_id from team_access_log
                                    where owner_id = ${anchor} and contact_id is null
                                    order by kind`;
    expect(own).toEqual([
      { kind: 'denied', login_id: null },
      { kind: 'turn', login_id: logins.solo },
    ]);
  });

  it('0175 is idempotent', async () => {
    const snapshot = async () =>
      admin<Row[]>`select id, login_id from team_access_log where owner_id = ${anchor}
                   union all
                   select id, login_id from node_comments where owner_id = ${anchor}
                   order by id`;
    const before = await snapshot();
    await runBackfill();
    expect(await snapshot()).toEqual(before);
  });

  it('the invite redeem links the contact it redeems, in its transaction', async () => {
    const { code } = await inv.createMemberInvite(anchor, {
      contactId: c.dee,
      createdBy: adminLogin,
    });
    const out = await inv.redeemMemberInvite({ code, passwordHash: 'x' });
    expect(out?.contactId).toBe(c.dee);
    // The old auth row and the redeem's own row both name the login.
    expect(await logLogins(c.dee)).toEqual([out!.loginId, out!.loginId]);
    expect(await commentLogins(c.dee)).toEqual([['member', out!.loginId]]);
    // Other contacts are untouched.
    expect(await logLogins(c.bo)).toEqual([null]);
    expect(await commentLogins(c.cy)).toEqual([['member', null]]);
  });

  it('listTeamAccess filters by login and returns it', async () => {
    const rows = await log.listTeamAccess(anchor, { loginId: logins.ana });
    expect(rows).toHaveLength(2);
    expect(rows.every((r) => r.loginId === logins.ana && r.contactId === c.ana)).toBe(true);
    const all = await log.listTeamAccess(anchor);
    expect(all.find((r) => r.contactId === c.bo)?.loginId).toBeNull();
    expect(await log.listTeamAccess(anchor, { loginId: randomUUID() })).toEqual([]);
  });
});
