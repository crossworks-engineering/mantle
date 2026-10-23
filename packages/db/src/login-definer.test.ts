/**
 * The callers of loginDefinerCall, pinned per file: a definer call in a
 * login's scope on the system pool is made only where it is listed (an
 * Admin act's, the member turn ledger's). A new caller fails here first.
 */
import { readFileSync, readdirSync, statSync } from 'node:fs';
import { join, relative } from 'node:path';
import { describe, expect, it } from 'vitest';

const ROOT = join(__dirname, '..', '..', '..');

function sources(dir: string, out: string[] = []): string[] {
  for (const name of readdirSync(dir)) {
    if (name === 'node_modules' || name.startsWith('.')) continue;
    const p = join(dir, name);
    if (statSync(p).isDirectory()) sources(p, out);
    else if (/\.tsx?$/.test(name) && !/\.test\.tsx?$/.test(name)) out.push(p);
  }
  return out;
}

describe('loginDefinerCall callers', () => {
  it('are the Admin acts and the member turn ledger, each with its count', () => {
    const found: Record<string, number> = {};
    for (const top of ['packages', 'server']) {
      for (const file of sources(join(ROOT, top))) {
        const rel = relative(ROOT, file);
        if (rel === 'packages/db/src/login-definer.ts' || /\/test-support\//.test(rel)) continue;
        const n = (readFileSync(file, 'utf8').match(/\bloginDefinerCall\s*(<[^>]*>)?\s*\(/g) ?? [])
          .length;
        if (n > 0) found[rel] = n;
      }
    }
    expect(found).toEqual({
      // asAdmin, the one wrapper every Admin act goes through.
      'packages/content/src/admin-acts.ts': 1,
      // The claim, the release and the settle.
      'packages/content/src/member-turn-ledger.ts': 3,
    });
  });
});
