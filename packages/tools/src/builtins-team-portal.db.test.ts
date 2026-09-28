/**
 * A member login invited from a team contact, on a real migrated Postgres:
 * the admin's `team_chat_read` with the `loginId` returns the login's live
 * thread in `messages` and the contact's OLD portal chat apart, in
 * `portal_history` (labelled, redacted like any admin read). The member's own
 * read (the query GET /api/member/chat runs) never includes the portal rows.
 * Seeds its own brain row, contacts, logins and rows, removes them.
 *   MANTLE_TEST_DATABASE_URL=postgres://… pnpm vitest run packages/tools/src/builtins-team-portal.db.test.ts
 */
import { randomUUID } from 'node:crypto';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { ToolHandlerContext } from './types';

const URL = process.env.MANTLE_TEST_DATABASE_URL;

type Row = Record<string, unknown>;
type Line = { text: string };
type ReadOut = {
  messages: Line[];
  count: number;
  portal_history?: { note: string; contactId: string; messages: Line[]; count: number };
};

describe.skipIf(!URL)('team_chat_read: a login and its old portal chat', () => {
  let m: typeof import('@mantle/db');
  let tm: typeof import('@mantle/content');
  let admin: Parameters<typeof m.ensureViewerRoles>[0];
  let read: (typeof import('./builtins-team'))['TEAM_TOOLS'][number];
  const tag = `portal-${randomUUID().slice(0, 8)}`;
  const anchor = randomUUID();
  const contact = randomUUID();
  const stranger = randomUUID(); // another contact with a portal thread
  const cat = randomUUID(); // member login invited from `contact`
  const dan = randomUUID(); // member login with no contact
  const email = (who: string) => `${who}-${tag}@example.invalid`;
  const texts = (rows: Line[]) => rows.map((r) => r.text);

  const adminRead = async (input: Record<string, unknown>) => {
    const ctx: ToolHandlerContext = { ownerId: anchor };
    const res = await read.handler(input, ctx);
    if (!res.ok) throw new Error(res.error);
    return res.output as ReadOut;
  };

  beforeAll(async () => {
    process.env.DATABASE_URL = URL;
    m = await import('@mantle/db');
    tm = await import('@mantle/content');
    admin = (m.systemDb as unknown as { $client: typeof admin }).$client;
    const { TEAM_TOOLS } = await import('./builtins-team');
    read = TEAM_TOOLS.find((t) => t.slug === 'team_chat_read')!;
    await admin`insert into auth.users (id, email, password_hash, role) values
      (${anchor}, ${email('anchor')}, 'x', 'admin')`;
    await admin`insert into spaces (id, kind, login_id) values (${anchor}, 'brain', ${anchor})`;
    await admin`insert into nodes (id, owner_id, type, title, path) values
      (${contact}, ${anchor}, 'contact', 'Cat', 'contacts'),
      (${stranger}, ${anchor}, 'contact', 'Stranger', 'contacts')`;
    await admin`insert into auth.users (id, email, password_hash, role, contact_id) values
      (${cat}, ${email('cat')}, 'x', 'member', ${contact}),
      (${dan}, ${email('dan')}, 'x', 'member', null)`;
    await admin`insert into team_messages (owner_id, contact_id, login_id, direction, text, used_private, created_at) values
      (${anchor}, ${contact}, null, 'inbound', 'portal ask', false, now() - interval '9 minutes'),
      (${anchor}, ${contact}, null, 'outbound', 'portal private answer', true, now() - interval '8 minutes'),
      (${anchor}, ${stranger}, null, 'inbound', 'stranger ask', false, now() - interval '7 minutes'),
      (${anchor}, null, ${cat}, 'inbound', 'live ask', false, now() - interval '2 minutes'),
      (${anchor}, null, ${cat}, 'outbound', 'live answer', false, now() - interval '1 minute'),
      (${anchor}, null, ${dan}, 'inbound', 'dan asks', false, now())`;
  });

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

  it('returns the live thread in messages and the portal chat apart, redacted', async () => {
    const out = await adminRead({ loginId: cat });
    expect(texts(out.messages)).toEqual(['live ask', 'live answer']);
    expect(out.portal_history).toMatchObject({ contactId: contact, count: 2 });
    expect(out.portal_history!.note).toMatch(/OLD team-code portal chat/);
    expect(texts(out.portal_history!.messages)).toEqual([
      'portal ask',
      tm.PRIVATE_REPLY_PLACEHOLDER,
    ]);
  });

  it('pages the live thread without repeating the portal chat', async () => {
    const out = await adminRead({ loginId: cat, before: new Date().toISOString() });
    expect(texts(out.messages)).toEqual(['live ask', 'live answer']);
    expect(out.portal_history).toBeUndefined();
  });

  it('a login with no contact has no portal history', async () => {
    const out = await adminRead({ loginId: dan });
    expect(texts(out.messages)).toEqual(['dan asks']);
    expect(out.portal_history).toBeUndefined();
  });

  it("never puts portal rows in the member's own read", async () => {
    const own = await tm.listTeamThread(anchor, '', { loginId: cat, limit: 50, withPrivate: true });
    expect(texts(own)).toEqual(['live ask', 'live answer']);
    const rows = await admin<Row[]>`select count(*)::int as n from team_messages
                                     where contact_id = ${contact} and login_id is not null`;
    expect(rows[0]!.n).toBe(0);
  });
});
