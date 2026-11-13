/**
 * The built-in pipelines: one for each extension, unique ids, the same nine
 * extensions FILE_DB_EXTS held before the registry, the stamp, and the
 * version pin. Pure; no files root, no database.
 */
import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { FILE_DB_EXTS } from '../file-dbs';
import { PIPELINE_API, type PipelineManifest } from './contract';
import { BUILTIN_PIPELINES, builtinForExt, pipelineStampOf } from './builtin';
import { SHAPES } from './shapes';

describe('the built-in pipelines', () => {
  it('every extension has exactly one built-in, and builtinForExt finds it', () => {
    const seen = new Map<string, string>();
    for (const p of BUILTIN_PIPELINES) {
      for (const ext of p.match.ext) {
        expect(seen.get(ext), `.${ext} is read by ${seen.get(ext)} and ${p.id}`).toBeUndefined();
        seen.set(ext, p.id);
        expect(builtinForExt(ext)?.id).toBe(p.id);
      }
    }
    expect(builtinForExt('docx')).toBeNull();
    expect(builtinForExt('')).toBeNull();
  });

  it('ids are unique and of the id form', () => {
    const ids = BUILTIN_PIPELINES.map((p) => p.id);
    expect(new Set(ids).size).toBe(ids.length);
    for (const id of ids) expect(id).toMatch(/^[a-z0-9-]+$/);
  });

  it('each runs in the core, at upload, on this contract, with a semver version', () => {
    for (const p of BUILTIN_PIPELINES) {
      expect(p.runtime).toBe('core');
      expect(p.start).toBe('upload');
      expect(p.api).toBe(PIPELINE_API);
      expect(p.entry).toBeUndefined();
      expect(p.version).toMatch(/^\d+\.\d+\.\d+$/);
    }
  });

  it('FILE_DB_EXTS is the nine extensions it held before, in the same order', () => {
    expect([...FILE_DB_EXTS]).toEqual([
      'xlsx',
      'xls',
      'csv',
      'xml',
      'pdf',
      'dwf',
      'dwg',
      'dxf',
      'dgn',
    ]);
  });
});

describe('the stamp', () => {
  const cad = builtinForExt('dwg')!;
  const bones = [
    { name: 'Segments', columns: SHAPES['circuit-v1'].tabs[0]!.columns },
    { name: 'Nodes', columns: SHAPES['circuit-v1'].tabs[1]!.columns },
  ];

  it('names the pipeline, its version and the contract, as text', () => {
    expect(pipelineStampOf(builtinForExt('csv')!, [{ name: 'Sheet1', columns: ['A'] }])).toEqual({
      pipeline_id: 'sheet',
      pipeline_version: '1.0.0',
      pipeline_api: String(PIPELINE_API),
      shapes: '',
    });
  });

  it('lists only the promised shapes the tabs carry', () => {
    expect(pipelineStampOf(cad, bones).shapes).toBe('circuit-v1');
    expect(pipelineStampOf(cad, [{ name: 'Layers', columns: ['Layer'] }]).shapes).toBe('');
    const symbols = { name: 'Symbols', columns: ['Key'] };
    expect(pipelineStampOf(cad, [symbols, ...bones]).shapes).toBe('drawing-v1,circuit-v1');
    // A sheet whose tabs happen to look like a PDF's File tab promised nothing.
    const file = { name: 'File', columns: ['Kind', 'Rules kind'] };
    expect(pipelineStampOf(builtinForExt('xlsx')!, [file]).shapes).toBe('');
    expect(pipelineStampOf(builtinForExt('pdf')!, [file]).shapes).toBe('pdf-file-v1');
  });
});

/**
 * The version pin: `id@version` -> a hash of what the manifest says it reads
 * and gives, with the shapes it promises. A change to any of them with no new
 * version fails here. Raise the version and add its line to
 * builtin.pins.json; keep the old lines.
 */
describe('the version pin', () => {
  const pins = JSON.parse(
    readFileSync(new URL('./builtin.pins.json', import.meta.url), 'utf8'),
  ) as Record<string, string>;
  const hashOf = (p: PipelineManifest) =>
    createHash('sha256')
      .update(
        JSON.stringify({
          match: p.match,
          produces: p.produces,
          shapes: (p.produces.shapes ?? []).map((id) => SHAPES[id]),
        }),
      )
      .digest('hex')
      .slice(0, 16);

  it.each(BUILTIN_PIPELINES.map((p) => [`${p.id}@${p.version}`, p] as const))(
    '%s is pinned and unchanged',
    (key, p) => {
      expect(pins[key], `${key} has no pin: add it to builtin.pins.json`).toBeDefined();
      expect(hashOf(p), `${key} changed: raise its version and pin the new one`).toBe(pins[key]);
    },
  );
});
