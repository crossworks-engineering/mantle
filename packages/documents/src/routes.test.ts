/**
 * The route table and its schemas: every Gotenberg 8.39 conversion route is
 * here, every route's options are a strict schema of the engine's own field
 * names, and the fields Mantle owns are refused everywhere, each with why.
 */
import { describe, expect, it } from 'vitest';
import { checkOptions, formValue } from './form';
import { DOCUMENT_ROUTES, findRoute, routesOf } from './routes';
import { MANTLE_OWNED_FIELDS } from './schemas';

const KEYS = [
  'chromium/convert/html',
  'chromium/convert/markdown',
  'chromium/convert/url',
  'chromium/screenshot/html',
  'chromium/screenshot/markdown',
  'chromium/screenshot/url',
  'libreoffice/convert',
  'pdfengines/merge',
  'pdfengines/split',
  'pdfengines/flatten',
  'pdfengines/convert',
  'pdfengines/metadata/read',
  'pdfengines/metadata/write',
  'pdfengines/encrypt',
  'pdfengines/embed',
  'pdfengines/watermark',
  'pdfengines/stamp',
  'pdfengines/rotate',
  'pdfengines/bookmarks/read',
  'pdfengines/bookmarks/write',
  'pdfengines/optimize',
  'pdfengines/factur-x',
];

describe('the route table mirrors Gotenberg', () => {
  it('has every route, once, with the engine path', () => {
    expect(DOCUMENT_ROUTES.map((r) => r.key)).toEqual(KEYS);
    for (const r of DOCUMENT_ROUTES) {
      expect(r.path).toBe(`/forms/${r.key}`);
      expect(r.family).toBe(r.key.split('/')[0]);
      expect(findRoute(r.key)).toBe(r);
    }
    expect(findRoute('pdfengines/nope')).toBeNull();
    expect(routesOf('pdfengines')).toHaveLength(15);
    expect(routesOf('chromium')).toHaveLength(6);
  });

  it('the JSON routes are the two reads', () => {
    expect(DOCUMENT_ROUTES.filter((r) => r.output === 'json').map((r) => r.key)).toEqual([
      'pdfengines/metadata/read',
      'pdfengines/bookmarks/read',
    ]);
    expect(DOCUMENT_ROUTES.filter((r) => r.output === 'image').map((r) => r.key)).toEqual(
      KEYS.filter((k) => k.includes('screenshot')),
    );
  });
});

describe('options: the engine field names, strict', () => {
  const page = findRoute('chromium/convert/html')!;

  it('takes the documented fields as the engine takes them', () => {
    expect(
      checkOptions(page, {
        paperWidth: 8.27,
        paperHeight: '11.69',
        marginTop: '18mm',
        landscape: true,
        printBackground: true,
        waitForExpression: 'window.ready === true',
        failOnHttpStatusCodes: [404, 499, 599],
        emulatedMediaFeatures: [{ name: 'prefers-color-scheme', value: 'light' }],
        pdfa: 'PDF/A-2b',
        metadata: { Author: 'Mantle' },
        splitMode: 'intervals',
        splitSpan: '2',
        rotateAngle: 90,
        userPassword: 'x',
      }),
    ).toMatchObject({ paperWidth: 8.27, landscape: true, rotateAngle: 90 });
    expect(checkOptions(page, undefined)).toEqual({});
  });

  it('refuses an unknown field with the first problem, in the engine name', () => {
    expect(() => checkOptions(page, { paperwidth: 8 })).toThrow(
      /options for chromium\/convert\/html: /,
    );
    expect(() => checkOptions(page, { scale: 9 })).toThrow(/scale: /);
    expect(() => checkOptions(page, { pdfa: 'PDF/A-9' })).toThrow(/pdfa/);
    expect(() => checkOptions(page, 'x')).toThrow(/must be an object/);
  });

  it('refuses every Mantle-owned field on every route, with why', () => {
    for (const r of DOCUMENT_ROUTES) {
      for (const [field, why] of Object.entries(MANTLE_OWNED_FIELDS)) {
        expect(() => checkOptions(r, { [field]: 'x' })).toThrow(why.slice(0, 20));
      }
    }
    expect(Object.keys(MANTLE_OWNED_FIELDS)).toEqual(
      expect.arrayContaining([
        'url',
        'cookies',
        'extraHttpHeaders',
        'userAgent',
        'downloadFrom',
        'webhookUrl',
        'files',
      ]),
    );
  });

  it('each PDF tool asks what the engine requires', () => {
    expect(() => checkOptions(findRoute('pdfengines/split')!, {})).toThrow(/splitMode/);
    expect(
      checkOptions(findRoute('pdfengines/split')!, {
        splitMode: 'pages',
        splitSpan: '1-2',
        splitUnify: true,
      }),
    ).toMatchObject({ splitUnify: true });
    expect(() => checkOptions(findRoute('pdfengines/convert')!, {})).toThrow(/pdfa .* or pdfua/);
    expect(checkOptions(findRoute('pdfengines/convert')!, { pdfua: true })).toEqual({
      pdfua: true,
    });
    expect(() => checkOptions(findRoute('pdfengines/encrypt')!, { allowPrinting: false })).toThrow(
      /userPassword or ownerPassword/,
    );
    expect(() =>
      checkOptions(findRoute('pdfengines/watermark')!, { watermarkSource: 'text' }),
    ).toThrow(/watermarkExpression/);
    expect(() => checkOptions(findRoute('pdfengines/stamp')!, {})).toThrow(/stampSource/);
    expect(() => checkOptions(findRoute('pdfengines/rotate')!, { rotateAngle: 45 })).toThrow(
      /rotateAngle/,
    );
    expect(() => checkOptions(findRoute('pdfengines/metadata/write')!, {})).toThrow(/metadata/);
    expect(() =>
      checkOptions(findRoute('pdfengines/bookmarks/write')!, { bookmarks: [{ title: 'A' }] }),
    ).toThrow(/bookmarks/);
    expect(
      checkOptions(findRoute('pdfengines/bookmarks/write')!, {
        bookmarks: [{ title: 'A', page: 1, children: [{ title: 'A.1', page: 2, children: [] }] }],
      }),
    ).toMatchObject({ bookmarks: [{ title: 'A', page: 1 }] });
    expect(() => checkOptions(findRoute('pdfengines/factur-x')!, {})).toThrow(
      /facturxConformanceLevel/,
    );
    expect(() =>
      checkOptions(findRoute('pdfengines/factur-x')!, {
        facturxConformanceLevel: 'BASIC',
        pdfa: 'PDF/A-2b',
      }),
    ).toThrow(/pdfa/);
    expect(() => checkOptions(findRoute('pdfengines/flatten')!, { landscape: true })).toThrow(
      /landscape/,
    );
    expect(checkOptions(findRoute('pdfengines/optimize')!, { imageQuality: 50 })).toEqual({
      imageQuality: 50,
    });
  });

  it('LibreOffice and screenshot fields are their routes alone', () => {
    const office = findRoute('libreoffice/convert')!;
    expect(
      checkOptions(office, {
        landscape: true,
        merge: true,
        exportFormFields: false,
        maxImageResolution: 150,
        nativeWatermarkText: 'DRAFT',
        initialView: 1,
      }),
    ).toMatchObject({ merge: true });
    expect(() => checkOptions(office, { paperWidth: 8 })).toThrow(/paperWidth/);
    const shot = findRoute('chromium/screenshot/url')!;
    expect(
      checkOptions(shot, { selector: 'img', deviceScaleFactor: 2, format: 'png', width: 800 }),
    ).toMatchObject({ selector: 'img' });
    expect(() => checkOptions(shot, { paperWidth: 8 })).toThrow(/paperWidth/);
    expect(() => checkOptions(shot, { format: 'gif' })).toThrow(/format/);
  });
});

describe('form values', () => {
  it('booleans and numbers as text, arrays and objects as JSON', () => {
    expect(formValue(true)).toBe('true');
    expect(formValue(8.27)).toBe('8.27');
    expect(formValue('18mm')).toBe('18mm');
    expect(formValue([404, 499])).toBe('[404,499]');
    expect(formValue({ Author: 'A' })).toBe('{"Author":"A"}');
  });
});
