/**
 * node_unshare and page_unshare against a real, migrated Postgres (MED 7):
 * unsharing a page takes it to admin with the same closure rule as setting
 * admin by hand, so its embedded file still at public is reported
 * (`stillBelow` plus a warning naming access_set), never raised on its own.
 * Seeds its own owner and rows and removes them.
 *   MANTLE_TEST_DATABASE_URL=postgres://… pnpm vitest run packages/tools/src/unshare-closure.db.test.ts
 */
import { randomUUID } from 'node:crypto';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { BuiltinToolDef, ToolHandlerContext } from './types';

const URL = process.env.MANTLE_TEST_DATABASE_URL;

describe.skipIf(!URL)('the unshare tools report the closure on Postgres', () => {
  type Db = typeof import('@mantle/db');
  type Content = typeof import('@mantle/content');
  let m: Db;
  let c: Content;
  let nodeUnshare: BuiltinToolDef;
  let pageUnshare: BuiltinToolDef;
  let sqlTag: typeof import('drizzle-orm').sql;
  const owner = randomUUID();
  const ids = { page: randomUUID(), file: randomUUID() };
  const tag = `unshare-closure-${owner.slice(0, 8)}`;
  const ctx: ToolHandlerContext = { ownerId: owner, surface: { kind: 'web' } }; // the owner (C4: none is not)

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
    nodeUnshare = (await import('./builtins-share')).SHARE_TOOLS.find(
      (t) => t.slug === 'node_unshare',
    )!;
    pageUnshare = (await import('./pages/sharing')).page_unshare;
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
  });

  afterAll(async () => {
    await m.db.execute(sqlTag`delete from shares where owner_id = ${owner}`);
    await m.db.execute(sqlTag`delete from nodes where owner_id = ${owner}`);
    await m.db.execute(sqlTag`delete from spaces where id = ${owner} or login_id = ${owner}`);
    await m.db.execute(sqlTag`delete from auth.users where id = ${owner}`);
    await m.closeDb();
  });

  for (const which of ['node_unshare', 'page_unshare'] as const) {
    it(`${which} reports the embedded file still at public`, async () => {
      await c.setItemLevel(owner, ids.page, 'public', { withClosure: true });
      expect(await audienceOf(ids.file)).toBe('public');

      const tool = which === 'node_unshare' ? nodeUnshare : pageUnshare;
      const res = await tool.handler({ id: ids.page }, ctx);
      if (!res.ok) throw new Error(res.error);
      const out = res.output as {
        unshared: boolean;
        stillBelow?: { id: string; audience: string }[];
        warning?: string;
      };
      expect(out.unshared).toBe(true);
      expect(out.stillBelow?.map((i) => [i.id, i.audience])).toEqual([[ids.file, 'public']]);
      expect(out.warning).toMatch(/img\.png \(file, public\)/);
      expect(await audienceOf(ids.page)).toBe('admin');
      expect(await c.getActiveShareForNode(owner, ids.page)).toBeNull();
      // Reported, not raised: raising is the explicit access_set step.
      expect(await audienceOf(ids.file)).toBe('public');
    });
  }
});
