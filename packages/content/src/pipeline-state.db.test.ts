/**
 * The state of a pipeline on a real migrated Postgres
 * (docs/pipelines.md): the one reader and the one writer of
 * pipeline_state (0373, 0375).
 *
 *  - no row gives the defaults of the code, for a reader and for a made-up
 *    `after` pipeline: on in every workspace (an empty off list);
 *  - a write then a read; a second write of one option keeps the others;
 *  - a reader and an `after` pipeline take an off list, a router refuses
 *    one; pipelineOffHere is the one test; an unknown workspace id, an
 *    archived one, more than 200, and a bad option, are refused and write
 *    nothing; an id in upper case is kept lower case;
 *  - a stored value that no longer passes reads as the default;
 *  - the write and the read hold in an Admin's scope (systemDb there is the
 *    narrow role: its rights on the table are the NARROW_WRITES line);
 *  - a remove of an own row whose id a built-in has now clears its package
 *    and keeps the row (the built-in's off list); another own row goes
 *    (both in one transaction that is rolled back, so no other test sees
 *    a built-in's row change);
 *  - with an empty table the stamp of a CSV build is the phase 1 stamp:
 *    the `_meta` of the database is the same as on the base, key for key.
 *
 * Its rows use made-up pipeline ids and are removed after.
 *
 *   MANTLE_TEST_DATABASE_URL=postgres://… pnpm test packages/content/src/pipeline-state.db.test.ts
 */
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { randomUUID } from 'node:crypto';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { PipelineManifest } from '@mantle/files';
import { inProcessPipelineFetch } from '@mantle/files/pipelines/test-job';

/** The parser's URL and fetch before this file's, put back after it. */
let parserSaved: { url: string | undefined; fetch: typeof fetch } | undefined;

const URL = process.env.MANTLE_TEST_DATABASE_URL;

describe.skipIf(!URL)('pipelineStateOf and setPipelineState', () => {
  type Db = typeof import('@mantle/db');
  let m: Db;
  let ps: typeof import('./pipeline-state');
  let files: typeof import('@mantle/files');
  let admin: Parameters<Db['ensureViewerRoles']>[0];
  let owner = '';
  let adminWs = '';
  const tag = randomUUID().slice(0, 8);
  const ids: string[] = [];
  const wsIds: string[] = [];

  // A made-up reader and a made-up `after` pipeline, so the test owns its
  // rows and depends on no built-in's options.
  let reader: PipelineManifest;
  let after: PipelineManifest;
  let router: PipelineManifest;

  const sys = <T>(fn: () => Promise<T>) => m.runAsSystem('test:pipeline-state', fn);

  beforeAll(async () => {
    // A spreadsheet is the package `sheet`: its parser job runs in this
    // process (inProcessPipelineFetch); any other route goes where it went.
    parserSaved = { url: process.env.PARSER_URL, fetch: globalThis.fetch };
    process.env.PARSER_URL ??= 'http://127.0.0.1:9';
    const realFetch = parserSaved.fetch;
    globalThis.fetch = inProcessPipelineFetch((url, init) => realFetch(url, init)) as typeof fetch;
    process.env.DATABASE_URL = URL;
    process.env.MANTLE_MASTER_KEY ??= 'mantle-viewer-test-key';
    m = await import('@mantle/db');
    files = await import('@mantle/files');
    ps = await import('./pipeline-state');
    const ts = await import('@mantle/db/test-support');
    admin = (m.systemDb as unknown as { $client: typeof admin }).$client;
    const su = ts.superuserClient(URL!);
    try {
      owner = await ts.ensureTestAnchor(su);
      adminWs = await ts.ensureAdminUsers(su, []);
    } finally {
      await su.end();
    }
    const base = files.readerFor(files.BUILTIN_PIPELINES, 'dxf')!;
    reader = {
      ...base,
      id: `made-up-reader-${tag}`,
      name: 'Made-up reader',
      options: { box_mm: { type: 'number', label: 'Box', default: 70, min: 20, max: 300 } },
    };
    after = {
      ...base,
      id: `made-up-after-${tag}`,
      name: 'Made-up tags',
      match: { ext: ['dxf'], after: 'drawing-v1' },
      produces: { tabs: ['Made-up tags'] },
      options: {
        strict: { type: 'bool', label: 'Strict', default: false },
        not_tags: { type: 'words', label: 'Not tags', default: [], maxItems: 3, maxChars: 8 },
      },
    };
    router = { ...base, id: `made-up-router-${tag}`, name: 'Made-up router', router: true };
    ids.push(reader.id, after.id, router.id);
  }, 120_000);

  afterAll(async () => {
    if (parserSaved) {
      globalThis.fetch = parserSaved.fetch;
      if (parserSaved.url === undefined) delete process.env.PARSER_URL;
    }
    if (!admin) return;
    await admin`delete from pipeline_state where pipeline_id = any(${ids})`;
    if (wsIds.length > 0) {
      const ts = await import('@mantle/db/test-support');
      const su = ts.superuserClient(URL!);
      try {
        await su`delete from workspaces where id = any(${wsIds})`;
      } finally {
        await su.end();
      }
    }
    await m.closeDb();
  });

  const rowOf = async (id: string) =>
    (
      await admin<{ options: unknown; off_in: string[] | null }[]>`
      select options, off_in from pipeline_state
       where owner_id = ${owner} and pipeline_id = ${id}`
    )[0] ?? null;

  it('no row gives the defaults of the code', async () => {
    expect(await sys(() => ps.pipelineStateOf(owner, reader))).toEqual({
      offIn: [],
      options: { box_mm: 70 },
      optionsHash: '',
      runs: 0,
      lastRunAt: null,
    });
    expect(await sys(() => ps.pipelineStateOf(owner, after))).toEqual({
      offIn: [],
      options: { strict: false, not_tags: [] },
      optionsHash: '',
      runs: 0,
      lastRunAt: null,
    });
    // Every built-in, Site tags too: on everywhere, its defaults, no hash.
    for (const p of files.BUILTIN_PIPELINES) {
      const s = await sys(() => ps.pipelineStateOf(owner, p));
      expect(s, p.id).toMatchObject({ offIn: [], optionsHash: '' });
    }
    expect(await rowOf(reader.id)).toBeNull();
  });

  it('a write then a read; a second write of one option keeps the others', async () => {
    const r = await sys(() =>
      ps.setPipelineState(owner, owner, after, {
        options: { strict: true, not_tags: ['tbd', 'TBD'] },
        offIn: [adminWs, adminWs],
      }),
    );
    expect(r).toMatchObject({
      ok: true,
      state: { offIn: [adminWs], options: { strict: true, not_tags: ['TBD'] } },
    });
    const hash = r.ok ? r.state.optionsHash : '';
    expect(hash).toMatch(/^[0-9a-f]{8}$/);
    expect(await sys(() => ps.pipelineStateOf(owner, after))).toEqual(r.ok ? r.state : null);

    const r2 = await sys(() =>
      ps.setPipelineState(owner, owner, after, { options: { not_tags: ['n/a'] } }),
    );
    expect(r2).toMatchObject({
      ok: true,
      state: { offIn: [adminWs], options: { strict: true, not_tags: ['N/A'] } },
    });
    // Back to the defaults (on everywhere): the hash is '' again, the row
    // stays.
    const r3 = await sys(() =>
      ps.setPipelineState(owner, owner, after, {
        options: { strict: false, not_tags: [] },
        offIn: [],
      }),
    );
    expect(r3).toEqual({
      ok: true,
      state: {
        offIn: [],
        options: { strict: false, not_tags: [] },
        optionsHash: '',
        runs: 0,
        lastRunAt: null,
      },
    });
    expect(await rowOf(after.id)).toMatchObject({ off_in: [] });
  });

  it('a reader takes an off list too; a router refuses one and writes nothing', async () => {
    // Its options first: no list is written (NULL, the default).
    const r = await sys(() =>
      ps.setPipelineState(owner, owner, reader, { options: { box_mm: 90 } }),
    );
    expect(r).toMatchObject({ ok: true, state: { offIn: [], options: { box_mm: 90 } } });
    expect(await rowOf(reader.id)).toMatchObject({ off_in: null });
    const off = await sys(() => ps.setPipelineState(owner, owner, reader, { offIn: [adminWs] }));
    expect(off).toMatchObject({ ok: true, state: { offIn: [adminWs], options: { box_mm: 90 } } });
    expect(await rowOf(reader.id)).toMatchObject({ off_in: [adminWs] });
    const on = await sys(() => ps.setPipelineState(owner, owner, reader, { offIn: [] }));
    expect(on).toMatchObject({ ok: true, state: { offIn: [] } });
    // Back to no list, as the next tests expect of this row.
    await admin`update pipeline_state set off_in = null
                 where owner_id = ${owner} and pipeline_id = ${reader.id}`;

    for (const change of [{ offIn: [adminWs] }, { offIn: [] }]) {
      expect(await sys(() => ps.setPipelineState(owner, owner, router, change))).toEqual({
        ok: false,
        error: ps.ROUTER_HAS_NO_OFF_LIST,
      });
    }
    expect(await rowOf(router.id)).toBeNull();
    // A row written by hand gives a router no list all the same.
    await admin`insert into pipeline_state (owner_id, pipeline_id, off_in)
                values (${owner}, ${router.id}, array[${adminWs}::uuid])`;
    expect((await sys(() => ps.pipelineStateOf(owner, router))).offIn).toEqual([]);
  });

  it('pipelineOffHere: off only for a file whose home is in the list; no home is on', () => {
    const other = randomUUID();
    expect(ps.pipelineOffHere({ offIn: [adminWs] }, adminWs)).toBe(true);
    expect(ps.pipelineOffHere({ offIn: [adminWs] }, other)).toBe(false);
    expect(ps.pipelineOffHere({ offIn: [adminWs] }, null)).toBe(false);
    expect(ps.pipelineOffHere({ offIn: [] }, adminWs)).toBe(false);
  });

  it('more than 200 workspaces are refused and write nothing', async () => {
    const before = await rowOf(after.id);
    const many = Array.from({ length: 201 }, () => randomUUID());
    expect(await sys(() => ps.setPipelineState(owner, owner, after, { offIn: many }))).toEqual({
      ok: false,
      error: 'A pipeline is off in at most 200 workspaces.',
    });
    expect(await rowOf(after.id)).toEqual(before);
  });

  it('an unknown workspace id, or one that is no id, is refused and writes nothing', async () => {
    const before = await rowOf(after.id);
    const unknown = randomUUID();
    expect(
      await sys(() => ps.setPipelineState(owner, owner, after, { offIn: [adminWs, unknown] })),
    ).toEqual({ ok: false, error: `${unknown} is not a workspace of this brain.` });
    expect(await sys(() => ps.setPipelineState(owner, owner, after, { offIn: ['admin'] }))).toEqual(
      { ok: false, error: 'admin is not a workspace id.' },
    );
    // A workspace of this brain, asked for by another owner id, is not its.
    expect(
      await sys(() => ps.setPipelineState(randomUUID(), owner, after, { offIn: [adminWs] })),
    ).toEqual({ ok: false, error: `${adminWs} is not a workspace of this brain.` });
    expect(await rowOf(after.id)).toEqual(before);
  });

  it('an id in upper case is the same workspace, kept lower case; an archived one is refused', async () => {
    const r = await sys(() =>
      ps.setPipelineState(owner, owner, after, {
        offIn: [adminWs.toUpperCase(), adminWs],
      }),
    );
    expect(r).toMatchObject({ ok: true, state: { offIn: [adminWs] } });
    expect(await rowOf(after.id)).toMatchObject({ off_in: [adminWs] });

    const old = randomUUID();
    wsIds.push(old);
    // The superuser: the system pool holds no insert on workspaces.
    const su = (await import('@mantle/db/test-support')).superuserClient(URL!);
    try {
      await su`insert into workspaces (id, owner_id, name, archived_at)
               values (${old}, ${owner}, ${`Made-up old ${tag}`}, now())`;
    } finally {
      await su.end();
    }
    expect(
      await sys(() => ps.setPipelineState(owner, owner, after, { offIn: [adminWs, old] })),
    ).toEqual({ ok: false, error: `${old} is not a workspace of this brain.` });
    expect(await rowOf(after.id)).toMatchObject({ off_in: [adminWs] });
  });

  it('a bad option is refused with the sentence of checkOptions, and writes nothing', async () => {
    const before = await rowOf(reader.id);
    expect(
      await sys(() => ps.setPipelineState(owner, owner, reader, { options: { box_mm: 5 } })),
    ).toEqual({ ok: false, error: 'Option "box_mm" must be a number from 20 to 300.' });
    expect(
      await sys(() => ps.setPipelineState(owner, owner, reader, { options: { pattern: '.*' } })),
    ).toEqual({ ok: false, error: 'Made-up reader has no option "pattern".' });
    expect(await rowOf(reader.id)).toEqual(before);
  });

  it('a stored value that no longer passes reads as the default', async () => {
    await admin`update pipeline_state set options = ${JSON.stringify({ box_mm: 9999, gone: 1 })}::jsonb
                 where owner_id = ${owner} and pipeline_id = ${reader.id}`;
    expect(await sys(() => ps.pipelineStateOf(owner, reader))).toEqual({
      offIn: [],
      options: { box_mm: 70 },
      optionsHash: '',
      runs: 0,
      lastRunAt: null,
    });
  });

  it('a hand-written bad off list reads as its good ids only, capped, and never throws', async () => {
    const good = randomUUID();
    const many = Array.from({ length: 250 }, () => randomUUID());
    // A NULL element, a nested array (uuid[] does not hold its dimensions),
    // and a double: none of them reach a caller.
    await admin`update pipeline_state set off_in = array[${good}::uuid, null, ${good}::uuid]
                 where owner_id = ${owner} and pipeline_id = ${after.id}`;
    expect((await sys(() => ps.pipelineStateOf(owner, after))).offIn).toEqual([good]);
    await admin`update pipeline_state
                   set off_in = ${`{{${good},${good}},{${many[0]},${many[1]}}}`}::uuid[]
                 where owner_id = ${owner} and pipeline_id = ${after.id}`;
    // However the driver gives a nested array back, only lower-case ids of
    // the list come out, each once.
    const nested = (await sys(() => ps.pipelineStateOf(owner, after))).offIn as string[];
    expect(nested.every((id) => [good, many[0], many[1]].includes(id as typeof good))).toBe(true);
    expect(new Set(nested).size).toBe(nested.length);
    await admin`update pipeline_state set off_in = ${many}::uuid[]
                 where owner_id = ${owner} and pipeline_id = ${after.id}`;
    expect((await sys(() => ps.pipelineStateOf(owner, after))).offIn).toEqual(many.slice(0, 200));
    await admin`update pipeline_state set off_in = null
                 where owner_id = ${owner} and pipeline_id = ${after.id}`;
    expect((await sys(() => ps.pipelineStateOf(owner, after))).offIn).toEqual([]);
  });

  it("holds in an Admin's request scope: the narrow role reads and upserts the row", async () => {
    const ts = await import('@mantle/db/test-support');
    // An Admin's request, as the route and the tool run it: systemDb there
    // takes the narrow route (member-turn-ledger-narrow.db.test.ts's form).
    const inRequest = <T>(fn: () => Promise<T>): Promise<T> =>
      m.runInRequestSlot(async () => {
        const scope = Object.freeze({
          kind: 'user' as const,
          loginId: owner,
          ws: Object.freeze([adminWs]),
          modWs: Object.freeze([]),
        });
        expect(m.enterRequestScope(scope, { writes: true, drafts: false })).toBe(true);
        return fn();
      });
    ts.takeNarrowDenials();
    ts.takeNarrowUses();
    const r = await inRequest(() =>
      ps.setPipelineState(owner, owner, after, {
        options: { strict: true },
        offIn: [adminWs],
      }),
    );
    expect(r).toMatchObject({ ok: true, state: { offIn: [adminWs] } });
    expect(await inRequest(() => ps.pipelineStateOf(owner, after))).toMatchObject({
      offIn: [adminWs],
      options: { strict: true },
    });
    // A second upsert there: one option, and the list to empty, which is
    // on everywhere. The other option is kept.
    const r2 = await inRequest(() =>
      ps.setPipelineState(owner, owner, after, {
        options: { not_tags: ['TBD'] },
        offIn: [],
      }),
    );
    expect(r2).toMatchObject({
      ok: true,
      state: { offIn: [], options: { strict: true, not_tags: ['TBD'] } },
    });
    expect(ts.takeNarrowDenials()).toEqual([]);
    expect(Object.keys(ts.takeNarrowUses()).length).toBeGreaterThan(0);
    expect(await rowOf(after.id)).toMatchObject({
      options: { strict: true, not_tags: ['TBD'] },
      off_in: [],
    });
  });

  it("a remove keeps a built-in's row, its package cleared; another own row goes", async () => {
    const { sql } = await import('drizzle-orm');
    const builtin = files.BUILTIN_PIPELINES[0]!.id;
    const own = `made-up-own-${tag}`;
    const ROLLBACK = new Error('rollback');
    /** The row of `id` after a remove, in a transaction rolled back. */
    const afterRemove = async (id: string) => {
      let seen: unknown[] = [];
      await sys(() =>
        ps.underPackageLock(owner, id, async ({ tx, remove }) => {
          await tx.execute(sql`
            insert into pipeline_state (owner_id, pipeline_id, package, off_in)
            values (${owner}, ${id}, ${JSON.stringify({ files: {} })}::jsonb, array[${adminWs}::uuid])
            on conflict (owner_id, pipeline_id)
            do update set package = excluded.package, off_in = excluded.off_in`);
          await remove();
          seen = Array.from(
            (await tx.execute(sql`
              select pipeline_id, package, off_in from pipeline_state
               where owner_id = ${owner} and pipeline_id = ${id}`)) as Iterable<unknown>,
          );
          throw ROLLBACK;
        }),
      ).catch((err: unknown) => {
        if (err !== ROLLBACK) throw err;
      });
      return seen;
    };
    expect(await afterRemove(builtin)).toEqual([
      { pipeline_id: builtin, package: null, off_in: [adminWs] },
    ]);
    expect(await afterRemove(own)).toEqual([]);
  });

  it('two holders of the lock of one id: the second waits for the first; another id does not', async () => {
    const id = `made-up-lock-${tag}`;
    const order: string[] = [];
    let release!: () => void;
    const held = new Promise<void>((r) => (release = r));
    let entered!: () => void;
    const inFirst = new Promise<void>((r) => (entered = r));
    const first = sys(() =>
      ps.underPackageLock(owner, id, async () => {
        order.push('first in');
        entered();
        await held;
        order.push('first out');
      }),
    );
    await inFirst;
    const second = sys(() =>
      ps.underPackageLock(owner, id, async () => {
        order.push('second in');
      }),
    );
    // Another id takes its own lock while the first holds this one.
    await sys(() =>
      ps.underPackageLock(owner, `${id}-other`, async () => {
        order.push('other in');
      }),
    );
    await new Promise((r) => setTimeout(r, 500));
    expect(order).toEqual(['first in', 'other in']);
    release();
    await Promise.all([first, second]);
    expect(order).toEqual(['first in', 'other in', 'first out', 'second in']);
  });

  it('with an empty table the stamp of a CSV build is the phase 1 stamp, key for key', async () => {
    const fd = await import('./file-database');
    const broker = await import('./table-broker');
    const { ensureWorkbookDoc } = await import('@mantle/content-core/table-model');
    const csv = files.readerFor(files.BUILTIN_PIPELINES, 'csv')!;
    // No row for the built-in: the box never opened the screen.
    expect(
      (
        await admin`select 1 from pipeline_state where owner_id = ${owner} and pipeline_id = 'sheet'`
      ).length,
    ).toBe(0);
    const pipelines = await (await import('./pipeline-registry')).boxPipelines(owner);
    const parsed = await fd.parseFileSheets(Buffer.from('Tag,Size\nP-101,2\nP-102,3\n'), 'csv', {
      pipelines,
    });
    if (parsed.kind !== 'sheets') throw new Error(`a CSV gave ${parsed.kind}`);
    const tabs = fd.tabsOfSheets(parsed.sheets);
    const cols = tabs.map((t) => ({ name: t.name, columns: t.columns.map((c) => c.name) }));
    const state = await sys(() => ps.pipelineStateOf(owner, csv));
    expect(state.optionsHash).toBe('');

    const dir = mkdtempSync(join(tmpdir(), 'pipeline-state-'));
    try {
      const write = (name: string, stamp: ReturnType<typeof files.pipelineStampOf>) => {
        const abs = join(dir, name);
        broker.writeFileDatabaseDoc(abs, ensureWorkbookDoc({ tabs }), {
          fileId: '00000000-0000-4000-8000-000000000001',
          ownerId: owner,
          stamp,
        });
        return abs;
      };
      // The base: phase 1's call. Now: the hash of the state in force.
      const base = write('base.sqlite', files.pipelineStampOf(csv, cols));
      const now = write('now.sqlite', files.pipelineStampOf(csv, cols, state.optionsHash));
      const metaOf = (abs: string) => {
        const { DatabaseSync } = process.getBuiltinModule('node:sqlite') as unknown as {
          DatabaseSync: new (
            p: string,
            o?: { readOnly?: boolean },
          ) => {
            prepare: (s: string) => { all: () => { k: string; v: string }[] };
            close: () => void;
          };
        };
        const db = new DatabaseSync(abs, { readOnly: true });
        try {
          return db
            .prepare('SELECT k, v FROM _meta ORDER BY k')
            .all()
            .map((r) => [r.k, r.v]);
        } finally {
          db.close();
        }
      };
      const a = metaOf(base);
      const b = metaOf(now);
      expect(b).toEqual(a);
      const keys = b.map(([k]) => k);
      for (const k of ['pipeline_id', 'pipeline_version', 'pipeline_api', 'shapes']) {
        expect(keys).toContain(k);
      }
      expect(keys).not.toContain('pipeline_options');
      expect(keys).not.toContain('pipelines_after');
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});
