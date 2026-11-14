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
import {
  AFTER_PIPELINES,
  BUILTIN_PIPELINES,
  afterMatches,
  builtinForExt,
  defaultState,
  isAfterPipeline,
  PIPELINE_STAMP_KEYS,
  pipelineStampOf,
  readersByExt,
  versionBelow,
} from './builtin';
import {
  OPTION_NAME,
  OPTION_WORD_MAX_CHARS,
  OPTION_WORDS_MAX_ITEMS,
  checkOptions,
} from './options';
import { SHAPES, type Shape } from './shapes';

describe('the built-in pipelines', () => {
  const READERS = BUILTIN_PIPELINES.filter((p) => !isAfterPipeline(p));

  it('every extension has exactly one reader, and builtinForExt finds it', () => {
    const seen = new Map<string, string>();
    for (const p of READERS) {
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

  it('builtinForExt never gives a pipeline with match.after (a made-up one here)', () => {
    const reader = builtinForExt('dxf')!;
    const after: PipelineManifest = {
      ...reader,
      id: 'made-up-after',
      match: { ext: ['dxf', 'pdf', 'txt'], after: 'drawing-v1' },
      produces: { tabs: ['Made-up'] },
    };
    for (const list of [
      [after, ...BUILTIN_PIPELINES],
      [...BUILTIN_PIPELINES, after],
    ]) {
      const byExt = readersByExt(list);
      expect(byExt.get('dxf')?.id).toBe('drawing-cad');
      expect(byExt.get('pdf')?.id).toBe('drawing-pdf');
      expect(byExt.has('txt')).toBe(false);
      expect([...byExt.values()].some((p) => p.id === after.id)).toBe(false);
    }
  });

  it('the defaults of the code: a reader is used in every workspace, an after pipeline in none', () => {
    for (const p of READERS) expect(defaultState(p)).toEqual({ workspaces: 'all' });
    for (const p of AFTER_PIPELINES) expect(defaultState(p)).toEqual({ workspaces: [] });
    expect(defaultState({ match: { ext: ['dxf'], after: 'drawing-v1' } })).toEqual({
      workspaces: [],
    });
  });

  it('each declared option has a name of the form, sane bounds, and a default its own check takes as it is (upper case, no doubles, sorted)', () => {
    for (const p of BUILTIN_PIPELINES as readonly PipelineManifest[]) {
      for (const [name, spec] of Object.entries(p.options ?? {})) {
        expect(name, `${p.id}.${name}`).toMatch(OPTION_NAME);
        if (spec.type === 'number') expect(spec.min).toBeLessThanOrEqual(spec.max);
        if (spec.type === 'words') {
          expect(spec.maxItems).toBeLessThanOrEqual(OPTION_WORDS_MAX_ITEMS);
          expect(spec.maxChars).toBeLessThanOrEqual(OPTION_WORD_MAX_CHARS);
        }
        const back = checkOptions(p, { [name]: spec.default });
        expect(back, `${p.id}.${name}`).toEqual({ ok: true, values: { [name]: spec.default } });
      }
    }
  });

  it('the after built-ins: Site tags alone, never a reader, reading the texts-v1 shape', () => {
    expect(AFTER_PIPELINES.map((p) => p.id)).toEqual(['site-tags']);
    for (const ext of ['dwg', 'dxf', 'dgn', 'pdf'])
      expect(builtinForExt(ext)?.id).not.toBe('site-tags');
    const site = AFTER_PIPELINES[0]!;
    expect(site.match.after).toBe('texts-v1');
    expect(site.produces.tabs).toEqual(['Site tags']);
    expect(site.produces.shapes).toBeUndefined();
  });

  it('no reader promises or writes a tab an after pipeline names', () => {
    // The tab names a reader is known to write: the shapes it promises.
    // (The DXF and PDF fixtures' sheet names are held in their own tests;
    // the db test of the chain holds a real CAD build.)
    const owned = new Set(AFTER_PIPELINES.flatMap((p) => p.produces.tabs ?? []));
    for (const p of READERS) {
      for (const shape of p.produces.shapes ?? []) {
        for (const tab of SHAPES[shape].tabs) expect(owned.has(tab.name), tab.name).toBe(false);
      }
    }
    for (const shape of Object.values(SHAPES)) {
      for (const tab of shape.tabs) expect(owned.has(tab.name), tab.name).toBe(false);
    }
  });

  it('the match rule: the extension, and the real tabs carry the shape', () => {
    const site = AFTER_PIPELINES[0]!;
    const texts = [{ name: 'Texts', columns: ['Text', 'Layer'] }];
    expect(afterMatches(site, 'dxf', texts)).toBe(true);
    expect(afterMatches(site, 'pdf', [{ name: 'Texts', columns: ['Page', 'Text'] }])).toBe(true);
    // A spreadsheet with a sheet named Texts: not its extension.
    expect(afterMatches(site, 'xlsx', texts)).toBe(false);
    expect(afterMatches(site, 'csv', texts)).toBe(false);
    // A drawing with no Texts tab, or one with no Text column.
    expect(afterMatches(site, 'dwg', [{ name: 'Layers', columns: ['Layer'] }])).toBe(false);
    expect(afterMatches(site, 'dwg', [{ name: 'Texts', columns: ['Layer'] }])).toBe(false);
    // A reader never matches as an after pipeline.
    expect(afterMatches(builtinForExt('dxf')!, 'dxf', texts)).toBe(false);
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

describe('versionBelow', () => {
  it('compares versions as numbers, not as text', () => {
    expect(versionBelow('1.9.0', '1.10.0')).toBe(true);
    expect(versionBelow('1.10.0', '1.9.0')).toBe(false);
    expect(versionBelow('1.0.0', '1.0.0')).toBe(false);
    expect(versionBelow('0.9.9', '1.0.0')).toBe(true);
    expect(versionBelow('2.0.0', '1.99.99')).toBe(false);
    expect(versionBelow('1.0.9', '1.0.10')).toBe(true);
  });

  it('a version that is not x.y.z is lower', () => {
    expect(versionBelow('', '1.0.0')).toBe(true);
    expect(versionBelow('1.0', '1.0.0')).toBe(true);
    expect(versionBelow('v1.0.0', '1.0.0')).toBe(true);
    expect(versionBelow('one', '1.0.0')).toBe(true);
  });

  it('is false when b is not x.y.z', () => {
    expect(versionBelow('1.0.0', 'one')).toBe(false);
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

  it('with the defaults it is the phase 1 stamp, key for key: no options key', () => {
    const tabs = [{ name: 'Sheet1', columns: ['A'] }];
    for (const p of BUILTIN_PIPELINES.filter((x) => !isAfterPipeline(x))) {
      expect(Object.keys(pipelineStampOf(p, tabs))).toEqual([
        'pipeline_id',
        'pipeline_version',
        'pipeline_api',
        'shapes',
      ]);
      expect(pipelineStampOf(p, tabs, '')).toEqual(pipelineStampOf(p, tabs));
    }
    expect(pipelineStampOf(cad, bones, '0a1b2c3d')).toMatchObject({ pipeline_options: '0a1b2c3d' });
    // The read list: the four of phase 1 first, then the two new keys.
    expect(PIPELINE_STAMP_KEYS.slice(0, 4)).toEqual([
      'pipeline_id',
      'pipeline_version',
      'pipeline_api',
      'shapes',
    ]);
    expect(PIPELINE_STAMP_KEYS.slice(4)).toEqual(['pipeline_options', 'pipelines_after']);
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
 * The version pin: `id@version` -> a hash of what a version promises: the
 * manifest's `match` and `produces`, each option's name, type, default and
 * bounds (min, max, maxItems, maxChars), and for each promised shape its id,
 * its needed tabs and their needed columns. A change to any of them with no
 * new version fails here, so a new default or a narrower bound needs a new
 * version. An optional tab or column added to a shape is no new promise, and
 * needs no new version. Raise the version and add its line to
 * builtin.pins.json; keep the old lines.
 *
 * The options are in the hash only when a manifest declares some, so a
 * pipeline with none keeps its phase 1 pin.
 */
describe('the version pin', () => {
  const pins = JSON.parse(
    readFileSync(new URL('./builtin.pins.json', import.meta.url), 'utf8'),
  ) as Record<string, string>;
  const hashOf = (p: PipelineManifest, shapes: typeof SHAPES = SHAPES) =>
    createHash('sha256')
      .update(
        JSON.stringify({
          match: p.match,
          produces: p.produces,
          ...(Object.keys(p.options ?? {}).length > 0
            ? {
                options: Object.entries(p.options ?? {}).map(([name, o]) => ({
                  name,
                  type: o.type,
                  default: o.default,
                  ...(o.type === 'number' ? { min: o.min, max: o.max } : {}),
                  ...(o.type === 'words' ? { maxItems: o.maxItems, maxChars: o.maxChars } : {}),
                })),
              }
            : {}),
          shapes: (p.produces.shapes ?? []).map((id) => ({
            id,
            tabs: shapes[id].tabs
              .filter((t) => t.needed)
              .map((t) => ({ name: t.name, neededColumns: t.neededColumns })),
          })),
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

  it('an optional column added to a shape changes no pin; a needed one does', () => {
    const cad = builtinForExt('dwg')!;
    const circuit = SHAPES['circuit-v1'];
    const withTabs = (tabs: Shape['tabs']) => ({
      ...SHAPES,
      'circuit-v1': { ...circuit, tabs },
    });
    const optional = circuit.tabs.map((t) =>
      t.name === 'Blocks' ? { ...t, columns: [...t.columns, 'Made-up'] } : t,
    );
    expect(hashOf(cad, withTabs(optional))).toBe(hashOf(cad));
    const needed = circuit.tabs.map((t) =>
      t.name === 'Nodes' ? { ...t, neededColumns: [...t.neededColumns, 'Made-up'] } : t,
    );
    expect(hashOf(cad, withTabs(needed))).not.toBe(hashOf(cad));
  });

  it("an option's name, type, default or bound moves the pin; its label does not", () => {
    const cad = builtinForExt('dwg')!;
    const opt = (o: Partial<{ label: string; default: number; min: number; max: number }> = {}) =>
      ({
        ...cad,
        options: {
          box_mm: { type: 'number', label: 'Box', default: 10, min: 1, max: 100, ...o },
        },
      }) as PipelineManifest;
    expect(hashOf(opt())).not.toBe(hashOf(cad));
    expect(hashOf(opt({ label: 'Other words' }))).toBe(hashOf(opt()));
    expect(hashOf(opt({ default: 11 }))).not.toBe(hashOf(opt()));
    expect(hashOf(opt({ max: 50 }))).not.toBe(hashOf(opt()));
    expect(hashOf(opt({ min: 5 }))).not.toBe(hashOf(opt()));
    const words = (o: Partial<{ maxItems: number; maxChars: number }> = {}) =>
      ({
        ...cad,
        options: {
          not_tags: {
            type: 'words',
            label: 'Not tags',
            default: [],
            maxItems: 10,
            maxChars: 8,
            ...o,
          },
        },
      }) as PipelineManifest;
    expect(hashOf(words({ maxItems: 5 }))).not.toBe(hashOf(words()));
    expect(hashOf(words({ maxChars: 4 }))).not.toBe(hashOf(words()));
    // No options and an empty set are the same: no options key in the hash.
    expect(hashOf({ ...cad, options: {} } as PipelineManifest)).toBe(hashOf(cad));
    const renamed = { ...cad, options: { box_cm: opt().options!.box_mm! } } as PipelineManifest;
    expect(hashOf(renamed)).not.toBe(hashOf(opt()));
  });
});
