/**
 * Pictures in a member's chat thread (client logins C6), on a real, migrated
 * Postgres: an image is pointed at the reader's own route only for a file or
 * drawing of this brain the reader may read (workspaces W5b2: what a
 * workspace of the login holds). The client chat went in workspaces W5c and
 * the client login in W8a; the second reader is a member too.
 * The fixture: every item is a real file or drawing of this brain, named by
 * the same image form, so only the lookup as the reader tells them apart.
 * The member is a user of a workspace that holds the team, client and public
 * items; the other member a user of one that holds the client items only,
 * and not a client-level file nobody gave it.
 *
 * Brain items belong to the shared test anchor (mantle_brain_id()). Removes
 * its rows after (the anchor stays).
 *   MANTLE_TEST_DATABASE_URL=postgres://… pnpm vitest run packages/content/src/chat-images.viewer.db.test.ts
 */
import { randomUUID } from 'node:crypto';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

const URL = process.env.MANTLE_TEST_DATABASE_URL;

describe.skipIf(!URL)('chat pictures at the reader’s level', () => {
  type Db = typeof import('@mantle/db');
  let m: Db;
  let ci: typeof import('./chat-images');
  let sqlTag: typeof import('drizzle-orm').sql;
  let anchor = '';
  const tag = `chatimg-${randomUUID().slice(0, 8)}`;
  const items = {
    adminFile: randomUUID(),
    teamFile: randomUUID(),
    clientFile: randomUUID(),
    publicFile: randomUUID(),
    clientDraw: randomUUID(),
    teamDraw: randomUUID(),
    clientNote: randomUUID(),
    /** At client level, but no workspace of the other member holds it. */
    clientUnheld: randomUUID(),
  };
  const member = randomUUID();
  const other = randomUUID();
  const ws = { members: randomUUID(), others: randomUUID() };
  const img = (id: string) => `![pic](/api/files/files/${id}?raw=1)`;

  beforeAll(async () => {
    process.env.DATABASE_URL = URL;
    process.env.MANTLE_MASTER_KEY ??= 'mantle-viewer-test-key';
    m = await import('@mantle/db');
    ci = await import('./chat-images');
    sqlTag = (await import('drizzle-orm')).sql;
    const admin = (m.systemDb as unknown as { $client: Parameters<Db['ensureViewerRoles']>[0] })
      .$client;
    await m.ensureViewerRoles(admin, process.env.MANTLE_MASTER_KEY);
    const { ensureTestAnchor } = await import('@mantle/db/test-support');
    anchor = await ensureTestAnchor(admin);
    const rows: Array<[string, string, string, string]> = [
      [items.adminFile, 'file', 'files', 'admin'],
      [items.teamFile, 'file', 'files', 'team'],
      [items.clientFile, 'file', 'files', 'client'],
      [items.publicFile, 'file', 'files', 'public'],
      [items.clientDraw, 'draw', 'draws', 'client'],
      [items.teamDraw, 'draw', 'draws', 'team'],
      [items.clientNote, 'note', 'notes', 'client'],
      [items.clientUnheld, 'file', 'files', 'client'],
    ];
    for (const [id, type, path, level] of rows) {
      await m.systemDb.execute(sqlTag`
        insert into nodes (id, owner_id, type, title, slug, path, audience)
        values (${id}, ${anchor}, ${type}, ${`${tag} ${level} ${type}`}, ${`${tag}-${id}`},
                ${path}, ${level})`);
    }
    await m.systemDb.execute(sqlTag`
      insert into auth.users (id, email, password_hash, role) values
        (${member}, ${`${tag}-m@example.invalid`}, 'x', 'member'),
        (${other}, ${`${tag}-o@example.invalid`}, 'x', 'member')`);
    await m.systemDb.execute(sqlTag`
      insert into workspaces (id, owner_id, name) values
        (${ws.members}, ${anchor}, ${`${tag} members`}),
        (${ws.others}, ${anchor}, ${`${tag} others`})`);
    await m.systemDb.execute(sqlTag`
      insert into workspace_users (workspace_id, login_id) values
        (${ws.members}, ${member}), (${ws.others}, ${other})`);
    const holds: Array<[string, string]> = [
      [ws.members, items.teamFile],
      [ws.members, items.clientFile],
      [ws.members, items.publicFile],
      [ws.members, items.clientDraw],
      [ws.members, items.teamDraw],
      [ws.members, items.clientNote],
      [ws.others, items.clientFile],
      [ws.others, items.clientDraw],
      [ws.others, items.clientNote],
    ];
    for (const [wsId, id] of holds) {
      await m.withSubtreeHeads(id, [], (tx) =>
        tx.execute(sqlTag`insert into item_grants (node_id, workspace_id) values (${id}, ${wsId})`),
      );
    }
  }, 60_000);

  afterAll(async () => {
    if (!m) return;
    for (const id of Object.values(items)) {
      await m.systemDb.execute(sqlTag`delete from nodes where id = ${id}`);
    }
    await m.systemDb.execute(
      sqlTag`delete from workspaces where id in (${ws.members}, ${ws.others})`,
    );
    await m.systemDb.execute(sqlTag`delete from auth.users where id in (${member}, ${other})`);
    await m.closeDb();
  });

  it('a member: the files and drawings its workspace holds, never an admin-only one', async () => {
    const got = await ci.chatImagesFor(anchor, 'team', member, Object.values(items));
    expect(Object.fromEntries(got)).toEqual({
      [items.teamFile]: 'file',
      [items.clientFile]: 'file',
      [items.publicFile]: 'file',
      [items.clientDraw]: 'draw',
      [items.teamDraw]: 'draw',
    });
  });

  it('another member: only what its own workspace holds, not an item nobody gave it', async () => {
    const got = await ci.chatImagesFor(anchor, 'team', other, Object.values(items));
    expect(Object.fromEntries(got)).toEqual({
      [items.clientFile]: 'file',
      [items.clientDraw]: 'draw',
    });
  });

  it('a thread page as the member receives it', async () => {
    const texts = [
      `one ${img(items.adminFile)} two`,
      `${img(items.teamFile)}`,
      `![d](draw:${items.clientDraw}) ![n](media:${items.clientNote})`,
      `![c](media:${items.clientFile})`,
    ];
    expect(await ci.chatTextsForReader(anchor, 'team', member, texts)).toEqual([
      'one  two',
      `![pic](/api/member/files/${items.teamFile})`,
      `![d](/api/member/draws/${items.clientDraw}/svg) `,
      `![c](/api/member/files/${items.clientFile})`,
    ]);
  });
});
