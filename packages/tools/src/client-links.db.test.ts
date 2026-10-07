/**
 * The share tools on a CLIENT item, against a real, migrated Postgres
 * (client logins C1, audit A31: one test per entry point). Client is
 * signed-in clients, never an open link:
 *  - node_share and page_share refuse it, in words for the human (ask the
 *    owner whether to make it public), and make no link;
 *  - node_share on a page that embeds a client file says the file left
 *    client logins' view (audit A10).
 * Seeds its own owner and rows and removes them.
 *   MANTLE_TEST_DATABASE_URL=postgres://… pnpm vitest run packages/tools/src/client-links.db.test.ts
 */
import { randomUUID } from 'node:crypto';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { BuiltinToolDef, ToolHandlerContext } from './types';

const URL = process.env.MANTLE_TEST_DATABASE_URL;

describe.skipIf(!URL)('the share tools on client items, on Postgres', () => {
  type Db = typeof import('@mantle/db');
  type Content = typeof import('@mantle/content');
  let m: Db;
  let c: Content;
  let nodeShare: BuiltinToolDef;
  let pageShare: BuiltinToolDef;
  let sqlTag: typeof import('drizzle-orm').sql;
  const owner = randomUUID();
  const ids = {
    note: randomUUID(),
    page: randomUUID(),
    embedder: randomUUID(),
    file: randomUUID(),
  };
  const tag = `client-links-${owner.slice(0, 8)}`;
  const ctx: ToolHandlerContext = { ownerId: owner, surface: { kind: 'web' } }; // the owner (C4: none is not)

  const audienceOf = async (id: string) =>
    (
      (await m.db.execute(sqlTag`select audience from nodes where id = ${id}`)) as unknown as {
        audience: string;
      }[]
    )[0]!.audience;
  const linkCount = async (id: string) =>
    (
      (await m.db.execute(
        sqlTag`select count(*)::int as n from shares where node_id = ${id}`,
      )) as unknown as { n: number }[]
    )[0]!.n;

  beforeAll(async () => {
    process.env.DATABASE_URL = URL;
    m = await import('@mantle/db');
    c = await import('@mantle/content');
    nodeShare = (await import('./builtins-share')).SHARE_TOOLS.find(
      (t) => t.slug === 'node_share',
    )!;
    pageShare = (await import('./pages/sharing')).page_share;
    sqlTag = (await import('drizzle-orm')).sql;
    const empty = '{"type":"doc","content":[]}';
    const withFile = JSON.stringify({
      type: 'doc',
      content: [{ type: 'image', attrs: { nodeId: ids.file, src: 'x' } }],
    });
    await m.db.execute(sqlTag`
      insert into auth.users (id, email, password_hash, role) values (${owner}, ${`${tag}@example.invalid`}, 'x', 'admin')`);
    await m.db.execute(sqlTag`
      insert into spaces (id, kind, login_id) values (${owner}, 'brain', ${owner})`);
    await m.db.execute(sqlTag`
      insert into nodes (id, owner_id, type, title, path, parent_id, audience) values
        (${ids.note}, ${owner}, 'note', 'client note', 'notes', null, 'client'),
        (${ids.page}, ${owner}, 'page', 'client page', 'pages', null, 'client'),
        (${ids.embedder}, ${owner}, 'page', 'embeds a client file', 'pages', null, 'admin'),
        (${ids.file}, ${owner}, 'file', 'plan.png', 'files', null, 'client')`);
    await m.db.execute(sqlTag`
      insert into pages (node_id, doc, doc_text) values
        (${ids.page}, ${empty}::jsonb, ''),
        (${ids.embedder}, ${withFile}::jsonb, '')`);
  }, 60_000);

  afterAll(async () => {
    await m.db.execute(sqlTag`delete from shares where owner_id = ${owner}`);
    await m.db.execute(sqlTag`delete from nodes where owner_id = ${owner}`);
    await m.db.execute(sqlTag`delete from spaces where id = ${owner} or login_id = ${owner}`);
    await m.db.execute(sqlTag`delete from auth.users where id = ${owner}`);
    await m.closeDb();
  });

  it('node_share refuses a client item, for the human, and makes no link', async () => {
    const res = await nodeShare.handler({ id: ids.note }, ctx);
    if (res.ok) throw new Error('expected a refusal');
    expect(res.error).toMatch(/Client items have no open link; clients sign in/);
    expect(res.error).toMatch(/Ask the owner whether to make it public/);
    expect(res.error).not.toMatch(/access_set/);
    expect(await linkCount(ids.note)).toBe(0);
    expect(await audienceOf(ids.note)).toBe('client');
  });

  it('page_share refuses a client page and makes no link', async () => {
    const res = await pageShare.handler({ id: ids.page }, ctx);
    if (res.ok) throw new Error('expected a refusal');
    expect(res.error).toMatch(/Client items have no open link/);
    expect(await linkCount(ids.page)).toBe(0);
    expect(await audienceOf(ids.page)).toBe('client');
  });

  it("node_share on a page that embeds a client file says it left client logins' view (A10)", async () => {
    const res = await nodeShare.handler({ id: ids.embedder }, ctx);
    if (!res.ok) throw new Error(res.error);
    const out = res.output as { alsoLowered: { id: string; from: string }[]; warning: string };
    expect(out.alsoLowered.map((l) => [l.id, l.from])).toEqual([[ids.file, 'client']]);
    expect(out.warning).toMatch(/left client logins' view: plan\.png \(file\)/);
    expect(await audienceOf(ids.file)).toBe('public');
    // The Access lever says the same (access_set to public).
    await c.setItemLevel(owner, ids.file, 'client');
    await c.setItemLevel(owner, ids.embedder, 'admin');
    const { access_set } = await import('./builtins-access');
    const set = await access_set.handler({ node_id: ids.embedder, level: 'public' }, ctx);
    if (!set.ok) throw new Error(set.error);
    expect((set.output as { warnings: string[] }).warnings.join(' ')).toMatch(
      /left client logins' view/,
    );
  });
});
