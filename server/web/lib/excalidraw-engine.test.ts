import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { EXCALIDRAW_ENGINE } from '@mantle/content';

/**
 * Tripwire for the pinned Excalidraw version.
 *
 * EXCALIDRAW_ENGINE is stamped onto every stored snapshot so an upgrade can
 * mark the old ones stale and re-render them. That only works if the constant
 * tracks the pin, so bumping the dependency without bumping the constant fails
 * here rather than silently leaving the whole corpus marked "current" while it
 * was drawn by a different renderer.
 *
 * Asserted against the declared pins rather than the installed package because
 * the package's `exports` map does not expose its own package.json.
 */
const repoRoot = join(import.meta.dirname, '../../..');

function declaredPin(app: string): string {
  const pkg = JSON.parse(readFileSync(join(repoRoot, app, 'package.json'), 'utf8')) as {
    dependencies?: Record<string, string>;
  };
  const pin = pkg.dependencies?.['@excalidraw/excalidraw'];
  if (!pin) throw new Error(`${app} does not depend on @excalidraw/excalidraw`);
  return pin;
}

describe('EXCALIDRAW_ENGINE', () => {
  // Both tiers render snapshots — the editor at commit, the sidecar on a cache
  // miss — so a drift between them would produce two different renderers
  // writing the same stamp.
  it.each(['client/web', 'server/web'])('matches the pin declared by %s', (app) => {
    expect(declaredPin(app)).toBe(EXCALIDRAW_ENGINE);
  });

  it('is pinned exactly, so the stamp cannot drift under us', () => {
    for (const app of ['client/web', 'server/web']) {
      expect(declaredPin(app)).toMatch(/^\d+\.\d+\.\d+$/);
    }
  });
});
