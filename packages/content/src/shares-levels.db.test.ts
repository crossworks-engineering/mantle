/**
 * Levels drive links, against a real, migrated Postgres: setting a level
 * fixes the item's link, and every older share path (create, mode, revoke,
 * sub-page cascade) re-derives the level from the link it leaves. Seeds its
 * own owner and rows and removes them.
 *   MANTLE_TEST_DATABASE_URL=postgres://… pnpm vitest run packages/content/src/shares-levels.db.test.ts
 */
import { randomUUID } from 'node:crypto';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

const URL = process.env.MANTLE_TEST_DATABASE_URL;

describe.skipIf(!URL)('levels drive links on Postgres', () => {
  type Db = typeof import('@mantle/db');
  type Access = typeof import('./access');
  type Shares = typeof import('./shares');
  let m: Db;
  let a: Access;
  let s: Shares;
  let sqlTag: typeof import('drizzle-orm').sql;
  const owner = randomUUID();
  const ids = {
    note: randomUUID(),
    page: randomUUID(),
    parent: randomUUID(),
    sub: randomUUID(),
    task: randomUUID(),
    embed: randomUUID(),
  };
  const tag = `share-levels-${owner.slice(0, 8)}`;

  const audienceOf = async (id: string) =>
    (
      (await m.db.execute(sqlTag`select audience from nodes where id = ${id}`)) as unknown as {
        audience: string;
      }[]
    )[0]!.audience;

  beforeAll(async () => {
    process.env.DATABASE_URL = URL;
    m = await import('@mantle/db');
    a = await import('./access');
    s = await import('./shares');
    sqlTag = (await import('drizzle-orm')).sql;
    const doc = {
      type: 'doc',
      content: [{ type: 'image', attrs: { nodeId: ids.embed, src: 'x' } }],
    };
    await m.db.execute(sqlTag`
      insert into auth.users (id, email, password_hash) values (${owner}, ${`${tag}@example.invalid`}, 'x')`);
    // Items belong to a space (0165): this test's own owner is a brain row.
    await m.db.execute(sqlTag`
      insert into spaces (id, kind, login_id) values (${owner}, 'brain', ${owner})`);
    await m.db.execute(sqlTag`
      insert into nodes (id, owner_id, type, title, path, parent_id) values
        (${ids.note}, ${owner}, 'note', 'n', 'notes', null),
        (${ids.page}, ${owner}, 'page', 'p', 'pages', null),
        (${ids.parent}, ${owner}, 'page', 'parent', 'pages', null),
        (${ids.sub}, ${owner}, 'page', 'sub', 'pages', ${ids.parent}),
        (${ids.task}, ${owner}, 'task', 't', 'tasks', null),
        (${ids.embed}, ${owner}, 'file', 'img.png', 'files', null)`);
    await m.db.execute(sqlTag`
      insert into pages (node_id, doc, doc_text) values
        (${ids.page}, ${JSON.stringify(doc)}::jsonb, ''),
        (${ids.parent}, '{"type":"doc","content":[]}'::jsonb, ''),
        (${ids.sub}, '{"type":"doc","content":[]}'::jsonb, '')`);
  });

  afterAll(async () => {
    await m.db.execute(sqlTag`delete from shares where owner_id = ${owner}`);
    await m.db.execute(sqlTag`delete from nodes where owner_id = ${owner}`);
    await m.db.execute(sqlTag`delete from spaces where id = ${owner} or login_id = ${owner}`);
    await m.db.execute(sqlTag`delete from auth.users where id = ${owner}`);
    await m.closeDb();
  });

  it('team gives a team-only link, client an open one, admin none', async () => {
    const team = await a.setItemLevel(owner, ids.note, 'team');
    expect(team.share?.mode).toBe('team');
    expect(await audienceOf(ids.note)).toBe('team');

    const client = await a.setItemLevel(owner, ids.note, 'client');
    expect(client.share?.mode).toBe('public');
    expect(client.share?.token).toBe(team.share?.token); // one link per item
    expect(await audienceOf(ids.note)).toBe('client');

    const admin = await a.setItemLevel(owner, ids.note, 'admin');
    expect(admin.share).toBeNull();
    expect(await s.getActiveShareForNode(owner, ids.note)).toBeNull();
    expect(await audienceOf(ids.note)).toBe('admin');
  });

  it('gives closure items the level but no link of their own', async () => {
    const res = await a.setItemLevel(owner, ids.page, 'team', { withClosure: true });
    expect(res.lowered.map((i) => i.id)).toEqual([ids.embed]);
    expect(await audienceOf(ids.embed)).toBe('team');
    expect(await s.getActiveShareForNode(owner, ids.embed)).toBeNull();
    await a.setItemLevel(owner, ids.page, 'admin');
    // Raising never raises the closure.
    expect(await audienceOf(ids.embed)).toBe('team');
  });

  it('re-derives the level on the older share paths', async () => {
    const link = await s.createShare(owner, ids.note);
    expect(await audienceOf(ids.note)).toBe('public');
    await s.applyShareMode(owner, link.id, 'team');
    expect(await audienceOf(ids.note)).toBe('team');
    await s.applyShareMode(owner, link.id, 'public');
    expect(await audienceOf(ids.note)).toBe('public');
    await s.revokeShareTree(owner, link.id);
    expect(await audienceOf(ids.note)).toBe('admin');
  });

  it("puts cascaded sub-pages at the parent's level and back to admin with it", async () => {
    await a.setItemLevel(owner, ids.parent, 'client');
    await s.setShareCascade(owner, ids.parent, true);
    expect(await audienceOf(ids.sub)).toBe('client');
    const parent = (await s.getActiveShareForNode(owner, ids.parent))!;
    await s.applyShareMode(owner, parent.id, 'team');
    expect(await audienceOf(ids.sub)).toBe('team');
    await a.setItemLevel(owner, ids.parent, 'admin');
    expect(await audienceOf(ids.sub)).toBe('admin');
    expect(await s.getActiveShareForNode(owner, ids.sub)).toBeNull();
  });

  it('keeps a task admin whatever its link, and admin removes an old link', async () => {
    await s.createShare(owner, ids.task, { mode: 'team' });
    expect(await audienceOf(ids.task)).toBe('admin');
    const res = await a.setItemLevel(owner, ids.task, 'admin');
    expect(res.share).toBeNull();
    expect(await s.getActiveShareForNode(owner, ids.task)).toBeNull();
    await expect(a.setItemLevel(owner, ids.task, 'team')).rejects.toMatchObject({
      code: 'type_ceiling',
    });
  });
});
