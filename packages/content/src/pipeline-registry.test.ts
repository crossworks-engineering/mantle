/**
 * The registry over the built-ins: the same answers the helpers bound to
 * the constant gave before it (builtinForExt, routerForExt, readerFor,
 * AFTER_PIPELINES, ACTED_PIPELINES, FILE_DB_EXTS), for every built-in
 * extension and kind. Pure: no database.
 */
import { describe, expect, it } from 'vitest';
import { BUILTIN_PIPELINES, PDF_KINDS } from '@mantle/files';
import { boxPipelines } from './pipeline-registry';

const pipelines = await boxPipelines('made-up-owner');

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

  it('is built fresh on every call: no answer is shared', async () => {
    const again = await boxPipelines('made-up-owner');
    expect(again).not.toBe(pipelines);
    expect(again.all).not.toBe(pipelines.all);
  });
});
