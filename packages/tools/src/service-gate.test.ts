/**
 * The agent tool list drops a tool whose optional service is off
 * (@mantle/config `toolService`). That mapping is by slug: every sandbox verb
 * starts with `sandbox_` (video_ingest needs no service of its own: the
 * parser, core on every box, extracts its audio). These pins
 * keep the mapping true as tools are added: a sandbox tool without the prefix
 * would stay listed on a box without sandboxes, and a non-sandbox tool WITH
 * it would vanish there.
 */
import { readdirSync, readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { toolService } from '@mantle/config';
// The documents tools register their service when their module loads.
import './builtins-documents';

const SRC = dirname(fileURLToPath(import.meta.url));
const SLUG = /^\s+slug: '([a-z0-9_]+)'/gm;

function slugsIn(file: string): string[] {
  return [...readFileSync(file, 'utf8').matchAll(SLUG)].map((m) => m[1]!);
}

function allSources(dir: string): string[] {
  return readdirSync(dir, { withFileTypes: true }).flatMap((e) => {
    const p = join(dir, e.name);
    if (e.isDirectory()) return allSources(p);
    return e.name.endsWith('.ts') && !e.name.endsWith('.test.ts') ? [p] : [];
  });
}

describe('tool slugs map to their optional service', () => {
  it('every tool in src/sandbox/ needs the sandboxes service', () => {
    const dir = join(SRC, 'sandbox');
    const slugs = readdirSync(dir)
      .filter((f) => f.endsWith('.ts') && !f.endsWith('.test.ts'))
      .flatMap((f) => slugsIn(join(dir, f)));
    expect(slugs.length).toBeGreaterThan(0);
    for (const s of slugs) expect(toolService(s), s).toBe('sandboxes');
  });

  it('no tool outside src/sandbox/ is mistaken for a sandbox tool', () => {
    const outside = allSources(SRC).filter((f) => !f.startsWith(join(SRC, 'sandbox') + '/'));
    for (const f of outside) {
      for (const s of slugsIn(f)) {
        const svc = toolService(s);
        // The documents engine's four tools (builtins-documents.ts) need the
        // documents service; the file pins itself to the config's set.
        if (f.endsWith('builtins-documents.ts')) {
          expect(svc, `${s} in ${f}`).toBe('documents');
          continue;
        }
        expect(svc, `${s} in ${f}`).toBeNull();
      }
    }
  });
});
