/**
 * Reindex and stale indexes (docs/files.md, "Reindex and stale indexes") on
 * a migrated scratch database, through the real app (createApp):
 *
 *  - GET /api/files/stale lists the stale files the caller reads (a file
 *    with no stamp is never stale), newest first, in pages with a cursor and
 *    a total; `failed` and `partial` list those read states. A member who
 *    reads nothing gets nothing.
 *  - The row status says `stale` and names the pipeline.
 *  - POST /api/files/reindex queues a file whose caller may change it (the
 *    edit right, the one check), skips one it only reads (`not-allowed`),
 *    one it cannot read (`not-found`), one already queued (`in-queue`), and
 *    all when the queue is busy (`busy`). Every id is queued or named. More
 *    than 200 ids is a 400 and queues nothing.
 *  - A queued file loses what the extractor derived from its bytes (its
 *    text, summary, reader stamp) and is stamped for a whole read; the
 *    pipeline's stamp and its facts stay until the new read.
 *  - A scanned drawing whose database holds its sketch read keeps that
 *    read's text (text, ocr, vision_model), so the pass works from it and
 *    pays no whole-page OCR (audit r2 M); a PDF with none drops it.
 *  - A file whose bytes are gone keeps everything and is `bytes-missing`;
 *    a superseded file is `not-found` (audit r1 M2, LOW 5).
 *  - A file stale only by its pipeline is not stale where that pipeline is
 *    off in its home workspace, in the list, its total and the row (LOW 3);
 *    a cursor that is not epoch microseconds is a 400 (LOW 7, r2 LOW 1).
 *
 * No owner session is made: the logins are rows of the scratch database.
 *   MANTLE_TEST_DATABASE_URL=postgres://… pnpm test server/web/app/api/files/file-reindex-route.db.test.ts
 */
import { randomUUID } from 'node:crypto';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { sql } from 'drizzle-orm';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { FileReindexAnswer, FileStaleAnswer, FileStatus } from '@mantle/client-types';
import { asSuperuser, teamWorkspaceSql } from '@mantle/db/test-support';

const URL = process.env.MANTLE_TEST_DATABASE_URL;

describe.skipIf(!URL)('reindex and the stale list: the edit right is the one check', () => {
  type Ts = typeof import('@mantle/db/test-support');
  let scratch: Awaited<ReturnType<Ts['createMigratedScratchDatabase']>> | undefined;
  let m: typeof import('@mantle/db');
  let app: import('hono').Hono;
  let cookieOf: (id: string) => string;
  let dir = '';
  const owner = randomUUID();
  const admin = randomUUID();
  const writer = randomUUID();
  const reader = randomUUID();
  const outsider = randomUUID();
  const tag = `p5ri${randomUUID().slice(0, 6)}`;
  /** The files by role: no stamp, current, reader stale, pipeline stale,
   *  failed, partial, already queued. */
  const ids: Record<string, string> = {};
  /** A stand-in queue table could be made (none on the scratch database). */
  let queue = false;

  const x = async <T>(q: ReturnType<typeof sql>): Promise<T[]> =>
    (await m.systemDb.execute(q)) as unknown as T[];
  const su = async <T>(q: ReturnType<typeof sql>): Promise<T[]> =>
    (await import('@mantle/db/test-support')).superuserExec<T>(scratch!.url, q);
  const get = (as: string, url: string) => app.request(url, { headers: { cookie: cookieOf(as) } });
  const post = (as: string, url: string, body: unknown) =>
    app.request(url, {
      method: 'POST',
      headers: { cookie: cookieOf(as), 'content-type': 'application/json' },
      body: JSON.stringify(body),
    });
  const stale = async (as: string, query = '') => {
    const res = await get(as, `/api/files/stale${query}`);
    const text = await res.text();
    return {
      status: res.status,
      text,
      body: res.ok ? (JSON.parse(text) as FileStaleAnswer) : null,
    };
  };
  const reindex = async (as: string, list: string[]) => {
    const res = await post(as, '/api/files/reindex', { ids: list });
    const text = await res.text();
    return {
      status: res.status,
      text,
      body: res.ok ? (JSON.parse(text) as FileReindexAnswer) : null,
    };
  };
  const setData = (id: string, patch: Record<string, unknown>) =>
    m.withHeads([id], 'update', async (tx) => {
      await tx.execute(sql`update nodes set data = data || ${JSON.stringify(patch)}::jsonb
        where id = ${id}`);
    });
  const dataOf = async (id: string) =>
    (await x<{ data: Record<string, unknown> }>(sql`select data from nodes where id = ${id}`))[0]!
      .data;

  beforeAll(async () => {
    const ts: Ts = await import('@mantle/db/test-support');
    scratch = await ts.createMigratedScratchDatabase(URL!);
    dir = await mkdtemp(path.join(tmpdir(), 'file-reindex-route-'));
    process.env.DATABASE_URL = scratch.url;
    process.env.MANTLE_FILES_ROOT = path.join(dir, 'files');
    process.env.TABLE_DB_DIR = path.join(dir, 'tables');
    process.env.APP_DB_DIR = path.join(dir, 'apps');
    process.env.MANTLE_MASTER_KEY ??= 'mantle-viewer-test-key';
    process.env.SESSION_SECRET = 'file-reindex-route-secret-at-least-32-characters!';
    delete process.env.MANTLE_DETACHED_DEV;
    m = await import('@mantle/db');
    await asSuperuser()(sql`insert into auth.users (id, email, password_hash, is_owner, role, display_name) values
      (${owner}, ${`${tag}-o@example.invalid`}, 'x', true, 'admin', 'Owner'),
      (${admin}, ${`${tag}-a@example.invalid`}, 'x', false, 'admin', 'Admin user'),
      (${writer}, ${`${tag}-w@example.invalid`}, 'x', false, 'member', 'Writer'),
      (${reader}, ${`${tag}-r@example.invalid`}, 'x', false, 'member', 'Reader'),
      (${outsider}, ${`${tag}-x@example.invalid`}, 'x', false, 'member', 'Outsider')`);
    await x(sql`insert into spaces (id, kind, login_id) values (${owner}, 'brain', ${owner})
      on conflict (id) do nothing`);
    await ts.runWorkspacesSwitch();
    await su(sql.raw(teamWorkspaceSql(owner)));
    const ws = await x<{ id: string; key: string | null }>(sql`
      select id::text as id, (case when is_admin then 'admin' when name = 'Team' then 'team' end) as key
        from workspaces where owner_id = ${owner}`);
    const teamWs = ws.find((w) => w.key === 'team')!.id;
    const adminWs = ws.find((w) => w.key === 'admin')!.id;
    await su(sql`insert into workspace_users (workspace_id, login_id, moderator)
      values (${adminWs}, ${admin}, false) on conflict do nothing`);
    await su(sql`delete from workspace_users where workspace_id = ${adminWs}
      and login_id in (${writer}, ${reader}, ${outsider})`);
    // The outsider is in Team only, which holds none of these files.
    await su(
      sql`delete from workspace_users where login_id in (${writer}, ${reader}, ${outsider})`,
    );
    await su(sql`insert into workspace_users (workspace_id, login_id, moderator)
      values (${teamWs}, ${outsider}, false) on conflict do nothing`);

    await x(sql`insert into nodes (owner_id, type, title, slug, path)
      values (${owner}, 'branch', 'files', 'files', 'files') on conflict do nothing`);
    const f = await import('@mantle/files');
    const roles = [
      'plain',
      'current',
      'reader',
      'pipeline',
      'failed',
      'partial',
      'queued',
      'gone',
      'old',
    ];
    const made = await m.runAsSystem('test:file-reindex-route', () =>
      m.withCreateHome({ createWs: adminWs, privateWs: null, quiet: true }, async () => {
        const folder = await f.createFolder({ ownerId: owner, parentPath: 'files', slug: tag });
        const files: Record<string, string> = {};
        for (const role of roles) {
          const file = await f.upsertFile({
            ownerId: owner,
            parentPath: folder.path,
            filename: `${role}.txt`,
            bytes: Buffer.from(`made-up ${role}\n`),
          });
          files[role] = file.id;
        }
        return { folder, files };
      }),
    );
    Object.assign(ids, made.files);
    const done = {
      extract_completed_at: '2026-11-18T00:00:00.000Z',
      summary: 'made up',
      text: 'x',
    };
    await setData(ids.current!, { ...done, read_by: { reader: 'utf8', v: 1 } });
    await setData(ids.reader!, { ...done, read_by: { reader: 'utf8', v: 0 } });
    await setData(ids.pipeline!, {
      ...done,
      read_by: { reader: 'utf8', v: 1 },
      pipeline_read: { id: 'sheet', name: 'Spreadsheet', version: '0.9.0' },
    });
    await setData(ids.failed!, { extract_skipped: { reason: 'document_unreadable' } });
    await setData(ids.partial!, { ...done, ocr: { pages_read: 2, pages_total: 9 } });
    // `gone`: read, current, and its bytes are in neither place (the disk
    // file removed, no sha256 for the object store).
    await setData(ids.gone!, { ...done, read_by: { reader: 'utf8', v: 1 } });
    await m.withHeads([ids.gone!], 'update', async (tx) => {
      await tx.execute(sql`update nodes set data = data - 'sha256' where id = ${ids.gone}`);
    });
    const [goneRow] = await x<{ id: string; path: string; data: unknown }>(
      sql`select id::text as id, path::text as path, data from nodes where id = ${ids.gone}`,
    );
    const gonePath = f.foldedFilePath(goneRow!) ?? f.diskPathForFile(goneRow!.path, 'gone.txt')!;
    await rm(gonePath);
    // `old`: superseded by `plain`.
    await m.withHeads([ids.old!], 'update', async (tx) => {
      await tx.execute(sql`update nodes set superseded_by = ${ids.plain} where id = ${ids.old}`);
    });

    // Two workspaces hold the folder: one with Write on (the writer), one
    // with Write off (the reader). The files take the folder's rows.
    const writeWs = randomUUID();
    const readWs = randomUUID();
    await su(sql`insert into workspaces (id, owner_id, name) values
      (${writeWs}, ${owner}, ${`${tag} Writers`}), (${readWs}, ${owner}, ${`${tag} Readers`})`);
    await su(sql`insert into workspace_users (workspace_id, login_id, moderator)
      values (${writeWs}, ${writer}, false), (${readWs}, ${reader}, false)`);
    await m.withHeads([made.folder.id, ...Object.values(made.files)], 'update', async (tx) => {
      await tx.execute(sql`insert into item_grants (node_id, workspace_id, write)
        values (${made.folder.id}, ${writeWs}, true), (${made.folder.id}, ${readWs}, false)`);
    });

    // The queue: a stand-in pgboss.job on the scratch database, with one
    // read of the `queued` file waiting.
    const [reg] = await su<{ ok: boolean }>(
      sql`select to_regclass('pgboss.job') is not null as ok`,
    );
    if (!reg?.ok) {
      await su(sql`create schema if not exists pgboss`);
      await su(sql`create table pgboss.job (name text not null, state text not null,
        data jsonb, completed_on timestamptz, output jsonb)`);
      await su(sql`grant select on pgboss.job to mantle_system_narrow, mantle_runtime`);
      await su(sql`insert into pgboss.job (name, state, data) values
        ('mantle.extract', 'created', ${JSON.stringify({ nodeId: ids.queued })}::jsonb)`);
      queue = true;
    }

    const tokens = await import('@/lib/auth/tokens');
    cookieOf = (id) => `mantle_session=${tokens.buildSessionCookie(id).value}`;
    const { createApp } = await import('@/server/app');
    app = await createApp();
  }, 240_000);

  afterAll(async () => {
    await m?.closeDb();
    await scratch?.drop();
    if (dir) await rm(dir, { recursive: true, force: true });
  });

  /** The two stale files, newest first as the list orders them (a grant
   *  write can give both the same updated_at; the id breaks the tie). */
  const staleOrder = async () =>
    (
      await x<{ id: string }>(sql`select id::text as id from nodes
        where id in (${ids.pipeline!}, ${ids.reader!}) order by updated_at desc, id desc`)
    ).map((r) => r.id);

  it('the stale list holds the stale files only, newest first, with a total', async () => {
    const got = await stale(admin);
    expect(got.status, got.text).toBe(200);
    expect(got.body!.files.map((r) => r.id)).toEqual(await staleOrder());
    expect(got.body!.total).toBe(2);
    expect(got.body!.next).toBeNull();
    const pipe = got.body!.files.find((r) => r.id === ids.pipeline)!.status as FileStatus;
    expect(pipe).toMatchObject({ ingest: 'done', stale: true, pipeline: 'Spreadsheet' });
  });

  it('pages with a cursor; a bad state or cursor is a 400', async () => {
    const [first, second] = await staleOrder();
    const one = await stale(admin, '?limit=1');
    expect(one.status, one.text).toBe(200);
    expect(one.body!.files.map((r) => r.id)).toEqual([first]);
    expect(one.body!.total).toBe(2);
    expect(one.body!.next).toEqual(expect.any(String));
    const two = await stale(admin, `?limit=1&cursor=${encodeURIComponent(one.body!.next!)}`);
    expect(two.body!.files.map((r) => r.id)).toEqual([second]);
    expect(two.body!.next).toBeNull();
    expect((await stale(admin, '?state=old')).status).toBe(400);
    expect((await stale(admin, '?cursor=nope')).status).toBe(400);
    // The cursor carries epoch microseconds (audit r2 LOW 1). A crafted
    // one: anything but a whole number of at most 16 digits (an old text
    // time, a zone past +-15:59, year 0000, a minus) is a 400 and never
    // reaches the database.
    const crafted = (ts: string) =>
      Buffer.from(`${ts}|${randomUUID()}`, 'utf8').toString('base64url');
    for (const ts of [
      'Nov 19 2026',
      '2026-11-19T00:00:00.5+00:00',
      '2026-11-19T00:00:00+99:00',
      '0000-01-01T00:00:00Z',
      '-1',
      '1.5',
      '12345678901234567',
      '',
    ]) {
      expect((await stale(admin, `?cursor=${crafted(ts)}`)).status, ts).toBe(400);
    }
    for (const us of ['0', '1795046400000000', '9999999999999999']) {
      expect((await stale(admin, `?cursor=${crafted(us)}`)).status, us).toBe(200);
    }
    // The cursor of a page is that whole number.
    const [us] = Buffer.from(one.body!.next!, 'base64url').toString('utf8').split('|');
    expect(us).toMatch(/^\d{1,16}$/);
    expect((await stale(admin, '?limit=500')).status).toBe(400);
  });

  it('failed and partial list those read states', async () => {
    const failed = await stale(admin, '?state=failed');
    expect(failed.body!.files.map((r) => r.id)).toEqual([ids.failed]);
    const partial = await stale(admin, '?state=partial');
    expect(partial.body!.files.map((r) => r.id)).toEqual([ids.partial]);
  });

  it('the list is the caller’s scope: a reader sees them, an outsider nothing', async () => {
    expect((await stale(reader)).body!.total).toBe(2);
    const none = await stale(outsider);
    expect(none.status).toBe(200);
    expect(none.body).toEqual({ files: [], next: null, total: 0 });
  });

  it('the row of the folder list says stale; a file with no stamp does not', async () => {
    const list = await get(admin, `/api/files/files?parent=files.${tag}`);
    expect(list.status).toBe(200);
    const rows = ((await list.json()) as { files: Array<{ id: string; status?: FileStatus }> })
      .files;
    const of = (id: string) => rows.find((r) => r.id === id)?.status;
    expect(of(ids.reader!)?.stale).toBe(true);
    expect(of(ids.current!)).not.toHaveProperty('stale');
    expect(of(ids.plain!)).not.toHaveProperty('stale');
  });

  it('a pipeline off in the file home: not stale in the list, its total or the row', async () => {
    const [home] = await x<{ home: string }>(
      sql`select home_ws::text as home from nodes where id = ${ids.pipeline}`,
    );
    expect(home?.home).toEqual(expect.any(String));
    await su(sql`insert into pipeline_state (owner_id, pipeline_id, off_in)
      values (${owner}, 'sheet', array[${home!.home}]::uuid[])
      on conflict (owner_id, pipeline_id) do update set off_in = excluded.off_in`);
    try {
      const got = await stale(admin);
      expect(got.status, got.text).toBe(200);
      expect(got.body!.files.map((r) => r.id)).toEqual([ids.reader]);
      expect(got.body!.total).toBe(1);
      const list = await get(admin, `/api/files/files?parent=files.${tag}`);
      const rows = ((await list.json()) as { files: Array<{ id: string; status?: FileStatus }> })
        .files;
      const pipe = rows.find((r) => r.id === ids.pipeline)!.status!;
      expect(pipe).not.toHaveProperty('stale');
      // The pipeline that built it is still named.
      expect(pipe.pipeline).toBe('Spreadsheet');
    } finally {
      await su(sql`update pipeline_state set off_in = null
        where owner_id = ${owner} and pipeline_id = 'sheet'`);
    }
    expect((await stale(admin)).body!.total).toBe(2);
  });

  it('a file with no bytes keeps all it has and is bytes-missing; a superseded one not-found', async () => {
    const before = await dataOf(ids.gone!);
    expect(before.text).toBe('x');
    const got = await reindex(admin, [ids.gone!, ids.old!]);
    expect(got.status, got.text).toBe(200);
    expect(got.body).toEqual({
      queued: 0,
      databases: 0,
      skipped: [
        { id: ids.old, reason: 'not-found' },
        { id: ids.gone, reason: 'bytes-missing' },
      ],
    });
    const after = await dataOf(ids.gone!);
    expect(after).toEqual(before);
    expect(after).not.toHaveProperty('index_work');
  });

  it('a body of more than 200 ids, or of no ids, is a 400 and queues nothing', async () => {
    const many = Array.from({ length: 201 }, () => randomUUID());
    const big = await reindex(admin, many);
    expect(big.status, big.text).toBe(400);
    expect((await reindex(admin, [])).status).toBe(400);
    expect((await reindex(admin, ['not-a-uuid'])).status).toBe(400);
  });

  it('the edit right is the check: an outsider not-found, a reader not-allowed', async () => {
    const out = await reindex(outsider, [ids.reader!]);
    expect(out.status, out.text).toBe(200);
    expect(out.body).toEqual({
      queued: 0,
      databases: 0,
      skipped: [{ id: ids.reader, reason: 'not-found' }],
    });
    const ro = await reindex(reader, [ids.reader!]);
    expect(ro.body).toEqual({
      queued: 0,
      databases: 0,
      skipped: [{ id: ids.reader, reason: 'not-allowed' }],
    });
    expect((await dataOf(ids.reader!)).read_by).toEqual({ reader: 'utf8', v: 0 });
  });

  it('a writer queues the file; a queued one and an unknown one are named', async () => {
    const unknown = randomUUID();
    const got = await reindex(writer, [ids.pipeline!, ids.pipeline!, ids.queued!, unknown]);
    expect(got.status, got.text).toBe(200);
    expect(got.body!.queued).toBe(1);
    expect(got.body!.skipped).toEqual(
      expect.arrayContaining([
        { id: unknown, reason: 'not-found' },
        ...(queue ? [{ id: ids.queued, reason: 'in-queue' }] : []),
      ]),
    );
    // Every id is queued or named, once.
    expect(got.body!.queued + got.body!.skipped.length).toBe(3);
    const data = await dataOf(ids.pipeline!);
    expect(data).not.toHaveProperty('read_by');
    expect(data).not.toHaveProperty('text');
    expect(data).not.toHaveProperty('summary');
    expect(data).not.toHaveProperty('extract_completed_at');
    // Kept: the pipeline's stamp (the extract builds no database).
    expect(data.pipeline_read).toEqual({ id: 'sheet', name: 'Spreadsheet', version: '0.9.0' });
    expect(data.index_work).toBe('extract');
  });

  it('a scanned drawing whose database holds its sketch read keeps that text (audit r2 M)', async () => {
    const f = await import('@mantle/files');
    const fd = await import('@mantle/content/file-database');
    const { ensureWorkbookDoc } = await import('@mantle/content-core/table-model');
    const { writeFileDatabaseDoc } = await import('@mantle/content/table-broker');
    const { mkdirSync } = await import('node:fs');
    const [ws] = await x<{ id: string }>(sql`select id::text as id from workspaces
      where owner_id = ${owner} and is_admin`);
    const made = await m.runAsSystem('test:file-reindex-route', () =>
      m.withCreateHome({ createWs: ws!.id, privateWs: null, quiet: true }, async () => {
        const out: Record<string, string> = {};
        for (const role of ['sketch', 'scan']) {
          const file = await f.upsertFile({
            ownerId: owner,
            parentPath: `files.${tag}`,
            filename: `${role}.pdf`,
            bytes: Buffer.from(`%PDF-1.7 made-up ${role}\n`),
          });
          out[role] = file.id;
        }
        return out;
      }),
    );
    const read = {
      extract_completed_at: '2026-11-18T00:00:00.000Z',
      summary: 'made up',
      text: 'the sketch text, paid for',
      ocr: true,
      vision_model: 'made-up-vision',
      read_by: { reader: 'pdf-parse', v: 1 },
    };
    for (const id of Object.values(made)) await setData(id, read);
    // `sketch` has a database whose File tab says the sketch read ran;
    // `scan` has none.
    const sha = (await dataOf(made.sketch!)).sha256;
    mkdirSync(f.fileDbsDir(), { recursive: true });
    writeFileDatabaseDoc(
      f.fileDbPaths(made.sketch!, sha)!.sqlite,
      ensureWorkbookDoc({
        tabs: fd.tabsOfSheets([
          {
            name: 'File',
            columns: [
              { name: 'Kind', type: 'text' },
              { name: 'Rules kind', type: 'text' },
              { name: 'Vision read', type: 'checkbox' },
            ],
            rows: [['scan', 'scan', true]],
          },
        ]),
      }),
      { fileId: made.sketch!, ownerId: owner, description: 'A sketch read.' },
    );
    const got = await reindex(admin, [made.sketch!, made.scan!]);
    expect(got.status, got.text).toBe(200);
    expect(got.body!.queued).toBe(2);
    expect(got.body!.skipped).toEqual([]);
    const kept = await dataOf(made.sketch!);
    expect(kept).toMatchObject({
      text: read.text,
      ocr: true,
      vision_model: 'made-up-vision',
      index_work: 'extract',
    });
    expect(kept).not.toHaveProperty('summary');
    expect(kept).not.toHaveProperty('read_by');
    expect(kept).not.toHaveProperty('extract_completed_at');
    const dropped = await dataOf(made.scan!);
    for (const k of ['text', 'ocr', 'vision_model', 'summary', 'read_by']) {
      expect(dropped, k).not.toHaveProperty(k);
    }
    expect(dropped.index_work).toBe('extract');
  });

  it('a busy queue queues nothing and names every file', async () => {
    if (!queue) return;
    await su(sql`insert into pgboss.job (name, state, data)
      select 'mantle.extract', 'created', jsonb_build_object('nodeId', gen_random_uuid()::text)
        from generate_series(1, 60)`);
    const got = await reindex(admin, [ids.reader!, ids.current!]);
    expect(got.status, got.text).toBe(200);
    expect(got.body).toEqual({
      queued: 0,
      databases: 0,
      skipped: [
        { id: ids.reader, reason: 'busy' },
        { id: ids.current, reason: 'busy' },
      ],
    });
    expect((await dataOf(ids.reader!)).read_by).toEqual({ reader: 'utf8', v: 0 });
  });
});
