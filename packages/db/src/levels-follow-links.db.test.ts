/**
 * Migration 0161's folder statement against a real, migrated Postgres (MED 8):
 * inside nested shared folders an item takes the level of the DEEPEST folder
 * above it, not an arbitrary one. Runs the migration's own last statement,
 * scoped to this test's owner so other rows are never touched. Seeds its own
 * owner and rows and removes them.
 *   MANTLE_TEST_DATABASE_URL=postgres://… pnpm vitest run packages/db/src/levels-follow-links.db.test.ts
 */
import { randomUUID } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

const URL = process.env.MANTLE_TEST_DATABASE_URL;

/** The migration's folder statement (its last), limited to one owner. */
function folderStatement(owner: string): string {
  const file = readFileSync(
    join(__dirname, '..', 'migrations', '0161_levels_follow_links.sql'),
    'utf8',
  );
  const last = file.split('--> statement-breakpoint').at(-1)!;
  const body = last
    .split('\n')
    .filter((l) => !l.trimStart().startsWith('--'))
    .join('\n')
    .trim()
    .replace(/;$/, '');
  if (!/^UPDATE "public"\."nodes" c SET/.test(body)) {
    throw new Error(`0161's last statement is not the folder update: ${body.slice(0, 60)}`);
  }
  // Its final WHERE names the target row `c`: one more condition scopes it.
  return `${body} AND c.owner_id = '${owner}'`;
}

describe.skipIf(!URL)('migration 0161: nested folders, deepest wins', () => {
  type Db = typeof import('./index');
  let m: Db;
  let sqlTag: typeof import('drizzle-orm').sql;
  const owner = randomUUID();
  const tag = `lfl_${owner.replace(/-/g, '').slice(0, 10)}`;
  const outer = `files.${tag}`;
  const middle = `${outer}.mid`;
  const inner = `${middle}.inner`;
  const ids = {
    outer: randomUUID(),
    middle: randomUUID(),
    inner: randomUUID(),
    inOuter: randomUUID(),
    inMiddle: randomUUID(),
    inInner: [randomUUID(), randomUUID(), randomUUID(), randomUUID()],
    task: randomUUID(),
  };

  const audienceOf = async (id: string) =>
    (
      (await m.db.execute(sqlTag`select audience from nodes where id = ${id}`)) as unknown as {
        audience: string;
      }[]
    )[0]!.audience;

  beforeAll(async () => {
    process.env.DATABASE_URL = URL;
    m = await import('./index');
    sqlTag = (await import('drizzle-orm')).sql;
    await m.db.execute(sqlTag`
      insert into auth.users (id, email, password_hash, role) values (${owner}, ${`${tag}@example.invalid`}, 'x', 'admin')`);
    await m.db.execute(sqlTag`
      insert into spaces (id, kind, login_id) values (${owner}, 'brain', ${owner})`);
    // Folders shallowest first, in separate statements: the old statement's
    // arbitrary pick then lands on the outer folder, not the nearest one.
    await m.db.execute(sqlTag`
      insert into nodes (id, owner_id, type, title, path, audience)
      values (${ids.outer}, ${owner}, 'branch', 'outer', ${outer}::ltree, 'team')`);
    await m.db.execute(sqlTag`
      insert into nodes (id, owner_id, type, title, path, audience)
      values (${ids.middle}, ${owner}, 'branch', 'mid', ${middle}::ltree, 'client')`);
    await m.db.execute(sqlTag`
      insert into nodes (id, owner_id, type, title, path, audience)
      values (${ids.inner}, ${owner}, 'branch', 'inner', ${inner}::ltree, 'public')`);
    for (const id of ids.inInner) {
      await m.db.execute(sqlTag`
        insert into nodes (id, owner_id, type, title, path)
        values (${id}, ${owner}, 'file', 'deep.pdf', ${inner}::ltree)`);
    }
    await m.db.execute(sqlTag`
      insert into nodes (id, owner_id, type, title, path) values
        (${ids.inMiddle}, ${owner}, 'file', 'mid.pdf', ${middle}::ltree),
        (${ids.inOuter}, ${owner}, 'note', 'top', ${outer}::ltree),
        (${ids.task}, ${owner}, 'task', 't', ${inner}::ltree)`);
  }, 60_000);

  afterAll(async () => {
    await m.db.execute(sqlTag`delete from nodes where owner_id = ${owner}`);
    await m.db.execute(sqlTag`delete from spaces where id = ${owner} or login_id = ${owner}`);
    await m.db.execute(sqlTag`delete from auth.users where id = ${owner}`);
    await m.closeDb();
  });

  it('gives each item the level of the nearest shared folder above it', async () => {
    await m.db.execute(sqlTag.raw(folderStatement(owner)));
    for (const id of ids.inInner) expect(await audienceOf(id)).toBe('public');
    expect(await audienceOf(ids.inMiddle)).toBe('client');
    expect(await audienceOf(ids.inOuter)).toBe('team');
    // Folders already below admin keep their own level; tasks stay admin.
    expect(await audienceOf(ids.inner)).toBe('public');
    expect(await audienceOf(ids.middle)).toBe('client');
    expect(await audienceOf(ids.task)).toBe('admin');
  });
});
