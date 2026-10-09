/**
 * The page, note and table lists leave out items made from an email
 * attachment when asked (a key without Search: access matrix T4, A1), in the
 * query itself, so a page of results stays full and the count matches. On a
 * real, migrated Postgres.
 *   MANTLE_TEST_DATABASE_URL=postgres://… pnpm vitest run packages/content/src/email-copies-list.db.test.ts
 */
import { randomUUID } from 'node:crypto';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

const URL = process.env.MANTLE_TEST_DATABASE_URL;

describe.skipIf(!URL)('lists without email copies', () => {
  type Db = typeof import('@mantle/db');
  let m: Db;
  let pages: typeof import('./pages/read');
  let notes: typeof import('./notes');
  let tables: typeof import('./tables/read');
  let sqlTag: typeof import('drizzle-orm').sql;
  const owner = randomUUID();
  const tag = `ecl-${randomUUID().slice(0, 8)}`;
  const inbox = `inbox.${tag.replace(/-/g, '_')}`;
  const attachment = randomUUID();
  const q = (s: ReturnType<typeof sqlTag>) => m.systemDb.execute(s);
  const made: Record<'page' | 'note' | 'table', { copy: string; plain: string }> = {
    page: { copy: randomUUID(), plain: randomUUID() },
    note: { copy: randomUUID(), plain: randomUUID() },
    table: { copy: randomUUID(), plain: randomUUID() },
  };

  beforeAll(async () => {
    process.env.DATABASE_URL = URL;
    process.env.MANTLE_MASTER_KEY ??= 'mantle-viewer-test-key';
    m = await import('@mantle/db');
    pages = await import('./pages/read');
    notes = await import('./notes');
    tables = await import('./tables/read');
    sqlTag = (await import('drizzle-orm')).sql;
    await q(sqlTag`insert into auth.users (id, email, password_hash, role)
      values (${owner}, ${`${tag}@example.invalid`}, 'x', 'admin')`);
    await q(sqlTag`insert into spaces (id, kind, login_id) values (${owner}, 'brain', ${owner})`);
    await q(sqlTag`
      insert into nodes (owner_id, type, title, path) values
        (${owner}, 'email', 'A mail', ${inbox})`);
    await q(sqlTag`
      insert into nodes (id, owner_id, type, title, path) values
        (${attachment}, ${owner}, 'file', 'invoice.pdf', ${`${inbox}.attachments`})`);
    const from = JSON.stringify({ sourceFileId: attachment, content: 'x' });
    for (const [type, ids] of Object.entries(made)) {
      const path = `${type}s`;
      await q(sqlTag`
        insert into nodes (id, owner_id, type, title, path, data) values
          (${ids.copy}, ${owner}, ${type}::node_type, ${`${tag} copy`}, ${path}::ltree, ${from}::jsonb),
          (${ids.plain}, ${owner}, ${type}::node_type, ${`${tag} plain`}, ${path}::ltree, '{"content":"y"}'::jsonb)`);
    }
  }, 60_000);

  afterAll(async () => {
    await q(sqlTag`delete from nodes where owner_id = ${owner}`);
    await q(sqlTag`delete from spaces where login_id = ${owner}`);
    await q(sqlTag`delete from auth.users where id = ${owner}`);
    await m.closeDb();
  }, 60_000);

  const ids = (rows: { id: string }[]) => rows.map((r) => r.id).sort();

  it('lists every item by default, and leaves the copies out when asked', async () => {
    const both = (k: keyof typeof made) => [made[k].copy, made[k].plain].sort();
    const plain = (k: keyof typeof made) => [made[k].plain];
    const query = tag;
    expect(ids(await pages.listPages(owner, { query }))).toEqual(both('page'));
    expect(ids(await pages.listPages(owner, { query, withoutEmailCopies: true }))).toEqual(
      plain('page'),
    );
    expect(await pages.countPages(owner, { query, withoutEmailCopies: true })).toBe(1);
    expect(ids(await notes.listNotes(owner, { query }))).toEqual(both('note'));
    expect(ids(await notes.listNotes(owner, { query, withoutEmailCopies: true }))).toEqual(
      plain('note'),
    );
    expect(await notes.countNotes(owner, { query, withoutEmailCopies: true })).toBe(1);
    expect(ids(await tables.listTables(owner, { query }))).toEqual(both('table'));
    expect(ids(await tables.listTables(owner, { query, withoutEmailCopies: true }))).toEqual(
      plain('table'),
    );
    expect(await tables.countTables(owner, { query, withoutEmailCopies: true })).toBe(1);
  });
});
