import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { CANVAS_RUNTIME_KEEP, clearCanvasRuntime } from './canvas-runtime';

/**
 * A canvas runtime rebuild empties its folder but keeps the present frame's
 * drawer (frame-look.js, written there by server/web build-share-runtime.ts),
 * so `pnpm canvas-runtime` on its own does not leave every present drawing
 * blank for `look`.
 */
describe('clearCanvasRuntime', () => {
  const dirs: string[] = [];
  afterEach(() => {
    for (const d of dirs.splice(0)) fs.rmSync(d, { recursive: true, force: true });
  });

  it('empties the folder but keeps the present drawer', () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'canvas-runtime-'));
    dirs.push(dir);
    fs.writeFileSync(path.join(dir, 'frame-look.js'), 'drawer');
    fs.writeFileSync(path.join(dir, 'three-ABCD1234.js'), 'old');
    fs.mkdirSync(path.join(dir, 'reveal'));
    fs.writeFileSync(path.join(dir, 'reveal', 'reveal.css'), 'old');
    clearCanvasRuntime(dir);
    expect(fs.readdirSync(dir)).toEqual(['frame-look.js']);
    expect(fs.readFileSync(path.join(dir, 'frame-look.js'), 'utf8')).toBe('drawer');
  });

  it('makes the folder when it is not there, and keeps only the drawer', () => {
    const dir = path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'canvas-runtime-')), 'out');
    dirs.push(path.dirname(dir));
    clearCanvasRuntime(dir);
    expect(fs.readdirSync(dir)).toEqual([]);
    expect(CANVAS_RUNTIME_KEEP).toEqual(['frame-look.js']);
  });
});
