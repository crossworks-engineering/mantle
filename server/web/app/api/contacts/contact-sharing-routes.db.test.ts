/**
 * The owner API of contact shares on a real, migrated Postgres (contact
 * shares, migration 0214; plan section 7). Only the owner check is stood
 * in. Seeds its own brain and removes it.
 *
 *  - POST /api/contacts/:id/sharing: enable answers the code once (a second
 *    enable is 409), the contact DTO carries `sharing`, regenerate answers a
 *    new code, disable revokes every live share and names how many;
 *  - POST /api/shares/contacts: one share per contact, refusals by reason;
 *    PATCH /api/shares/:id { canWrite } for an app only;
 *  - DELETE /api/shares/:id on a contact share changes no level (the tab's
 *    Revoke and the dialog's Remove are this one call);
 *  - GET /api/contacts/:id/shares lists the contact's live shares;
 *    DELETE revokes them all and keeps sharing on;
 *  - GET /api/access/nodes/:id lists the item's contacts; Shared links name
 *    the contact.
 *   MANTLE_TEST_DATABASE_URL=postgres://… pnpm vitest run contact-sharing-routes.db.test
 */
import { randomUUID } from 'node:crypto';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';

const URL = process.env.MANTLE_TEST_DATABASE_URL;
const h = vi.hoisted(() => ({ owner: '' }));

vi.mock('@/lib/auth', async (importOriginal) => ({
  ...(await importOriginal<Record<string, unknown>>()),
  getOwnerOr401: vi.fn(async () => ({
    id: h.owner,
    email: 'admin@example.invalid',
    actor: { id: h.owner, email: 'admin@example.invalid', displayName: null, isOwner: true },
  })),
}));

// eslint-disable-next-line @typescript-eslint/no-explicit-any
type Route = (req: Request, ctx?: { params: Promise<any> }) => Promise<Response>;

describe.skipIf(!URL)('the contact share owner API on Postgres', () => {
  type Db = typeof import('@mantle/db');
  let m: Db;
  let sqlTag: typeof import('drizzle-orm').sql;
  const r: Record<string, Route> = {};
  const owner = randomUUID();
  h.owner = owner;
  const tag = `csapi-${owner.slice(0, 8)}`;
  const ann = randomUUID();
  const ben = randomUUID();
  const page = randomUUID();
  const app = randomUUID();

  const call = (method: string, path: string, body?: unknown) =>
    new Request(`http://brain.test${path}`, {
      method,
      headers: { 'content-type': 'application/json' },
      ...(body === undefined ? {} : { body: JSON.stringify(body) }),
    });
  const p = (o: Record<string, string>) => ({ params: Promise.resolve(o) });
  const json = async <T>(res: Response) => (await res.json()) as T;
  const levelOf = async (id: string) =>
    (
      (await m.db.execute(sqlTag`select audience as a from nodes where id = ${id}`)) as unknown as {
        a: string;
      }[]
    )[0]!.a;

  beforeAll(async () => {
    process.env.DATABASE_URL = URL;
    process.env.MANTLE_MASTER_KEY ??= 'mantle-viewer-test-key';
    m = await import('@mantle/db');
    sqlTag = (await import('drizzle-orm')).sql;
    r.sharing = (await import('./[id]/sharing/route')).POST as unknown as Route;
    const shares = await import('./[id]/shares/route');
    r.tabGet = shares.GET as unknown as Route;
    r.tabDelete = shares.DELETE as unknown as Route;
    r.contact = (await import('./[id]/route')).GET as unknown as Route;
    r.create = (await import('../shares/contacts/route')).POST as unknown as Route;
    const one = await import('../shares/[id]/route');
    r.patch = one.PATCH as unknown as Route;
    r.remove = one.DELETE as unknown as Route;
    r.all = (await import('../shares/all/route')).GET as unknown as Route;
    r.access = (await import('../access/nodes/[id]/route')).GET as unknown as Route;

    await m.db.execute(sqlTag`
      insert into auth.users (id, email, password_hash, role) values (${owner}, ${`${tag}@example.invalid`}, 'x', 'admin')`);
    await m.db.execute(
      sqlTag`insert into spaces (id, kind, login_id) values (${owner}, 'brain', ${owner})`,
    );
    await m.db.execute(sqlTag`
      insert into nodes (id, owner_id, type, title, path, audience, data) values
        (${ann}, ${owner}, 'contact', ${`${tag} Ann`}, 'contacts', 'admin', '{"first_name":"Ann"}'::jsonb),
        (${ben}, ${owner}, 'contact', ${`${tag} Ben`}, 'contacts', 'admin', '{"first_name":"Ben"}'::jsonb),
        (${page}, ${owner}, 'page', ${`${tag} page`}, 'pages', 'team', '{}'::jsonb),
        (${app}, ${owner}, 'app', ${`${tag} app`}, 'apps', 'admin', '{}'::jsonb)`);
  }, 60_000);

  afterAll(async () => {
    await m.db.execute(sqlTag`delete from shares where owner_id = ${owner}`);
    await m.db.execute(sqlTag`delete from contact_share_codes where owner_id = ${owner}`);
    await m.db.execute(sqlTag`delete from nodes where owner_id = ${owner}`);
    await m.db.execute(sqlTag`delete from spaces where id = ${owner} or login_id = ${owner}`);
    await m.db.execute(sqlTag`delete from auth.users where id = ${owner}`);
    await m.closeDb();
  }, 60_000);

  it('enable answers the code once; the contact shows sharing; enable again is 409', async () => {
    const res = await r.sharing!(call('POST', '/x', { action: 'enable' }), p({ id: ann }));
    expect(res.status).toBe(200);
    const body = await json<{ code: string; sharing: { shareCount: number } }>(res);
    expect(body.code).toMatch(/^[A-Za-z2-9]{8}$/);
    expect(body.sharing).toMatchObject({ shareCount: 0, locked: false });
    const again = await r.sharing!(call('POST', '/x', { action: 'enable' }), p({ id: ann }));
    expect(again.status).toBe(409);
    expect(await again.json()).not.toHaveProperty('code');
    const contact = await json<{ contact: { sharing: unknown } }>(
      await r.contact!(call('GET', '/x'), p({ id: ann })),
    );
    expect(contact.contact.sharing).toMatchObject({ shareCount: 0 });
    const ben0 = await json<{ contact: { sharing: unknown } }>(
      await r.contact!(call('GET', '/x'), p({ id: ben })),
    );
    expect(ben0.contact.sharing).toBeNull();
  });

  it('shares an item with contacts, refuses by reason, and sets Can write on an app only', async () => {
    const off = await r.create!(call('POST', '/x', { nodeId: page, contactIds: [ann, ben] }));
    expect(off.status).toBe(400);
    expect(await off.json()).toMatchObject({ reason: 'sharing-off' });
    await r.sharing!(call('POST', '/x', { action: 'enable' }), p({ id: ben }));
    const ok = await r.create!(call('POST', '/x', { nodeId: page, contactIds: [ann, ben] }));
    expect(ok.status).toBe(200);
    const made = await json<{
      shares: Array<{ shareId: string; contactId: string; path: string }>;
    }>(ok);
    expect(made.shares.map((s) => s.contactId).sort()).toEqual([ann, ben].sort());
    expect(made.shares.every((s) => s.path.startsWith('/s/'))).toBe(true);
    expect(await levelOf(page)).toBe('team');
    const write = await r.create!(
      call('POST', '/x', { nodeId: page, contactIds: [ann], canWrite: true }),
    );
    expect(await write.json()).toMatchObject({ reason: 'write-not-app' });
    const [appShare] = (
      await json<{ shares: Array<{ shareId: string }> }>(
        await r.create!(call('POST', '/x', { nodeId: app, contactIds: [ann] })),
      )
    ).shares;
    const patched = await r.patch!(
      call('PATCH', '/x', { canWrite: true }),
      p({ id: appShare!.shareId }),
    );
    expect(await patched.json()).toEqual({ ok: true, canWrite: true });
    const notApp = await r.patch!(
      call('PATCH', '/x', { canWrite: true }),
      p({ id: made.shares[0]!.shareId }),
    );
    expect(notApp.status).toBe(400);
  });

  it('the access view and Shared links name the contacts', async () => {
    const view = await json<{ contactShares: Array<{ name: string; sharingOn: boolean }> }>(
      await r.access!(call('GET', '/x'), p({ id: page })),
    );
    expect(view.contactShares.map((c) => c.name)).toEqual([`${tag} Ann`, `${tag} Ben`]);
    expect(view.contactShares.every((c) => c.sharingOn)).toBe(true);
    const all = await json<{
      shares: Array<{ nodeId: string; contactName: string | null; canWrite: boolean }>;
    }>(await r.all!(call('GET', '/x')));
    const mine = all.shares.filter((s) => s.nodeId === app);
    expect(mine).toEqual([expect.objectContaining({ contactName: `${tag} Ann`, canWrite: true })]);
  });

  it("the Shared tab lists the contact's shares; Revoke there changes no level", async () => {
    const tab = await json<{
      shares: Array<{ shareId: string; nodeId: string; canWrite: boolean }>;
    }>(await r.tabGet!(call('GET', `/api/contacts/${ann}/shares`), p({ id: ann })));
    expect(tab.shares.map((s) => s.nodeId).sort()).toEqual([app, page].sort());
    const pageRow = tab.shares.find((s) => s.nodeId === page)!;
    const res = await r.remove!(call('DELETE', '/x'), p({ id: pageRow.shareId }));
    expect(await res.json()).toEqual({ ok: true, stillBelow: [] });
    expect(await levelOf(page)).toBe('team');
    const after = await json<{ shares: Array<{ nodeId: string }> }>(
      await r.tabGet!(call('GET', `/api/contacts/${ann}/shares`), p({ id: ann })),
    );
    expect(after.shares.map((s) => s.nodeId)).toEqual([app]);
  });

  it("Revoke all ends the contact's shares and keeps sharing on; regenerate and disable", async () => {
    const res = await r.tabDelete!(call('DELETE', `/api/contacts/${ann}/shares`), p({ id: ann }));
    expect(await res.json()).toEqual({ revoked: 1 });
    const contact = await json<{ contact: { sharing: unknown } }>(
      await r.contact!(call('GET', '/x'), p({ id: ann })),
    );
    expect(contact.contact.sharing).toMatchObject({ shareCount: 0 });
    const regen = await json<{ code: string }>(
      await r.sharing!(call('POST', '/x', { action: 'regenerate' }), p({ id: ann })),
    );
    expect(regen.code).toMatch(/^[A-Za-z2-9]{8}$/);
    // Ben still has the page: disabling Ben revokes it and says so.
    const off = await json<{ sharing: unknown; revoked: number }>(
      await r.sharing!(call('POST', '/x', { action: 'disable' }), p({ id: ben })),
    );
    expect(off).toEqual({ sharing: null, revoked: 1 });
    expect(await levelOf(page)).toBe('team');
  });
});
