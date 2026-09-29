/**
 * GET /api/access/nodes/:id on a real, migrated Postgres (client logins
 * audit A11): the view says a new open link is made at public only
 * (`openLinkLevels`), and for an item at client it names the old live link
 * on a client folder that holds it (anyone with that link opens the item,
 * though the item has no link of its own). Only the owner check is stubbed.
 * Seeds its own owner and rows and removes them.
 *   MANTLE_TEST_DATABASE_URL=postgres://… pnpm vitest run access-old-links.db.test
 */
import { randomUUID } from 'node:crypto';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import type { AccessNodeView } from '@mantle/client-types';

const URL = process.env.MANTLE_TEST_DATABASE_URL;
const h = vi.hoisted(() => ({ owner: '' }));

vi.mock('@/lib/auth', () => ({ getOwnerOr401: vi.fn(async () => ({ id: h.owner })) }));

describe.skipIf(!URL)('the Access view names old links above a client item', () => {
  type Db = typeof import('@mantle/db');
  let m: Db;
  let route: typeof import('./route');
  let sqlTag: typeof import('drizzle-orm').sql;
  const owner = randomUUID();
  h.owner = owner;
  const ids = { folder: randomUUID(), file: randomUUID(), teamFile: randomUUID() };
  const shareId = randomUUID();
  const tag = `access-old-${owner.slice(0, 8)}`;
  const params = (id: string) => ({ params: Promise.resolve({ id }) });

  beforeAll(async () => {
    process.env.DATABASE_URL = URL;
    m = await import('@mantle/db');
    route = await import('./route');
    sqlTag = (await import('drizzle-orm')).sql;
    const folderPath = `files.ao_${owner.slice(0, 8)}`;
    await m.db.execute(sqlTag`
      insert into auth.users (id, email, password_hash, role) values (${owner}, ${`${tag}@example.invalid`}, 'x', 'admin')`);
    await m.db.execute(sqlTag`
      insert into spaces (id, kind, login_id) values (${owner}, 'brain', ${owner})`);
    await m.db.execute(sqlTag`
      insert into nodes (id, owner_id, type, title, path, audience) values
        (${ids.folder}, ${owner}, 'branch', 'Old client folder', ${folderPath}, 'client'),
        (${ids.file}, ${owner}, 'file', 'late.pdf', ${folderPath}, 'client'),
        (${ids.teamFile}, ${owner}, 'file', 'team.pdf', ${folderPath}, 'team')`);
    await m.db.execute(sqlTag`
      insert into shares (id, owner_id, node_id, node_type, token)
      values (${shareId}, ${owner}, ${ids.folder}, 'branch', ${`${tag}-tok`})`);
  }, 60_000);

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

  it('a client file under a client folder with a live link: the link is named', async () => {
    const view = await get(ids.file);
    expect(view.share).toBeNull();
    expect(view.openLinkLevels).toEqual(['public']);
    expect(view.oldLinksAbove).toEqual([
      { shareId, nodeId: ids.folder, title: 'Old client folder', type: 'branch', via: 'folder' },
    ]);
  });

  it('an item not at client carries no oldLinksAbove; openLinkLevels is always there', async () => {
    const view = await get(ids.teamFile);
    expect(view.oldLinksAbove).toBeUndefined();
    expect(view.openLinkLevels).toEqual(['public']);
  });
});
