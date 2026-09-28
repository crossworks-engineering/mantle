/**
 * DELETE /api/shares/:id against a real, migrated Postgres (MED 7): turning
 * a page's link off takes it to admin with the same closure rule as the
 * Access control, so the response lists the embedded file still at public in
 * `stillBelow` and leaves it there. Only the owner check is stubbed.
 * Seeds its own owner and rows and removes them.
 *   MANTLE_TEST_DATABASE_URL=postgres://… pnpm vitest run unshare-route.db.test
 */
import { randomUUID } from 'node:crypto';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';

const URL = process.env.MANTLE_TEST_DATABASE_URL;
const h = vi.hoisted(() => ({ owner: '' }));

vi.mock('@/lib/auth', () => ({ getOwnerOr401: vi.fn(async () => ({ id: h.owner })) }));

describe.skipIf(!URL)('DELETE /api/shares/:id reports the closure on Postgres', () => {
  type Db = typeof import('@mantle/db');
  type Content = typeof import('@mantle/content');
  let m: Db;
  let c: Content;
  let route: typeof import('./route');
  let sqlTag: typeof import('drizzle-orm').sql;
  const owner = randomUUID();
  h.owner = owner;
  const ids = { page: randomUUID(), file: randomUUID() };
  const tag = `unshare-route-${owner.slice(0, 8)}`;

  const audienceOf = async (id: string) =>
    (
      (await m.db.execute(sqlTag`select audience from nodes where id = ${id}`)) as unknown as {
        audience: string;
      }[]
    )[0]!.audience;

  beforeAll(async () => {
    process.env.DATABASE_URL = URL;
    m = await import('@mantle/db');
    c = await import('@mantle/content');
    route = await import('./route');
    sqlTag = (await import('drizzle-orm')).sql;
    const doc = {
      type: 'doc',
      content: [{ type: 'image', attrs: { nodeId: ids.file, src: 'x' } }],
    };
    await m.db.execute(sqlTag`
      insert into auth.users (id, email, password_hash) values (${owner}, ${`${tag}@example.invalid`}, 'x')`);
    await m.db.execute(sqlTag`
      insert into spaces (id, kind, login_id) values (${owner}, 'brain', ${owner})`);
    await m.db.execute(sqlTag`
      insert into nodes (id, owner_id, type, title, path) values
        (${ids.page}, ${owner}, 'page', 'A page', 'pages'),
        (${ids.file}, ${owner}, 'file', 'img.png', 'files')`);
    await m.db.execute(
      sqlTag`insert into pages (node_id, doc, doc_text) values (${ids.page}, ${JSON.stringify(doc)}::jsonb, '')`,
    );
  });

  afterAll(async () => {
    await m.db.execute(sqlTag`delete from shares where owner_id = ${owner}`);
    await m.db.execute(sqlTag`delete from nodes where owner_id = ${owner}`);
    await m.db.execute(sqlTag`delete from spaces where id = ${owner} or login_id = ${owner}`);
    await m.db.execute(sqlTag`delete from auth.users where id = ${owner}`);
    await m.closeDb();
  });

  it('lists the embedded file still at public and leaves it there', async () => {
    await c.setItemLevel(owner, ids.page, 'public', { withClosure: true });
    const link = (await c.getActiveShareForNode(owner, ids.page))!;

    const res = await route.DELETE(
      new Request('http://brain.test/api/shares/x', { method: 'DELETE' }),
      {
        params: Promise.resolve({ id: link.id }),
      },
    );
    const body = (await res.json()) as {
      ok: boolean;
      stillBelow: { id: string; audience: string }[];
    };
    expect(body.ok).toBe(true);
    expect(body.stillBelow.map((i) => [i.id, i.audience])).toEqual([[ids.file, 'public']]);
    expect(await audienceOf(ids.page)).toBe('admin');
    expect(await audienceOf(ids.file)).toBe('public');
  });
});
