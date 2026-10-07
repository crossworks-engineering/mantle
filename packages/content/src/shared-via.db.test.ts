/**
 * Which shared folder an item takes its share from (the Access control's
 * "Shared via"), against a real, migrated Postgres:
 *   MANTLE_TEST_DATABASE_URL=postgres://… pnpm vitest run packages/content/src/shared-via.db.test.ts
 */
import { randomUUID } from 'node:crypto';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

const URL = process.env.MANTLE_TEST_DATABASE_URL;

describe.skipIf(!URL)('sharedViaFolder', () => {
  type Db = typeof import('@mantle/db');
  let m: Db;
  let tree: typeof import('./tree/index');
  let notes: typeof import('./notes');
  let via: typeof import('./shared-via');
  let sqlTag: typeof import('drizzle-orm').sql;
  const owner = randomUUID();
  const other = randomUUID();
  const tag = `shared-via-${owner.slice(0, 8)}`;

  beforeAll(async () => {
    process.env.DATABASE_URL = URL;
    m = await import('@mantle/db');
    tree = await import('./tree/index');
    notes = await import('./notes');
    via = await import('./shared-via');
    sqlTag = (await import('drizzle-orm')).sql;
    for (const id of [owner, other]) {
      await m.db.execute(sqlTag`
        insert into auth.users (id, email, password_hash, role)
        values (${id}, ${`${tag}-${id.slice(0, 4)}@example.invalid`}, 'x', 'admin')`);
      await m.db.execute(sqlTag`
        insert into spaces (id, kind, login_id) values (${id}, 'brain', ${id})`);
      await tree.ensureKindRoot(id, 'notes');
    }
  }, 60_000);

  afterAll(async () => {
    for (const id of [owner, other]) {
      await m.db.execute(sqlTag`delete from nodes where owner_id = ${id}`);
      await m.db.execute(sqlTag`delete from spaces where id = ${id} or login_id = ${id}`);
      await m.db.execute(sqlTag`delete from auth.users where id = ${id}`);
    }
  });

  it('names the nearest shared folder, its trail and level; a folder only from above', async () => {
    const clients = await tree.createTreeFolder(owner, 'notes', {
      parentId: null,
      name: 'Clients',
    });
    const acme = await tree.createTreeFolder(owner, 'notes', {
      parentId: clients.id,
      name: 'Acme Corp',
    });
    const loose = await notes.createNote(owner, { title: 'Loose', content: '' });
    const inAcme = await notes.createNote(owner, { title: 'Scope', content: '' });
    await tree.moveTreeItems(owner, 'notes', [inAcme.id], acme.id);

    // Nothing shared yet.
    expect(await via.sharedViaFolder(owner, inAcme.id)).toBeNull();

    await tree.updateTreeFolder(owner, 'notes', clients.id, { share: 'team' }, { confirm: true });
    expect(await via.sharedViaFolder(owner, inAcme.id)).toEqual({
      folderId: clients.id,
      trail: ['Clients'],
      level: 'team',
    });
    // The subfolder takes it from above; the shared folder itself has none.
    expect(await via.sharedViaFolder(owner, acme.id)).toMatchObject({ folderId: clients.id });
    expect(await via.sharedViaFolder(owner, clients.id)).toBeNull();
    expect(await via.sharedViaFolder(owner, loose.id)).toBeNull();

    // A nearer share wins, with the whole folder chain as its trail.
    await tree.updateTreeFolder(owner, 'notes', acme.id, { share: 'client' }, { confirm: true });
    expect(await via.sharedViaFolder(owner, inAcme.id)).toEqual({
      folderId: acme.id,
      trail: ['Clients', 'Acme Corp'],
      level: 'client',
    });
    expect(await via.sharedViaFolder(owner, acme.id)).toMatchObject({ folderId: clients.id });
  });

  it('answers nothing for another owner’s item', async () => {
    const theirs = await notes.createNote(other, { title: 'Theirs', content: '' });
    expect(await via.sharedViaFolder(owner, theirs.id)).toBeNull();
  });
});
