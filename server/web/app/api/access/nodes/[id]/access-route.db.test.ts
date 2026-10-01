/**
 * GET / PATCH /api/access/nodes/:id against a real, migrated Postgres
 * (embedding means sharing): the GET says whether an item's embeds follow it
 * (a page's do, a folder's contents do not), and the PATCH that lowers a page
 * lowers its embedded image with it and lists it in `alsoLowered` (and in
 * the older `lowered` the Access control reads). Only the owner check is
 * stubbed. Seeds its own owner and rows and removes them.
 *   MANTLE_TEST_DATABASE_URL=postgres://… pnpm vitest run access-route.db.test
 */
import { randomUUID } from 'node:crypto';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import type { AccessNodeUpdate, AccessNodeView } from '@mantle/client-types';

const URL = process.env.MANTLE_TEST_DATABASE_URL;
const h = vi.hoisted(() => ({ owner: '' }));

vi.mock('@/lib/auth', () => ({ getOwnerOr401: vi.fn(async () => ({ id: h.owner })) }));

describe.skipIf(!URL)('the Access API on Postgres', () => {
  type Db = typeof import('@mantle/db');
  let m: Db;
  let route: typeof import('./route');
  let sqlTag: typeof import('drizzle-orm').sql;
  const owner = randomUUID();
  h.owner = owner;
  const ids = { page: randomUUID(), file: randomUUID(), folder: randomUUID() };
  const tag = `access-route-${owner.slice(0, 8)}`;
  const params = (id: string) => ({ params: Promise.resolve({ id }) });

  beforeAll(async () => {
    process.env.DATABASE_URL = URL;
    m = await import('@mantle/db');
    route = await import('./route');
    sqlTag = (await import('drizzle-orm')).sql;
    const doc = { type: 'doc', content: [{ type: 'image', attrs: { nodeId: ids.file } }] };
    await m.db.execute(sqlTag`
      insert into auth.users (id, email, password_hash, role) values (${owner}, ${`${tag}@example.invalid`}, 'x', 'admin')`);
    await m.db.execute(sqlTag`
      insert into spaces (id, kind, login_id) values (${owner}, 'brain', ${owner})`);
    await m.db.execute(sqlTag`
      insert into nodes (id, owner_id, type, title, path) values
        (${ids.page}, ${owner}, 'page', 'A page', 'pages'),
        (${ids.file}, ${owner}, 'file', 'img.png', 'files'),
        (${ids.folder}, ${owner}, 'branch', 'f', ${`files.ar_${owner.slice(0, 8)}`})`);
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

  const get = async (id: string) =>
    (await (
      await route.GET(new Request(`http://brain.test/api/access/nodes/${id}`), params(id))
    ).json()) as AccessNodeView;

  it("says a page's embeds follow it and a folder's contents do not", async () => {
    const page = await get(ids.page);
    expect(page.embedsFollow).toBe(true);
    expect(page.closure.map((c) => [c.id, c.audience])).toEqual([[ids.file, 'admin']]);
    expect((await get(ids.folder)).embedsFollow).toBe(false);
  });

  it('lowering a page lowers its image and lists it in alsoLowered', async () => {
    const res = await route.PATCH(
      new Request(`http://brain.test/api/access/nodes/${ids.page}`, {
        method: 'PATCH',
        body: JSON.stringify({ audience: 'public' }),
      }),
      params(ids.page),
    );
    expect(res.status).toBe(200);
    const body = (await res.json()) as AccessNodeUpdate;
    expect(body.alsoLowered?.map((l) => [l.id, l.from, l.to])).toEqual([
      [ids.file, 'admin', 'public'],
    ]);
    expect(body.lowered.map((l) => [l.id, l.audience])).toEqual([[ids.file, 'public']]);
    expect(body.share?.path).toMatch(/^\/s\//);
    expect((await get(ids.page)).closure.map((c) => c.audience)).toEqual(['public']);
  });
});
