/**
 * Held and accepted items as their author reads them (client logins C5
 * audit: L1, L5, L6, L7, I6), on a real, migrated Postgres:
 *
 *  - an item a reviewer TOOK OVER, edited and accepted reaches its author
 *    redacted at the author's level: a client reads "Private item" for a
 *    team mention and a team link, and no child page card of an admin page;
 *    a member reads "Private item" for an admin mention. What the author may
 *    read stays: a client-level item (by today's title), their own image;
 *  - My requests search matches the accepted title, not an admin's later
 *    rename;
 *  - a taken item lists under the title it had when it was taken, never the
 *    admin's working title, and a search matches that one;
 *  - an accepted file keeps the name its author gave it, not the name Accept
 *    made unique in the brain folder;
 *  - a deleted client's item keeps the Client badge and Accept's client
 *    rules (the confirmation at client level), from the stamped role.
 *
 * Every hidden fixture is in the accepted snapshot as written (checked
 * first), so only the redaction under test hides it.
 *   MANTLE_TEST_DATABASE_URL=postgres://… pnpm vitest run packages/content/src/client-accepted-c5a.viewer.db.test.ts
 */
import { randomUUID } from 'node:crypto';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { Readable } from 'node:stream';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

const URL = process.env.MANTLE_TEST_DATABASE_URL;
const PRIVATE = 'Private item';

describe.skipIf(!URL)('held and accepted items, as their author reads them', () => {
  type Db = typeof import('@mantle/db');
  let m: Db;
  let sp: typeof import('./member-space');
  let sf: typeof import('./member-space-files');
  let rv: typeof import('./member-review');
  let ma: typeof import('./member-accepted');
  let fp: typeof import('@mantle/files');
  let sqlTag: typeof import('drizzle-orm').sql;
  const tag = `c5aleak-${randomUUID().slice(0, 8)}`;
  const anchor = randomUUID();
  const adminA = randomUUID();
  const member = randomUUID();
  const client = randomUUID();
  const gone = randomUUID(); // a client login deleted mid-review
  const logins = [adminA, member, client, gone];
  const spaceOf: Record<string, string> = {};
  const root = mkdtempSync(path.join(tmpdir(), 'mantle-c5aleak-'));

  const as = <T>(login: string, fn: () => Promise<T>) =>
    m.withSpace({ spaceId: spaceOf[login]!, loginId: login }, fn);
  const exec = async <T>(q: ReturnType<typeof sqlTag>) =>
    (await m.systemDb.execute(q)) as unknown as T[];
  const actorA = () => ({ loginId: adminA, spaceId: spaceOf[adminA]! });
  const writer = () => ({ adminOfBrain: anchor });
  const para = (...content: unknown[]) => ({ type: 'paragraph', content });
  const text = (t: string, marks?: unknown[]) => ({
    type: 'text',
    text: t,
    ...(marks ? { marks } : {}),
  });
  const mention = (id: string, label: string) => ({
    type: 'mention',
    attrs: { id, label, ref: 'node', kind: 'note' },
  });
  const upload = async (login: string, filename: string, body = 'BYTES') =>
    as(login, async () =>
      sf.createMineFile(spaceOf[login]!, {
        filename,
        spooled: await fp.spoolUpload(Readable.from([Buffer.from(body)]), {
          maxBytes: sf.SPACE_FILE_MAX_BYTES,
          dir: fp.spaceSpoolDir(),
        }),
      }),
    );
  const create = async (login: string, type: 'page' | 'note', title: string, content?: string) =>
    (
      await as(login, () =>
        sp.createMineItem(spaceOf[login]!, { type, title, ...(content ? { content } : {}) }),
      )
    ).id;
  const submit = (login: string, id: string) => as(login, () => sp.submitItem(spaceOf[login]!, id));
  /** A brain item at `level`, made through the content functions. */
  const brainItem = async (type: 'page' | 'note', title: string, level: string) => {
    const id =
      type === 'page'
        ? (await (await import('./pages/tree')).createPage(anchor, { title })).id
        : (await (await import('./notes')).createNote(anchor, { title, content: 'x' })).id;
    await m.systemDb.execute(sqlTag`update nodes set audience = ${level} where id = ${id}`);
    return id;
  };
  const snapshotText = async (id: string) =>
    JSON.stringify(
      (
        await exec<{ doc: unknown; content: string | null }>(
          sqlTag`select doc, content from accepted_snapshots where node_id = ${id}`,
        )
      )[0] ?? null,
    );

  beforeAll(async () => {
    process.env.DATABASE_URL = URL;
    process.env.MANTLE_MASTER_KEY ??= 'mantle-viewer-test-key';
    process.env.MANTLE_SPACES_ROOT = path.join(root, 'spaces');
    process.env.TABLE_DB_DIR = path.join(root, 'table-dbs');
    process.env.MANTLE_FILES_ROOT = path.join(root, 'files');
    m = await import('@mantle/db');
    sp = await import('./member-space');
    sf = await import('./member-space-files');
    rv = await import('./member-review');
    ma = await import('./member-accepted');
    fp = await import('@mantle/files');
    sqlTag = (await import('drizzle-orm')).sql;
    const admin = (m.systemDb as unknown as { $client: Parameters<Db['ensureViewerRoles']>[0] })
      .$client;
    await m.ensureViewerRoles(admin, process.env.MANTLE_MASTER_KEY);
    await m.systemDb.execute(sqlTag`
      insert into auth.users (id, email, password_hash, role, display_name) values
        (${anchor}, ${`${tag}-anchor@example.invalid`}, 'x', 'admin', null),
        (${adminA}, ${`${tag}-a@example.invalid`}, 'x', 'admin', 'Staff Person'),
        (${member}, ${`${tag}-m@example.invalid`}, 'x', 'member', 'Mia Member'),
        (${client}, ${`${tag}-c@example.invalid`}, 'x', 'client', 'Cara Client'),
        (${gone}, ${`${tag}-g@example.invalid`}, 'x', 'client', 'Gone Client')`);
    await m.systemDb.execute(sqlTag`
      insert into spaces (id, kind, login_id) values (${anchor}, 'brain', ${anchor})`);
    const rows = await exec<{ id: string; login_id: string }>(sqlTag`
      select id, login_id from spaces where kind = 'personal'
        and login_id = any(${`{${logins.join(',')}}`}::uuid[])`);
    for (const r of rows) spaceOf[r.login_id] = r.id;
  }, 60_000);

  afterAll(async () => {
    if (!m) return;
    const spaces = Object.values(spaceOf);
    for (const s of [...spaces, anchor]) {
      await m.systemDb.execute(sqlTag`delete from nodes where owner_id = ${s}`);
    }
    for (const s of spaces) await m.systemDb.execute(sqlTag`delete from spaces where id = ${s}`);
    await m.systemDb.execute(sqlTag`delete from spaces where id = ${anchor}`);
    await m.systemDb.execute(
      sqlTag`delete from auth.users where id = any(${`{${[...logins, anchor].join(',')}}`}::uuid[])`,
    );
    await m.closeDb();
    rmSync(root, { recursive: true, force: true });
  });

  // Brain items the taken items name.
  let teamNote: string; // a team item: a client may not read it
  let adminNote: string; // an admin item: a member may not read it
  let adminPage: string; // an admin page, embedded as a child page
  let clientNote: string; // a client item: a client reads it

  it('brain items at each level', async () => {
    teamNote = await brainItem('note', `${tag} TEAMSECRET note`, 'team');
    adminNote = await brainItem('note', `${tag} ADMINSECRET note`, 'admin');
    adminPage = await brainItem('page', `${tag} ADMINSECRET child`, 'admin');
    clientNote = await brainItem('note', `${tag} CLIENTOK old`, 'client');
  });

  // ── A client's page, taken over, edited, accepted ───────────────────────

  let pageId: string;
  let imageId: string;

  it('a taken item lists under the title it had when taken, never the admin’s (L6)', async () => {
    const C = spaceOf[client]!;
    const A = spaceOf[adminA]!;
    imageId = await upload(client, 'photo.png', 'CLIENTPNG');
    pageId = await create(client, 'page', `${tag} Quote request`);
    const img = { type: 'image', attrs: { nodeId: imageId } };
    expect(
      (
        await as(client, () =>
          sp.saveMinePage(C, pageId, { type: 'doc', content: [img, para(text('client words'))] }),
        )
      ).ok,
    ).toBe(true);
    await submit(client, pageId);
    await rv.takeOverReviewItem(pageId, actorA());
    // The admin renames it while it is theirs.
    await as(adminA, () =>
      sp.updateMineItem(A, pageId, { title: `${tag} ADMINWORK reject over limit` }, writer()),
    );
    const [live] = await exec<{ title: string }>(
      sqlTag`select title from nodes where id = ${pageId}`,
    );
    expect(live?.title).toBe(`${tag} ADMINWORK reject over limit`);

    const held = await sp.listWithAdmin(client, {});
    expect(held.map((r) => [r.id, r.title, r.reviewState])).toEqual(
      expect.arrayContaining([
        [pageId, `${tag} Quote request`, 'with-admin'],
        [imageId, 'photo.png', 'with-admin'],
      ]),
    );
    expect(held.map((r) => r.title).join(' ')).not.toContain('ADMINWORK');
    // A search matches the title it had, never the admin's.
    expect((await sp.listWithAdmin(client, { q: 'ADMINWORK' })).map((r) => r.id)).toEqual([]);
    expect((await sp.listWithAdmin(client, { q: 'Quote request' })).map((r) => r.id)).toEqual([
      pageId,
    ]);
  });

  it('accepted after the admin named team and admin items: the client reads them redacted (L1)', async () => {
    const A = spaceOf[adminA]!;
    const doc = {
      type: 'doc',
      content: [
        { type: 'image', attrs: { nodeId: imageId } },
        para(
          text('client words '),
          mention(teamNote, 'TEAMSECRET note'),
          text(' and '),
          mention(clientNote, 'CLIENTOK old'),
        ),
        para(text('TEAMLINK words', [{ type: 'link', attrs: { href: `/n/${teamNote}` } }])),
        { type: 'childPage', attrs: { pageId: adminPage, title: 'ADMINSECRET child' } },
      ],
    };
    expect((await as(adminA, () => sp.saveMinePage(A, pageId, doc, writer()))).ok).toBe(true);
    const res = await rv.acceptOwnItem(anchor, actorA(), pageId);
    expect(res.audience).toBe('team');
    // The fixture: the snapshot holds every reference as the admin wrote it.
    const raw = await snapshotText(pageId);
    for (const s of ['TEAMSECRET', 'ADMINSECRET', 'TEAMLINK', teamNote, adminPage]) {
      expect(raw).toContain(s);
    }
    // The client item is renamed since: its chip carries today's title.
    await m.systemDb.execute(
      sqlTag`update nodes set title = ${`${tag} CLIENTOK now`} where id = ${clientNote}`,
    );

    const item = await ma.getClientAcceptedItem(anchor, client, pageId);
    expect(item?.type).toBe('page');
    const read = JSON.stringify(item);
    for (const s of ['TEAMSECRET', 'ADMINSECRET', 'TEAMLINK', teamNote, adminPage]) {
      expect(read).not.toContain(s);
    }
    expect(read).toContain(PRIVATE);
    expect(read).not.toContain('childPage');
    // What the client may read stays: the client item, its own image.
    expect(read).toContain(`${tag} CLIENTOK now`);
    expect(read).toContain(clientNote);
    expect(read).toContain(imageId);
    // The row carries the accepted title, and the taken title is cleared.
    expect(item?.title).toBe(`${tag} ADMINWORK reject over limit`);
    const [row] = await exec<{ taken_title: string | null }>(
      sqlTag`select taken_title from space_items where node_id = ${pageId}`,
    );
    expect(row?.taken_title).toBeNull();
  });

  it('My requests search matches the accepted title, not a later rename (L5)', async () => {
    await m.systemDb.execute(
      sqlTag`update nodes set title = ${`${tag} LIVE dispute send to legal`} where id = ${pageId}`,
    );
    const kinds = ['page', 'note', 'file'] as const;
    const miss = await ma.listAccepted(anchor, client, { kinds, q: 'dispute' });
    expect(miss).toEqual({ items: [], total: 0 });
    const hit = await ma.listAccepted(anchor, client, { kinds, q: 'ADMINWORK' });
    expect(hit.items.map((r) => [r.id, r.title])).toEqual([
      [pageId, `${tag} ADMINWORK reject over limit`],
    ]);
    expect(hit.total).toBe(1);
  });

  it('a client’s note taken over and accepted: a team link reads "Private item" (L1)', async () => {
    const A = spaceOf[adminA]!;
    const noteId = await create(client, 'note', `${tag} note`, 'hello');
    await submit(client, noteId);
    await rv.takeOverReviewItem(noteId, actorA());
    const content = `see [TEAMLINK](/n/${teamNote}) and [the shared one](/n/${clientNote})`;
    await as(adminA, () => sp.updateMineItem(A, noteId, { content }, writer()));
    await rv.acceptOwnItem(anchor, actorA(), noteId);
    expect(await snapshotText(noteId)).toContain(teamNote);

    const item = await ma.getClientAcceptedItem(anchor, client, noteId);
    expect(item?.type).toBe('note');
    const got = item?.type === 'note' ? item.content : '';
    expect(got).not.toContain('TEAMLINK');
    expect(got).not.toContain(teamNote);
    expect(got).toContain(PRIVATE);
    expect(got).toContain(`/n/${clientNote}`);
  });

  // ── A member's page, taken over, accepted: redacted at team ─────────────

  it('a member reads an admin mention in their taken, accepted page as "Private item" (L1)', async () => {
    const M = spaceOf[member]!;
    const A = spaceOf[adminA]!;
    const id = await create(member, 'page', `${tag} member page`);
    expect(
      (
        await as(member, () =>
          sp.saveMinePage(M, id, { type: 'doc', content: [para(text('member words'))] }),
        )
      ).ok,
    ).toBe(true);
    await submit(member, id);
    await rv.takeOverReviewItem(id, actorA());
    const doc = {
      type: 'doc',
      content: [
        para(
          mention(adminNote, 'ADMINSECRET note'),
          text(' and '),
          mention(teamNote, 'the team note'),
        ),
      ],
    };
    expect((await as(adminA, () => sp.saveMinePage(A, id, doc, writer()))).ok).toBe(true);
    const res = await rv.acceptOwnItem(anchor, actorA(), id);
    expect(res.audience).toBe('admin');
    expect(await snapshotText(id)).toContain('ADMINSECRET');

    const item = await ma.getAcceptedItem(anchor, member, id);
    const read = JSON.stringify(item);
    expect(read).not.toContain('ADMINSECRET');
    expect(read).not.toContain(adminNote);
    expect(read).toContain(PRIVATE);
    // A team item the member reads keeps its chip, by today's title.
    expect(read).toContain(teamNote);
    expect(read).toContain(`${tag} TEAMSECRET note`);
  });

  // ── An accepted file keeps its author's name (L7) ───────────────────────

  it('an accepted file keeps the name its author gave it, not the name Accept made unique', async () => {
    // The brain folder already holds a quote.txt: Accept files this one
    // under another name.
    await m.systemDb.execute(sqlTag`
      insert into nodes (owner_id, type, title, slug, path, data) values
        (${anchor}, 'file', 'quote.txt', 'quote.txt', 'files',
         ${JSON.stringify({ filename: 'quote.txt' })}::jsonb)`);
    const fileId = await upload(client, 'quote.txt', 'QUOTEBYTES');
    await submit(client, fileId);
    await rv.acceptReviewItem(anchor, fileId, { loginId: adminA });
    const [live] = await exec<{ filename: string }>(
      sqlTag`select data->>'filename' as filename from nodes where id = ${fileId}`,
    );
    expect(live?.filename).not.toBe('quote.txt');
    expect(await ma.acceptedFileMeta(anchor, client, fileId)).toEqual({
      filename: 'quote.txt',
      mimeType: expect.any(String),
    });
    expect(await ma.getClientAcceptedItem(anchor, client, fileId)).toMatchObject({
      type: 'file',
      filename: 'quote.txt',
    });
    // Someone else's accepted file answers nothing.
    expect(await ma.acceptedFileMeta(anchor, member, fileId)).toBeNull();
  });

  // ── A deleted client's item is still a client's (I6) ────────────────────

  it('a deleted client’s item keeps the Client badge and needs the confirmation at client', async () => {
    const queued = await create(gone, 'page', `${tag} gone queued`);
    const taken = await create(gone, 'page', `${tag} gone taken`);
    await submit(gone, queued);
    await submit(gone, taken);
    await rv.takeOverReviewItem(taken, actorA());
    await m.systemDb.execute(sqlTag`delete from auth.users where id = ${gone}`);

    const row = (await rv.listReviewQueue()).items.find((i) => i.id === queued);
    expect(row?.author).toMatchObject({ loginId: null, role: 'client' });
    // Accept at client asks for the confirmation, as for a live client...
    await expect(
      rv.acceptReviewItem(anchor, queued, { loginId: adminA }, { audience: 'client' }),
    ).rejects.toMatchObject({ reason: 'confirm-level' });
    await expect(
      rv.acceptOwnItem(anchor, actorA(), taken, { audience: 'client' }),
    ).rejects.toMatchObject({ reason: 'confirm-level' });
    // ...and the default is team.
    expect((await rv.acceptReviewItem(anchor, queued, { loginId: adminA })).audience).toBe('team');
    expect((await rv.acceptOwnItem(anchor, actorA(), taken)).audience).toBe('team');
    // The accepted badge still says a client wrote it.
    const authors = await ma.acceptedAuthors(anchor, [queued, taken]);
    expect(authors.get(queued)).toMatchObject({ role: 'client', name: 'Removed client' });
    expect(authors.get(taken)).toMatchObject({ role: 'client', name: 'Removed client' });
  });
});
