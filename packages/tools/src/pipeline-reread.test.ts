/**
 * `pipeline_reread` and rereadPipeline (docs/pipelines.md, "Read the older
 * files again"), on a temporary files root with small made-up databases;
 * the file rows, the state, the busy check and the notify are stand-ins, so
 * no Postgres. The route's rights are proven on Postgres
 * (server/web/app/api/pipelines/[id]/reread/pipelines-reread-route.db.test.ts).
 *
 *  - The dry run sends nothing, and its number is the list's `older`: both
 *    ask pipelineReadOf.
 *  - `apply` sends one notify for each older file and none for a current
 *    one; a busy queue sends nothing.
 *  - The cap: `limit` older files, and a budget of ids a call; `next` goes
 *    on, also when a page found fewer than `limit`.
 *  - The reader of a PDF drawing is refused (`pdf`); a private file is
 *    skipped (`private`).
 *  - An `after` pipeline takes only the files with its entry.
 */
import { mkdirSync, mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { fileDbPaths, fileDbsDir } from '@mantle/files';
import { writeDocFile } from '@mantle/tabledb/write';
import type { ToolHandlerContext } from './types';

type Row = { id: string; path: string; title: string; data: Record<string, unknown> };
const h = vi.hoisted(() => ({
  own: [] as { id: string; manifest: string | null }[],
  rows: new Map<string, Row>(),
  hash: new Map<string, string>(),
  privateIds: new Set<string>(),
  busy: false,
  max: 5000,
  notified: [] as string[],
  /** The home of every file, and the off list of every pipeline. */
  home: null as string | null,
  offIn: [] as string[],
}));

vi.mock('@mantle/db', async (orig) => ({
  ...(await orig<typeof import('@mantle/db')>()),
  extractQueueBusy: vi.fn(async () => h.busy),
  notifyPipelineRun: vi.fn(async (nodeId: string, pipelineId: string) => {
    h.notified.push(`${pipelineId} ${nodeId}`);
  }),
}));

vi.mock('@mantle/files', async (orig) => ({
  ...(await orig<typeof import('@mantle/files')>()),
  fileDataRows: vi.fn(async (_owner: string, ids: readonly string[]) =>
    ids.flatMap((id) => (h.rows.has(id) ? [h.rows.get(id)!] : [])),
  ),
}));

vi.mock('@mantle/content/file-database', async (orig) => ({
  ...(await orig<typeof import('@mantle/content/file-database')>()),
  readFileRowNow: vi.fn(async (id: string) => {
    const row = h.rows.get(id);
    return row
      ? {
          sha256: row.data.sha256 as string,
          isPrivate: h.privateIds.has(id),
          home: h.home,
          filename: row.title,
        }
      : null;
  }),
}));

vi.mock('@mantle/content/pipeline-state', async () => {
  const f = await import('@mantle/files');
  return {
    // No own pipeline on this box (the registry's one read of them).
    ownManifests: async () => h.own,
    pipelineStateOf: vi.fn(async (_owner: string, m: import('@mantle/files').PipelineManifest) => ({
      offIn: f.isRouter(m) ? f.defaultState().offIn : h.offIn,
      options: f.effectiveOptions(m, {}),
      optionsHash: h.hash.get(m.id) ?? '',
      runs: 0,
      lastRunAt: null,
    })),
    setPipelineState: vi.fn(),
  };
});

vi.mock('./pipeline-look', async (orig) => ({
  ...(await orig<typeof import('./pipeline-look')>()),
  get PIPELINE_SCAN_MAX() {
    return h.max;
  },
}));

const { rereadPipeline, pipeline_reread } = await import('./pipeline-reread');
const { listPipelines, resetPipelineCounts } = await import('./pipelines');

const OWNER = '00000000-0000-4000-8000-000000000000';
const id = (n: number) => `${String(n).padStart(8, '0')}-1111-4111-8111-111111111111`;
const sha = (n: number) => String(n % 10).repeat(64);

let root: string;
beforeEach(() => {
  root = mkdtempSync(path.join(tmpdir(), 'mantle-reread-'));
  vi.stubEnv('MANTLE_FILES_ROOT', root);
  h.own = [];
  h.rows.clear();
  h.hash.clear();
  h.privateIds.clear();
  h.busy = false;
  h.max = 5000;
  h.notified = [];
  h.home = null;
  h.offIn = [];
  resetPipelineCounts();
});
afterEach(() => {
  vi.unstubAllEnvs();
  rmSync(root, { recursive: true, force: true });
});

const DOC = {
  columns: [{ id: 'c1', name: 'Tag', type: 'text' as const }],
  rows: [{ id: 'r1', cells: { c1: 'P-101' } }],
};

/** A file row and its database with this stamp (none: before stamps). */
function file(
  n: number,
  filename: string,
  stamp?: { id: string; version: string; options?: string; after?: string },
  after?: string,
) {
  h.rows.set(id(n), {
    id: id(n),
    path: 'files',
    title: filename,
    data: { filename, sha256: sha(n) },
  });
  mkdirSync(fileDbsDir(), { recursive: true });
  const extraMeta = stamp
    ? {
        pipeline_id: stamp.id,
        pipeline_version: stamp.version,
        pipeline_api: '1',
        shapes: '',
        ...(stamp.options ? { pipeline_options: stamp.options } : {}),
        ...(stamp.after ? { pipelines_after: stamp.after } : {}),
      }
    : after
      ? { pipelines_after: after }
      : undefined;
  writeDocFile(fileDbPaths(id(n), sha(n))!.sqlite, DOC, {
    nodeId: id(n),
    ownerId: OWNER,
    ...(extraMeta ? { extraMeta } : {}),
  });
}

const older = async (pid: string) =>
  (await listPipelines(OWNER)).pipelines.find((p) => p.id === pid)!.older;

describe('rereadPipeline', () => {
  it('the dry run sends nothing, and its number is the list’s older', async () => {
    file(1, 'a.csv', { id: 'sheet', version: '1.0.0' });
    file(2, 'b.csv', { id: 'sheet', version: '0.9.0' });
    file(3, 'c.xlsx');
    file(4, 'd.csv', { id: 'sheet', version: '1.0.0', options: '0a1b2c3d' });
    file(5, 'e.dwg', { id: 'drawing-cad', version: '0.9.0' });
    const res = await rereadPipeline(OWNER, 'sheet', {});
    expect(res).toEqual({
      ok: true,
      answer: {
        apply: false,
        busy: false,
        choices: [{ pipeline: 'sheet', name: 'Spreadsheet', files: 3, refused: null }],
        queued: 0,
        skipped: {},
        next: null,
      },
    });
    expect(await older('sheet')).toBe(3);
    expect(h.notified).toEqual([]);
    // The count follows the options in force, and the re-read with it.
    h.hash.set('sheet', '0a1b2c3d');
    resetPipelineCounts();
    const again = await rereadPipeline(OWNER, 'sheet', {});
    expect(again.ok && again.answer.choices[0]!.files).toBe(await older('sheet'));
  });

  it('does not read the off list: an older file in a workspace the pipeline is off in is queued', async () => {
    const ws = '00000000-0000-4000-8000-00000000aaaa';
    h.home = ws;
    h.offIn = [ws];
    file(1, 'a.csv', { id: 'sheet', version: '0.9.0' });
    const res = await rereadPipeline(OWNER, 'sheet', { apply: true });
    expect(res).toMatchObject({ ok: true, answer: { queued: 1, skipped: {} } });
    expect(h.notified).toEqual([`sheet ${id(1)}`]);
  });

  it('apply sends one notify for each older file and none for a current one', async () => {
    file(1, 'a.csv', { id: 'sheet', version: '1.0.0' });
    file(2, 'b.csv', { id: 'sheet', version: '0.9.0' });
    file(3, 'c.xlsx');
    const res = await rereadPipeline(OWNER, 'sheet', { apply: true });
    expect(res.ok && res.answer.queued).toBe(2);
    expect(h.notified).toEqual([`sheet ${id(2)}`, `sheet ${id(3)}`]);
  });

  it('a busy queue sends nothing: the dry run walks and says busy; a run walks nothing and keeps next where it came in', async () => {
    for (const n of [1, 2, 3]) file(n, `${n}.csv`, { id: 'sheet', version: '0.9.0' });
    h.busy = true;
    const dry = await rereadPipeline(OWNER, 'sheet', { limit: 1 });
    expect(dry.ok && [dry.answer.busy, dry.answer.choices[0]!.files, dry.answer.next]).toEqual([
      true,
      1,
      id(1),
    ]);
    for (const after of [undefined, id(1)]) {
      const run = await rereadPipeline(OWNER, 'sheet', { apply: true, limit: 1, after });
      expect(run.ok && run.answer).toMatchObject({
        busy: true,
        queued: 0,
        choices: [{ files: 0 }],
        next: after ?? null,
      });
    }
    expect(h.notified).toEqual([]);
  });

  it('takes at most limit older files, and next goes on to the rest', async () => {
    for (const n of [1, 2, 3, 4, 5]) file(n, `${n}.csv`, { id: 'sheet', version: '0.9.0' });
    const first = await rereadPipeline(OWNER, 'sheet', { apply: true, limit: 2 });
    expect(first.ok && [first.answer.queued, first.answer.next]).toEqual([2, id(2)]);
    const second = await rereadPipeline(OWNER, 'sheet', { apply: true, limit: 2, after: id(2) });
    expect(second.ok && [second.answer.queued, second.answer.next]).toEqual([2, id(4)]);
    const last = await rereadPipeline(OWNER, 'sheet', { apply: true, limit: 2, after: id(4) });
    expect(last.ok && [last.answer.queued, last.answer.next]).toEqual([1, null]);
    expect(h.notified).toEqual([1, 2, 3, 4, 5].map((n) => `sheet ${id(n)}`));
  });

  it('looks at no more than its budget of ids a call, and gives next when it found fewer than limit', async () => {
    h.max = 3;
    file(1, 'a.csv', { id: 'sheet', version: '1.0.0' });
    file(2, 'b.csv', { id: 'sheet', version: '1.0.0' });
    file(3, 'c.csv', { id: 'sheet', version: '0.9.0' });
    file(4, 'd.csv', { id: 'sheet', version: '0.9.0' });
    file(5, 'e.csv', { id: 'sheet', version: '1.0.0' });
    const first = await rereadPipeline(OWNER, 'sheet', { limit: 100 });
    expect(first.ok && [first.answer.choices[0]!.files, first.answer.next]).toEqual([1, id(3)]);
    const second = await rereadPipeline(OWNER, 'sheet', { limit: 100, after: id(3) });
    expect(second.ok && [second.answer.choices[0]!.files, second.answer.next]).toEqual([1, null]);
  });

  it('takes the reader of a PDF drawing (MV5): the dry run counts, apply queues, no refusal', async () => {
    file(1, 'a.pdf', { id: 'drawing-pdf', version: '0.9.0' });
    const dry = await rereadPipeline(OWNER, 'drawing-pdf', {});
    expect(dry.ok && dry.answer).toMatchObject({
      choices: [{ pipeline: 'drawing-pdf', files: 1, refused: null }],
      queued: 0,
      skipped: {},
    });
    expect(h.notified).toEqual([]);
    const run = await rereadPipeline(OWNER, 'drawing-pdf', { apply: true });
    expect(run.ok && run.answer).toMatchObject({ queued: 1, skipped: {} });
    expect(h.notified).toHaveLength(1);
  });

  it('refuses a router with its one sentence, on the tool and the route function alike', async () => {
    const { ROUTER_REFUSED } = await import('./pipeline-run');
    file(1, 'a.pdf', { id: 'drawing-pdf', version: '0.9.0' });
    for (const apply of [false, true]) {
      expect(await rereadPipeline(OWNER, 'pdf-router', { apply })).toEqual({
        ok: false,
        error: ROUTER_REFUSED,
      });
      expect(
        await pipeline_reread.handler({ id: 'pdf-router', apply }, {
          ownerId: OWNER,
        } as ToolHandlerContext),
      ).toEqual({ ok: false, error: ROUTER_REFUSED });
    }
    expect(h.notified).toEqual([]);
  });

  it('refuses an own row that does not run with its sentence, and queues nothing', async () => {
    h.own = [{ id: 'lx9-logger', manifest: '{' }];
    for (const apply of [false, true]) {
      expect(await rereadPipeline(OWNER, 'lx9-logger', { apply })).toEqual({
        ok: false,
        error: 'Its pipeline.json is not JSON. Install it again.',
      });
    }
    expect(h.notified).toEqual([]);
  });

  it('a file of text and no tabs counts by the stamp in its word, and the re-read skips it with text', async () => {
    // An own Reader of text at 1.0.1 (docs/pipeline-template/qnote, made up);
    // its file was read at 1.0.0: no database, the word with the stamp.
    const { readFileSync } = await import('node:fs');
    const { writeFileDbNone } = await import('@mantle/files');
    const qnote = JSON.parse(
      readFileSync(
        path.join(import.meta.dirname, '../../../docs/pipeline-template/qnote/pipeline.json'),
        'utf8',
      ),
    ) as Record<string, unknown>;
    h.own = [{ id: 'qnote-field-note', manifest: JSON.stringify({ ...qnote, version: '1.0.1' }) }];
    h.rows.set(id(1), {
      id: id(1),
      path: 'files',
      title: 'walk.qnote',
      data: { filename: 'walk.qnote', sha256: sha(1) },
    });
    await writeFileDbNone(id(1), sha(1), 'no-rows', {
      parsed: true,
      stamp: {
        pipeline_id: 'qnote-field-note',
        pipeline_version: '1.0.0',
        pipeline_api: '1',
        shapes: '',
      },
    });
    const row = (await listPipelines(OWNER)).pipelines.find((p) => p.id === 'qnote-field-note')!;
    expect([row.files, row.older, row.versions]).toEqual([1, 1, [{ version: '1.0.0', files: 1 }]]);
    for (const apply of [false, true]) {
      expect(await rereadPipeline(OWNER, 'qnote-field-note', { apply })).toMatchObject({
        ok: true,
        answer: { choices: [{ files: 1 }], queued: 0, skipped: { text: 1 } },
      });
    }
    expect(h.notified).toEqual([]);
    // The word is still the word for every reader of it.
    const { readFileDbNone } = await import('@mantle/files');
    expect(await readFileDbNone(id(1), sha(1))).toBe('no-rows');
  });

  it('skips a private file and counts it', async () => {
    file(1, 'a.csv', { id: 'sheet', version: '0.9.0' });
    file(2, 'b.csv', { id: 'sheet', version: '0.9.0' });
    h.privateIds.add(id(1));
    const res = await rereadPipeline(OWNER, 'sheet', { apply: true });
    expect(res.ok && res.answer).toMatchObject({ queued: 1, skipped: { private: 1 } });
    expect(h.notified).toEqual([`sheet ${id(2)}`]);
  });

  it('an after pipeline takes only the files with its entry that is not current', async () => {
    file(1, 'a.dwg', { id: 'drawing-cad', version: '1.0.0', after: 'site-tags@1.0.0' });
    file(2, 'b.dwg', { id: 'drawing-cad', version: '1.0.0', after: 'site-tags@0.9.0' });
    file(3, 'c.dwg', { id: 'drawing-cad', version: '1.0.0' });
    file(4, 'd.dxf', undefined, 'other@1.0.0,site-tags@0.9.0');
    const res = await rereadPipeline(OWNER, 'site-tags', { apply: true });
    expect(res.ok && res.answer.choices[0]!.files).toBe(await older('site-tags'));
    expect(h.notified).toEqual([`site-tags ${id(2)}`, `site-tags ${id(4)}`]);
  });

  it('refuses an unknown pipeline, a bad after and a bad limit, with nothing sent', async () => {
    file(1, 'a.csv', { id: 'sheet', version: '0.9.0' });
    expect(await rereadPipeline(OWNER, 'no-such', { apply: true })).toMatchObject({
      ok: false,
      missing: true,
    });
    expect(await rereadPipeline(OWNER, 'sheet', { apply: true, after: 'x' })).toMatchObject({
      ok: false,
    });
    for (const limit of [0, 1001, 1.5, '2']) {
      expect(await rereadPipeline(OWNER, 'sheet', { apply: true, limit })).toMatchObject({
        ok: false,
      });
    }
    expect(h.notified).toEqual([]);
  });
});

describe('pipeline_reread', () => {
  it('writes, MCP only, in the settings area, spends nothing, and is no recipe step', () => {
    expect(pipeline_reread.mcpOnly).toBe(true);
    expect(pipeline_reread.policy).toMatchObject({
      effect: 'write',
      spends: 'none',
      scope: { area: 'settings' },
      recipe: { step: 'forbidden' },
      matrix: { none: 'a pipeline is not an item' },
    });
  });

  it('gives the answer of rereadPipeline', async () => {
    file(1, 'a.csv', { id: 'sheet', version: '0.9.0' });
    const out = await pipeline_reread.handler({ id: 'sheet' }, {
      ownerId: OWNER,
    } as ToolHandlerContext);
    expect(out).toEqual({
      ok: true,
      output: ((await rereadPipeline(OWNER, 'sheet', {})) as { answer: unknown }).answer,
    });
    expect(h.notified).toEqual([]);
  });
});
