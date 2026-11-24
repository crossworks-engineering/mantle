/**
 * The built-in pipelines: one for each extension, unique ids, the same nine
 * extensions FILE_DB_EXTS held before the registry (dbExtsOf), each passing
 * the one manifest check (checkManifest), the stamp, and the version pin.
 * Pure; no files root, no database.
 */
import { createHash } from 'node:crypto';
import { existsSync, readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { FILE_KIND_ORDER, PDF_KINDS } from '../pdf-kind';
import { extractWeightOfExt, SOME_FILES_EXTS } from '../slug';
import {
  PIPELINE_API,
  PIPELINE_ASK_PAGE_MAX,
  PIPELINE_DESCRIPTION_MAX,
  PIPELINE_PICTURES_MAX_BYTES,
  PIPELINE_WINDOW_DEFAULT,
  type PipelineManifest,
} from './contract';
import {
  BUILTIN_PIPELINES,
  afterMatches,
  asksMaxOf,
  dbExtsOf,
  defaultState,
  isAfterPipeline,
  isAgent,
  isReader,
  isRouter,
  PIPELINE_STAMP_KEYS,
  pipelineStampOf,
  readerFor,
  readersByExt,
  roleOf,
  routerFor,
  versionBelow,
} from './builtin';
import { checkManifest } from './manifest-check';
import {
  OPTION_NAME,
  OPTION_WORD_MAX_CHARS,
  OPTION_WORDS_MAX_ITEMS,
  checkOptions,
} from './options';
import { SHAPES, type Shape } from './shapes';

describe('the built-in pipelines', () => {
  // A router is not a reader, as an `after` pipeline is not one.
  const READERS = BUILTIN_PIPELINES.filter(isReader);
  const AFTER = BUILTIN_PIPELINES.filter(isAfterPipeline);

  it('each passes the one manifest check, as a built-in', () => {
    for (const p of BUILTIN_PIPELINES) {
      expect(checkManifest(p, 'builtin'), p.id).toEqual({ ok: true, manifest: p });
    }
  });

  it('every extension has one reader by extension, and readerFor finds it; a second claims kinds only', () => {
    const seen = new Map<string, string>();
    for (const p of READERS) {
      for (const ext of p.match.ext) {
        const first = seen.get(ext);
        if (first !== undefined) {
          // The book reader: a second reader of a routed type, of the kinds
          // the first does not claim.
          const firstKinds = READERS.find((r) => r.id === first)!.match.kind ?? [];
          const kinds = (p.match as PipelineManifest['match']).kind ?? [];
          expect(kinds.length, `.${ext} is read by ${first} and ${p.id}`).toBeGreaterThan(0);
          expect(routerFor(BUILTIN_PIPELINES, ext), ext).not.toBeNull();
          for (const k of kinds) expect(firstKinds as readonly string[]).not.toContain(k);
          expect(readerFor(BUILTIN_PIPELINES, ext)?.id).toBe(first);
          continue;
        }
        seen.set(ext, p.id);
        expect(readerFor(BUILTIN_PIPELINES, ext)?.id).toBe(p.id);
      }
    }
    expect(readerFor(BUILTIN_PIPELINES, 'docx')).toBeNull();
    expect(readerFor(BUILTIN_PIPELINES, '')).toBeNull();
  });

  it('each has a description of 1 to 300 plain characters', () => {
    expect(PIPELINE_DESCRIPTION_MAX).toBe(300);
    for (const p of BUILTIN_PIPELINES) {
      expect(p.description.trim().length, p.id).toBeGreaterThan(0);
      expect(p.description.length, p.id).toBeLessThanOrEqual(PIPELINE_DESCRIPTION_MAX);
      // Plain text: one line, no markup.
      expect(p.description, p.id).not.toMatch(/[\n<>`*#]|\u2014|\u2013/);
    }
  });

  it('ids are unique and of the id form', () => {
    const ids = BUILTIN_PIPELINES.map((p) => p.id);
    expect(new Set(ids).size).toBe(ids.length);
    for (const id of ids) expect(id).toMatch(/^[a-z0-9-]+$/);
  });

  it('each is a package (bun, step.ts; or python, a file of the CAD tier), at upload, on this contract, with a semver version', () => {
    for (const p of BUILTIN_PIPELINES) {
      const m = p as PipelineManifest;
      expect(['bun', 'python']).toContain(m.runtime);
      expect(p.start, p.id).toBe('upload');
      expect(p.api).toBe(PIPELINE_API);
      if (m.runtime === 'bun') expect(m.entry).toBe('step.ts');
      else {
        // The parser runs it from its CAD tier folder (builtinPythonEntry).
        expect(m.entry).toMatch(/^[a-z_]+\.py$/);
        const file = new URL(`../../../../server/parser/cad/${m.entry}`, import.meta.url);
        expect(existsSync(file), `${p.id}: no ${m.entry}`).toBe(true);
      }
      expect(p.version).toMatch(/^\d+\.\d+\.\d+$/);
    }
  });

  it('the python built-ins are drawing-raster and pdf-pages, model-free, with no automatic Table', () => {
    const python = BUILTIN_PIPELINES.filter((p) => (p.runtime as string) === 'python');
    expect(python.map((p) => p.id)).toEqual(['drawing-raster', 'pdf-pages']);
    const book = python[1] as PipelineManifest;
    expect(book.needs.workers).toBeUndefined();
    expect(book.produces).toEqual({ text: true, table: false, pages: true });
    expect(book.match).toEqual({ ext: ['pdf'], kind: ['book'] });
    expect(book.needs.window).toEqual(PIPELINE_WINDOW_DEFAULT);
    expect(Object.keys(book.options ?? {})).toEqual(['text_min_chars', 'tables']);
    const iso = python[0] as PipelineManifest;
    expect(iso.needs.workers).toBeUndefined();
    expect(iso.produces).toEqual({ text: true, pictures: true, table: false });
    expect(iso.match.ext).toEqual(['tif', 'tiff', 'smf', '000']);
    // Its types are among those whose Reader takes only some files.
    for (const ext of ['xml', ...iso.match.ext]) expect(SOME_FILES_EXTS.has(ext), ext).toBe(true);
    expect(SOME_FILES_EXTS.size).toBe(5);
  });

  // The extract lane comes from the extension (extractWeightOfExt), not from
  // where a reader runs: a heavy type stays one at a time, in the core or as
  // a package (the pipelineRun job is one pass of that one extract).
  it('a reader names the weight of its extensions', () => {
    // An Agent is no reader: its weight is its own job's, not a lane of
    // the extract.
    for (const p of BUILTIN_PIPELINES.filter((b) => !('after' in b.match) && !isAgent(b))) {
      for (const ext of p.match.ext)
        expect(extractWeightOfExt(ext), `${p.id} ${ext}`).toBe(p.needs.weight);
    }
  });

  it('readerFor never gives a pipeline with match.after (a made-up one here)', () => {
    const reader = readerFor(BUILTIN_PIPELINES, 'dxf')!;
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

  it('the defaults of the code: one form for every pipeline, an empty off list (on everywhere)', () => {
    expect(defaultState()).toEqual({ offIn: [] });
    // A fresh list each call: no caller can change the default of another.
    expect(defaultState().offIn).not.toBe(defaultState().offIn);
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

  it('the after built-ins: Site tags and Links, never a reader, each reading its shape', () => {
    expect(AFTER.map((p) => p.id)).toEqual(['site-tags', 'links']);
    for (const ext of ['dwg', 'dxf', 'dgn', 'pdf'])
      for (const id of ['site-tags', 'links'])
        expect(readerFor(BUILTIN_PIPELINES, ext)?.id).not.toBe(id);
    const site = AFTER[0]!;
    expect(site.match.after).toBe('texts-v1');
    expect(site.produces.tabs).toEqual(['Site tags']);
    expect(site.produces.shapes).toBeUndefined();
    const links = AFTER[1]!;
    expect(links.match).toEqual({ ext: ['pdf'], after: 'pages-v1' });
    expect(links.produces.tabs).toEqual(['Links', 'Link nodes']);
    expect(links.produces.shapes).toBeUndefined();
  });

  it('no reader promises or writes a tab an after pipeline names', () => {
    // The tab names a reader is known to write: the shapes it promises.
    // (The DXF and PDF fixtures' sheet names are held in their own tests;
    // the db test of the chain holds a real CAD build.)
    const owned = new Set(AFTER.flatMap((p) => p.produces.tabs ?? []));
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
    const site = AFTER[0]!;
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
    expect(afterMatches(readerFor(BUILTIN_PIPELINES, 'dxf')!, 'dxf', texts)).toBe(false);
  });

  it("dbExtsOf is the nine extensions FILE_DB_EXTS held before, in the same order, then the raster reader's four and the mail reader's three", () => {
    expect([...dbExtsOf(BUILTIN_PIPELINES)]).toEqual([
      'xlsx',
      'xls',
      'csv',
      'xml',
      'pdf',
      'dwf',
      'dwg',
      'dxf',
      'dgn',
      'tif',
      'tiff',
      'smf',
      '000',
      'eml',
      'msg',
      'mbox',
    ]);
  });
});

describe('the roles', () => {
  const AGENTS = BUILTIN_PIPELINES.filter(isAgent);

  it('roleOf names the role of each built-in', () => {
    expect(Object.fromEntries(BUILTIN_PIPELINES.map((p) => [p.id, roleOf(p)]))).toEqual({
      sheet: 'reader',
      'plan-mspdi': 'reader',
      'pdf-router': 'router',
      'drawing-pdf': 'reader',
      'plot-dwf': 'reader',
      'drawing-cad': 'reader',
      'drawing-raster': 'reader',
      mail: 'reader',
      'site-tags': 'after',
      'iso-title-block': 'agent',
      links: 'after',
      'pdf-sheet-read': 'agent',
      'pdf-pages': 'reader',
      'pdf-page-read': 'agent',
    });
  });

  it('only a router and an Agent ask a model: a Reader and a Transformer have no needs.workers', () => {
    for (const p of BUILTIN_PIPELINES as readonly PipelineManifest[]) {
      const asks = Object.keys(p.needs.workers ?? {}).length > 0;
      expect(asks, p.id).toBe(roleOf(p) === 'router' || roleOf(p) === 'agent');
      expect(asksMaxOf(p) > 0, p.id).toBe(asks);
    }
  });

  it('an Agent gets the file, writes one tab and at most a list tab, and reads no other database', () => {
    expect(AGENTS.map((p) => p.id)).toEqual(['iso-title-block', 'pdf-sheet-read', 'pdf-page-read']);
    for (const p of AGENTS as readonly PipelineManifest[]) {
      expect(p.input, p.id).toBe('file');
      expect(p.produces.tabs?.length, p.id).toBeGreaterThanOrEqual(1);
      expect(p.produces.tabs?.length, p.id).toBeLessThanOrEqual(2);
      expect(p.match.after, p.id).toBeUndefined();
      expect(p.router, p.id).toBeUndefined();
    }
    // Only an Agent names its input.
    for (const p of BUILTIN_PIPELINES as readonly PipelineManifest[]) {
      if (!isAgent(p)) expect(p.input, p.id).toBeUndefined();
    }
  });

  it('no two pipelines of one file type declare the same tab', () => {
    // The Agents' tabs and the Transformers' tabs go into the database of
    // one file type: two of them with one tab name there would write over
    // each other. Two file types may each have a `Title block`.
    const all = BUILTIN_PIPELINES as readonly PipelineManifest[];
    const exts = new Set(all.flatMap((p) => p.match.ext));
    for (const ext of exts) {
      const tabs = all
        .filter((p) => p.match.ext.includes(ext))
        .flatMap((p) => p.produces.tabs ?? []);
      expect(new Set(tabs).size, ext).toBe(tabs.length);
    }
    expect(all.flatMap((p) => p.produces.tabs ?? []).length).toBeGreaterThan(1);
  });

  it('an Agent is no Reader: the reader of its extensions is a built-in Reader, never the Agent', () => {
    const byExt = readersByExt(BUILTIN_PIPELINES);
    const readerOf: Record<string, string> = {
      'iso-title-block': 'drawing-raster',
      'pdf-sheet-read': 'drawing-pdf',
      // By extension; the book's database is the book reader's (pdf-pages,
      // by the kind `book`).
      'pdf-page-read': 'drawing-pdf',
    };
    for (const p of AGENTS) {
      expect(isReader(p)).toBe(false);
      for (const ext of p.match.ext) {
        expect(dbExtsOf(BUILTIN_PIPELINES).has(ext), ext).toBe(true);
        expect(byExt.get(ext)?.id, ext).toBe(readerOf[p.id]);
        expect(readerFor(BUILTIN_PIPELINES, ext)?.id, ext).toBe(readerOf[p.id]);
      }
    }
    expect(routerFor(BUILTIN_PIPELINES, 'tif')).toBeNull();
    expect(routerFor(BUILTIN_PIPELINES, 'pdf')?.id).toBe('pdf-router');
    // The database comes from the Reader alone: in a list with no reader of
    // these extensions, the Agent gives them none.
    const noReader = BUILTIN_PIPELINES.filter((p) => p.id !== 'drawing-raster');
    for (const ext of ['tif', 'tiff', 'smf', '000']) {
      expect(dbExtsOf(noReader).has(ext), ext).toBe(false);
      expect(readerFor(noReader, ext), ext).toBeNull();
    }
    // The Agent stands after its Reader in the list.
    const ids: string[] = BUILTIN_PIPELINES.map((p) => p.id);
    expect(ids.indexOf('iso-title-block')).toBeGreaterThan(ids.indexOf('drawing-raster'));
    expect(ids.indexOf('pdf-sheet-read')).toBeGreaterThan(ids.indexOf('drawing-pdf'));
    expect(ids.indexOf('pdf-page-read')).toBeGreaterThan(ids.indexOf('pdf-pages'));
  });

  it('the book Agent: one tab, text by page, vision one ask a page, in the book windows', () => {
    const agent = AGENTS.find((p) => p.id === 'pdf-page-read')! as PipelineManifest;
    // A book, and since 1.3.0 (M4) every kind the drawing reader claims:
    // the office-lane pages of a PDF drawing.
    const drawing = BUILTIN_PIPELINES.find((p) => p.id === 'drawing-pdf')!;
    expect(agent.match).toEqual({ ext: ['pdf'], kind: ['book', ...drawing.match.kind!] });
    expect(agent.produces).toEqual({ tabs: ['Page text'], pages: true });
    expect(agent.needs).toEqual({
      weight: 'heavy',
      timeMs: 240_000,
      workers: { vision: PIPELINE_ASK_PAGE_MAX },
      window: { pages: 15, mb: PIPELINE_WINDOW_DEFAULT.mb },
    });
    // 15 pictures of PICTURE_MAX_BYTES fit one answer.
    expect(15 * 4 * 1024 * 1024).toBeLessThanOrEqual(PIPELINE_PICTURES_MAX_BYTES);
    expect(Object.keys(agent.options ?? {})).toEqual(['pages']);
    const pages = agent.options!.pages!;
    expect(pages.type === 'number' && [pages.default, pages.max]).toEqual([
      10_000,
      PIPELINE_ASK_PAGE_MAX,
    ]);
  });

  it('the PDF Agent: two tabs, the vision worker 31 times at most, two options', () => {
    const agent = AGENTS.find((p) => p.id === 'pdf-sheet-read')! as PipelineManifest;
    // Its kinds are the core's check (1.2.0, M4): a book's drawing pages too.
    expect(agent.match).toEqual({
      ext: ['pdf'],
      kind: ['scan', 'isometric', 'unsure', 'other_drawing', 'book'],
    });
    expect(agent.produces).toEqual({ tabs: ['Title block', 'Sheet list'] });
    expect(agent.needs).toEqual({ weight: 'heavy', timeMs: 240_000, workers: { vision: 31 } });
    expect(asksMaxOf(agent)).toBe(31);
    expect(Object.keys(agent.options ?? {})).toEqual(['more_fields', 'pages']);
    // The page cap and the ask cap agree: three asks a page (the whole page
    // and its two halves), page 1 one more (its title block corner).
    const pages = agent.options!.pages!;
    expect(pages.type === 'number' && 3 * pages.max + 1).toBe(31);
    expect(agent.version).toBe('1.2.0');
  });

  it('the first Agent: the title block of a raster or plot isometric, two vision asks at most', () => {
    const agent = AGENTS[0]!;
    expect(agent.match).toEqual({ ext: ['tif', 'tiff', 'smf', '000'] });
    expect(agent.produces).toEqual({ tabs: ['Title block'] });
    expect(agent.needs).toEqual({ weight: 'heavy', timeMs: 120_000, workers: { vision: 2 } });
    expect(asksMaxOf(agent)).toBe(2);
    expect(agent.version).toBe('1.0.0');
  });
});

describe('the PDF router', () => {
  const router = routerFor(BUILTIN_PIPELINES, 'pdf')!;
  const reader = readerFor(BUILTIN_PIPELINES, 'pdf')!;
  const named = (router.produces.kinds ?? []).map((k) => k.kind);

  it('is the one router: of pdf, never a reader, with no options, tabs or shapes', () => {
    expect(BUILTIN_PIPELINES.filter(isRouter).map((p) => p.id)).toEqual(['pdf-router']);
    expect(router.router).toBe(true);
    expect(router.match).toEqual({ ext: ['pdf'] });
    for (const ext of ['dwg', 'dxf', 'xlsx', 'csv', 'xml', 'dwf', 'docx', '']) {
      expect(routerFor(BUILTIN_PIPELINES, ext), ext).toBeNull();
    }
    expect(isReader(router)).toBe(false);
    expect(isAfterPipeline(router)).toBe(false);
    expect(reader.id).toBe('drawing-pdf');
    expect(readersByExt(BUILTIN_PIPELINES).get('pdf')?.id).toBe('drawing-pdf');
    expect(router.options).toBeUndefined();
    expect(router.produces.tabs).toBeUndefined();
    expect(router.produces.shapes).toBeUndefined();
  });

  it('names the eleven kinds of PDF_KINDS, and marks the four the rules never give as the decider answer', () => {
    expect(named).toHaveLength(11);
    expect(new Set(named)).toEqual(new Set(PDF_KINDS));
    const byRules = (router.produces.kinds ?? []).filter((k) => !k.decider).map((k) => k.kind);
    // The page rules' kinds, and `book` by its own rule (bookOf).
    expect(new Set(byRules)).toEqual(new Set([...FILE_KIND_ORDER, 'book']));
    const byDecider = (router.produces.kinds ?? []).filter((k) => k.decider).map((k) => k.kind);
    expect(byDecider.sort()).toEqual(['datasheet', 'equipment_drawing', 'pfd', 'table']);
  });

  it('states its ask: the decider, once a file (its step) and once a page, to the page cap (M3)', () => {
    expect(router.needs.workers).toEqual({ decider: PIPELINE_ASK_PAGE_MAX });
    expect(router.needs.weight).toBe('light');
  });

  it('drawing-pdf claims every kind the router names but document and book', () => {
    expect([...(reader.match.kind ?? [])].sort()).toEqual(
      named.filter((k) => k !== 'document' && k !== 'book').sort(),
    );
    // 1.1.1: the File tab's Rules version 3 (the kind `book`); 1.1.2: rules 4;
    // 1.1.3: rules 5; 1.1.4: the page types in Pages (M3); 1.1.5: Kind
    // from `decider` (M4); 1.1.6: the File tab's scan pages not read.
    expect(reader.version).toBe('1.1.6');
  });

  it('the lookup: the reader that claims the kind; no kind, the ranked list; no claim, nothing', () => {
    for (const kind of named) {
      expect(readerFor(BUILTIN_PIPELINES, 'pdf', kind)?.id ?? null, kind).toBe(
        kind === 'document' ? null : kind === 'book' ? 'pdf-pages' : 'drawing-pdf',
      );
    }
    expect(readerFor(BUILTIN_PIPELINES, 'pdf')?.id).toBe('drawing-pdf');
    expect(readerFor(BUILTIN_PIPELINES, 'pdf', 'made_up')).toBeNull();
    // No router for the type: the ranked list, whatever the kind.
    expect(readerFor(BUILTIN_PIPELINES, 'dwg')?.id).toBe('drawing-cad');
    expect(readerFor(BUILTIN_PIPELINES, 'dwg', 'pid')?.id).toBe('drawing-cad');
    expect(readerFor(BUILTIN_PIPELINES, 'csv', 'document')?.id).toBe('sheet');
    expect(readerFor(BUILTIN_PIPELINES, 'docx')).toBeNull();
    expect(readerFor(BUILTIN_PIPELINES, 'docx', 'pid')).toBeNull();
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
  const cad = readerFor(BUILTIN_PIPELINES, 'dwg')!;
  const bones = [
    { name: 'Segments', columns: SHAPES['circuit-v1'].tabs[0]!.columns },
    { name: 'Nodes', columns: SHAPES['circuit-v1'].tabs[1]!.columns },
  ];

  it('names the pipeline, its version and the contract, as text', () => {
    expect(
      pipelineStampOf(readerFor(BUILTIN_PIPELINES, 'csv')!, [{ name: 'Sheet1', columns: ['A'] }]),
    ).toEqual({
      pipeline_id: 'sheet',
      pipeline_version: '1.0.0',
      pipeline_api: String(PIPELINE_API),
      shapes: '',
    });
  });

  it('with the defaults it is the phase 1 stamp, key for key: no options key', () => {
    const tabs = [{ name: 'Sheet1', columns: ['A'] }];
    for (const p of BUILTIN_PIPELINES.filter(isReader)) {
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
    expect(pipelineStampOf(readerFor(BUILTIN_PIPELINES, 'xlsx')!, [file]).shapes).toBe('');
    expect(pipelineStampOf(readerFor(BUILTIN_PIPELINES, 'pdf')!, [file]).shapes).toBe(
      'pdf-file-v1',
    );
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
    const cad = readerFor(BUILTIN_PIPELINES, 'dwg')!;
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
    const cad = readerFor(BUILTIN_PIPELINES, 'dwg')!;
    const opt = (o: Partial<{ label: string; default: number; min: number; max: number }> = {}) =>
      ({
        ...cad,
        options: {
          box_mm: { type: 'number', label: 'Box', default: 10, min: 1, max: 100, ...o },
        },
      }) as PipelineManifest;
    expect(hashOf(opt())).not.toBe(hashOf(cad));
    expect(hashOf(opt({ label: 'Other words' }))).toBe(hashOf(opt()));
    // The description is not in the pin: it says nothing about the rows.
    expect(hashOf({ ...cad, description: 'Other words.' })).toBe(hashOf(cad));
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

describe('the package index (./pkg/index.ts)', () => {
  it('each built-in with runtime bun has a key, and each key is such a built-in', async () => {
    const { BUILTIN_PIPELINES: all } = await import('./builtin');
    const { PIPELINE_PACKAGES } = await import('./pkg');
    const bun = all.filter((p) => (p.runtime as string) === 'bun').map((p) => p.id);
    expect(Object.keys(PIPELINE_PACKAGES).sort()).toEqual([...bun].sort());
    for (const p of all) {
      // A Bun package names step.ts; a Python one its file of the CAD tier.
      if ((p.runtime as string) === 'bun') expect((p as PipelineManifest).entry).toBe('step.ts');
      else expect((p as PipelineManifest).entry).toMatch(/\.py$/);
    }
  });

  it('every step of the index loads and is a function (the boot smoke does the same)', async () => {
    const { loadEveryStep, PIPELINE_PACKAGES } = await import('./pkg');
    expect(await loadEveryStep()).toBe(Object.keys(PIPELINE_PACKAGES).length);
  });

  it('the test-only package is not in the index of the image', async () => {
    const { PIPELINE_PACKAGES } = await import('./pkg');
    expect(Object.hasOwn(PIPELINE_PACKAGES, 'test-echo')).toBe(false);
  });
});
