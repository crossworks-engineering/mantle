/**
 * The one manifest check (checkManifest): the common rules, and the rules
 * of an own pipeline in phase 3. Every built-in passes it (builtin.test.ts).
 * Pure. The manifests here are made up.
 */
import { describe, expect, it } from 'vitest';
import { PIPELINE_API, PIPELINE_KIT, type PipelineManifest } from './contract';
import { checkManifest } from './manifest-check';

/** A made-up own Reader that passes every rule. */
const OWN: PipelineManifest = {
  id: 'made-up-lx9',
  name: 'Made-up LX9 log',
  description: 'Reads a made-up LX9 log and writes its readings as one tab.',
  version: '1.0.0',
  api: PIPELINE_API,
  kit: PIPELINE_KIT,
  runtime: 'python',
  entry: 'step.py',
  start: 'upload',
  match: { ext: ['lx9'] },
  produces: {},
  needs: { weight: 'light', timeMs: 60_000, tools: ['file_tabs_write'] },
  options: {
    unit: { type: 'words', label: 'Units', default: [], maxItems: 4, maxChars: 8 },
  },
};

const refusal = (m: unknown, source: 'builtin' | 'own' = 'own') => {
  const out = checkManifest(m, source);
  return out.ok ? null : out.error;
};

describe('checkManifest', () => {
  it('takes a good own Reader as it is', () => {
    expect(checkManifest(OWN, 'own')).toEqual({ ok: true, manifest: OWN });
  });

  it('refuses what breaks a common rule, with a plain sentence', () => {
    const cases: [string, unknown][] = [
      ['no object', null],
      ['id', { ...OWN, id: 'Made Up' }],
      ['id length', { ...OWN, id: 'a'.repeat(41) }],
      ['name', { ...OWN, name: ' ' }],
      ['description', { ...OWN, description: '' }],
      ['long description', { ...OWN, description: 'x'.repeat(301) }],
      ['markup', { ...OWN, description: 'Reads *bold* logs.' }],
      ['version', { ...OWN, version: '1.0' }],
      ['api', { ...OWN, api: PIPELINE_API + 1 }],
      ['kit', { ...OWN, kit: PIPELINE_KIT + 1 }],
      ['runtime', { ...OWN, runtime: 'perl' }],
      ['entry', { ...OWN, entry: '' }],
      ['no ext', { ...OWN, match: { ext: [] } }],
      ['upper-case ext', { ...OWN, match: { ext: ['LX9'] } }],
      ['eleven exts', { ...OWN, match: { ext: 'abcdefghijk'.split('') } }],
      ['weight', { ...OWN, needs: { weight: 'huge' } }],
      ['time', { ...OWN, needs: { weight: 'light', timeMs: 240_001 } }],
      ['option name', { ...OWN, options: { Unit: OWN.options!.unit } }],
      [
        'option default',
        { ...OWN, options: { n: { type: 'number', label: 'N', default: 9, min: 0, max: 1 } } },
      ],
      ['option type', { ...OWN, options: { n: { type: 'regex', label: 'N', default: '' } } }],
    ];
    for (const [what, m] of cases) {
      const error = refusal(m);
      expect(error, what).toEqual(expect.any(String));
      expect(error, what).not.toMatch(/—|–/);
    }
  });

  it('an own pipeline is a Reader at upload on Bun or Python, with no worker, no other tool and no shape', () => {
    const cases: [string, unknown][] = [
      ['router', { ...OWN, router: true }],
      ['kind', { ...OWN, match: { ext: ['lx9'], kind: ['pid'] } }],
      ['after', { ...OWN, match: { ext: ['lx9'], after: 'texts-v1' } }],
      ['demand', { ...OWN, start: 'demand' }],
      ['core', { ...OWN, runtime: 'core' }],
      ['worker', { ...OWN, needs: { weight: 'light', workers: { vision: 1 } } }],
      ['tool', { ...OWN, needs: { weight: 'light', tools: ['file_tabs_write', 'web_fetch'] } }],
      ['shape', { ...OWN, produces: { shapes: ['texts-v1'] } }],
    ];
    for (const [what, m] of cases) expect(refusal(m), what).toEqual(expect.any(String));
    // The same manifests are no breach for a built-in, which may route,
    // claim kinds, read a database, ask a worker and promise a shape.
    for (const [what, m] of cases.filter(([w]) => w !== 'demand' && w !== 'core')) {
      expect(refusal(m, 'builtin'), what).toBeNull();
    }
    expect(refusal({ ...OWN, runtime: 'bun', entry: 'step.ts' })).toBeNull();
    expect(refusal({ ...OWN, needs: { weight: 'light', tools: [] } })).toBeNull();
  });

  it("an own pipeline's entry is a plain path inside the package, of its runtime's kind", () => {
    for (const entry of ['../step.py', '/abs/step.py', 'a/./step.py', 'a\\step.py', 'step.ts']) {
      expect(refusal({ ...OWN, entry }), entry).toEqual(expect.any(String));
    }
    expect(refusal({ ...OWN, runtime: 'bun', entry: 'step.py' })).toMatch(/\.ts or \.js/);
    expect(refusal({ ...OWN, entry: 'lib/step.py' })).toBeNull();
    expect(refusal({ ...OWN, runtime: 'bun', entry: 'src/step.js' })).toBeNull();
  });
});
