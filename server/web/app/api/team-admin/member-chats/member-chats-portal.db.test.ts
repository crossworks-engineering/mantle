/**
 * A member login's old team portal chat, on a real migrated Postgres, through
 * the real routes (only the sessions are stood in):
 *
 *   - GET /api/team-admin/member-chats?login= returns the login's live thread
 *     in `selected.thread` and its contact's OLD portal chat apart, in
 *     `selected.portalThread` (redacted like any admin read), paged by
 *     `portalBefore`;
 *   - the member's own GET /api/member/chat never shows a portal row.
 *
 *   MANTLE_TEST_DATABASE_URL=postgres://… pnpm vitest run server/web/app/api/team-admin/member-chats/member-chats-portal.db.test.ts
 */
import { randomUUID } from 'node:crypto';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import type { MemberChatThread, MemberChatsResponse } from '@mantle/client-types';

const URL = process.env.MANTLE_TEST_DATABASE_URL;

const h = vi.hoisted(() => ({ owner: null as unknown, member: null as unknown }));

vi.mock('@/lib/auth', async (importOriginal) => ({
  ...(await importOriginal<Record<string, unknown>>()),
  getOwnerOr401: vi.fn(async () => h.owner),
  getMemberOr401: vi.fn(async () => h.member),
}));

describe.skipIf(!URL)('member chats: the portal history is the admin view only', () => {
  let m: typeof import('@mantle/db');
  let tm: typeof import('@mantle/content');
  let admin: Parameters<typeof m.ensureViewerRoles>[0];
  let adminRoute: typeof import('./route');
  let memberRoute: typeof import('../../member/chat/route');
  const tag = `mchat-${randomUUID().slice(0, 8)}`;
  const anchor = randomUUID();
  const contact = randomUUID();
  const cat = randomUUID(); // member login invited from `contact`
  const dan = randomUUID(); // member login with no contact
  const email = (who: string) => `${who}-${tag}@example.invalid`;

  const adminGet = async (query: string) => {
    const res = await adminRoute.GET(
      new Request(`http://brain.test/api/team-admin/member-chats?${query}`),
    );
    expect(res.status).toBe(200);
    return (await res.json()) as MemberChatsResponse;
  };
  const texts = (rows: { text: string }[]) => rows.map((r) => r.text);

  beforeAll(async () => {
    process.env.DATABASE_URL = URL;
    m = await import('@mantle/db');
    tm = await import('@mantle/content');
    admin = (m.systemDb as unknown as { $client: typeof admin }).$client;
    adminRoute = await import('./route');
    memberRoute = await import('../../member/chat/route');
    h.owner = { id: anchor };
    h.member = {
      role: 'member',
      loginId: cat,
      anchorId: anchor,
      spaceId: randomUUID(),
      email: email('cat'),
      displayName: 'Cat',
      contactId: contact,
    };
    await admin`insert into auth.users (id, email, password_hash, role) values
      (${anchor}, ${email('anchor')}, 'x', 'admin')`;
    await admin`insert into spaces (id, kind, login_id) values (${anchor}, 'brain', ${anchor})`;
    await admin`insert into nodes (id, owner_id, type, title, path) values
      (${contact}, ${anchor}, 'contact', 'Cat', 'contacts')`;
    await admin`insert into auth.users (id, email, password_hash, role, contact_id) values
      (${cat}, ${email('cat')}, 'x', 'member', ${contact}),
      (${dan}, ${email('dan')}, 'x', 'member', null)`;
    await admin`insert into team_messages (owner_id, contact_id, login_id, direction, text, used_private, created_at) values
      (${anchor}, ${contact}, null, 'inbound', 'portal ask', false, now() - interval '9 minutes'),
      (${anchor}, ${contact}, null, 'outbound', 'portal private answer', true, now() - interval '8 minutes'),
      (${anchor}, null, ${cat}, 'inbound', 'live ask', false, now() - interval '2 minutes'),
      (${anchor}, null, ${cat}, 'outbound', 'live answer', false, now() - interval '1 minute')`;
  }, 60_000); // imports the route modules: slow while the whole suite runs in parallel

  afterAll(async () => {
    if (!admin) return;
    await admin`delete from team_messages where owner_id = ${anchor}`;
    await admin`delete from nodes where owner_id = ${anchor}`;
    const ids = [anchor, cat, dan];
    await admin`delete from spaces where login_id in ${admin(ids)}`;
    await admin`delete from spaces where id = ${anchor}`;
    await admin`delete from auth.users where id in ${admin(ids)}`;
    await m.closeDb();
  });

  it('shows the portal chat apart from the live thread, redacted', async () => {
    const body = await adminGet(`login=${cat}`);
    expect(body.selected?.loginId).toBe(cat);
    expect(texts(body.selected!.thread)).toEqual(['live ask', 'live answer']);
    expect(body.selected!.portalThread?.contactId).toBe(contact);
    expect(texts(body.selected!.portalThread!.thread)).toEqual([
      'portal ask',
      tm.PRIVATE_REPLY_PLACEHOLDER,
    ]);
  });

  it('pages the portal chat by portalBefore, and answers an empty older page', async () => {
    const body = await adminGet(`login=${cat}&portalBefore=${new Date(0).toISOString()}`);
    expect(body.selected!.portalThread).toMatchObject({ contactId: contact, thread: [] });
    expect(texts(body.selected!.thread)).toEqual(['live ask', 'live answer']);
  });

  it('has no portal section for a login with no contact', async () => {
    const body = await adminGet(`login=${dan}`);
    expect(body.selected?.loginId).toBe(dan);
    expect(body.selected!.portalThread).toBeNull();
  });

  it("never shows a portal row in the member's own chat", async () => {
    const res = await memberRoute.GET(new Request('http://brain.test/api/member/chat'));
    expect(res.status).toBe(200);
    const body = (await res.json()) as MemberChatThread;
    expect(texts(body.messages)).toEqual(['live ask', 'live answer']);
  });
});
