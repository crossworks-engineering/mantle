/**
 * Tables and files in a member's personal space, on a real migrated Postgres
 * (member logins Phase 2, the space disk root): a table's workbook lives
 * under TABLE_DB_DIR/<spaceId>/, a file's bytes under
 * MANTLE_SPACES_ROOT/<spaceId>/files/<nodeId>. Every call runs inside
 * withSpace (or withTeamDrafts), like the member routes.
 *   MANTLE_TEST_DATABASE_URL=postgres://… pnpm vitest run packages/content/src/member-space-files.viewer.db.test.ts
 */
import { randomUUID } from 'node:crypto';
import { existsSync, mkdtempSync, readFileSync, readdirSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { Readable } from 'node:stream';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

const URL = process.env.MANTLE_TEST_DATABASE_URL;

describe.skipIf(!URL)('member personal space: tables and files', () => {
  type Db = typeof import('@mantle/db');
  type Space = typeof import('./member-space');
  type Files = typeof import('./member-space-files');
  type FilesPkg = typeof import('@mantle/files');
  type TableDraft = typeof import('./tables/draft');
  let m: Db;
  let sp: Space;
  let sf: Files;
  let fp: FilesPkg;
  let td: TableDraft;
  let sqlTag: typeof import('drizzle-orm').sql;
  let unlisten: () => Promise<void>;
  const announced: string[] = [];
  const tag = `msfiles-${randomUUID().slice(0, 8)}`;
  const loginA = randomUUID();
  const loginB = randomUUID();
  let spaceA: string;
  let spaceB: string;
  const root = mkdtempSync(path.join(tmpdir(), 'mantle-spaces-'));

  const asA = <T>(fn: () => Promise<T>) => m.withSpace({ spaceId: spaceA, loginId: loginA }, fn);
  const asB = <T>(fn: () => Promise<T>) => m.withSpace({ spaceId: spaceB, loginId: loginB }, fn);

  const spool = (text: string) =>
    fp.spoolUpload(Readable.from([Buffer.from(text)]), {
      maxBytes: sf.SPACE_FILE_MAX_BYTES,
      dir: fp.spaceSpoolDir(),
    });

  beforeAll(async () => {
    process.env.DATABASE_URL = URL;
    process.env.MANTLE_MASTER_KEY ??= 'mantle-viewer-test-key';
    process.env.MANTLE_SPACES_ROOT = path.join(root, 'spaces');
    process.env.TABLE_DB_DIR = path.join(root, 'table-dbs');
    process.env.MANTLE_FILES_ROOT = path.join(root, 'files');
    m = await import('@mantle/db');
    sp = await import('./member-space');
    sf = await import('./member-space-files');
    fp = await import('@mantle/files');
    td = await import('./tables/draft');
    sqlTag = (await import('drizzle-orm')).sql;
    const admin = (m.systemDb as unknown as { $client: Parameters<Db['ensureViewerRoles']>[0] })
      .$client;
    await m.ensureViewerRoles(admin, process.env.MANTLE_MASTER_KEY);
    const sub = await admin.listen('node_ingested', (id: string) => announced.push(id));
    unlisten = () => sub.unlisten();

    await m.systemDb.execute(sqlTag`
      insert into auth.users (id, email, password_hash, role) values
        (${loginA}, ${`${tag}-a@example.invalid`}, 'x', 'member'),
        (${loginB}, ${`${tag}-b@example.invalid`}, 'x', 'member')`);
    const rows = (await m.systemDb.execute(sqlTag`
      select id, login_id from spaces where kind = 'personal'
        and login_id in (${loginA}, ${loginB})`)) as unknown as {
      id: string;
      login_id: string;
    }[];
    spaceA = rows.find((r) => r.login_id === loginA)!.id;
    spaceB = rows.find((r) => r.login_id === loginB)!.id;
  });

  afterAll(async () => {
    await unlisten();
    await m.systemDb.execute(sqlTag`delete from nodes where owner_id in (${spaceA}, ${spaceB})`);
    await m.systemDb.execute(sqlTag`delete from spaces where login_id in (${loginA}, ${loginB})`);
    await m.systemDb.execute(sqlTag`delete from auth.users where id in (${loginA}, ${loginB})`);
    await m.closeDb();
    rmSync(root, { recursive: true, force: true });
  });

  // ── Tables ────────────────────────────────────────────────────────────────

  let tableId: string;

  it('creates a table in the own space; its workbook sits under the space', async () => {
    const row = await asA(() => sp.createMineItem(spaceA, { type: 'table', title: `${tag} grid` }));
    tableId = row.id;
    expect([row.type, row.sharing, row.reviewState]).toEqual(['table', 'private', 'draft']);
    expect(existsSync(path.join(root, 'table-dbs', spaceA, `${tableId}.sqlite`))).toBe(true);
  });

  it('edits the draft with ops; Save version publishes it', async () => {
    const got = await asA(() => sp.getMineItem(spaceA, tableId));
    const table = got?.body.type === 'table' ? got.body.table : null;
    const col = table?.data.columns[0]?.id;
    expect(col).toBeTruthy();
    const applied = await asA(() =>
      td.applyTableOps(spaceA, tableId, [{ op: 'row_add', cells: { [col!]: 'saved cell' } }]),
    );
    expect(applied?.ok).toBe(true);
    await expect(asA(() => sp.submitItem(spaceA, tableId))).rejects.toMatchObject({
      reason: 'unsaved-draft',
    });
    const saved = await asA(() => sp.saveMineTable(spaceA, tableId));
    expect(saved?.body.type).toBe('table');
    // A second Save with nothing new is not an error.
    expect(await asA(() => sp.saveMineTable(spaceA, tableId))).not.toBeNull();
  });

  it('a teammate reads a shared table’s saved version, never its draft', async () => {
    await asA(() => sp.setSharing(spaceA, tableId, 'team'));
    const got = await asA(() => sp.getMineItem(spaceA, tableId));
    const col = got?.body.type === 'table' ? got.body.table.data.columns[0]!.id : '';
    await asA(() =>
      td.applyTableOps(spaceA, tableId, [{ op: 'row_add', cells: { [col]: 'draft secret' } }]),
    );
    const item = await m.withTeamDrafts(() => sp.getTeamDraftItem(tableId));
    const text = JSON.stringify(item?.body.type === 'table' ? item.body.table : null);
    expect(text).toContain('saved cell');
    expect(text).not.toContain('draft secret');
    // Another member cannot open it as their own.
    expect(await asB(() => sp.getMineItem(spaceB, tableId))).toBeNull();
  });

  it('an autosave racing Submit leaves the published workbook intact (D1)', async () => {
    const { fileStats } = await import('@mantle/tabledb');
    const row = await asA(() => sp.createMineItem(spaceA, { type: 'table', title: `${tag} race` }));
    const got = await asA(() => sp.getMineItem(spaceA, row.id));
    const col = got?.body.type === 'table' ? got.body.table.data.columns[0]!.id : '';
    await asA(() =>
      td.applyTableOps(spaceA, row.id, [
        { op: 'row_add', cells: { [col]: 'kept 1' } },
        { op: 'row_add', cells: { [col]: 'kept 2' } },
        { op: 'tab_add', tabId: 'two', name: 'Two' },
      ]),
    );
    await asA(() => sp.saveMineTable(spaceA, row.id));
    const file = path.join(root, 'table-dbs', spaceA, `${row.id}.sqlite`);
    const before = fileStats(file);
    expect(before.tabs.length).toBe(2);

    // The autosave passed its state check; Submit commits before its lock.
    const raced = await asA(async () => {
      await sp.assertEditable(spaceA, row.id);
      await m.systemDb.execute(
        sqlTag`update space_items set review_state = 'submitted' where node_id = ${row.id}`,
      );
      return td.saveTableDraft(spaceA, row.id, {
        tabs: [{ name: 'Sheet1', columns: [], rows: [] }],
      });
    });
    expect(raced).toBeNull();
    expect(fileStats(file).totalRows).toBe(before.totalRows);
    expect(fileStats(file).tabs.length).toBe(2);
    // What the route asks next: the item is frozen, a 409 not a 404.
    await expect(asA(() => sp.assertEditable(spaceA, row.id))).rejects.toMatchObject({
      reason: 'frozen',
    });
    await asA(() => sp.recallItem(spaceA, row.id));
    await asA(() => sp.deleteMineItem(spaceA, row.id));
  });

  it('deletes a draft table and its workbook files', async () => {
    const extra = await asA(() =>
      sp.createMineItem(spaceA, { type: 'table', title: `${tag} scratch grid` }),
    );
    const file = path.join(root, 'table-dbs', spaceA, `${extra.id}.sqlite`);
    expect(existsSync(file)).toBe(true);
    expect(await asA(() => sp.deleteMineItem(spaceA, extra.id))).toBe(true);
    expect(existsSync(file)).toBe(false);
  });

  // ── Files ─────────────────────────────────────────────────────────────────

  let fileId: string;

  it('uploads a file into the own space, outside the files tree', async () => {
    const spooled = await spool('hello from a member');
    fileId = await asA(() =>
      sf.createMineFile(spaceA, { filename: `../Notes ${tag}.TXT`, spooled }),
    );
    const bytesAt = path.join(root, 'spaces', spaceA, 'files', fileId);
    expect(readFileSync(bytesAt, 'utf8')).toBe('hello from a member');
    expect(existsSync(spooled.tempPath)).toBe(false);
    const got = await asA(() => sp.getMineItem(spaceA, fileId));
    expect(got?.row.type).toBe('file');
    expect(got?.body.type === 'file' && got.body.file.filename).toBe(`Notes ${tag}.TXT`);
    const node = (await m.systemDb.execute(
      sqlTag`select path::text as path, owner_id from nodes where id = ${fileId}`,
    )) as unknown as { path: string; owner_id: string }[];
    expect(node[0]).toEqual({ path: 'space_files', owner_id: spaceA });
    // Nothing landed in the brain's mirrored files tree.
    expect(existsSync(path.join(root, 'files'))).toBe(false);
  });

  it('opens the own file; another member cannot; the brain file reader is blind', async () => {
    const opened = await asA(() => sf.openMineFile(spaceA, fileId));
    expect(opened?.size).toBe('hello from a member'.length);
    opened?.stream.destroy();
    expect(await asB(() => sf.openMineFile(spaceB, fileId))).toBeNull();
    expect(await m.withTeamDrafts(() => sp.openTeamDraftFile(fileId))).toBeNull();
    // The brain's own reader, scoped to the space id, resolves no disk path.
    const byId = await fp.readFileById({ ownerId: spaceA, fileId });
    expect(byId).toBeNull();
  });

  it('shared with the team: a teammate streams it', async () => {
    await asA(() => sp.setSharing(spaceA, fileId, 'team'));
    const opened = await m.withTeamDrafts(() => sp.openTeamDraftFile(fileId));
    const chunks: Buffer[] = [];
    for await (const c of opened!.stream) chunks.push(c as Buffer);
    expect(Buffer.concat(chunks).toString('utf8')).toBe('hello from a member');
  });

  it('renames a file (metadata only) and keeps its extension', async () => {
    const got = await asA(() => sp.updateMineItem(spaceA, fileId, { title: 'Minutes' }));
    expect(got?.body.type === 'file' && got.body.file.filename).toBe('Minutes.txt');
    expect(existsSync(path.join(root, 'spaces', spaceA, 'files', fileId))).toBe(true);
  });

  it('refuses an upload over the space limits and keeps no bytes', async () => {
    const spooled = await spool('x');
    const huge = { ...spooled, size: sf.SPACE_FILE_MAX_BYTES + 1 };
    await expect(
      asA(() => sf.createMineFile(spaceA, { filename: 'big.bin', spooled: huge })),
    ).rejects.toMatchObject({ reason: 'quota' });
    expect(existsSync(spooled.tempPath)).toBe(false);
  });

  it('a submitted file is frozen; recalled, it deletes with its bytes', async () => {
    await asA(() => sp.submitItem(spaceA, fileId));
    await expect(asA(() => sp.deleteMineItem(spaceA, fileId))).rejects.toMatchObject({
      reason: 'frozen',
    });
    await asA(() => sp.recallItem(spaceA, fileId));
    expect(await asA(() => sp.deleteMineItem(spaceA, fileId))).toBe(true);
    expect(existsSync(path.join(root, 'spaces', spaceA, 'files', fileId))).toBe(false);
  });

  // ── Disk work follows the space transaction (D2, D5) ─────────────────────

  const boom = <T>(fn: () => Promise<T>) =>
    expect(
      asA(async () => {
        await fn();
        throw new Error('later failure');
      }),
    ).rejects.toThrow('later failure');

  it('a delete that rolls back keeps the bytes; one that commits removes them', async () => {
    const spooled = await spool('keep me');
    const id = await asA(() => sf.createMineFile(spaceA, { filename: `${tag} keep.txt`, spooled }));
    const bytesAt = path.join(root, 'spaces', spaceA, 'files', id);
    await boom(() => sp.deleteMineItem(spaceA, id));
    expect(await asA(() => sp.getMineItem(spaceA, id))).not.toBeNull();
    expect(readFileSync(bytesAt, 'utf8')).toBe('keep me');

    const grid = await asA(() =>
      sp.createMineItem(spaceA, { type: 'table', title: `${tag} keep` }),
    );
    const workbook = path.join(root, 'table-dbs', spaceA, `${grid.id}.sqlite`);
    await boom(() => sp.deleteMineItem(spaceA, grid.id));
    expect(await asA(() => sp.getMineItem(spaceA, grid.id))).not.toBeNull();
    expect(existsSync(workbook)).toBe(true);

    await asA(() => sp.deleteMineItem(spaceA, id));
    await asA(() => sp.deleteMineItem(spaceA, grid.id));
    expect(existsSync(bytesAt)).toBe(false);
    expect(existsSync(workbook)).toBe(false);
  });

  it('a create that rolls back leaves no orphan bytes', async () => {
    const before = new Set([
      ...readdirSync(path.join(root, 'spaces', spaceA, 'files')),
      ...readdirSync(path.join(root, 'table-dbs', spaceA)),
    ]);
    const spooled = await spool('orphan?');
    await boom(() => sf.createMineFile(spaceA, { filename: `${tag} orphan.txt`, spooled }));
    await boom(() => sp.createMineItem(spaceA, { type: 'table', title: `${tag} orphan` }));
    const after = [
      ...readdirSync(path.join(root, 'spaces', spaceA, 'files')),
      ...readdirSync(path.join(root, 'table-dbs', spaceA)),
    ].filter((f) => !before.has(f));
    expect(after).toEqual([]);
  });

  it('storage used counts table workbooks', async () => {
    expect(await asA(() => sf.spaceStorageUsed(spaceA))).toBeGreaterThan(0);
  });

  it('nothing in the space was ever announced to the extractor', async () => {
    await new Promise((r) => setTimeout(r, 300));
    expect(announced.filter((id) => [tableId, fileId].includes(id))).toEqual([]);
  });

  // ── The save-time embed rule ──────────────────────────────────────────────

  it('a saved page embeds only own items and Library items', async () => {
    let anchor = (
      (await m.systemDb.execute(sqlTag`select mantle_brain_id() as id`)) as unknown as {
        id: string | null;
      }[]
    )[0]?.id;
    let madeAnchor = false;
    if (!anchor) {
      anchor = randomUUID();
      madeAnchor = true;
      await m.systemDb.execute(sqlTag`
        insert into auth.users (id, email, password_hash, is_owner)
        values (${anchor}, ${`${tag}-owner@example.invalid`}, 'x', true)`);
    }
    const libPage = randomUUID();
    const adminPage = randomUUID();
    await m.systemDb.execute(sqlTag`
      insert into nodes (id, owner_id, type, title, path, audience) values
        (${libPage}, ${anchor}, 'page', ${`${tag} library`}, 'pages', 'team'),
        (${adminPage}, ${anchor}, 'page', ${`${tag} secret`}, 'pages', 'admin')`);
    try {
      const own = await asA(() => sp.createMineItem(spaceA, { type: 'note', title: `${tag} n` }));
      const theirs = await asB(() =>
        sp.createMineItem(spaceB, { type: 'page', title: `${tag} theirs` }),
      );
      await asB(() => sp.setSharing(spaceB, theirs.id, 'team'));
      const page = await asA(() => sp.createMineItem(spaceA, { type: 'page', title: `${tag} p` }));
      const mention = (id: string) => ({ type: 'mention', attrs: { id, ref: 'node' } });
      const docWith = (...ids: string[]) => ({
        type: 'doc',
        content: [{ type: 'paragraph', content: ids.map(mention) }],
      });

      const ok = await asA(() => sp.saveMinePage(spaceA, page.id, docWith(own.id, libPage)));
      expect(ok.ok).toBe(true);
      const ghost = randomUUID();
      await expect(
        asA(() => sp.saveMinePage(spaceA, page.id, docWith(own.id, theirs.id, adminPage, ghost))),
      ).rejects.toMatchObject({ reason: 'embed', ids: [theirs.id, adminPage, ghost] });
      // An image of someone else's file is refused the same way.
      const image = { type: 'doc', content: [{ type: 'image', attrs: { nodeId: theirs.id } }] };
      await expect(asA(() => sp.saveMinePage(spaceA, page.id, image))).rejects.toMatchObject({
        reason: 'embed',
      });

      // Every other reference type (audit S2): a child page, a link mark, a
      // member bytes URL. Library and own ids stay fine.
      const refused = async (doc: unknown, ids: string[]) =>
        expect(
          asA(() => sp.saveMinePage(spaceA, page.id, doc as Record<string, unknown>)),
        ).rejects.toMatchObject({ reason: 'embed', ids });
      const link = (href: string) => ({
        type: 'doc',
        content: [
          {
            type: 'paragraph',
            content: [{ type: 'text', text: 'x', marks: [{ type: 'link', attrs: { href } }] }],
          },
        ],
      });
      await refused(
        { type: 'doc', content: [{ type: 'childPage', attrs: { pageId: theirs.id } }] },
        [theirs.id],
      );
      await refused(link(`/n/${adminPage}`), [adminPage]);
      await refused(link(`/api/member/team-drafts/${theirs.id}/bytes`), [theirs.id]);
      expect((await asA(() => sp.saveMinePage(spaceA, page.id, link(`page:${libPage}`)))).ok).toBe(
        true,
      );
      // A malformed id is a 409, never Postgres's 22P02.
      await refused({ type: 'doc', content: [{ type: 'image', attrs: { nodeId: 'x1' } }] }, ['x1']);

      // Notes: checked on every change (a note has no draft).
      await expect(
        asA(() => sp.updateMineItem(spaceA, own.id, { content: `see [it](page:${theirs.id})` })),
      ).rejects.toMatchObject({ reason: 'embed', ids: [theirs.id] });
      await expect(
        asA(() =>
          sp.createMineItem(spaceA, {
            type: 'note',
            title: `${tag} n2`,
            content: `![x](media:${adminPage})`,
          }),
        ),
      ).rejects.toMatchObject({ reason: 'embed', ids: [adminPage] });

      // Drawings: element links, checked on Save version.
      const draw = await asA(() => sp.createMineItem(spaceA, { type: 'draw', title: `${tag} d` }));
      await expect(
        asA(() =>
          sp.saveMineDraw(spaceA, draw.id, {
            elements: [{ id: 'e1', type: 'rectangle', link: `/pages/${theirs.id}` }],
          }),
        ),
      ).rejects.toMatchObject({ reason: 'embed', ids: [theirs.id] });

      // Tables: the draft workbook's cells, checked on Save version.
      const grid = await asA(() => sp.createMineItem(spaceA, { type: 'table', title: `${tag} t` }));
      const got = await asA(() => sp.getMineItem(spaceA, grid.id));
      const col = got?.body.type === 'table' ? got.body.table.data.columns[0]!.id : '';
      await asA(() =>
        td.applyTableOps(spaceA, grid.id, [
          { op: 'row_add', cells: { [col]: `page:${theirs.id}` } },
          { op: 'row_add', cells: { [col]: 'Note: plain text' } },
        ]),
      );
      await expect(asA(() => sp.saveMineTable(spaceA, grid.id))).rejects.toMatchObject({
        reason: 'embed',
        ids: [theirs.id],
      });
    } finally {
      await m.systemDb.execute(sqlTag`delete from nodes where id in (${libPage}, ${adminPage})`);
      if (madeAnchor) {
        await m.systemDb.execute(sqlTag`delete from spaces where id = ${anchor}`);
        await m.systemDb.execute(sqlTag`delete from auth.users where id = ${anchor}`);
      }
    }
  });
  // ── Quotas (audit D3) ─────────────────────────────────────────────────────

  it('the daily cap counts uploads a member deleted (the ledger)', async () => {
    const spooled = await spool('ledger bytes');
    const id = await asA(() => sf.createMineFile(spaceA, { filename: `${tag} l.txt`, spooled }));
    await asA(() => sp.deleteMineItem(spaceA, id));
    const [row] = (await m.systemDb.execute(
      sqlTag`select coalesce(sum(bytes), 0)::bigint as n from space_uploads where space_id = ${spaceA}`,
    )) as unknown as { n: string }[];
    expect(Number(row?.n)).toBeGreaterThanOrEqual('ledger bytes'.length);
    // The member cannot erase the ledger (no update or delete rule).
    const erased = await asA(() =>
      m.db.execute(sqlTag`delete from space_uploads where space_id = ${spaceA} returning id`),
    );
    expect((erased as unknown as unknown[]).length).toBe(0);
    // A spent budget refuses the next upload, and the headroom says so first.
    const filler = randomUUID();
    await m.systemDb.execute(sqlTag`
      insert into space_uploads (id, space_id, bytes)
      values (${filler}, ${spaceA}, ${sf.SPACE_DAILY_UPLOAD_BYTES})`);
    try {
      expect(await asA(() => sf.spaceUploadHeadroom(spaceA))).toBe(0);
      const more = await spool('one more');
      await expect(
        asA(() => sf.createMineFile(spaceA, { filename: `${tag} m.txt`, spooled: more })),
      ).rejects.toMatchObject({ reason: 'quota' });
    } finally {
      await m.systemDb.execute(sqlTag`delete from space_uploads where id = ${filler}`);
    }
  });

  it('storage counts unsaved table drafts, and a full space refuses more', async () => {
    const grid = await asA(() => sp.createMineItem(spaceA, { type: 'table', title: `${tag} q` }));
    const before = await asA(() => sf.spaceStorageUsed(spaceA));
    const got = await asA(() => sp.getMineItem(spaceA, grid.id));
    const col = got?.body.type === 'table' ? got.body.table.data.columns[0]!.id : '';
    await asA(() => td.applyTableOps(spaceA, grid.id, [{ op: 'row_add', cells: { [col]: 'x' } }]));
    expect(await asA(() => sf.spaceStorageUsed(spaceA))).toBeGreaterThan(before);

    const big = randomUUID();
    await m.systemDb.execute(sqlTag`
      insert into nodes (id, owner_id, type, title, path, data)
      values (${big}, ${spaceA}, 'file', 'big', 'space_files',
              ${JSON.stringify({ size_bytes: sf.SPACE_STORAGE_LIMIT_BYTES })}::jsonb)`);
    try {
      await expect(asA(() => sf.assertSpaceStorage(spaceA, 1))).rejects.toMatchObject({
        reason: 'quota',
      });
    } finally {
      await m.systemDb.execute(sqlTag`delete from nodes where id = ${big}`);
    }
    await asA(() => sp.deleteMineItem(spaceA, grid.id));
  });

  it('quota checks in one space wait for each other (advisory lock)', async () => {
    const order: string[] = [];
    const first = asA(async () => {
      await sf.assertSpaceStorage(spaceA);
      order.push('first checked');
      await new Promise((r) => setTimeout(r, 400));
      order.push('first done');
    });
    await new Promise((r) => setTimeout(r, 100));
    const second = asA(async () => {
      await sf.assertSpaceStorage(spaceA);
      order.push('second checked');
    });
    // Another space is not held up.
    await asB(async () => {
      await sf.assertSpaceStorage(spaceB);
      order.push('other space checked');
    });
    await Promise.all([first, second]);
    expect(order).toEqual(['first checked', 'other space checked', 'first done', 'second checked']);
  });
});
