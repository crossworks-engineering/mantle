/**
 * DELETE /api/shares/:id against a real, migrated Postgres (workspaces
 * W5b2): turning a page's link off is a plain revoke. The answer is
 * `{ ok }` only, and nothing about the page or what it embeds changes (who
 * reads them is their grants). Only the owner check is stubbed.
 * Seeds its own owner and rows and removes them.
 *   MANTLE_TEST_DATABASE_URL=postgres://… pnpm vitest run unshare-route.db.test
 */
import { randomUUID } from 'node:crypto';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';

const URL = process.env.MANTLE_TEST_DATABASE_URL;
const h = vi.hoisted(() => ({ owner: '' }));

vi.mock('@/lib/auth', () => ({ getOwnerOr401: vi.fn(async () => ({ id: h.owner })) }));

describe.skipIf(!URL)('DELETE /api/shares/:id is a plain revoke on Postgres', () => {
  type Db = typeof import('@mantle/db');
  let m: Db;
  let route: typeof import('./route');
  let sqlTag: typeof import('drizzle-orm').sql;
  const owner = randomUUID();
  h.owner = owner;
  const ids = { page: randomUUID(), file: randomUUID() };
  const tag = `unshare-route-${owner.slice(0, 8)}`;

  const accessOf = async (id: string) =>
    (
      (await m.db.execute(
        sqlTag`select audience, read_ws::text as read_ws from nodes where id = ${id}`,
      )) as unknown as { audience: string; read_ws: string }[]
    )[0]!;

  beforeAll(async () => {
    process.env.DATABASE_URL = URL;
    m = await import('@mantle/db');
    route = await import('./route');
    sqlTag = (await import('drizzle-orm')).sql;
    const doc = {
      type: 'doc',
      content: [{ type: 'image', attrs: { nodeId: ids.file, src: 'x' } }],
    };
    await m.db.execute(sqlTag`
      insert into auth.users (id, email, password_hash, role) values (${owner}, ${`${tag}@example.invalid`}, 'x', 'admin')`);
    await m.db.execute(sqlTag`
      insert into spaces (id, kind, login_id) values (${owner}, 'brain', ${owner})`);
    await m.db.execute(sqlTag`
      insert into nodes (id, owner_id, type, title, path) values
        (${ids.page}, ${owner}, 'page', 'A page', 'pages'),
        (${ids.file}, ${owner}, 'file', 'img.png', 'files')`);
    await m.db.execute(
      sqlTag`insert into pages (node_id, doc, doc_text) values (${ids.page}, ${JSON.stringify(doc)}::jsonb, '')`,
    );
  }, 60_000);

  afterAll(async () => {
    await m.db.execute(sqlTag`delete from shares where owner_id = ${owner}`);
    await m.db.execute(sqlTag`delete from nodes where owner_id = ${owner}`);
    await m.db.execute(sqlTag`delete from spaces where id = ${owner} or login_id = ${owner}`);
    await m.db.execute(sqlTag`delete from auth.users where id = ${owner}`);
    await m.closeDb();
  });

  it('revokes the link and answers { ok } only; nothing else changes', async () => {
    const linkId = randomUUID();
    await m.db.execute(sqlTag`
      insert into shares (id, owner_id, node_id, node_type, token)
      values (${linkId}, ${owner}, ${ids.page}, 'page', ${`${tag}-tok`})`);
    const before = [await accessOf(ids.page), await accessOf(ids.file)];
    const del = () =>
      route.DELETE(new Request('http://brain.test/api/shares/x', { method: 'DELETE' }), {
        params: Promise.resolve({ id: linkId }),
      });
    expect(await (await del()).json()).toEqual({ ok: true });
    const [row] = (await m.db.execute(
      sqlTag`select revoked_at is not null as revoked from shares where id = ${linkId}`,
    )) as unknown as { revoked: boolean }[];
    expect(row?.revoked).toBe(true);
    expect([await accessOf(ids.page), await accessOf(ids.file)]).toEqual(before);
    // Already revoked: nothing to do.
    expect(await (await del()).json()).toEqual({ ok: false });
  });
});
