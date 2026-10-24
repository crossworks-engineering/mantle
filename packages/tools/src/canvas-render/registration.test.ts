import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';

/**
 * Every server process that runs the canvas tools registers the canvas
 * renderer: without it a save lands undrawn and the agent works blind,
 * which reads as a canvas with no picture, not as a broken deploy. The agent
 * turns run in server/api, so the web process alone was not enough (the
 * Present final audit, C4). A SOURCE check, like
 * packages/content/src/recall-embed-registration.test.ts. A background
 * worker registers none: there a save says plainly that no picture is drawn.
 */
const repoRoot = join(dirname(fileURLToPath(import.meta.url)), '../../../..');

const ENTRYPOINTS = [
  'server/web/server/main.ts',
  'server/api/src/main.ts',
  'server/mcp/src/server.ts',
] as const;

describe('the canvas renderer is registered where the canvas tools run', () => {
  for (const file of ENTRYPOINTS) {
    it(file, () => {
      const src = readFileSync(join(repoRoot, file), 'utf8');
      expect(src).toMatch(/registerCanvasRenderer\(renderCanvas\)/);
      expect(src).toMatch(/@mantle\/tools\/canvas-render['"]/);
    });
  }
});
