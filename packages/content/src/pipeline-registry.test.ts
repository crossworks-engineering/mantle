/**
 * The registry over the built-ins: the same answers the helpers bound to
 * the constant gave before it (builtinForExt, routerForExt, readerFor,
 * AFTER_PIPELINES, ACTED_PIPELINES, FILE_DB_EXTS), for every built-in
 * extension and kind; then a box with own rows: a good row runs after the
 * built-ins, and a row that clashes, fails the check, sits on a curated
 * box or whose files are not on disk is a problem that runs nothing. Pure: no database (pipelinesOf is
 * the builder boxPipelines gives the rows of a box).
 */
import { afterEach, describe, expect, it, vi } from 'vitest';
import { CURATED_ONLY } from '@mantle/config';
import { BUILTIN_PIPELINES, PDF_KINDS } from '@mantle/files';
import { BUILTIN_HAS_ID, NOT_ON_DISK, pipelinesOf, type BoxPipeline } from './pipeline-registry';

const pipelines = pipelinesOf([]);

/** The reader of each extension, as builtinForExt gave it. */
const READER_OF: Record<string, string> = {
  xlsx: 'sheet',
  xls: 'sheet',
  csv: 'sheet',
  xml: 'plan-mspdi',
  pdf: 'drawing-pdf',
  dwf: 'plot-dwf',
  dwg: 'drawing-cad',
  dxf: 'drawing-cad',
  dgn: 'drawing-cad',
};

describe('the registry of a box with the built-ins only', () => {
  it('holds every built-in, in its order, as a built-in, with no problem', () => {
    expect(pipelines.all.map((p) => p.id)).toEqual(BUILTIN_PIPELINES.map((p) => p.id));
    expect(pipelines.all.every((p) => p.source === 'builtin')).toBe(true);
    expect(pipelines.problems.size).toBe(0);
    for (const p of BUILTIN_PIPELINES) {
      const { source, ...manifest } = pipelines.byId(p.id)!;
      expect(source).toBe('builtin');
      expect(manifest).toEqual(p);
    }
    expect(pipelines.byId('no-such')).toBeNull();
  });

  it('the reader of each extension, with no kind', () => {
    for (const [ext, id] of Object.entries(READER_OF)) {
      expect(pipelines.readerFor(ext)?.id, ext).toBe(id);
    }
    for (const ext of ['docx', 'txt', 'xlsm', '']) expect(pipelines.readerFor(ext), ext).toBeNull();
  });

  it('the reader of a PDF for each kind the router names: drawing-pdf, none for a document', () => {
    for (const kind of PDF_KINDS) {
      expect(pipelines.readerFor('pdf', kind)?.id ?? null, kind).toBe(
        kind === 'document' ? null : 'drawing-pdf',
      );
    }
    // A kind on a type with no router: the reader of the extension.
    expect(pipelines.readerFor('dxf', 'pid')?.id).toBe('drawing-cad');
  });

  it('the router of a PDF, and of no other type', () => {
    expect(pipelines.routerFor('pdf')?.id).toBe('pdf-router');
    for (const ext of Object.keys(READER_OF).filter((e) => e !== 'pdf')) {
      expect(pipelines.routerFor(ext), ext).toBeNull();
    }
  });

  it('after, acted and dbExts as the derived tables were', () => {
    expect(pipelines.after.map((p) => p.id)).toEqual(['site-tags']);
    expect(pipelines.acted.map((p) => p.id)).toEqual(
      BUILTIN_PIPELINES.map((p) => p.id).filter((id) => id !== 'pdf-router'),
    );
    expect([...pipelines.dbExts]).toEqual(Object.keys(READER_OF));
  });

  it('is built fresh on every call: no answer is shared', () => {
    const again = pipelinesOf([]);
    expect(again).not.toBe(pipelines);
    expect(again.all).not.toBe(pipelines.all);
  });
});

/** A made-up own reader (the template's LX-9 logger). */
const lx9 = (over: Record<string, unknown> = {}) => ({
  id: 'lx9-logger',
  name: 'LX-9 data logger',
  description: 'Reads an LX-9 logger export into its readings and header.',
  version: '1.0.0',
  api: 1,
  kit: 1,
  runtime: 'bun',
  entry: 'step.ts',
  start: 'upload',
  match: { ext: ['lx9'] },
  produces: {},
  needs: { weight: 'light', timeMs: 60000 },
  ...over,
});
const row = (m: unknown, id = 'lx9-logger') => ({
  id,
  manifest: typeof m === 'string' ? m : JSON.stringify(m),
});

describe('the registry of a box with own rows', () => {
  afterEach(() => vi.unstubAllEnvs());

  it('a good own row runs after the built-ins: its reader, its db type, acted, no problem', () => {
    const box = pipelinesOf([row(lx9())]);
    expect(box.all.map((p) => p.id)).toEqual([...BUILTIN_PIPELINES.map((p) => p.id), 'lx9-logger']);
    expect(box.byId('lx9-logger')?.source).toBe('own');
    expect(box.readerFor('lx9')?.id).toBe('lx9-logger');
    expect(box.dbExts.has('lx9')).toBe(true);
    expect(box.acted.map((p) => p.id)).toContain('lx9-logger');
    expect(box.after.map((p) => p.id)).toEqual(['site-tags']);
    expect(box.routerFor('lx9')).toBeNull();
    expect(box.problems.size).toBe(0);
    // A built-in's answers do not change.
    for (const [ext, id] of Object.entries(READER_OF)) expect(box.readerFor(ext)?.id).toBe(id);
  });

  it('a built-in wins an id and an extension: the own row is a problem and runs nothing', () => {
    const box = pipelinesOf([
      row(lx9({ id: 'sheet' }), 'sheet'),
      row(lx9({ id: 'csv-own', match: { ext: ['csv'] } }), 'csv-own'),
    ]);
    expect(box.problems.get('sheet')).toBe(BUILTIN_HAS_ID);
    expect(box.problems.get('csv-own')).toMatch(/A built-in now reads \.csv/);
    expect(box.readerFor('csv')?.id).toBe('sheet');
    expect(box.byId('sheet')?.source).toBe('builtin');
    expect(box.acted.map((p) => p.id)).not.toContain('csv-own');
    expect(box.byId('csv-own')?.source).toBe('own');
  });

  it('two own rows for one extension: the first by id reads it, the other is a problem', () => {
    const box = pipelinesOf([
      row(lx9({ id: 'b-lx9' }), 'b-lx9'),
      row(lx9({ id: 'a-lx9' }), 'a-lx9'),
    ]);
    expect(box.readerFor('lx9')?.id).toBe('a-lx9');
    expect(box.problems.get('b-lx9')).toMatch(/The pipeline a-lx9 now reads \.lx9/);
  });

  it('a manifest that fails the check, is not JSON, or names another id: a problem with a stand-in', () => {
    const box = pipelinesOf([
      row(lx9({ needs: { weight: 'light', workers: { vision: 1 } } })),
      row('{not json', 'broken'),
      row(lx9({ id: 'other' }), 'named-wrong'),
    ]);
    expect(box.problems.get('lx9-logger')).toMatch(
      /no longer passes: An own pipeline asks no AI worker/,
    );
    expect(box.problems.get('broken')).toMatch(/not JSON/);
    expect(box.problems.get('named-wrong')).toMatch(/another id/);
    expect(box.readerFor('lx9')).toBeNull();
    expect(box.byId('lx9-logger')?.name).toBe('LX-9 data logger');
    expect(box.byId('broken')?.match.ext).toEqual([]);
  });

  it('a curated box runs no own row: each is a problem with the one sentence', () => {
    vi.stubEnv('MANTLE_PIPELINES', 'curated');
    const box = pipelinesOf([row(lx9())]);
    expect(box.problems.get('lx9-logger')).toBe(CURATED_ONLY);
    expect(box.readerFor('lx9')).toBeNull();
    expect(box.dbExts.has('lx9')).toBe(false);
  });

  it('a draft takes the place of the row of its id, for the test that runs it only', () => {
    const draft = {
      ...lx9({ version: '2.0.0' }),
      source: 'own',
      draft: '0123456789abcdef',
    } as BoxPipeline;
    const box = pipelinesOf([row(lx9())], draft);
    expect(box.readerFor('lx9')).toBe(draft);
    expect(box.all.filter((p) => p.id === 'lx9-logger')).toHaveLength(1);
  });

  it('a row whose files are not on disk is listed with its problem, runs nothing, and keeps its extension', () => {
    const box = pipelinesOf(
      [row(lx9()), row(lx9({ id: 'z-lx9' }), 'z-lx9')],
      undefined,
      new Set(['lx9-logger']),
    );
    expect(box.problems.get('lx9-logger')).toBe(NOT_ON_DISK);
    expect(box.byId('lx9-logger')?.match.ext).toEqual(['lx9']);
    expect(box.readerFor('lx9')).toBeNull();
    expect(box.dbExts.has('lx9')).toBe(false);
    expect(box.acted.map((p) => p.id)).not.toContain('lx9-logger');
    expect(box.problems.get('z-lx9')).toMatch(/The pipeline lx9-logger now reads \.lx9/);
  });

  it('a stored manifest with the key draft runs nothing: only a test gives a run its draft', () => {
    const box = pipelinesOf([row(lx9({ draft: true }))]);
    expect(box.problems.get('lx9-logger')).toMatch(/no key draft/);
    expect(box.readerFor('lx9')).toBeNull();
  });
});
