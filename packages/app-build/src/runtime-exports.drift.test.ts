/**
 * The import check is only as good as the export map it checks against.
 * Production reads the GENERATED manifest, so it is always accurate; the tests
 * use a hand-written fixture, which is not. This builds the real runtime and
 * asserts the two agree, so a runtime change that the fixture misses fails
 * here instead of quietly letting every other test pass against a shape that
 * no longer exists.
 */
import { describe, expect, it } from 'vitest';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { buildRuntime } from './build-runtime';
import { RUNTIME_EXPORTS_FIXTURE } from './runtime-exports.fixture';

describe('RUNTIME_EXPORTS_FIXTURE', () => {
  it('matches what buildRuntime actually emits', async () => {
    const outDir = fs.mkdtempSync(path.join(os.tmpdir(), 'mantle-rt-'));
    try {
      const manifest = await buildRuntime(outDir, '/app-runtime/');

      // Same specifiers on both sides.
      expect(Object.keys(RUNTIME_EXPORTS_FIXTURE).sort()).toEqual(
        Object.keys(manifest.exports).sort(),
      );

      for (const [spec, fixture] of Object.entries(RUNTIME_EXPORTS_FIXTURE)) {
        const real = new Set(manifest.exports[spec]);
        // The fixture may list a SUBSET of a big surface (react has hundreds of
        // exports) — what it must never do is claim a name the runtime lacks,
        // because that is what would let a broken import pass the check.
        for (const name of fixture) {
          expect(real, `${spec} should export ${name}`).toContain(name);
        }
      }

      // The specifier the field bug hit: assert its exact shape, since the
      // whole check turns on '@host' having no default export.
      expect(manifest.exports['@host']).toEqual(['__mount', 'host']);
    } finally {
      fs.rmSync(outDir, { recursive: true, force: true });
    }
  }, 120_000);
});
