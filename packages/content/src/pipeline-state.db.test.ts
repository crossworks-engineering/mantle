/**
 * The state of a pipeline on a real migrated Postgres
 * (docs/pipelines.md): the one reader and the one writer of
 * pipeline_state (0373).
 *
 *  - no row gives the defaults of the code, for a reader and for a made-up
 *    `after` pipeline;
 *  - a write then a read; a second write of one option keeps the others;
 *  - a reader refuses a workspace list; an unknown workspace id, an
 *    archived one, and a bad option, are refused and write nothing; an id
 *    in upper case is kept lower case;
 *  - a stored value that no longer passes reads as the default;
 *  - the write and the read hold in an Admin's scope (systemDb there is the
 *    narrow role: its rights on the table are the NARROW_WRITES line);
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

  const sys = <T>(fn: () => Promise<T>) => m.runAsSystem('test:pipeline-state', fn);

  beforeAll(async () => {
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
    const base = files.builtinForExt('dxf')!;
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
    ids.push(reader.id, after.id);
  }, 120_000);

  afterAll(async () => {
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
      await admin<{ options: unknown; workspaces: string[] | null }[]>`
      select options, workspaces from pipeline_state
       where owner_id = ${owner} and pipeline_id = ${id}`
    )[0] ?? null;

  it('no row gives the defaults of the code', async () => {
    expect(await sys(() => ps.pipelineStateOf(owner, reader))).toEqual({
      workspaces: 'all',
      options: { box_mm: 70 },
      optionsHash: '',
    });
    expect(await sys(() => ps.pipelineStateOf(owner, after))).toEqual({
      workspaces: [],
      options: { strict: false, not_tags: [] },
      optionsHash: '',
    });
    // Every built-in: everywhere, its defaults, no hash.
    for (const p of files.BUILTIN_PIPELINES) {
      const s = await sys(() => ps.pipelineStateOf(owner, p));
      expect(s, p.id).toMatchObject({ workspaces: 'all', optionsHash: '' });
    }
    expect(await rowOf(reader.id)).toBeNull();
  });

  it('a write then a read; a second write of one option keeps the others', async () => {
    const r = await sys(() =>
      ps.setPipelineState(owner, owner, after, {
        options: { strict: true, not_tags: ['tbd', 'TBD'] },
        workspaces: [adminWs, adminWs],
      }),
    );
    expect(r).toMatchObject({
      ok: true,
      state: { workspaces: [adminWs], options: { strict: true, not_tags: ['TBD'] } },
    });
    const hash = r.ok ? r.state.optionsHash : '';
    expect(hash).toMatch(/^[0-9a-f]{8}$/);
    expect(await sys(() => ps.pipelineStateOf(owner, after))).toEqual(r.ok ? r.state : null);

    const r2 = await sys(() =>
      ps.setPipelineState(owner, owner, after, { options: { not_tags: ['n/a'] } }),
    );
    expect(r2).toMatchObject({
      ok: true,
      state: { workspaces: [adminWs], options: { strict: true, not_tags: ['N/A'] } },
    });
    // Back to the defaults (off is attached to no workspace): the hash is ''
    // again, the row stays.
    const r3 = await sys(() =>
      ps.setPipelineState(owner, owner, after, {
        options: { strict: false, not_tags: [] },
        workspaces: [],
      }),
    );
    expect(r3).toEqual({
      ok: true,
      state: {
        workspaces: [],
        options: { strict: false, not_tags: [] },
        optionsHash: '',
      },
    });
    expect(await rowOf(after.id)).toMatchObject({ workspaces: [] });
  });

  it('a reader refuses a workspace list, and writes nothing', async () => {
    for (const change of [{ workspaces: [adminWs] }, { workspaces: [] }]) {
      expect(await sys(() => ps.setPipelineState(owner, owner, reader, change))).toEqual({
        ok: false,
        error: 'A reader is used in every workspace.',
      });
    }
    expect(await rowOf(reader.id)).toBeNull();
    // Its options it takes; it stays in every workspace.
    const r = await sys(() =>
      ps.setPipelineState(owner, owner, reader, { options: { box_mm: 90 } }),
    );
    expect(r).toMatchObject({
      ok: true,
      state: { workspaces: 'all', options: { box_mm: 90 } },
    });
    expect(await rowOf(reader.id)).toMatchObject({ workspaces: null });
  });

  it('an unknown workspace id, or one that is no id, is refused and writes nothing', async () => {
    const before = await rowOf(after.id);
    const unknown = randomUUID();
    expect(
      await sys(() => ps.setPipelineState(owner, owner, after, { workspaces: [adminWs, unknown] })),
    ).toEqual({ ok: false, error: `${unknown} is not a workspace of this brain.` });
    expect(
      await sys(() => ps.setPipelineState(owner, owner, after, { workspaces: ['admin'] })),
    ).toEqual({ ok: false, error: 'admin is not a workspace id.' });
    // A workspace of this brain, asked for by another owner id, is not its.
    expect(
      await sys(() => ps.setPipelineState(randomUUID(), owner, after, { workspaces: [adminWs] })),
    ).toEqual({ ok: false, error: `${adminWs} is not a workspace of this brain.` });
    expect(await rowOf(after.id)).toEqual(before);
  });

  it('an id in upper case is the same workspace, kept lower case; an archived one is refused', async () => {
    const r = await sys(() =>
      ps.setPipelineState(owner, owner, after, {
        workspaces: [adminWs.toUpperCase(), adminWs],
      }),
    );
    expect(r).toMatchObject({ ok: true, state: { workspaces: [adminWs] } });
    expect(await rowOf(after.id)).toMatchObject({ workspaces: [adminWs] });

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
      await sys(() => ps.setPipelineState(owner, owner, after, { workspaces: [adminWs, old] })),
    ).toEqual({ ok: false, error: `${old} is not a workspace of this brain.` });
    expect(await rowOf(after.id)).toMatchObject({ workspaces: [adminWs] });
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
      workspaces: 'all',
      options: { box_mm: 70 },
      optionsHash: '',
    });
  });

  it('a hand-written bad attach list reads as its good ids only, capped, and never throws', async () => {
    const good = randomUUID();
    const many = Array.from({ length: 250 }, () => randomUUID());
    // A NULL element, a nested array (uuid[] does not hold its dimensions),
    // and a double: none of them reach a caller.
    await admin`update pipeline_state set workspaces = array[${good}::uuid, null, ${good}::uuid]
                 where owner_id = ${owner} and pipeline_id = ${after.id}`;
    expect((await sys(() => ps.pipelineStateOf(owner, after))).workspaces).toEqual([good]);
    await admin`update pipeline_state
                   set workspaces = ${`{{${good},${good}},{${many[0]},${many[1]}}}`}::uuid[]
                 where owner_id = ${owner} and pipeline_id = ${after.id}`;
    // However the driver gives a nested array back, only lower-case ids of
    // the list come out, each once.
    const nested = (await sys(() => ps.pipelineStateOf(owner, after))).workspaces as string[];
    expect(nested.every((id) => [good, many[0], many[1]].includes(id as typeof good))).toBe(true);
    expect(new Set(nested).size).toBe(nested.length);
    await admin`update pipeline_state set workspaces = ${many}::uuid[]
                 where owner_id = ${owner} and pipeline_id = ${after.id}`;
    expect((await sys(() => ps.pipelineStateOf(owner, after))).workspaces).toEqual(
      many.slice(0, 200),
    );
    await admin`update pipeline_state set workspaces = null
                 where owner_id = ${owner} and pipeline_id = ${after.id}`;
    expect((await sys(() => ps.pipelineStateOf(owner, after))).workspaces).toEqual([]);
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
        workspaces: [adminWs],
      }),
    );
    expect(r).toMatchObject({ ok: true, state: { workspaces: [adminWs] } });
    expect(await inRequest(() => ps.pipelineStateOf(owner, after))).toMatchObject({
      workspaces: [adminWs],
      options: { strict: true },
    });
    // A second upsert there: one option, and the list to empty, which is
    // off. The other option is kept.
    const r2 = await inRequest(() =>
      ps.setPipelineState(owner, owner, after, {
        options: { not_tags: ['TBD'] },
        workspaces: [],
      }),
    );
    expect(r2).toMatchObject({
      ok: true,
      state: { workspaces: [], options: { strict: true, not_tags: ['TBD'] } },
    });
    expect(ts.takeNarrowDenials()).toEqual([]);
    expect(Object.keys(ts.takeNarrowUses()).length).toBeGreaterThan(0);
    expect(await rowOf(after.id)).toMatchObject({
      options: { strict: true, not_tags: ['TBD'] },
      workspaces: [],
    });
  });

  it('with an empty table the stamp of a CSV build is the phase 1 stamp, key for key', async () => {
    const fd = await import('./file-database');
    const broker = await import('./table-broker');
    const { ensureWorkbookDoc } = await import('@mantle/content-core/table-model');
    const csv = files.builtinForExt('csv')!;
    // No row for the built-in: the box never opened the screen.
    expect(
      (
        await admin`select 1 from pipeline_state where owner_id = ${owner} and pipeline_id = 'sheet'`
      ).length,
    ).toBe(0);
    const parsed = await fd.parseFileSheets(Buffer.from('Tag,Size\nP-101,2\nP-102,3\n'), 'csv');
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
