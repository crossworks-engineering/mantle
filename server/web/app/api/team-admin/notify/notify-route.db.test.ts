/**
 * A request a member LOGIN filed, through the real admin routes on a migrated
 * Postgres (only the owner session is stood in), audit F05 and F08:
 *
 *   - GET /api/team-admin/requests names the login (`loginId`), with no
 *     contact: a member needs none since users are the team;
 *   - POST /api/team-admin/notify answers it in that login's own thread;
 *   - the request is extract-exempt until then: answering it (or editing it
 *     through PATCH /api/tasks/:id) stamps `reviewed_at`, and only then may
 *     the extractor index it.
 *
 *   MANTLE_TEST_DATABASE_URL=postgres://… pnpm vitest run server/web/app/api/team-admin/notify/notify-route.db.test.ts
 */
import { randomUUID } from 'node:crypto';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import type { TeamRequest } from '@mantle/client-types';

const URL = process.env.MANTLE_TEST_DATABASE_URL;

const h = vi.hoisted(() => ({ owner: null as unknown }));

vi.mock('@/lib/auth', async (importOriginal) => ({
  ...(await importOriginal<Record<string, unknown>>()),
  getOwnerOr401: vi.fn(async () => h.owner),
}));

type Row = Record<string, unknown>;

describe.skipIf(!URL)('a member login request: listed by login, answered, then indexable', () => {
  let m: typeof import('@mantle/db');
  let admin: (strings: TemplateStringsArray, ...v: unknown[]) => Promise<Row[]>;
  let notifyRoute: typeof import('./route');
  let requestsRoute: typeof import('../requests/route');
  let taskRoute: typeof import('../../tasks/[id]/route');
  const tag = `tnote-${randomUUID().slice(0, 8)}`;
  const anchor = randomUUID();
  const member = randomUUID();
  const answered = randomUUID();
  const edited = randomUUID();
  const inbound = randomUUID();
  const email = (who: string) => `${who}-${tag}@example.invalid`;
  const request = (loginId: string, msg: string) =>
    JSON.stringify({
      source: 'team-request',
      status: 'open',
      body: 'please change X',
      teamRequest: { loginId, contactId: null, contactName: 'Pat', threadMessageId: msg },
    });
  const dataOf = async (id: string) =>
    ((await admin`select data from nodes where id = ${id}`)[0]!.data ?? {}) as Record<
      string,
      unknown
    >;

  beforeAll(async () => {
    process.env.DATABASE_URL = URL;
    m = await import('@mantle/db');
    admin = (m.systemDb as unknown as { $client: typeof admin }).$client;
    notifyRoute = await import('./route');
    requestsRoute = await import('../requests/route');
    taskRoute = await import('../../tasks/[id]/route');
    h.owner = { id: anchor };
    await admin`insert into auth.users (id, email, password_hash, role) values
      (${anchor}, ${email('anchor')}, 'x', 'admin')`;
    await admin`insert into spaces (id, kind, login_id) values (${anchor}, 'brain', ${anchor})`;
    await admin`insert into auth.users (id, email, password_hash, role) values
      (${member}, ${email('pat')}, 'x', 'member')`;
    await admin`insert into nodes (id, owner_id, type, title, path, tags, data) values
      (${answered}, ${anchor}, 'task', 'Answered request', 'tasks', '{team-request}',
        ${request(member, inbound)}::jsonb),
      (${edited}, ${anchor}, 'task', 'Edited request', 'tasks', '{team-request}',
        ${request(member, randomUUID())}::jsonb)`;
  }, 60_000);

  afterAll(async () => {
    if (!admin) return;
    await admin`delete from team_messages where owner_id = ${anchor}`;
    await admin`delete from nodes where owner_id = ${anchor}`;
    await admin`delete from spaces where login_id in (${anchor}, ${member})`;
    await admin`delete from auth.users where id in (${member}, ${anchor})`;
    await m.closeDb();
  });

  it('lists the request with its loginId and no contact', async () => {
    const res = await requestsRoute.GET();
    expect(res.status).toBe(200);
    const { requests } = (await res.json()) as { requests: TeamRequest[] };
    const row = requests.find((r) => r.taskId === answered);
    expect(row).toMatchObject({ loginId: member, contactId: null, contactName: 'Pat' });
  });

  it('starts extract-exempt', async () => {
    expect(m.isExtractExempt({ data: await dataOf(answered) })).toBe(true);
    expect(m.isExtractExempt({ data: await dataOf(edited) })).toBe(true);
  });

  it("notify answers in the login's own thread and makes the request indexable", async () => {
    const res = await notifyRoute.POST(
      new Request('http://brain.test/api/team-admin/notify', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ taskId: answered, text: 'Done, see Pages.', markDone: true }),
      }),
    );
    expect(res.status).toBe(200);
    const [row] = await admin`select contact_id, login_id, direction from team_messages
                               where owner_id = ${anchor} and text = 'Done, see Pages.'`;
    expect(row).toMatchObject({ contact_id: null, login_id: member, direction: 'outbound' });
    const data = await dataOf(answered);
    expect(data.status).toBe('done');
    expect(typeof data.reviewed_at).toBe('string');
    expect(m.isExtractExempt({ data })).toBe(false);
  });

  it('an admin edit through PATCH /api/tasks/:id makes the request indexable too', async () => {
    const res = await taskRoute.PATCH(
      new Request(`http://brain.test/api/tasks/${edited}`, {
        method: 'PATCH',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ status: 'in_progress' }),
      }),
      { params: Promise.resolve({ id: edited }) },
    );
    expect(res.status).toBe(200);
    const data = await dataOf(edited);
    expect(typeof data.reviewed_at).toBe('string');
    expect(data.source).toBe('team-request');
    expect(m.isExtractExempt({ data })).toBe(false);
  });

  it('counts the requests filed by the login (the tool cap reads this)', async () => {
    const { countTeamRequestsFiled } = await import('@mantle/content');
    expect(
      await countTeamRequestsFiled(anchor, {
        loginId: member,
        since: new Date(Date.now() - 60_000),
      }),
    ).toBe(2);
    expect(
      await countTeamRequestsFiled(anchor, { loginId: randomUUID(), since: new Date(0) }),
    ).toBe(0);
    expect(await countTeamRequestsFiled(anchor, { threadMessageId: inbound })).toBe(1);
  });
});
