/**
 * Pictures in a member's or a client's chat thread (client logins C6), on a
 * real, migrated Postgres: an image is pointed at the reader's own route only
 * for a file or drawing of this brain the reader may read at their level
 * (client for a client; team, client and public for a member). The fixture:
 * every item is a real file or drawing of this brain, named by the same
 * image form, so only the lookup at the reader's level tells them apart.
 *
 * Brain items belong to the shared test anchor (mantle_brain_id()): the level
 * roles' row security knows only that brain. Removes its rows after.
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
  };
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
    ];
    for (const [id, type, path, level] of rows) {
      await m.systemDb.execute(sqlTag`
        insert into nodes (id, owner_id, type, title, slug, path, audience)
        values (${id}, ${anchor}, ${type}, ${`${tag} ${level} ${type}`}, ${`${tag}-${id}`},
                ${path}, ${level})`);
    }
  }, 60_000);

  afterAll(async () => {
    if (!m) return;
    for (const id of Object.values(items)) {
      await m.systemDb.execute(sqlTag`delete from nodes where id = ${id}`);
    }
    await m.closeDb();
  });

  it('a client: only client-level files and drawings', async () => {
    const got = await ci.chatImagesFor(anchor, 'client', Object.values(items));
    expect(Object.fromEntries(got)).toEqual({
      [items.clientFile]: 'file',
      [items.clientDraw]: 'draw',
    });
  });

  it('a member: files and drawings at team level and below, never admin', async () => {
    const got = await ci.chatImagesFor(anchor, 'team', Object.values(items));
    expect(Object.fromEntries(got)).toEqual({
      [items.teamFile]: 'file',
      [items.clientFile]: 'file',
      [items.publicFile]: 'file',
      [items.clientDraw]: 'draw',
      [items.teamDraw]: 'draw',
    });
  });

  it('a thread page as each reader receives it', async () => {
    const texts = [
      `one ${img(items.adminFile)} two`,
      `${img(items.teamFile)}`,
      `![d](draw:${items.clientDraw}) ![n](media:${items.clientNote})`,
      `![c](media:${items.clientFile})`,
    ];
    expect(await ci.chatTextsForReader(anchor, 'client', texts)).toEqual([
      'one  two',
      '',
      `![d](/api/client/draws/${items.clientDraw}/svg) `,
      `![c](/api/client/files/${items.clientFile})`,
    ]);
    expect(await ci.chatTextsForReader(anchor, 'team', texts)).toEqual([
      'one  two',
      `![pic](/api/member/files/${items.teamFile})`,
      `![d](/api/member/draws/${items.clientDraw}/svg) `,
      `![c](/api/member/files/${items.clientFile})`,
    ]);
  });
});
