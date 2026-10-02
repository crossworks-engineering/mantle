/**
 * The admin's reply to a team request (Phase 6) on a real, migrated Postgres:
 * a request a member LOGIN filed is answered in that login's own thread (the
 * one the dock shows); a request from the retired team-code portal (a contact,
 * no login) still lands in the contact's old thread; no requester is refused.
 * Seeds its own brain row, login, contact and tasks, removes them.
 *   MANTLE_TEST_DATABASE_URL=postgres://… pnpm vitest run packages/content/src/team-requests.db.test.ts
 */
import { randomUUID } from 'node:crypto';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

const URL = process.env.MANTLE_TEST_DATABASE_URL;

type Row = Record<string, unknown>;

describe.skipIf(!URL)('notifyTeamRequester', () => {
  let m: typeof import('@mantle/db');
  let admin: (strings: TemplateStringsArray, ...v: unknown[]) => Promise<Row[]>;
  const tag = `treq-${randomUUID().slice(0, 8)}`;
  const anchor = randomUUID();
  const member = randomUUID();
  const contact = randomUUID();
  const fromLogin = randomUUID();
  const fromPortal = randomUUID();
  const noRequester = randomUUID();

  const task = (teamRequest: Record<string, unknown>) =>
    JSON.stringify({ status: 'open', teamRequest });

  beforeAll(async () => {
    process.env.DATABASE_URL = URL;
    m = await import('@mantle/db');
    admin = (m.systemDb as unknown as { $client: typeof admin }).$client;
    await admin`insert into auth.users (id, email, password_hash, role) values
      (${anchor}, ${`anchor-${tag}@example.invalid`}, 'x', 'admin')`;
    await admin`insert into spaces (id, kind, login_id) values (${anchor}, 'brain', ${anchor})`;
    await admin`insert into nodes (id, owner_id, type, title, path, data) values
      (${contact}, ${anchor}, 'contact', 'Pat', 'contacts', '{}'::jsonb)`;
    await admin`insert into auth.users (id, email, password_hash, role, contact_id) values
      (${member}, ${`member-${tag}@example.invalid`}, 'x', 'member', ${contact})`;
    await admin`insert into nodes (id, owner_id, type, title, path, data) values
      (${fromLogin}, ${anchor}, 'task', 'Login request', 'tasks',
        ${task({ loginId: member, contactId: null, contactName: 'Pat' })}::jsonb),
      (${fromPortal}, ${anchor}, 'task', 'Portal request', 'tasks',
        ${task({ contactId: contact, contactName: 'Pat' })}::jsonb),
      (${noRequester}, ${anchor}, 'task', 'Plain task', 'tasks', '{"status":"open"}'::jsonb)`;
  });

  afterAll(async () => {
    if (!admin) return;
    await admin`delete from team_messages where owner_id = ${anchor}`;
    await admin`delete from nodes where owner_id = ${anchor}`;
    await admin`delete from spaces where login_id in (${anchor}, ${member})`;
    await admin`delete from auth.users where id in (${member}, ${anchor})`;
    await m.closeDb();
  });

  it("answers a member login's request in that login's own thread", async () => {
    const { notifyTeamRequester } = await import('./team-requests');
    const { listTeamThread } = await import('./team-messages');
    const res = await notifyTeamRequester(anchor, fromLogin, {
      text: 'Done, see Pages.',
      markDone: true,
    });
    expect(res).toEqual({ ok: true, contactId: null, loginId: member });
    const [row] = await admin`select contact_id, login_id, direction, agent_id from team_messages
                               where owner_id = ${anchor} and text = 'Done, see Pages.'`;
    expect(row).toMatchObject({
      contact_id: null,
      login_id: member,
      direction: 'outbound',
      agent_id: null,
    });
    // The member's own read (the dock) shows it.
    const own = await listTeamThread(anchor, '', { loginId: member, withPrivate: true });
    expect(own.map((r) => r.text)).toContain('Done, see Pages.');
    const [t] = await admin`select data from nodes where id = ${fromLogin}`;
    const data = t!.data as {
      status: string;
      status_before_done?: string;
      teamRequest: { notifiedAt: string | null };
    };
    expect(data.status).toBe('done');
    // Resolving remembers the status it had, so a reopen restores it.
    expect(data.status_before_done).toBe('open');
    expect(data.teamRequest.notifiedAt).toBeTruthy();
  });

  it("answers a portal request in the contact's old thread", async () => {
    const { notifyTeamRequester } = await import('./team-requests');
    const res = await notifyTeamRequester(anchor, fromPortal, { text: 'Portal answer.' });
    expect(res).toEqual({ ok: true, contactId: contact, loginId: null });
    const [row] = await admin`select contact_id, login_id from team_messages
                               where owner_id = ${anchor} and text = 'Portal answer.'`;
    expect(row).toMatchObject({ contact_id: contact, login_id: null });
  });

  it('refuses a task with no requester', async () => {
    const { notifyTeamRequester } = await import('./team-requests');
    const res = await notifyTeamRequester(anchor, noRequester, { text: 'hello' });
    expect(res.ok).toBe(false);
  });
});
