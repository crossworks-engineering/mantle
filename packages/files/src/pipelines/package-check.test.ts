/**
 * The one check of an own package (checkPackage): the shape, the caps, the
 * path rule, the manifest as text and its own rules, the entry a file of
 * the package, and the hash of the files whatever their order. Pure. The
 * package is made up (the template's LX-9 logger).
 */
import { describe, expect, it } from 'vitest';
import { PIPELINE_PACKAGE_FILES_MAX, PIPELINE_PACKAGE_MAX_BYTES } from './contract';
import { checkPackage } from './package-check';

const manifest = {
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
};
const files = (over: Record<string, unknown> = {}) => ({
  'pipeline.json': JSON.stringify(manifest),
  'step.ts': 'export const step = async () => ({ status: "not_mine" });',
  'bin/decode': { base64: Buffer.from([0, 1, 2, 255]).toString('base64') },
  ...over,
});
const refusal = (raw: unknown) => {
  const out = checkPackage(raw);
  return out.ok ? null : out.error;
};

describe('checkPackage', () => {
  it('takes a good package: the manifest, the bytes of each file, the hash', () => {
    const out = checkPackage({ files: files() });
    if (!out.ok) throw new Error(out.error);
    expect(out.manifest.id).toBe('lx9-logger');
    expect(out.bytes.get('bin/decode')).toEqual(Buffer.from([0, 1, 2, 255]));
    expect(out.bytes.get('step.ts')?.toString('utf8')).toMatch(/not_mine/);
    expect(Object.keys(out.pkg.files)).toEqual(['bin/decode', 'pipeline.json', 'step.ts']);
  });

  it('the same files in another order have the same hash; other files another', () => {
    const a = checkPackage({ files: files() });
    const f = files();
    const b = checkPackage({ files: Object.fromEntries(Object.entries(f).reverse()) });
    const c = checkPackage({ files: files({ 'step.ts': 'export const step = 1;' }) });
    if (!a.ok || !b.ok || !c.ok) throw new Error('refused');
    expect(a.hash).toBe(b.hash);
    expect(a.hash).not.toBe(c.hash);
  });

  it('refuses each broken package with a plain sentence', () => {
    const many = Object.fromEntries(
      Array.from({ length: PIPELINE_PACKAGE_FILES_MAX + 1 }, (_, i) => [`f${i}.txt`, 'x']),
    );
    const cases: [string, unknown, RegExp][] = [
      ['no files', {}, /files/],
      ['a list', { files: [] }, /files/],
      ['too many', { files: { ...files(), ...many } }, /at most 200 files/],
      [
        'too large',
        { files: files({ big: 'x'.repeat(PIPELINE_PACKAGE_MAX_BYTES) }) },
        /MB of files/,
      ],
      ['a path out', { files: files({ '../x': 'x' }) }, /relative inside the package/],
      ['a path abs', { files: files({ '/x': 'x' }) }, /relative inside the package/],
      ['a bad file', { files: files({ 'x.bin': { bytes: 'AA' } }) }, /base64/],
      ['bad base64', { files: files({ 'x.bin': { base64: 'A!==' } }) }, /base64/],
      ['no manifest', { files: { 'step.ts': 'x' } }, /pipeline\.json/],
      ['binary manifest', { files: files({ 'pipeline.json': { base64: 'AA==' } }) }, /text file/],
      ['not JSON', { files: files({ 'pipeline.json': '{' }) }, /not JSON/],
      [
        'a worker',
        {
          files: files({
            'pipeline.json': JSON.stringify({
              ...manifest,
              needs: { weight: 'light', workers: { vision: 1 } },
            }),
          }),
        },
        /asks no AI worker/,
      ],
      [
        'a router',
        { files: files({ 'pipeline.json': JSON.stringify({ ...manifest, router: true }) }) },
        /is a Reader/,
      ],
      [
        'no entry file',
        { files: { 'pipeline.json': JSON.stringify(manifest) } },
        /not a file of the package/,
      ],
    ];
    for (const [what, raw, re] of cases) expect(refusal(raw), what).toMatch(re);
  });
});
