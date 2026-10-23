/**
 * A shared note shows its own `media:` and `draw:` pictures and file embeds,
 * and nothing else, against a real, migrated Postgres. The note embeds
 * pictures, a file and a drawing; the share serves exactly those, read the
 * way a page's doc is (a link inside a sentence, or an id quoted in code, is
 * not an embed), under the same rule as a page: on the link's served list
 * (plan 8.1; an embed taken off the list is not served). A file or drawing
 * the note does NOT embed stays refused even on the list, and an expired or
 * revoked share
 * refuses everything, through the real /s routes. Only the file byte store is
 * stubbed. Seeds its own owner and rows and removes them.
 *   MANTLE_TEST_DATABASE_URL=postgres://… pnpm vitest run shares-note-media.db.test
 */
import { randomUUID } from 'node:crypto';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import type { Share } from '@mantle/db';
import { asSuperuser } from '@mantle/db/test-support';

const URL = process.env.MANTLE_TEST_DATABASE_URL;

vi.mock('@/lib/files', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@/lib/files')>()),
  readFileById: vi.fn(async () => ({
    bytes: Buffer.from('bytes'),
    row: { mimeType: 'image/png', filename: 'x.png' },
  })),
}));

describe.skipIf(!URL)('a shared note serves the pictures and files it names', () => {
  type Db = typeof import('@mantle/db');
  let m: Db;
  let shares: typeof import('./shares');
  let assetRoute: typeof import('@/app/s/[token]/a/[fileId]/route');
  let drawRoute: typeof import('@/app/s/[token]/draw/[drawId]/route');
  let sqlTag: typeof import('drizzle-orm').sql;
  const owner = randomUUID();
  const tag = `note-media-${owner.slice(0, 8)}`;
  const id = {
    note: randomUUID(),
    // The same note text under a second id: an item holds one open link at
    // a time (shares_node_open_uq), so the expired link gets its own item.
    note2: randomUUID(),
    pic: randomUUID(),
    doc: randomUUID(),
    inlineDoc: randomUUID(),
    titled: randomUUID(),
    titledLink: randomUUID(),
    fenced: randomUUID(),
    inlineCode: randomUUID(),
    draw: randomUUID(),
    otherFile: randomUUID(),
    otherDraw: randomUUID(),
    page: randomUUID(),
  };
  const token = {
    live: `${tag}-live`,
    revoked: `${tag}-revoked`,
    expired: `${tag}-expired`,
  };
  const content = [
    `![photo](media:${id.pic})`,
    // A file link alone on its line is a file embed: it follows the note.
    `[spec.pdf](media:${id.doc})`,
    // One inside a sentence is a link, not an embed, as on a page.
    `Also see [notes.txt](media:${id.inlineDoc}) for more.`,
    // A titled picture or file link is still an embed.
    `![titled](media:${id.titled} "A title")`,
    `[titled.pdf](media:${id.titledLink} "A title")`,
    // An id quoted in code renders as text: not a picture.
    ['```md', `![x](media:${id.fenced})`, '```'].join('\n'),
    `Write it as \`![x](media:${id.inlineCode})\` in a note.`,
    `![sketch](draw:${id.draw})`,
    // A page link is not a file: never served by the asset route.
    `[a page](page:${id.page})`,
  ].join('\n\n');

  /** Every item of the fixture: the served list of the links below, so a
   *  refusal is the reference rule, not the list. */
  const everything = () => Object.values(id);
  const noteLink = (served = everything()) =>
    ({
      id: randomUUID(),
      ownerId: owner,
      nodeId: id.note,
      nodeType: 'note',
      token: 't',
      contactId: null,
      settings: { served },
    }) as unknown as Share;

  beforeAll(async () => {
    process.env.DATABASE_URL = URL;
    m = await import('@mantle/db');
    shares = await import('./shares');
    assetRoute = await import('@/app/s/[token]/a/[fileId]/route');
    drawRoute = await import('@/app/s/[token]/draw/[drawId]/route');
    sqlTag = (await import('drizzle-orm')).sql;
    await asSuperuser()(sqlTag`
      insert into auth.users (id, email, password_hash, role) values (${owner}, ${`${tag}@example.invalid`}, 'x', 'admin')`);
    await m.db.execute(sqlTag`
      insert into spaces (id, kind, login_id) values (${owner}, 'brain', ${owner})`);
    const rows: Array<[string, string, string, string, Record<string, unknown>]> = [
      [id.note, 'note', 'Shared note', 'notes', { content }],
      [id.note2, 'note', 'Older note', 'notes', { content }],
      [id.pic, 'file', 'photo.png', 'files', {}],
      [id.doc, 'file', 'spec.pdf', 'files', {}],
      [id.inlineDoc, 'file', 'notes.txt', 'files', {}],
      [id.titled, 'file', 'titled.png', 'files', {}],
      [id.titledLink, 'file', 'titled.pdf', 'files', {}],
      [id.fenced, 'file', 'fenced.png', 'files', {}],
      [id.inlineCode, 'file', 'inline-code.png', 'files', {}],
      [id.draw, 'draw', 'Sketch', 'draw', {}],
      [id.otherFile, 'file', 'private.pdf', 'files', {}],
      [id.otherDraw, 'draw', 'Other sketch', 'draw', {}],
      [id.page, 'page', 'A page', 'pages', {}],
    ];
    for (const [nid, type, title, path, data] of rows) {
      await m.db.execute(sqlTag`
        insert into nodes (id, owner_id, type, title, path, data) values
          (${nid}, ${owner}, ${type}, ${title}, ${path}::ltree, ${JSON.stringify(data)}::jsonb)`);
    }
    const svg = '<svg xmlns="http://www.w3.org/2000/svg"></svg>';
    for (const d of [id.draw, id.otherDraw]) {
      await m.db.execute(sqlTag`
        insert into draws (node_id, scene, file_refs, scene_svg) values
          (${d}, '{"elements":[]}'::jsonb, '{}'::jsonb, ${svg})`);
    }
    // The links serve every item of the fixture, the ones the note does not
    // name too, so a refusal below is the reference rule, not the list.
    const served = JSON.stringify({ served: everything() });
    await m.db.execute(sqlTag`
      insert into shares (owner_id, node_id, node_type, token, settings, expires_at, revoked_at) values
        (${owner}, ${id.note}, 'note', ${token.live}, ${served}::jsonb, null, null),
        (${owner}, ${id.note2}, 'note', ${token.expired}, ${served}::jsonb, now() - interval '1 hour', null),
        (${owner}, ${id.note}, 'note', ${token.revoked}, ${served}::jsonb, null, now())`);
  }, 60_000);

  afterAll(async () => {
    await m.db.execute(sqlTag`delete from shares where owner_id = ${owner}`);
    await m.db.execute(sqlTag`delete from nodes where owner_id = ${owner}`);
    await m.db.execute(sqlTag`delete from spaces where id = ${owner} or login_id = ${owner}`);
    await m.db.execute(sqlTag`delete from auth.users where id = ${owner}`);
    await m.closeDb();
  });

  const getAsset = async (t: string, fileId: string) =>
    (
      await assetRoute.GET(new Request(`http://brain.test/s/${t}/a/${fileId}`), {
        params: Promise.resolve({ token: t, fileId }),
      })
    ).status;
  const getDraw = async (t: string, drawId: string) =>
    (
      await drawRoute.GET(new Request(`http://brain.test/s/${t}/draw/${drawId}`), {
        params: Promise.resolve({ token: t, drawId }),
      })
    ).status;

  it('serves the pictures, file links and drawings the note names', async () => {
    expect(await shares.isAssetAllowed(noteLink(), id.pic)).toBe(true);
    expect(await shares.isAssetAllowed(noteLink(), id.doc)).toBe(true);
    expect(await shares.isAssetAllowed(noteLink(), id.titled)).toBe(true);
    expect(await shares.isAssetAllowed(noteLink(), id.titledLink)).toBe(true);
    expect(await shares.isEmbeddedDrawAllowed(noteLink(), id.draw)).toBe(true);
    expect(await getAsset(token.live, id.titled)).toBe(200);
    expect(await getAsset(token.live, id.pic)).toBe(200);
    expect(await getAsset(token.live, id.doc)).toBe(200);
    expect(await getDraw(token.live, id.draw)).toBe(200);
  });

  it('refuses an id the note only quotes in code, even on the list', async () => {
    expect(await shares.isAssetAllowed(noteLink(), id.fenced)).toBe(false);
    expect(await shares.isAssetAllowed(noteLink(), id.inlineCode)).toBe(false);
    expect(await getAsset(token.live, id.fenced)).toBe(404);
    expect(await getAsset(token.live, id.inlineCode)).toBe(404);
  });

  it('refuses a file the note only links inside a sentence, even on the list', async () => {
    // A link, not an embed: a page share refuses the same.
    expect(await shares.isAssetAllowed(noteLink(), id.inlineDoc)).toBe(false);
    expect(await getAsset(token.live, id.inlineDoc)).toBe(404);
  });

  it('refuses a file or drawing the note does not name', async () => {
    expect(await shares.isAssetAllowed(noteLink(), id.otherFile)).toBe(false);
    expect(await shares.isEmbeddedDrawAllowed(noteLink(), id.otherDraw)).toBe(false);
    expect(await getAsset(token.live, id.otherFile)).toBe(404);
    expect(await getDraw(token.live, id.otherDraw)).toBe(404);
  });

  it('refuses what the note names under the wrong scheme or as a non-file', async () => {
    // A drawing named by draw: is not a file; a page named by page: is neither.
    expect(await shares.isAssetAllowed(noteLink(), id.draw)).toBe(false);
    expect(await shares.isAssetAllowed(noteLink(), id.page)).toBe(false);
    expect(await shares.isEmbeddedDrawAllowed(noteLink(), id.pic)).toBe(false);
    // Not a uuid: refused before any query.
    expect(await shares.isAssetAllowed(noteLink(), 'not-a-uuid')).toBe(false);
    expect(await getAsset(token.live, '../../etc')).toBe(404);
  });

  it('an expired or revoked share refuses everything', async () => {
    // The two links exist, so the refusals below are expiry and revocation,
    // not an unknown token.
    const rows = (await m.db.execute(sqlTag`
      select token from shares where token in (${token.revoked}, ${token.expired})`)) as unknown as {
      token: string;
    }[];
    expect(rows.map((r) => r.token).sort()).toEqual([token.expired, token.revoked].sort());
    for (const t of [token.revoked, token.expired, `${tag}-unknown`]) {
      expect(await getAsset(t, id.pic)).toBe(404);
      expect(await getAsset(t, id.doc)).toBe(404);
      expect(await getDraw(t, id.draw)).toBe(404);
    }
  });

  it('does not serve an embed taken off the served list', async () => {
    const without = everything().filter((x) => x !== id.pic && x !== id.draw);
    expect(await shares.isAssetAllowed(noteLink(without), id.pic)).toBe(false);
    expect(await shares.isEmbeddedDrawAllowed(noteLink(without), id.draw)).toBe(false);
    await m.db.execute(sqlTag`
      update shares set settings = ${JSON.stringify({ served: without })}::jsonb
      where token = ${token.live}`);
    expect(await getAsset(token.live, id.pic)).toBe(404);
    expect(await getDraw(token.live, id.draw)).toBe(404);
    expect(await getAsset(token.live, id.doc)).toBe(200);
    await m.db.execute(sqlTag`
      update shares set settings = ${JSON.stringify({ served: everything() })}::jsonb
      where token = ${token.live}`);
  });

  it('drops a file the moment an edit takes its reference out of the note', async () => {
    expect(await shares.isAssetAllowed(noteLink(), id.doc)).toBe(true);
    await m.db.execute(sqlTag`
      update nodes set data = ${JSON.stringify({ content: 'nothing here' })}::jsonb
      where id = ${id.note}`);
    expect(await shares.isAssetAllowed(noteLink(), id.doc)).toBe(false);
    expect(await getAsset(token.live, id.doc)).toBe(404);
  });

  it('a share of another kind does not serve note embeds', async () => {
    const pageLink = { ...noteLink(), nodeId: id.page, nodeType: 'page' } as Share;
    // The page row has no doc: nothing it names, so nothing is served.
    expect(await shares.isEmbeddedDrawAllowed(pageLink, id.otherDraw)).toBe(false);
    const taskLink = { ...noteLink(), nodeType: 'task' } as Share;
    expect(await shares.isAssetAllowed(taskLink, id.otherFile)).toBe(false);
    expect(await shares.isEmbeddedDrawAllowed(taskLink, id.otherDraw)).toBe(false);
  });
});
