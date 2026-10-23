/**
 * Which folder an item takes its sharing from (the Access control's "Shared
 * via"; workspaces W5b2: its grant rows "via folder"), against a real,
 * migrated Postgres. Read through embeds is gone: an embed gives no reads.
 *   MANTLE_TEST_DATABASE_URL=postgres://… pnpm vitest run packages/content/src/shared-via.db.test.ts
 */
import { randomUUID } from 'node:crypto';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { asSuperuser } from '@mantle/db/test-support';

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
  const ws = {
    admin: randomUUID(),
    team: randomUUID(),
    field: randomUUID(),
    otherTeam: randomUUID(),
  };

  /** A hand grant of `node` to `wsId`; a folder passes it to what is inside
   *  (rows "via folder", by trigger), under its subtree's heads. */
  const grant = (node: string, wsId: string) =>
    m.withSubtreeHeads(node, [], (tx) =>
      tx.execute(sqlTag`insert into item_grants (node_id, workspace_id)
        values (${node}, ${wsId})`),
    );
  /** "Removed here": the folder's row on `node` taken away. */
  const removeHere = (node: string, wsId: string) =>
    m.withHeads([node], 'update', (tx) =>
      tx.execute(sqlTag`update item_grants set excluded = true
        where node_id = ${node} and workspace_id = ${wsId}`),
    );

  /** A fixture write to the workspace tables, as the superuser: the app's
   *  pools only read them. */
  const su = async (q: ReturnType<typeof sqlTag>) =>
    (await import('@mantle/db/test-support')).superuserExec(URL!, q);

  beforeAll(async () => {
    process.env.DATABASE_URL = URL;
    m = await import('@mantle/db');
    tree = await import('./tree/index');
    notes = await import('./notes');
    via = await import('./shared-via');
    sqlTag = (await import('drizzle-orm')).sql;
    for (const id of [owner, other]) {
      await asSuperuser()(sqlTag`
        insert into auth.users (id, email, password_hash, role)
        values (${id}, ${`${tag}-${id.slice(0, 4)}@example.invalid`}, 'x', 'admin')`);
      await m.db.execute(sqlTag`
        insert into spaces (id, kind, login_id) values (${id}, 'brain', ${id})`);
      await tree.ensureKindRoot(id, 'notes');
    }
    await su(sqlTag`
      insert into workspaces (id, owner_id, name, is_admin, bridge_key) values
        (${ws.admin}, ${owner}, ${`${tag} Admin`}, true, 'admin'),
        (${ws.team}, ${owner}, ${`${tag} Team`}, false, null),
        (${ws.field}, ${owner}, ${`${tag} Field`}, false, null),
        (${ws.otherTeam}, ${other}, ${`${tag} Other`}, false, null)`);
  }, 60_000);

  afterAll(async () => {
    for (const id of [owner, other]) {
      await m.db.execute(sqlTag`
        delete from item_grants where node_id in (select id from nodes where owner_id = ${id})`);
      await m.db.execute(sqlTag`delete from nodes where owner_id = ${id}`);
      await su(sqlTag`delete from workspaces where owner_id = ${id}`);
      await m.db.execute(sqlTag`delete from spaces where id = ${id} or login_id = ${id}`);
      await m.db.execute(sqlTag`delete from auth.users where id = ${id}`);
    }
  });

  it('names the nearest folder whose grant the item takes, and its trail', async () => {
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

    // Nothing shared yet; an Admin row from a folder is not sharing.
    expect(await via.sharedViaFolder(owner, inAcme.id)).toBeNull();
    await grant(clients.id, ws.admin);
    expect(await via.sharedViaFolder(owner, inAcme.id)).toBeNull();

    await grant(clients.id, ws.team);
    expect(await via.sharedViaFolder(owner, inAcme.id)).toEqual({
      folderId: clients.id,
      trail: ['Clients'],
      level: 'team',
    });
    // The subfolder takes it from above; the shared folder itself has none.
    expect(await via.sharedViaFolder(owner, acme.id)).toMatchObject({ folderId: clients.id });
    expect(await via.sharedViaFolder(owner, clients.id)).toBeNull();
    expect(await via.sharedViaFolder(owner, loose.id)).toBeNull();
    // A nearer folder's grant wins, with the whole folder chain as its trail.
    await grant(acme.id, ws.field);
    expect(await via.sharedViaFolder(owner, inAcme.id)).toEqual({
      folderId: acme.id,
      trail: ['Clients', 'Acme Corp'],
      level: 'team',
    });
    expect(await via.sharedViaFolder(owner, acme.id)).toMatchObject({ folderId: clients.id });
    // Nothing is read through an embed.
    expect(await via.readThroughEmbeds(owner, inAcme.id)).toBeNull();
  });

  it('a row removed here does not count', async () => {
    const folder = await tree.createTreeFolder(owner, 'notes', { parentId: null, name: 'Ops' });
    const note = await notes.createNote(owner, { title: 'Removed', content: '' });
    await tree.moveTreeItems(owner, 'notes', [note.id], folder.id);
    await grant(folder.id, ws.team);
    expect(await via.sharedViaFolder(owner, note.id)).toMatchObject({ folderId: folder.id });
    await removeHere(note.id, ws.team);
    expect(await via.sharedViaFolder(owner, note.id)).toBeNull();
  });

  it('answers nothing for another owner’s item', async () => {
    const theirs = await notes.createNote(other, { title: 'Theirs', content: '' });
    await grant(theirs.id, ws.otherTeam);
    expect(await via.sharedViaFolder(owner, theirs.id)).toBeNull();
  });
});
