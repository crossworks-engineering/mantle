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
  rows: new Map<string, Row>(),
  hash: new Map<string, string>(),
  privateIds: new Set<string>(),
  busy: false,
  max: 5000,
  notified: [] as string[],
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
          home: null,
          filename: row.title,
        }
      : null;
  }),
}));

vi.mock('@mantle/content/pipeline-state', async () => {
  const f = await import('@mantle/files');
  return {
    pipelineStateOf: vi.fn(async (_owner: string, m: import('@mantle/files').PipelineManifest) => ({
      workspaces: f.defaultState(m).workspaces,
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
  h.rows.clear();
  h.hash.clear();
  h.privateIds.clear();
  h.busy = false;
  h.max = 5000;
  h.notified = [];
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

  it('apply sends one notify for each older file and none for a current one', async () => {
    file(1, 'a.csv', { id: 'sheet', version: '1.0.0' });
    file(2, 'b.csv', { id: 'sheet', version: '0.9.0' });
    file(3, 'c.xlsx');
    const res = await rereadPipeline(OWNER, 'sheet', { apply: true });
    expect(res.ok && res.answer.queued).toBe(2);
    expect(h.notified).toEqual([`sheet ${id(2)}`, `sheet ${id(3)}`]);
  });

  it('a busy queue sends nothing, in the dry run and with apply', async () => {
    file(1, 'a.csv', { id: 'sheet', version: '0.9.0' });
    h.busy = true;
    for (const apply of [false, true]) {
      const res = await rereadPipeline(OWNER, 'sheet', { apply });
      expect(res.ok && [res.answer.busy, res.answer.queued, res.answer.choices[0]!.files]).toEqual([
        true,
        0,
        1,
      ]);
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

  it('refuses the reader of a PDF drawing with pdf, and apply sends nothing', async () => {
    file(1, 'a.pdf', { id: 'drawing-pdf', version: '0.9.0' });
    for (const apply of [false, true]) {
      const res = await rereadPipeline(OWNER, 'drawing-pdf', { apply });
      expect(res.ok && res.answer).toMatchObject({
        choices: [{ pipeline: 'drawing-pdf', files: 1, refused: 'pdf' }],
        queued: 0,
        skipped: { pdf: 1 },
      });
    }
    expect(h.notified).toEqual([]);
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
