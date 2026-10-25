/**
 * The committed blank canvases (templates/<name>.canvas.html) are what the
 * build makes from the source today: built in memory the way
 * scripts/build.ts builds them, byte for byte. A failure here means the
 * source changed and the templates were not rebuilt: run
 * `pnpm -C packages/diagram-templates build` and commit them.
 */
import { readFileSync } from 'node:fs';
import * as path from 'node:path';
import { describe, expect, it } from 'vitest';
import { bundleRuntime, ROOT, TEMPLATE_SAMPLES, templateCanvas } from '../scripts/bundle.ts';

describe('the committed template canvases', () => {
  it('match a fresh build of the source', async () => {
    const { iife } = await bundleRuntime();
    for (const name of Object.keys(TEMPLATE_SAMPLES) as ('flow' | 'pid')[]) {
      const file = path.join(ROOT, 'templates', `${name}.canvas.html`);
      const fresh = templateCanvas(name, iife);
      // Compared as a flag first: a mismatch would otherwise print 160 KB.
      const same = readFileSync(file, 'utf8') === fresh;
      expect(same, `templates/${name}.canvas.html is stale: run the package build`).toBe(true);
    }
  }, 60_000);
});
