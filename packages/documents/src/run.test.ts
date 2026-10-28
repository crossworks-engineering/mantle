/**
 * The runner: the form the engine receives (parts, the node URL and cookie,
 * the node defaults a caller did not set, the options), and the answer
 * landed by the export rules or handed back as bytes; a JSON route saves
 * nothing. The engine is a stubbed fetch; the file store a stubbed
 * saveExport.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const saved = vi.hoisted(() => ({ calls: [] as Record<string, unknown>[] }));
vi.mock('@mantle/files', () => ({
  readFileById: vi.fn(),
  saveExport: vi.fn(async (a: Record<string, unknown>) => {
    saved.calls.push(a);
    return {
      file: {
        id: 'f-new',
        filename: a.filename,
        parentPath: 'files.auto_filed.exports',
        sizeBytes: (a.bytes as Buffer).length,
        mimeType: 'application/pdf',
      },
      autoFiled: true,
      landedIn: { id: 'ws-admin', name: 'Admin' },
    };
  }),
}));
vi.mock('@mantle/db', () => ({ db: {}, nodes: {} }));

import { resetServicesFileCache } from '@mantle/config';
import {
  buildForm,
  extensionFor,
  outputStem,
  PAGE_WAIT_EXPRESSION,
  routeFor,
  runDocuments,
} from './run';
import { findRoute } from './routes';
import type { InputDeps } from './inputs';

const PDF = 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb';
const PAGE = '11111111-1111-4111-8111-111111111111';
const deps: InputDeps = {
  readFile: async (_o, id) =>
    id === PDF ? { filename: 'report.pdf', bytes: Buffer.from('%PDF') } : null,
  nodeKind: async (_o, id) => (id === PAGE ? 'page' : null),
};
const caller = { ownerId: 'o1', actorLoginId: '44444444-4444-4444-8444-444444444444' };
const KEYS = [
  'GOTENBERG_URL',
  'GOTENBERG_PASSWORD',
  'MANTLE_COMPOSE_PROFILES',
  'MANTLE_UPDATE_SIGNAL_DIR',
  'SESSION_SECRET',
  'MANTLE_PRINT_ORIGIN',
] as const;
const env: Record<string, string | undefined> = {};
let posted: { url: string; form: FormData; headers: Record<string, string> }[] = [];

function engine(status: number, body: string | Buffer, headers: Record<string, string> = {}) {
  vi.stubGlobal('fetch', async (url: string, init: RequestInit) => {
    posted.push({
      url,
      form: init.body as FormData,
      headers: init.headers as Record<string, string>,
    });
    return new Response(typeof body === 'string' ? body : new Uint8Array(body), {
      status,
      headers,
    });
  });
}
const field = (form: FormData, name: string) => form.get(name);

beforeEach(() => {
  for (const k of KEYS) env[k] = process.env[k];
  process.env.GOTENBERG_URL = 'http://gotenberg:3000';
  process.env.GOTENBERG_PASSWORD = 'pw';
  process.env.SESSION_SECRET = 'a-session-secret-of-at-least-32-characters';
  process.env.MANTLE_PRINT_ORIGIN = 'http://web:3000';
  process.env.MANTLE_UPDATE_SIGNAL_DIR = '/nonexistent-signal-dir';
  delete process.env.MANTLE_COMPOSE_PROFILES;
  resetServicesFileCache();
  posted = [];
  saved.calls.length = 0;
});
afterEach(() => {
  for (const k of KEYS) {
    if (env[k] === undefined) delete process.env[k];
    else process.env[k] = env[k];
  }
  resetServicesFileCache();
  vi.unstubAllGlobals();
});

describe('buildForm', () => {
  it('a node print: url, the cookie, and the page defaults the caller did not set', async () => {
    const { form, stem, exportOf } = await buildForm(
      { route: 'chromium/convert/url', inputs: { node_id: PAGE } },
      caller,
      deps,
    );
    expect(field(form, 'url')).toBe(`http://web:3000/print/pages/${PAGE}`);
    expect(String(field(form, 'cookies'))).toContain('mantle_render');
    expect(field(form, 'failOnHttpStatusCodes')).toBe('[403,404,499,599]');
    expect(field(form, 'waitForExpression')).toBe(PAGE_WAIT_EXPRESSION);
    expect(field(form, 'skipNetworkIdleEvent')).toBe('false');
    expect(field(form, 'printBackground')).toBe('true');
    expect(stem).toBe('page');
    expect(exportOf).toBe(PAGE);
  });

  it('a caller value wins, but 403 and 404 always fail a node print', async () => {
    const { form } = await buildForm(
      {
        route: 'chromium/convert/url',
        inputs: { node_id: PAGE },
        options: {
          waitForExpression: 'true',
          failOnHttpStatusCodes: [500],
          printBackground: false,
          paperWidth: '8.27in',
        },
      },
      caller,
      deps,
    );
    expect(field(form, 'waitForExpression')).toBe('true');
    expect(field(form, 'failOnHttpStatusCodes')).toBe('[500,403,404,499,599]');
    expect(field(form, 'printBackground')).toBe('false');
    expect(field(form, 'paperWidth')).toBe('8.27in');
  });

  it('a drawing screenshot clips to the image by default', async () => {
    const d: InputDeps = { ...deps, nodeKind: async () => 'draw' };
    const { form } = await buildForm(
      {
        route: 'chromium/screenshot/url',
        inputs: { node_id: PAGE },
        options: { deviceScaleFactor: 2 },
      },
      caller,
      d,
    );
    expect(field(form, 'selector')).toBe('img');
    expect(field(form, 'deviceScaleFactor')).toBe('2');
    expect(field(form, 'printBackground')).toBeNull();
  });

  it('files are parts; the options follow; a Mantle-owned option is refused before anything is read', async () => {
    const { form, stem } = await buildForm(
      { route: 'pdfengines/merge', inputs: { file_ids: [PDF] }, options: { pdfa: 'PDF/A-2b' } },
      caller,
      deps,
    );
    expect((field(form, 'files') as File).name).toBe('report.pdf');
    expect(field(form, 'pdfa')).toBe('PDF/A-2b');
    expect(stem).toBe('report-merged');
    await expect(
      buildForm(
        { route: 'pdfengines/merge', inputs: { file_ids: [PDF] }, options: { cookies: '[]' } },
        caller,
        deps,
      ),
    ).rejects.toThrow(/not yours to set/);
    await expect(buildForm({ route: 'nope/x' }, caller, deps)).rejects.toThrow(
      /unknown documents route/,
    );
  });
});

describe('names', () => {
  it('the caller stem wins and loses its extension; else the input stem with the op suffix', () => {
    const merge = findRoute('pdfengines/merge')!;
    expect(outputStem(merge, 'Q3 pack.pdf', 'a')).toBe('Q3 pack');
    expect(outputStem(merge, undefined, 'a')).toBe('a-merged');
    expect(outputStem(findRoute('libreoffice/convert')!, undefined, 'plan')).toBe('plan');
    expect(outputStem(merge, '../x/../y:z', 'a')).toBe('x-y-z');
    expect(outputStem(merge, '   ', '')).toBe('document-merged');
    expect(extensionFor('application/pdf')).toBe('pdf');
    expect(extensionFor('application/zip')).toBe('zip');
    expect(extensionFor('image/png')).toBe('png');
    expect(routeFor('pdfengines/split').key).toBe('pdfengines/split');
  });
});

describe('runDocuments', () => {
  it('lands the answer by the export rules with the route and the source on the file', async () => {
    engine(200, Buffer.from('%PDF-out'), { 'content-type': 'application/pdf' });
    const res = await runDocuments(
      { route: 'libreoffice/convert', inputs: { file_ids: [PDF] } },
      caller,
      'file',
      deps,
    );
    expect(res).toEqual({
      kind: 'file',
      route: 'libreoffice/convert',
      file: {
        id: 'f-new',
        name: 'report.pdf',
        path: 'files.auto_filed.exports/report.pdf',
        sizeBytes: 8,
        mimeType: 'application/pdf',
        landedIn: { id: 'ws-admin', name: 'Admin' },
      },
    });
    expect(saved.calls[0]).toMatchObject({
      ownerId: 'o1',
      filename: 'report.pdf',
      data: { exportOf: PDF, documentsRoute: 'libreoffice/convert' },
    });
    expect(posted[0]!.headers['Gotenberg-Output-Filename']).toBe('report');
    expect(posted[0]!.url).toBe('http://gotenberg:3000/forms/libreoffice/convert');
  });

  it('hands bytes back without saving, named by the output kind', async () => {
    engine(200, Buffer.from('PK'), { 'content-type': 'application/zip' });
    const res = await runDocuments(
      {
        route: 'pdfengines/split',
        inputs: { file_ids: [PDF] },
        options: { splitMode: 'intervals', splitSpan: '1' },
        filename: 'parts',
      },
      caller,
      'bytes',
      deps,
    );
    expect(res).toMatchObject({
      kind: 'bytes',
      contentType: 'application/zip',
      filename: 'parts.zip',
    });
    expect(saved.calls).toHaveLength(0);
  });

  it('a JSON route answers the JSON and saves nothing', async () => {
    engine(200, JSON.stringify({ 'report.pdf': { PageCount: 3 } }), {
      'content-type': 'application/json',
    });
    const res = await runDocuments(
      { route: 'pdfengines/metadata/read', inputs: { file_ids: [PDF] } },
      caller,
      'file',
      deps,
    );
    expect(res).toEqual({
      kind: 'json',
      route: 'pdfengines/metadata/read',
      json: { 'report.pdf': { PageCount: 3 } },
    });
    expect(saved.calls).toHaveLength(0);
  });

  it('the service off: refused before any read or request', async () => {
    process.env.MANTLE_COMPOSE_PROFILES = '';
    engine(200, 'x');
    await expect(
      runDocuments(
        { route: 'pdfengines/merge', inputs: { file_ids: [PDF] } },
        caller,
        'file',
        deps,
      ),
    ).rejects.toThrow(/not available/);
    expect(posted).toHaveLength(0);
  });
});
