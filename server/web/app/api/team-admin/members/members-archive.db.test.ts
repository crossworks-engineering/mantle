/**
 * The Members tab's Chat archive with no team codes (migration 0178), on a
 * real migrated Postgres, through the real route (only the session is stood
 * in): GET /api/team-admin/members lists every contact of this brain with
 * old portal chat, newest activity first, with or without a login made from
 * it; a contact with no portal chat, a login's live thread and another
 * brain's contact are not there. Each row keeps `tokenLastUsedAt` (always
 * null) and `memberSince` (the first portal message) for older clients. The
 * selected contact's archive, requests and access log still come back.
 *
 *   MANTLE_TEST_DATABASE_URL=postgres://… pnpm vitest run server/web/app/api/team-admin/members/members-archive.db.test.ts
 */
import { randomUUID } from 'node:crypto';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import type { TeamMemberActivity } from '@mantle/client-types';

const URL = process.env.MANTLE_TEST_DATABASE_URL;

const h = vi.hoisted(() => ({ owner: null as unknown }));

vi.mock('@/lib/auth', async (importOriginal) => ({
  ...(await importOriginal<Record<string, unknown>>()),
  getOwnerOr401: vi.fn(async () => h.owner),
}));

type MembersBody = {
  members: Array<TeamMemberActivity & { forum: null }>;
  selected: null | {
    contactId: string;
    thread: Array<{ text: string }>;
    requests: unknown[];
    access: unknown[];
  };
};

describe.skipIf(!URL)('team-admin members: the Chat archive needs no team code', () => {
  let m: typeof import('@mantle/db');
  let content: typeof import('@mantle/content');
  let admin: Parameters<typeof m.ensureViewerRoles>[0];
  let route: typeof import('./route');
  const tag = `marc-${randomUUID().slice(0, 8)}`;
  const anchor = randomUUID();
  const otherBrain = randomUUID();
  const c = {
    ana: randomUUID(), // portal chat, and a member login made from her
    bo: randomUUID(), // portal chat, read up to date, no login
    cy: randomUUID(), // access log only, no portal chat
    far: randomUUID(), // another brain's contact with portal chat
  };
  const anaLogin = randomUUID();
  const email = (who: string) => `${who}-${tag}@example.invalid`;
  const ago = (min: number) => new Date(Date.now() - min * 60_000);
  const anaFirst = ago(30);
  const boFirst = ago(60);

  const get = async (query = '') => {
    const res = await route.GET(new Request(`http://brain.test/api/team-admin/members?${query}`));
    expect(res.status).toBe(200);
    return (await res.json()) as MembersBody;
  };

  beforeAll(async () => {
    process.env.DATABASE_URL = URL;
    m = await import('@mantle/db');
    content = await import('@mantle/content');
    admin = (m.systemDb as unknown as { $client: typeof admin }).$client;
    route = await import('./route');
    h.owner = { id: anchor };
    await admin`insert into auth.users (id, email, password_hash, role) values
      (${anchor}, ${email('anchor')}, 'x', 'admin'),
      (${otherBrain}, ${email('other')}, 'x', 'admin')`;
    await admin`insert into spaces (id, kind, login_id) values
      (${anchor}, 'brain', ${anchor}), (${otherBrain}, 'brain', ${otherBrain})`;
    await admin`insert into nodes (id, owner_id, type, title, path) values
      (${c.ana}, ${anchor}, 'contact', 'Ana', 'contacts'),
      (${c.bo}, ${anchor}, 'contact', 'Bo', 'contacts'),
      (${c.cy}, ${anchor}, 'contact', 'Cy', 'contacts'),
      (${c.far}, ${otherBrain}, 'contact', 'Far', 'contacts')`;
    await admin`insert into auth.users (id, email, password_hash, role, contact_id) values
      (${anaLogin}, ${email('ana')}, 'x', 'member', ${c.ana})`;
    await admin`insert into team_messages (owner_id, contact_id, login_id, direction, text, created_at) values
      (${anchor}, ${c.bo}, null, 'inbound', 'bo asks', ${boFirst}),
      (${anchor}, ${c.bo}, null, 'outbound', 'bo answered', ${ago(59)}),
      (${anchor}, ${c.ana}, null, 'inbound', 'ana first', ${anaFirst}),
      (${anchor}, ${c.ana}, null, 'outbound', 'ana answered', ${ago(29)}),
      (${anchor}, ${c.ana}, null, 'inbound', 'ana again', ${ago(20)}),
      (${anchor}, null, ${anaLogin}, 'inbound', 'ana live', ${ago(1)}),
      (${otherBrain}, ${c.far}, null, 'inbound', 'far asks', ${ago(5)})`;
    await admin`insert into team_read_cursors (owner_id, contact_id, last_read_at)
                values (${anchor}, ${c.bo}, ${ago(58)})`;
    await admin`insert into team_access_log (owner_id, contact_id, kind, detail) values
      (${anchor}, ${c.ana}, 'auth', '{"event":"portal"}'::jsonb),
      (${anchor}, ${c.cy}, 'auth', '{"event":"portal"}'::jsonb)`;
  }, 60_000); // imports the route module: slow while the whole suite runs in parallel

  afterAll(async () => {
    if (!admin) return;
    await admin`delete from team_read_cursors where owner_id in (${anchor}, ${otherBrain})`;
    await admin`delete from team_access_log where owner_id in (${anchor}, ${otherBrain})`;
    await admin`delete from team_messages where owner_id in (${anchor}, ${otherBrain})`;
    await admin`delete from nodes where owner_id in (${anchor}, ${otherBrain})`;
    const ids = [anchor, otherBrain, anaLogin];
    await admin`delete from spaces where login_id in ${admin(ids)}`;
    await admin`delete from spaces where id in ${admin(ids)}`;
    await admin`delete from auth.users where id in ${admin(ids)}`;
    await m.closeDb();
  });

  it('lists every contact with portal chat, newest activity first, and no one else', async () => {
    const body = await get();
    expect(body.members.map((r) => r.contactName)).toEqual(['Ana', 'Bo']);
    const [ana, bo] = body.members;
    expect(ana).toMatchObject({
      contactId: c.ana,
      // The first portal message: there is no code whose creation it was.
      memberSince: anaFirst.toISOString(),
      tokenLastUsedAt: null,
      lastMessageText: 'ana again',
      lastMessageDirection: 'inbound',
      messageCount: 3,
      unread: 2,
      forum: null,
    });
    expect(bo).toMatchObject({
      contactId: c.bo,
      memberSince: boFirst.toISOString(),
      tokenLastUsedAt: null,
      lastMessageText: 'bo answered',
      messageCount: 2,
      unread: 0,
    });
  });

  it('returns the selected contact archive and access log, the first by default', async () => {
    const first = await get();
    expect(first.selected?.contactId).toBe(c.ana);
    expect(first.selected!.thread.map((t) => t.text)).toEqual([
      'ana first',
      'ana answered',
      'ana again',
    ]);
    expect(first.selected!.access).toHaveLength(1);

    const bo = await get(`contact=${c.bo}`);
    expect(bo.selected?.contactId).toBe(c.bo);
    expect(bo.selected!.thread.map((t) => t.text)).toEqual(['bo asks', 'bo answered']);

    // A contact with no portal chat is not selectable: the first one is shown.
    expect((await get(`contact=${c.cy}`)).selected?.contactId).toBe(c.ana);
  });

  it('a contact row no longer carries a team code status', async () => {
    const row = await content.getContact(anchor, c.ana);
    expect(row).not.toBeNull();
    expect(Object.keys(row!)).not.toContain('team');
  });
});
