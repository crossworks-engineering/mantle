/**
 * Client requests for members (client logins C5, decision 5 B), on a real
 * migrated Postgres: a member reads what a CLIENT submitted (a page, a note,
 * a file, and a file in the page's bundle), read only, on the team role with
 * the human flag on, and nothing else of the client's space.
 *
 * The control items are the leak test: the same client, the same space, the
 * same kind of saved page, only the review state differs (draft, returned,
 * accepted). Nothing but the submitted rule can keep them out. A member's own
 * submitted item and a brain item, both readable in the same scope for other
 * reasons, are never a client request. A client's item never shows in Team
 * drafts, even submitted and shared with the team.
 *   MANTLE_TEST_DATABASE_URL=postgres://… pnpm vitest run packages/content/src/client-requests.viewer.db.test.ts
 */
import { randomUUID } from 'node:crypto';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { Readable } from 'node:stream';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

const URL = process.env.MANTLE_TEST_DATABASE_URL;

describe.skipIf(!URL)('client requests: members read clients’ submitted items only', () => {
  type Db = typeof import('@mantle/db');
  let m: Db;
  let sp: typeof import('./member-space');
  let sf: typeof import('./member-space-files');
  let cr: typeof import('./client-requests');
  let fp: typeof import('@mantle/files');
  let sqlTag: typeof import('drizzle-orm').sql;
  const tag = `creq-${randomUUID().slice(0, 8)}`;
  let brain = '';
  const client = randomUUID();
  const reader = randomUUID();
  const author = randomUUID();
  /** A member who shared and submitted, then became a client login. */
  const turned = randomUUID();
  const logins = [client, reader, author, turned];
  const spaceOf: Record<string, string> = {};
  const brainTeam = randomUUID();
  const root = mkdtempSync(path.join(tmpdir(), 'mantle-creq-'));
  const ids = {
    page: '',
    note: '',
    file: '',
    bundleFile: '',
    draft: '',
    returned: '',
    accepted: '',
    draftFile: '',
    sharedSubmitted: '',
    sharedDraft: '',
    memberSubmitted: '',
  };

  const as = <T>(login: string, fn: () => Promise<T>) =>
    m.withSpace({ spaceId: spaceOf[login]!, loginId: login }, fn);
  const say = (text: string, extra: unknown[] = []) => ({
    type: 'doc',
    content: [...extra, { type: 'paragraph', content: [{ type: 'text', text }] }],
  });
  const spool = (text: string) =>
    fp.spoolUpload(Readable.from([Buffer.from(text)]), {
      maxBytes: 1_000_000,
      dir: fp.spaceSpoolDir(),
    });
  /** A saved page in `login`'s space. */
  const page = async (login: string, title: string, extra: unknown[] = []) => {
    const S = spaceOf[login]!;
    const id = (await as(login, () => sp.createMineItem(S, { type: 'page', title }))).id;
    const res = await as(login, () => sp.saveMinePage(S, id, say('the same text', extra)));
    expect(res.ok, `save ${title}`).toBe(true);
    return id;
  };
  const file = (login: string, name: string, text: string) =>
    as(login, async () =>
      sf.createMineFile(spaceOf[login]!, { filename: name, spooled: await spool(text) }),
    );
  const submit = (login: string, id: string) => as(login, () => sp.submitItem(spaceOf[login]!, id));
  const setState = (id: string, state: string, sharing = 'private') =>
    m.systemDb.execute(
      sqlTag`update space_items set review_state = ${state}, sharing = ${sharing} where node_id = ${id}`,
    );
  const readStream = async (s: NodeJS.ReadableStream) => {
    const chunks: Buffer[] = [];
    for await (const c of s) chunks.push(c as Buffer);
    return Buffer.concat(chunks).toString('utf8');
  };
  const listed = async (opts: { kind?: string } = {}) =>
    m.withHumanViewer('team', () => cr.listClientRequests({ q: tag, ...opts }));

  beforeAll(async () => {
    process.env.DATABASE_URL = URL;
    process.env.MANTLE_MASTER_KEY ??= 'mantle-viewer-test-key';
    process.env.MANTLE_SPACES_ROOT = path.join(root, 'spaces');
    process.env.TABLE_DB_DIR = path.join(root, 'table-dbs');
    process.env.MANTLE_FILES_ROOT = path.join(root, 'files');
    m = await import('@mantle/db');
    sp = await import('./member-space');
    sf = await import('./member-space-files');
    cr = await import('./client-requests');
    fp = await import('@mantle/files');
    sqlTag = (await import('drizzle-orm')).sql;
    const { ensureTestAnchor } = await import('@mantle/db/test-support');
    const admin = (m.systemDb as unknown as { $client: Parameters<Db['ensureViewerRoles']>[0] })
      .$client;
    await m.ensureViewerRoles(admin, process.env.MANTLE_MASTER_KEY);
    brain = await ensureTestAnchor(admin);
    await m.systemDb.execute(sqlTag`
      insert into auth.users (id, email, password_hash, role, display_name) values
        (${client}, ${`${tag}-c@example.invalid`}, 'x', 'client', 'Cleo Client'),
        (${reader}, ${`${tag}-r@example.invalid`}, 'x', 'member', null),
        (${author}, ${`${tag}-a@example.invalid`}, 'x', 'member', null),
        (${turned}, ${`${tag}-t@example.invalid`}, 'x', 'member', null)`);
    const rows = (await m.systemDb.execute(sqlTag`
      select id, login_id from spaces where kind = 'personal'
        and login_id in (${client}, ${reader}, ${author}, ${turned})`)) as unknown as {
      id: string;
      login_id: string;
    }[];
    for (const r of rows) spaceOf[r.login_id] = r.id;
    await m.systemDb.execute(sqlTag`
      insert into nodes (id, owner_id, type, title, path, audience) values
        (${brainTeam}, ${brain}, 'note', ${`${tag} brain team note`}, 'notes', 'team')`);

    // What the client submits: a page that shows a file (its bundle), a
    // note and a file, through the content functions in the client's space.
    ids.bundleFile = await file(client, `${tag} plan.txt`, 'bundle bytes');
    ids.page = await page(client, `${tag} request page`, [
      { type: 'image', attrs: { nodeId: ids.bundleFile, src: 'x' } },
    ]);
    ids.note = (
      await as(client, () =>
        sp.createMineItem(spaceOf[client]!, {
          type: 'note',
          title: `${tag} request note`,
          content: 'note text',
        }),
      )
    ).id;
    ids.file = await file(client, `${tag} brief.txt`, 'file bytes');
    for (const id of [ids.page, ids.note, ids.file]) await submit(client, id);

    // The controls: the same client, space and saved text; only the state
    // differs (each was submitted, then set by hand).
    ids.draft = await page(client, `${tag} control draft`);
    ids.returned = await page(client, `${tag} control returned`);
    ids.accepted = await page(client, `${tag} control accepted`);
    ids.draftFile = await file(client, `${tag} control.txt`, 'draft bytes');
    for (const id of [ids.draft, ids.returned, ids.accepted, ids.draftFile]) {
      await submit(client, id);
    }
    await setState(ids.draft, 'draft');
    await setState(ids.returned, 'returned');
    await setState(ids.accepted, 'accepted');
    await setState(ids.draftFile, 'draft');

    // Items with a 'team' sharing row in a CLIENT's space. No client can
    // share (a trigger refuses it, 0189), but a member's login can become a
    // client's with its team-shared items in place: one submitted, one a
    // draft. Neither is a team draft any more.
    ids.sharedSubmitted = await page(turned, `${tag} turned shared submitted`);
    await as(turned, () => sp.setSharing(spaceOf[turned]!, ids.sharedSubmitted, 'team'));
    await submit(turned, ids.sharedSubmitted);
    ids.sharedDraft = await page(turned, `${tag} turned shared draft`);
    await as(turned, () => sp.setSharing(spaceOf[turned]!, ids.sharedDraft, 'team'));
    await m.systemDb.execute(sqlTag`update auth.users set role = 'client' where id = ${turned}`);

    // A member's submitted item, shared with the team: a team draft, never
    // a client request.
    ids.memberSubmitted = await page(author, `${tag} member submitted`);
    await as(author, () => sp.setSharing(spaceOf[author]!, ids.memberSubmitted, 'team'));
    await submit(author, ids.memberSubmitted);
  }, 120_000);

  afterAll(async () => {
    await m.systemDb.execute(sqlTag`delete from nodes where id = ${brainTeam}`);
    for (const l of logins) {
      await m.systemDb.execute(sqlTag`delete from nodes where owner_id in
        (select id from spaces where login_id = ${l})`);
      await m.systemDb.execute(sqlTag`delete from spaces where login_id = ${l}`);
      await m.systemDb.execute(sqlTag`delete from auth.users where id = ${l}`);
    }
    await m.closeDb();
    rmSync(root, { recursive: true, force: true });
  });

  it('lists the submitted roots only, newest first, each by the client', async () => {
    const res = await listed();
    const got = res.items.map((r) => r.row.id);
    // Exactly the three roots: not the bundle file, not a control, not the
    // member's submitted item.
    expect([...got].sort()).toEqual([ids.page, ids.note, ids.file, ids.sharedSubmitted].sort());
    expect(res.total).toBe(4);
    for (const r of res.items) {
      // The client's display name, else "A client" (never an email).
      const name = r.row.id === ids.sharedSubmitted ? 'A client' : 'Cleo Client';
      expect(r.author).toEqual({ name, acceptedAt: null, role: 'client' });
      expect(r.row.reviewState).toBe('submitted');
    }
    const times = res.items.map((r) => r.row.updatedAt);
    expect(times).toEqual([...times].sort().reverse());
    // The kind filter; a kind a client never writes lists nothing.
    expect((await listed({ kind: 'note' })).items.map((r) => r.row.id)).toEqual([ids.note]);
    expect(await listed({ kind: 'table' })).toEqual({ items: [], total: 0 });
  });

  it('reads a submitted page, note and file, and a file in the page’s bundle', async () => {
    const read = (id: string) => m.withHumanViewer('team', () => cr.getClientRequestItem(id));
    const pageItem = await read(ids.page);
    expect(pageItem?.body.type).toBe('page');
    if (pageItem?.body.type === 'page') {
      expect(JSON.stringify(pageItem.body.page.doc)).toContain('the same text');
      // Published only: a member never reads the client's working copy.
      expect(pageItem.body.page.draft).toBeNull();
    }
    expect(pageItem?.author.name).toBe('Cleo Client');
    const noteItem = await read(ids.note);
    expect(noteItem?.body.type === 'note' && noteItem.body.note.content).toBe('note text');
    const fileItem = await read(ids.file);
    expect(fileItem?.body.type === 'file' && fileItem.body.file.filename).toContain('brief');
    const inBundle = await read(ids.bundleFile);
    expect(inBundle?.row.id).toBe(ids.bundleFile);

    for (const [id, text] of [
      [ids.file, 'file bytes'],
      [ids.bundleFile, 'bundle bytes'],
    ] as const) {
      const opened = await m.withHumanViewer('team', () => cr.openClientRequestFile(id));
      expect(opened, id).not.toBeNull();
      expect(await readStream(opened!.stream)).toBe(text);
    }
  });

  it('never reads the same client’s draft, returned or accepted item', async () => {
    for (const id of [ids.draft, ids.returned, ids.accepted, ids.draftFile, ids.sharedDraft]) {
      expect(await m.withHumanViewer('team', () => cr.getClientRequestItem(id)), id).toBeNull();
    }
    expect(
      await m.withHumanViewer('team', () => cr.openClientRequestFile(ids.draftFile)),
    ).toBeNull();
    // Row security itself, not only the functions: the team role sees none
    // of these nodes, and none of their state rows.
    const controls = [ids.draft, ids.returned, ids.accepted, ids.draftFile];
    const seen = await m.withHumanViewer('team', async () => ({
      nodes: (await m.db.execute(
        sqlTag`select id from nodes where id in (${sqlTag.join(controls, sqlTag`, `)})`,
      )) as unknown as unknown[],
      items: (await m.db.execute(
        sqlTag`select node_id from space_items where node_id in (${sqlTag.join(controls, sqlTag`, `)})`,
      )) as unknown as unknown[],
    }));
    expect(seen).toEqual({ nodes: [], items: [] });
  });

  it('a member’s submitted item and a brain item are never a client request', async () => {
    // Both are readable in this scope for other reasons (team drafts, the
    // Library); only the client-space rule keeps them out.
    const visible = await m.withHumanViewer('team', async () =>
      (
        (await m.db.execute(
          sqlTag`select id from nodes where id in (${ids.memberSubmitted}, ${brainTeam})`,
        )) as unknown as { id: string }[]
      )
        .map((r) => r.id)
        .sort(),
    );
    expect(visible).toEqual([ids.memberSubmitted, brainTeam].sort());
    for (const id of [ids.memberSubmitted, brainTeam]) {
      expect(await m.withHumanViewer('team', () => cr.getClientRequestItem(id)), id).toBeNull();
    }
  });

  it('nothing without the human flag: an agent on the team role reads 0 rows', async () => {
    const roots = [ids.page, ids.note, ids.file, ids.bundleFile];
    const seen = await m.withViewer('team', async () => ({
      nodes: (await m.db.execute(
        sqlTag`select id from nodes where id in (${sqlTag.join(roots, sqlTag`, `)})`,
      )) as unknown as unknown[],
      items: (await m.db.execute(
        sqlTag`select node_id from space_items where node_id in (${sqlTag.join(roots, sqlTag`, `)})`,
      )) as unknown as unknown[],
    }));
    expect(seen).toEqual({ nodes: [], items: [] });
    expect(await m.withViewer('team', () => cr.listClientRequests({ q: tag }))).toEqual({
      items: [],
      total: 0,
    });
    // Outside a level scope the functions refuse (the admin pool reads all).
    await expect(cr.listClientRequests({ q: tag })).rejects.toThrow(/withHumanViewer/);
  });

  it('a client’s space never shows in Team drafts, even shared with the team', async () => {
    const drafts = await m.withTeamDrafts(() => sp.listTeamDrafts(reader, { q: tag }));
    expect(drafts.items.map((r) => r.id)).toEqual([ids.memberSubmitted]);
    expect(drafts.total).toBe(1);
    for (const id of [ids.sharedSubmitted, ids.sharedDraft]) {
      expect(await m.withTeamDrafts(() => sp.getTeamDraftItem(id)), id).toBeNull();
      expect(await m.withTeamDrafts(() => sp.getTeamDraftRow(id)), id).toBeNull();
    }
  });
});
